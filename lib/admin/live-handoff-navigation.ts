import type { LiveJobLink } from "@/lib/candidate-links";

export interface LiveHandoffFocusSource {
  applicant_id: number;
  job_id: number;
  job_title: string;
  paused_at: string | null;
}

export interface LiveHandoffFocus {
  applicantId: number;
  jobId: number;
  jobLink: LiveJobLink;
}

function liveHandoffFocus(handoff: LiveHandoffFocusSource): LiveHandoffFocus {
  return {
    applicantId: handoff.applicant_id,
    jobId: handoff.job_id,
    jobLink: {
      job_id: handoff.job_id,
      title: handoff.job_title,
      // 인계 API의 branch에는 지원자 지점이 섞일 수 있어 예외 탭은 공고명만 쓴다.
      branch: null,
      agent_stage: "paused",
      created_at: null,
      stage_updated_at: handoff.paused_at,
    },
  };
}

export function liveHandoffGroupFocus(
  groups: LiveHandoffFocusSource[][],
  applicantId: number | null,
): LiveHandoffFocus | null {
  if (applicantId == null) return null;
  const head = groups.find((items) => items[0]?.applicant_id === applicantId)?.[0];
  return head ? liveHandoffFocus(head) : null;
}
