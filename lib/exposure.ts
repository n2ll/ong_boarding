import type { SupabaseClient } from "@supabase/supabase-js";
import { SLOTS, SLOT_LABEL, applicantAvailableSlots, type SlotKey } from "./admin/types";
import { distanceToJobKm, jobSupportsRadius, type GeoJob } from "./geo";

/**
 * J · 타겟 공고 노출 — 규칙 매처 + 유효 노출 판정 (파이프라인 필터 의미와 단일 소스).
 *
 * 유효 노출(지정 노출 공고 J, 지원자 A):
 *   exclude 있으면 제외 → include 있으면 노출 → 규칙 매칭이면 노출 → 아니면 제외.
 * 전체 노출(all) 공고는 이 판정을 거치지 않고 항상 노출(호출부에서 분기).
 */

// 자동 노출 규칙 — 파이프라인 필터 스키마 재사용(지역·가용성·선탑완료·코호트) + 차량.
export interface ExposureRule {
  sido?: string[]; // 시도(지역) 화이트리스트
  /**
   * 시군구(구 단위) 화이트리스트 — 시·도로는 '강남권/용산권'을 가를 수 없어서 추가했다.
   * 값은 `sigunguKey()`의 복합키(`서울특별시>강남구`) 또는 `'미확인'`. 구 이름만 담으면 동명이구가 교차로 걸린다.
   */
  sigungu?: string[];
  availability?: string[]; // 가용성 값 화이트리스트
  /**
   * 차량 보유 화이트리스트 — 정규화 값('있음' | '없음' | '미확인').
   * 공고 요건과 직결되는 축인데 규칙에 없어서, 차량이 필요한 라인이 도보만 가능한 분에게도 그대로 노출됐다.
   * (실데이터 645명 전원 own_vehicle 값 보유: 있음 389 · 없음 165 · 미확인 91 — 가장 잘 채워진 축이다.)
   */
  vehicle?: string[];
  /**
   * 희망 시간대 화이트리스트 — 4슬롯 정규 키('평일오전'…) 또는 `'미확인'`.
   * 판정은 `applicantAvailableSlots`(자기 신고 → 폼 토큰 → 자유 입력 파서) 하나만 쓴다.
   * 실데이터 645명: 슬롯 확정 408명 · 미확인 237명(값이 '~' 한 글자이거나 야간·새벽 근무).
   */
  slot?: string[];
  /**
   * 집결지 거리 반경(km) — 이 안에 사는 사람만. `'미확인'` 개념이 없는 유일한 축이라
   * 좌표 없는 분(실측 186명)은 `radiusIncludeUnknown`을 켜야 통과한다.
   * 기준점(집결지만 / 경유지 포함)은 **공고가 정한다**(jobs.distance_basis) — lib/geo 단일 공식.
   */
  radiusKm?: number;
  /** 좌표 없는 분을 반경 규칙에 포함할지 — 조용한 탈락을 없애기 위한 명시 선택(다른 축의 '미확인'과 같은 역할). */
  radiusIncludeUnknown?: boolean;
  suntopDone?: boolean; // 선탑 완료자만
  cohortMonths?: number; // 원지원(없으면 등록)일이 최근 N개월 이내
}

// 규칙 평가에 필요한 applicant 필드(부분).
export interface ExposureApplicant {
  id: number;
  sido: string | null;
  sigungu: string | null;
  availability: string | null;
  /** 자유 입력 값이라 정규화해서 비교한다(있음/없음/미확인). 호출부가 반드시 함께 넘길 것 — 없으면 차량 규칙이 fail-closed. */
  own_vehicle?: string | null;
  /**
   * 희망 시간대 판정 재료 — **필수**로 둔다(옵셔널이면 배선을 빠뜨린 판정 지점에서 전원이 조용히 탈락한다).
   * 시군구·차량 축에서 실제로 겪은 사고라 타입으로 강제한다.
   */
  work_hours: string | null;
  available_slots: string[] | null;
  /** 거리 판정 재료 — **필수**. 옵셔널로 두면 배선을 빠뜨린 지점에서 전원이 조용히 탈락한다. */
  lat: number | null;
  lng: number | null;
  applied_at: string | null;
  created_at: string | null;
  suntopDone?: boolean; // pool_events(suntop_done)에서 계산해 주입
}

