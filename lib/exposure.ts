import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * J · 타겟 공고 노출 — 규칙 매처 + 유효 노출 판정 (파이프라인 필터 의미와 단일 소스).
 *
 * 유효 노출(지정 노출 공고 J, 지원자 A):
 *   exclude 있으면 제외 → include 있으면 노출 → 규칙 매칭이면 노출 → 아니면 제외.
 * 전체 노출(all) 공고는 이 판정을 거치지 않고 항상 노출(호출부에서 분기).
 */

// 자동 노출 규칙 — 파이프라인 필터 스키마 재사용(지역·가용성·선탑완료·코호트).
export interface ExposureRule {
  sido?: string[]; // 시도(지역) 화이트리스트
  availability?: string[]; // 가용성 값 화이트리스트
  suntopDone?: boolean; // 선탑 완료자만
  cohortMonths?: number; // 원지원(없으면 등록)일이 최근 N개월 이내
}

// 규칙 평가에 필요한 applicant 필드(부분).
export interface ExposureApplicant {
  id: number;
  sido: string | null;
  availability: string | null;
  applied_at: string | null;
  created_at: string | null;
  suntopDone?: boolean; // pool_events(suntop_done)에서 계산해 주입
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
  const availability = strArr(r.availability);
  if (sido && sido.length) out.sido = sido;
  if (availability && availability.length) out.availability = availability;
  if (r.suntopDone === true) out.suntopDone = true;
  if (typeof r.cohortMonths === "number" && r.cohortMonths > 0 && r.cohortMonths <= 120) {
    out.cohortMonths = Math.floor(r.cohortMonths);
  }
  return Object.keys(out).length ? out : null;
}

/** applicant가 규칙에 매칭되나. 규칙 없으면 false(자동 노출 없음). nowMs 주입 가능(테스트/일관성). */
export function matchesRule(a: ExposureApplicant, rule: ExposureRule | null, nowMs: number = Date.now()): boolean {
  if (!rule) return false;
  if (rule.sido && rule.sido.length) {
    if (!a.sido || !rule.sido.includes(a.sido)) return false;
  }
  if (rule.availability && rule.availability.length) {
    if (!a.availability || !rule.availability.includes(a.availability)) return false;
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
  nowMs: number = Date.now()
): boolean {
  if (override === "exclude") return false;
  if (override === "include") return true;
  return matchesRule(a, rule, nowMs);
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
      .select("id, name, sido, availability, applied_at, created_at")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`[exposure] applicants load failed: ${error.message}`);
    const batch = data ?? [];
    for (const r of batch) {
      const row = r as {
        id: number;
        name: string | null;
        sido: string | null;
        availability: string | null;
        applied_at: string | null;
        created_at: string | null;
      };
      out.push({ ...row, suntopDone: suntop.has(row.id) });
    }
    if (batch.length < 1000) break;
  }
  return out;
}
