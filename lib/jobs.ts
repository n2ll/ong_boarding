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
