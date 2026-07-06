/**
 * 긴급 건(sos_requests)·비용 원장(cost_ledger) 공용 상수.
 *
 * 키 값은 docs/migrations/2026-07-sos-cost-ledger.sql의 CHECK/관례와 1:1 대응 —
 * admin API(검증)와 SosLedgerCard(한글 라벨)가 함께 import한다.
 */

/** sos_requests.resolution CHECK 목록 → 한글 라벨 */
export const SOS_RESOLUTIONS = {
  internal_bench: "내부 벤치 투입",
  yongcha: "용차",
  self_cover: "팀원 직접 투입",
  external_hire: "외부 급구 채용",
  unresolved: "미해결 종결",
} as const;

export type SosResolution = keyof typeof SOS_RESOLUTIONS;

/** cost_ledger.category 관례(COST_CATEGORIES) → 한글 라벨 */
export const COST_CATEGORIES = {
  backup_labor: "백업인력 인건비",
  ads: "구인광고비",
  sla: "SLA 위약·환불·퀵비",
  education: "교육비",
  other: "기타",
} as const;

export type CostCategory = keyof typeof COST_CATEGORIES;

/** KST 기준 'YYYY-MM' — 서버(UTC)에서 자정~09:00가 전월로 밀리지 않게 +9h 보정 (lib/agent/usage.ts kstDay와 동일 규칙) */
export function kstMonth(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}