/**
 * 차량 보유 3값 정규화 — **파이프라인 목록의 차량 판정(vehicleClassOf)과 같은 규칙**이어야 한다.
 * 매니저가 파이프라인에서 '차량 보유'로 고른 집합과 노출 규칙 '있음'이 다른 사람을 가리키면 안 된다.
 * 그래서 느슨한 패턴 매칭을 쓰지 않는다 — 자유 입력('업무용 차량 있음' 같은 값)은 '미확인'으로 남기고
 * 사람이 값을 정리하게 한다(잘못 '없음'으로 분류해 조용히 노출을 끊는 것보다 안전).
 */
export function normalizeVehicleOwned(raw: string | null | undefined): "있음" | "없음" | "미확인" {
  const v = (raw ?? "").trim();
  if (v === "있음" || v === "네" || v === "예") return "있음";
  if (v === "없음" || v === "아니오") return "없음";
  return "미확인";
}

/** 노출 규칙에서 고를 수 있는 차량 값 — UI 칩과 서버 정규화가 같은 집합을 쓴다. */
export const VEHICLE_RULE_VALUES = ["있음", "없음", "미확인"] as const;

/**
 * 값이 비어 있는 사람을 가리키는 규칙 값 — 매니저가 이걸 골라야 그 사람들이 통과한다.
 * 조용한 탈락을 없애기 위한 장치다(시군구 미상 194명 · 시간대 미상 205명이 규칙마다 사라지던 문제).
 */
export const UNKNOWN_RULE_VALUE = "미확인";

/** 텍스트 축(지역) 판정 — 값이 비면 '미확인'을 고른 규칙만 통과시킨다. */
function matchesTextAxis(allow: string[], v: string | null | undefined): boolean {
  const s = (v ?? "").trim();
  return s ? allow.includes(s) : allow.includes(UNKNOWN_RULE_VALUE);
}

/** 시도 값이 없는 사람을 묶는 그룹 이름 — 옵션 API·규칙 키·에디터가 같은 문자열을 쓴다. */
export const SIGUNGU_NO_SIDO = "시도 미확인";

/**
 * 시군구 규칙 키 — `시도>시군구` 복합키.
 * 구 이름만으로 비교하면 동명이구(중구·서구가 서울·인천·부산에 모두 있다) 때문에
 * 에디터에서 '서울특별시 > 중구'를 골라도 인천·부산 중구가 함께 걸린다(표시와 판정이 어긋난다).
 */
export function sigunguKey(sido: string | null | undefined, sigungu: string | null | undefined): string | null {
  const g = (sigungu ?? "").trim();
  if (!g) return null;
  const s = (sido ?? "").trim() || SIGUNGU_NO_SIDO;
  return `${s}>${g}`;
}

export type ExposureMode = "include" | "exclude";

