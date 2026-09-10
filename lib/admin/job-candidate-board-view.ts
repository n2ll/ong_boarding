import { getHandoffDisposition, type HandoffDispositionInput } from "./handoff-disposition.ts";

type CandidateStage = { agent_stage: string | null } & Pick<HandoffDispositionInput, "paused_reason" | "agent_state">;

const STAGE_ORDER = ["unstarted", "exploration", "screening", "onboarding", "active", "paused", "paused_held", "paused_resolved", "abort"];

/** 조회용 그룹만 구분한다. 처리 완료 뒤에도 실제 agent_stage='paused'는 유지한다. */
export function jobCandidateBoardStage(candidate: CandidateStage, jobTitle?: string): string {
  if (candidate.agent_stage !== "paused") return candidate.agent_stage ?? "unstarted";
  const disposition = getHandoffDisposition({ ...candidate, job_title: jobTitle });
  if (disposition.state === "resolved") return "paused_resolved";
  if (disposition.state === "intentional_pause") return "paused_held";
  return "paused";
}

/** 연결·단계 초기화는 지원 또는 관심 클릭의 증거가 아니다. */
export function jobCandidateBoardView<T extends CandidateStage>(
  candidates: T[],
  interestCount?: number | null,
  jobTitle?: string,
) {
  return {
    linkedCount: candidates.length,
    interestCount: interestCount ?? null,
    groups: STAGE_ORDER
      .map((stage) => ({
        stage,
        items: candidates.filter((candidate) => jobCandidateBoardStage(candidate, jobTitle) === stage),
      }))
      .filter((group) => group.items.length > 0),
  };
}
