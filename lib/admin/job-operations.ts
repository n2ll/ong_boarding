export type JobOperationInput = {
  effectivelyClosed: boolean;
  capacity: number;
  confirmed: number;
  waiting: number;
  paused: number;
  reviewReady: number;
  inProgress: number;
};

export type JobOperationTone = "success" | "danger" | "warning" | "info" | "muted";

export type JobOperationMeta = {
  remaining: number | null;
  fillPercent: number | null;
  attention: number;
  nextAction: {
    label: string;
    description: string;
    tone: JobOperationTone;
  };
};

export function isReviewReadyCandidate(stage: string | null, applicantStatus: string | null): boolean {
  return (stage === "onboarding" || stage === "active") && applicantStatus !== "확정인력";
}

export function jobCandidateBoardPolicy(effectivelyClosed: boolean) {
  return effectivelyClosed
    ? {
        readOnly: true,
        label: "마감 공고 · 조회만 가능",
        allowDispatch: false,
        allowCandidateMutation: false,
      }
    : {
        readOnly: false,
        label: null,
        allowDispatch: true,
        allowCandidateMutation: true,
      };
}

export function jobOperationMeta(input: JobOperationInput): JobOperationMeta {
  const capacity = Math.max(0, input.capacity);
  const confirmed = Math.max(0, input.confirmed);
  const waiting = Math.max(0, input.waiting);
  const paused = Math.max(0, input.paused);
  const attention = waiting + paused;
  const remaining = capacity > 0 ? Math.max(0, capacity - confirmed) : null;
  const fillPercent = capacity > 0 ? Math.min(100, Math.round((confirmed / capacity) * 100)) : null;

  if (input.effectivelyClosed) {
    return {
      remaining,
      fillPercent,
      attention,
      nextAction: {
        label: "마감됨",
        description: "필요하면 공고를 다시 열어 후보 관리를 재개하세요",
        tone: "muted",
      },
    };
  }

  if (capacity === 0) {
    return {
      remaining,
      fillPercent,
      attention,
      nextAction: {
        label: "정원 설정 필요",
        description: "충원 상태를 판단하려면 모집 인원을 입력하세요",
        tone: "warning",
      },
    };
  }

  if (confirmed >= capacity) {
    return {
      remaining,
      fillPercent,
      attention,
      nextAction: {
        label: "충원 완료",
        description: `정원 ${capacity}명 충원 · 공고 마감 검토`,
        tone: "success",
      },
    };
  }

  if (attention > 0) {
    const parts = [
      paused > 0 ? `수동 응대 ${paused}명` : null,
      waiting > 0 ? `응대 시작 전 ${waiting}명` : null,
    ].filter(Boolean);
    return {
      remaining,
      fillPercent,
      attention,
      nextAction: {
        label: `사람 확인 ${attention}명`,
        description: parts.join(" · "),
        tone: paused > 0 ? "danger" : "warning",
      },
    };
  }

  if (input.reviewReady > 0) {
    return {
      remaining,
      fillPercent,
      attention,
      nextAction: {
        label: `후보 검토 ${input.reviewReady}명`,
        description: "스크리닝 완료 · 확정 여부는 매니저 판단",
        tone: "info",
      },
    };
  }

  if (input.inProgress > 0) {
    return {
      remaining,
      fillPercent,
      attention,
      nextAction: {
        label: `AI 응대 ${input.inProgress}명`,
        description: "자동 응대 진행 중 · 완료 후 매니저가 검토",
        tone: "info",
      },
    };
  }

  return {
    remaining,
    fillPercent,
    attention,
    nextAction: {
      label: "후보 모집 필요",
      description: `남은 정원 ${remaining ?? capacity}명 · 후보를 연결하세요`,
      tone: "muted",
    },
  };
}

export function jobOperationsSummary(jobs: JobOperationInput[]) {
  return jobs.reduce(
    (summary, job) => {
      if (job.effectivelyClosed) return summary;
      summary.openJobs += 1;
      summary.attention += Math.max(0, job.waiting) + Math.max(0, job.paused);
      summary.reviewReady += Math.max(0, job.reviewReady);
      if (job.capacity > 0) summary.remaining += Math.max(0, job.capacity - job.confirmed);
      else summary.unconfiguredCapacity += 1;
      return summary;
    },
    { openJobs: 0, remaining: 0, unconfiguredCapacity: 0, attention: 0, reviewReady: 0 },
  );
}