/** 들어온 jsonb를 안전한 ExposureRule로 정규화(알 수 없는 키·타입 제거). null이면 규칙 없음. */
export function normalizeRule(raw: unknown): ExposureRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: ExposureRule = {};
  // 배열은 중복 제거 + 원소 100자·50개 상한 — 거대 jsonb가 그대로 저장되는 것 방지.
  const strArr = (v: unknown) =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim() !== "" && x.length <= 100))].slice(0, 50)
      : undefined;
  const sido = strArr(r.sido);
  const sigungu = strArr(r.sigungu);
  const availability = strArr(r.availability);
  if (sido && sido.length) out.sido = sido;
  if (sigungu && sigungu.length) out.sigungu = sigungu;
  if (availability && availability.length) out.availability = availability;
  // 차량 — 허용 3값만 남긴다(자유 문자열이 규칙에 들어와 아무도 매칭되지 않는 상태 방지).
  const vehicle = strArr(r.vehicle)?.filter((v) => (VEHICLE_RULE_VALUES as readonly string[]).includes(v));
  if (vehicle && vehicle.length) out.vehicle = vehicle;
  // 시간대 — 4슬롯 정규 키 + '미확인'만. 자유 문자열('평일 오전' 공백형 등)이 들어와 아무도 안 걸리는 상태 방지.
  const slot = strArr(r.slot)?.filter(
    (v) => (SLOTS as readonly string[]).includes(v) || v === UNKNOWN_RULE_VALUE
  );
  if (slot && slot.length) out.slot = slot;
  // 반경 — 1~100km 정수만. 0·음수·거대값이 들어와 아무도(또는 전원이) 걸리는 상태 방지.
  if (typeof r.radiusKm === "number") {
    // 반올림 **후** 검증 — 0.3이 0으로 저장되면 '조건 1개'로 보이는데 아무것도 거르지 않는다.
    const km = Math.round(r.radiusKm);
    if (km >= 1 && km <= 100) {
      out.radiusKm = km;
      if (r.radiusIncludeUnknown === true) out.radiusIncludeUnknown = true;
    }
  }
  if (r.suntopDone === true) out.suntopDone = true;
  if (typeof r.cohortMonths === "number" && r.cohortMonths > 0 && r.cohortMonths <= 120) {
    out.cohortMonths = Math.floor(r.cohortMonths);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 규칙을 사람이 읽는 조건 목록으로 풀어 쓴다.
 *
 * 왜 필요한가: '규칙을 지우고 이 명단만 노출'을 누르면 저장된 규칙은 **되돌릴 수 없이** 사라진다.
 * 무엇을 지우는지 확인 화면에 그대로 보여줘야 조용한 소거가 아니게 된다.
 * 서버 응답(impact)과 클라이언트 표시가 같은 문구를 쓰도록 여기에 둔다.
 */
export function describeRule(rule: ExposureRule | null): string[] {
  if (!rule) return [];
  const out: string[] = [];
  if (rule.sido?.length) out.push(`지역 ${rule.sido.join("·")}`);
  // 복합키(시도>시군구)는 '>'만 공백으로 — 구 이름만 남기면 어느 시도의 중구인지 알 수 없다.
  if (rule.sigungu?.length) out.push(`시군구 ${rule.sigungu.map((k) => k.replace(">", " ")).join("·")}`);
  if (rule.availability?.length) out.push(`가용성 ${rule.availability.join("·")}`);
  if (rule.vehicle?.length) out.push(`차량 ${rule.vehicle.join("·")}`);
  if (rule.slot?.length)
    out.push(
      `시간대 ${rule.slot.map((s) => SLOT_LABEL[s as SlotKey] ?? s).join("·")}`
    );
  if (rule.radiusKm)
    out.push(`반경 ${rule.radiusKm}km${rule.radiusIncludeUnknown ? "(주소 미확인 포함)" : ""}`);
  if (rule.suntopDone) out.push("선탑(동승) 완료자만");
  if (rule.cohortMonths) out.push(`최근 ${rule.cohortMonths}개월 안에 지원`);
  return out;
}

/**
 * 판정 컨텍스트 — 시각과 **대상 공고**. 거리 축이 생기면서 '규칙 + 사람'만으로는 판정이 불가능해졌다.
 * job을 넘기지 않으면 반경 규칙은 fail-closed(아무도 통과 못 함)라, 호출부가 반드시 채워야 한다.
 */
export interface ExposureContext {
  nowMs?: number;
  job?: GeoJob | null;
}

/** applicant가 규칙에 매칭되나. 규칙 없으면 false(자동 노출 없음). */
export function matchesRule(a: ExposureApplicant, rule: ExposureRule | null, ctx: ExposureContext): boolean {
  if (!rule) return false;
  const nowMs = ctx.nowMs ?? Date.now();
  if (rule.sido && rule.sido.length) {
    if (!matchesTextAxis(rule.sido, a.sido)) return false;
  }
  if (rule.sigungu && rule.sigungu.length) {
    // 복합키(시도>시군구) 비교 — 값이 비면 '미확인'을 고른 규칙만 통과.
    const key = sigunguKey(a.sido, a.sigungu);
    if (key === null ? !rule.sigungu.includes(UNKNOWN_RULE_VALUE) : !rule.sigungu.includes(key)) return false;
  }
  if (rule.availability && rule.availability.length) {
    if (!a.availability || !rule.availability.includes(a.availability)) return false;
  }
  if (rule.vehicle && rule.vehicle.length) {
    // own_vehicle을 안 넘긴 호출부에서는 '미확인'으로 본다 — 조용히 전원 통과시키지 않는다(fail-closed 방향).
    if (!rule.vehicle.includes(normalizeVehicleOwned(a.own_vehicle))) return false;
  }
  if (rule.slot && rule.slot.length) {
    // 판정은 applicantAvailableSlots 하나만 — 파이프라인 조건 바와 같은 집합을 가리켜야 한다.
    // 슬롯을 못 정한 사람(요일만 아는 경우·야간·새벽 포함)은 '미확인'을 고른 규칙만 통과.
    const { slots } = applicantAvailableSlots({ work_hours: a.work_hours, available_slots: a.available_slots });
    const ok = slots.length
      ? slots.some((s) => rule.slot!.includes(s))
      : rule.slot.includes(UNKNOWN_RULE_VALUE);
    if (!ok) return false;
  }
  if (typeof rule.radiusKm === "number" && rule.radiusKm > 0) {
    // '공고 기준점 없음'과 '지원자 좌표 없음'은 다른 상태다.
    //  · 공고 기준점 없음(좌표 없는 공고·공고 미전달) = 규칙 오설정 → 전원 차단(fail-closed).
    //    '미확인 포함'은 지원자 주소를 모르는 경우를 위한 스위치지, 오설정을 전원 통과로 뒤집는 스위치가 아니다.
    //  · 지원자 좌표 없음 → '미확인 포함'을 켠 규칙만 통과(조용한 탈락 방지).
    if (!jobSupportsRadius(ctx.job ?? null)) return false;
    const km = distanceToJobKm({ lat: a.lat, lng: a.lng }, ctx.job ?? null);
    if (km === null) {
      if (!rule.radiusIncludeUnknown) return false;
    } else if (km > rule.radiusKm) return false;
  }
  if (rule.suntopDone && !a.suntopDone) return false;
  if (typeof rule.cohortMonths === "number" && rule.cohortMonths > 0) {
    const ref = a.applied_at ?? a.created_at;
    if (!ref) return false;
    const t = new Date(ref).getTime();
    if (Number.isNaN(t) || t < nowMs - rule.cohortMonths * 30 * 24 * 60 * 60 * 1000) return false;
  }
  return true;
}

/** 유효 노출 판정 — exclude > include > 규칙. */
export function isExposed(
  a: ExposureApplicant,
  rule: ExposureRule | null,
  override: ExposureMode | undefined,
  ctx: ExposureContext
): boolean {
  if (override === "exclude") return false;
  if (override === "include") return true;
  return matchesRule(a, rule, ctx);
}

/**
 * 특정 지원자의 job별 수동 오버라이드 조회 — Map<job_id, mode>.
 * 에러는 던진다 — 조용한 빈 Map은 exclude 오버라이드를 무시해 'exclude 최우선' 불변식이
 * fail-open으로 깨진다. 호출부는 실패 시 targeted 공고를 숨기는 방향(fail-closed)으로 처리할 것.
 */
export async function fetchOverridesForApplicant(
  supabase: SupabaseClient,
  applicantId: number,
  jobIds: number[]
): Promise<Map<number, ExposureMode>> {
  const out = new Map<number, ExposureMode>();
  if (jobIds.length === 0) return out;
  const { data, error } = await supabase
    .from("job_exposure_targets")
    .select("job_id, mode")
    .eq("applicant_id", applicantId)
    .in("job_id", jobIds);
  if (error) throw new Error(`[exposure] overrides fetch failed: ${error.message}`);
  for (const r of data ?? []) {
    const row = r as { job_id: number; mode: ExposureMode };
    out.set(row.job_id, row.mode);
  }
  return out;
}

/** 지원자가 선탑 완료자인지(pool_events suntop_done 존재). */
export async function fetchSuntopDone(supabase: SupabaseClient, applicantId: number): Promise<boolean> {
  const { data } = await supabase
    .from("pool_events")
    .select("id")
    .eq("applicant_id", applicantId)
    .eq("event_type", "suntop_done")
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

/**
 * 선탑 완료자 applicant_id 전체 집합 — 규칙 미리보기·유효 명단의 배치 평가용.
 * 페이지네이션·정렬 필수(PostgREST 행 상한 절단 시 admin 판정이 pull 단건 판정과 어긋난다).
 * 에러는 던진다 — 조용한 빈 집합은 suntop 규칙 명단을 통째로 0으로 보이게 한다.
 */
export async function fetchSuntopDoneSet(supabase: SupabaseClient): Promise<Set<number>> {
  const out = new Set<number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("pool_events")
      .select("applicant_id")
      .eq("event_type", "suntop_done")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`[exposure] suntop set fetch failed: ${error.message}`);
    const batch = data ?? [];
    for (const r of batch) {
      const id = (r as { applicant_id: number | null }).applicant_id;
      if (typeof id === "number") out.add(id);
    }
    if (batch.length < 1000) break;
  }
  return out;
}

