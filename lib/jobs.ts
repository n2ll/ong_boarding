/**
 * 공고 상태 공용 헬퍼.
 *
 * 마감시각(closes_at)이 지난 공고는 status가 'active'로 남아 있어도 실질적으로 마감이다.
 * status와 closes_at을 각자 해석하면 목록 배지·AI 배지·통계·dispatch·interest 가드가 서로
 * 모순된다("진행 중" 배지 + "마감됨" 텍스트, 마감 공고에 발송 허용 등). 이 단일 판단으로 통일한다.
 *
 * ⚠️ pull(/p/[token])은 마감 후 3일 유예 카드 로직을 따로 두므로 여기서 판단하지 않는다.
 * (크론 자동 status 승격은 범위 밖 — 이 헬퍼는 표시/동작 일관성만 담당한다.)
 */

/** status가 active가 아니거나, closes_at이 과거면 실질 마감으로 본다. */
export function isJobEffectivelyClosed(
  status: string | null | undefined,
  closesAt: string | null | undefined
): boolean {
  if (status !== "active") return true;
  if (closesAt && new Date(closesAt).getTime() <= Date.now()) return true;
  return false;
}

/**
 * 시스템 예약 프리픽스.
 *
 * `__danggeun_system__`·`__baemin_system__` 등 인입 라우터가 쓰는 더미 공고는 제목이 `__`로 시작한다.
 * 이 프리픽스로 시작하는 공고는 매니저 목록·pull(/p/[token])·검색에서 숨겨진다. 판정이 클라·서버·pull에
 * 제각각(startsWith·neq·like)이면 "등록됐는데 목록에서 사라지는" 혼란이 생기므로 이 헬퍼로 단일화한다.
 */
export const SYSTEM_JOB_TITLE_PREFIX = "__";

/** 제목이 시스템 예약 프리픽스(`__`)로 시작하면 시스템 공고로 본다(목록·pull·검색에서 숨김 대상). */
export function isSystemJobTitle(title: string | null | undefined): boolean {
  return typeof title === "string" && title.startsWith(SYSTEM_JOB_TITLE_PREFIX);
}

/** 사용자 입력 제목에서 앞쪽 `__`(및 연속된 언더스코어)를 제거한다 — 사용자가 실수로 넣은 예약 프리픽스 방어용. */
export function stripSystemPrefix(title: string): string {
  return title.replace(/^_+/, "");
}
