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
  const strArr = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : undefined;
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

/** 특정 지원자의 job별 수동 오버라이드 조회 — Map<job_id, mode>. */
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
  if (error) {
    console.error("[exposure] overrides fetch failed", error);
    return out;
  }
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