/**
 * **노출이 좁아질 때 명단에 남겨야 하는 사람**을 계산한다 — 노출 축소의 단일 공식.
 *
 * 왜: 노출 판정(isExposed)은 후보 여부도, 그 공고 문자를 받았는지도 보지 않는다.
 * 그래서 전체→지정 전환이나 규칙 축소로 이분들이 규칙에서 빠지면
 *  - 이야기 중인 공고가 본인 화면에서 사라지고(AI만 그 공고를 말하는 상태),
 *  - '새 배송 건이 올라왔어요! {공고명}' 문자를 받은 분이 링크를 열면 그 공고가 없다.
 * 좁히는 경로가 둘(파이프라인 일괄 배정 · 공고 수정 모달 저장)이라 여기 한 곳에 둔다.
 *
 * 두 소스:
 *  1) job_candidates — 이탈(abort)만 제외. stage가 NULL인 '관심만 누른 분'을 반드시 포함한다.
 *  2) pool_events ping_sent(purpose='new_job', meta.job_id=이 공고) — 그 공고 이름이 적힌 안내 문자 수신자.
 *     공고 무관 캠페인(purpose='campaign')은 job_id가 없어 걸리지 않는다(명단이 부풀지 않는다).
 *
 * 이미 오버라이드 행이 있는 사람은 건너뛴다 — 매니저가 명시적으로 제외한 사람을 되살리면 안 된다.
 */
