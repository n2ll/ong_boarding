export type CandidateLinkOutcome =
  | "linked"
  | "already_linked"
  | "unchanged_closed"
  | "unavailable"
  | null;

export type FinalCandidateOutcome =
  | Exclude<CandidateLinkOutcome, null>
  | "failed"
  | "not_requested";

export type AcquisitionAttributionResult = "recorded" | "replay" | "failed";

export type ApplicationReplayAttributionPlan =
  | { kind: "repair" }
  | { kind: "invalid" }
  | {
      kind: "reuse";
      finalCandidateOutcome: FinalCandidateOutcome;
      candidateLinkOutcome: CandidateLinkOutcome;
    };

export type ApplicationCandidateFinalizationPlan =
  | { kind: "retry" }
  | { kind: "finalize"; outcome: FinalCandidateOutcome };

const FINAL_CANDIDATE_OUTCOMES = new Set<FinalCandidateOutcome>([
  "linked",
  "already_linked",
  "unchanged_closed",
  "unavailable",
  "failed",
  "not_requested",
]);

export function parseAcquisitionAttributionResult(
  value: unknown,
  submissionFingerprint: string,
): AcquisitionAttributionResult {
  if (typeof value !== "object" || value === null) return "failed";

  const result = value as Record<string, unknown>;
  if (
    typeof result.request_fingerprint !== "string"
    || result.request_fingerprint !== submissionFingerprint
  ) {
    return "failed";
  }

  return result.outcome === "recorded" || result.outcome === "replay"
    ? result.outcome
    : "failed";
}

export function finalCandidateOutcome(
  jobRequested: boolean,
  currentOutcome: CandidateLinkOutcome,
): FinalCandidateOutcome {
  if (currentOutcome !== null) return currentOutcome;
  return jobRequested ? "failed" : "not_requested";
}

export function applicationCandidateFinalizationPlan(
  jobRequested: boolean,
  currentOutcome: CandidateLinkOutcome,
): ApplicationCandidateFinalizationPlan {
  if (jobRequested && currentOutcome === null) return { kind: "retry" };
  return {
    kind: "finalize",
    outcome: finalCandidateOutcome(jobRequested, currentOutcome),
  };
}

export function applicationReplayAttributionPlan(input: {
  acceptedReplay: boolean;
  persisted: unknown;
  requestFingerprint: string;
  applicantId: number;
  jobRequested: boolean;
}): ApplicationReplayAttributionPlan {
  if (!input.acceptedReplay || input.persisted === null) return { kind: "repair" };
  if (typeof input.persisted !== "object") return { kind: "invalid" };

  const row = input.persisted as Record<string, unknown>;
  const outcome = row.candidate_link_outcome;
  if (
    row.request_fingerprint !== input.requestFingerprint
    || Number(row.applicant_id) !== input.applicantId
    || typeof outcome !== "string"
    || !FINAL_CANDIDATE_OUTCOMES.has(outcome as FinalCandidateOutcome)
    || (input.jobRequested ? outcome === "not_requested" : outcome !== "not_requested")
  ) {
    return { kind: "invalid" };
  }

  const finalOutcome = outcome as FinalCandidateOutcome;
  return {
    kind: "reuse",
    finalCandidateOutcome: finalOutcome,
    candidateLinkOutcome: finalOutcome === "failed" || finalOutcome === "not_requested"
      ? null
      : finalOutcome,
  };
}
