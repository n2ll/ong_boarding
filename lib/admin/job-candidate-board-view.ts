type CandidateStage = { agent_stage: string | null };

const STAGE_ORDER = ["unstarted", "exploration", "screening", "onboarding", "active", "paused", "abort"];

/** 연결·단계 초기화는 지원 또는 관심 클릭의 증거가 아니다. */
export function jobCandidateBoardView<T extends CandidateStage>(
  candidates: T[],
  interestCount?: number | null,
) {
  return {
    linkedCount: candidates.length,
    interestCount: interestCount ?? null,
    groups: STAGE_ORDER
      .map((stage) => ({
        stage,
        items: candidates.filter((candidate) => (candidate.agent_stage ?? "unstarted") === stage),
      }))
      .filter((group) => group.items.length > 0),
  };
}