export async function gatherExposureProtectTargets(
  supabase: SupabaseClient,
  jobIds: number[]
): Promise<{ linked: Map<number, Set<number>>; error?: string }> {
  const linked = new Map<number, Set<number>>();
  if (jobIds.length === 0) return { linked };
  const add = (jobId: number, applicantId: number) => {
    const s = linked.get(jobId) ?? new Set<number>();
    s.add(applicantId);
    linked.set(jobId, s);
  };

  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("job_candidates")
      .select("job_id, applicant_id")
      .in("job_id", jobIds)
      .or("agent_stage.is.null,agent_stage.neq.abort")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) return { linked, error: error.message };
    const batch = data ?? [];
    for (const r of batch) {
      const row = r as { job_id: number; applicant_id: number | null };
      if (typeof row.applicant_id === "number") add(row.job_id, row.applicant_id);
    }
    if (batch.length < 1000) break;
  }

  // 안내 문자 수신자. 공고 필터는 **JS에서** 한다 — meta의 job_id가 숫자/문자열 어느 쪽으로도
  // 들어올 수 있고, jsonb 경로를 in-필터로 쓰면 문법이 조용히 어긋나 0건이 될 위험이 있다.
  // 보호가 조용히 사라지는 것이 최악이라, 대상은 넓게 읽고 판정은 코드로 확실히 한다(건수는 안내 상한 200/공고로 작다).
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("pool_events")
      .select("applicant_id, meta")
      .eq("event_type", "ping_sent")
      .eq("meta->>purpose", "new_job")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) return { linked, error: error.message };
    const batch = data ?? [];
    for (const r of batch) {
      const row = r as { applicant_id: number | null; meta: { job_id?: number | string } | null };
      const jid = Number(row.meta?.job_id);
      if (typeof row.applicant_id === "number" && jobIds.includes(jid)) add(jid, row.applicant_id);
    }
    if (batch.length < 1000) break;
  }

  return { linked };
}

/**
 * gather 결과에서 **아직 오버라이드 행이 없는** 사람만 골라 insert할 행으로 만든다.
 * 이미 행이 있는 사람은 건너뛴다 — 매니저가 명시적으로 제외한 사람을 되살리면 안 된다.
 */
