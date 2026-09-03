export function jobTrackingSubmissionLabel(count: number | null): string {
  return count === null
    ? "추적 링크 지원 확인 불가"
    : `추적 링크 지원 ${count}건`;
}
