export type ApplicationServerReplayPlan =
  | {
      kind: "accepted_replay";
      requiresJobPreflight: false;
      persistsApplicant: false;
      filterPass: boolean | null;
      repairsMissingSideEffects: boolean;
    }
  | {
      kind: "new_submission";
      requiresJobPreflight: true;
      persistsApplicant: true;
      filterPass: null;
      repairsMissingSideEffects: true;
    };

export function applicationServerReplayPlan(input: {
  acceptedReplay: boolean;
  storedFilterPass: string | null;
  sameAttemptApplicant: boolean;
}): ApplicationServerReplayPlan {
  if (input.acceptedReplay) {
    const hasStoredFilterOutcome = input.storedFilterPass === "Y" || input.storedFilterPass === "N";
    return {
      kind: "accepted_replay",
      requiresJobPreflight: false,
      persistsApplicant: false,
      filterPass: input.sameAttemptApplicant && hasStoredFilterOutcome
        ? input.storedFilterPass === "Y"
        : null,
      repairsMissingSideEffects: input.sameAttemptApplicant && hasStoredFilterOutcome,
    };
  }
  return {
    kind: "new_submission",
    requiresJobPreflight: true,
    persistsApplicant: true,
    filterPass: null,
    repairsMissingSideEffects: true,
  };
}

const ACTIVE_CANDIDATE_STAGES = new Set([
  "exploration",
  "screening",
  "onboarding",
  "active",
  "paused",
]);

export function applicationReplayCandidateOutcome(input: {
  found: boolean;
  agentStage: string | null;
  closedAt: string | null;
  closedReason: string | null;
  candidateCreatedAt: string | null;
  submissionMappedAt: string | null;
  sameAttemptApplicant: boolean;
}): "already_linked" | "unchanged_closed" | null {
  if (!input.found) return null;
  if (input.sameAttemptApplicant && input.closedReason === "auto: 자동 필터 부적합") {
    const candidateCreatedAt = Date.parse(input.candidateCreatedAt ?? "");
    const submissionMappedAt = Date.parse(input.submissionMappedAt ?? "");
    if (
      Number.isFinite(candidateCreatedAt)
      && Number.isFinite(submissionMappedAt)
      && candidateCreatedAt >= submissionMappedAt
    ) {
      return "already_linked";
    }
  }
  if (
    input.closedAt === null
    && input.closedReason === null
    && (input.agentStage === null || ACTIVE_CANDIDATE_STAGES.has(input.agentStage))
  ) {
    return "already_linked";
  }
  return "unchanged_closed";
}