export async function collectExposureProtectRows(
  supabase: SupabaseClient,
  jobIds: number[]
): Promise<{ rows: { job_id: number; applicant_id: number; mode: string; added_by: string }[]; error?: string }> {
  const { linked, error: gatherErr } = await gatherExposureProtectTargets(supabase, jobIds);
  if (gatherErr) return { rows: [], error: gatherErr };
  if (linked.size === 0) return { rows: [] };

  const existing = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("job_exposure_targets")
      .select("job_id, applicant_id")
      .in("job_id", jobIds)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) return { rows: [], error: error.message };
    const batch = data ?? [];
    for (const r of batch) {
      const row = r as { job_id: number; applicant_id: number };
      existing.add(`${row.job_id}:${row.applicant_id}`);
    }
    if (batch.length < 1000) break;
  }

  const rows: { job_id: number; applicant_id: number; mode: string; added_by: string }[] = [];
  for (const [jobId, set] of linked) {
    for (const applicantId of set) {
      if (existing.has(`${jobId}:${applicantId}`)) continue;
      rows.push({ job_id: jobId, applicant_id: applicantId, mode: "include", added_by: "auto_linked" });
    }
  }
  return { rows };
}

/** 위 계산 + 쓰기까지. 기존 행은 보존(ignoreDuplicates) — 대상 계산과 쓰기 사이의 경합에서도 죽지 않는다. */
export async function writeExposureProtectRows(
  supabase: SupabaseClient,
  jobIds: number[]
): Promise<{ inserted: number; error?: string }> {
  const { rows, error } = await collectExposureProtectRows(supabase, jobIds);
  if (error) return { inserted: 0, error };
  if (rows.length === 0) return { inserted: 0 };
  const { error: insErr } = await supabase
    .from("job_exposure_targets")
    .upsert(rows, { onConflict: "job_id,applicant_id", ignoreDuplicates: true });
  if (insErr) return { inserted: 0, error: insErr.message };
  return { inserted: rows.length };
}

/**
 * 지정 노출 공고에 후보를 새로 붙일 때 그 인원을 노출 명단에 남긴다.
 *
 * 좁히는 시점의 보호(위)는 그 순간의 명단만 지킨다 — **전환 뒤에** 매니저가 후보를 추가하면
 * 다시 '지원자는 못 보는데 AI는 말하는' 상태가 된다. 그래서 후보를 만드는 쓰기 지점에서도 보장한다.
 * 전체 노출 공고는 그대로 전원에게 보이므로 아무것도 하지 않는다.
 */
export async function ensureExposureIncludeForLinked(
  supabase: SupabaseClient,
  jobId: number,
  applicantIds: number[]
): Promise<number> {
  if (applicantIds.length === 0) return 0;
  const { data: job, error } = await supabase
    .from("jobs")
    .select("exposure")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(`[exposure] linked include job load failed: ${error.message}`);
  if ((job as { exposure?: string } | null)?.exposure !== "targeted") return 0;
  const rows = applicantIds.map((aid) => ({
    job_id: jobId,
    applicant_id: aid,
    mode: "include",
    added_by: "auto_linked",
  }));
  // 기존 행 보존 — 매니저가 제외해둔 사람을 후보 추가로 되살리지 않는다.
  const { error: insErr } = await supabase
    .from("job_exposure_targets")
    .upsert(rows, { onConflict: "job_id,applicant_id", ignoreDuplicates: true });
  if (insErr) throw new Error(`[exposure] linked include failed: ${insErr.message}`);
  return rows.length;
}

/**
 * 규칙 평가용 지원자 전량 로드(id·name·sido·availability·applied_at·created_at + suntopDone 주입).
 * 페이지네이션·정렬 필수(PostgREST 행 상한/무정렬 누락 방지 — tms-sync 패턴).
 */
export async function fetchApplicantsForExposure(
  supabase: SupabaseClient
): Promise<(ExposureApplicant & { name: string | null })[]> {
  const suntop = await fetchSuntopDoneSet(supabase);
  const out: (ExposureApplicant & { name: string | null })[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("applicants")
      .select("id, name, sido, sigungu, availability, own_vehicle, work_hours, available_slots, lat, lng, applied_at, created_at")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`[exposure] applicants load failed: ${error.message}`);
    const batch = data ?? [];
    for (const r of batch) {
      const row = r as {
        id: number;
        name: string | null;
        sido: string | null;
        sigungu: string | null;
        availability: string | null;
        own_vehicle: string | null;
        work_hours: string | null;
        available_slots: string[] | null;
        lat: number | null;
        lng: number | null;
        applied_at: string | null;
        created_at: string | null;
      };
      out.push({ ...row, suntopDone: suntop.has(row.id) });
    }
    if (batch.length < 1000) break;
  }
  return out;
}
