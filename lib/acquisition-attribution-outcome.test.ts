import assert from "node:assert/strict";
import test from "node:test";

type CandidateLinkOutcome =
  | "linked"
  | "already_linked"
  | "unchanged_closed"
  | "unavailable"
  | null;

type FinalCandidateOutcome = Exclude<CandidateLinkOutcome, null> | "failed" | "not_requested";
type AcquisitionAttributionResult = "recorded" | "replay" | "failed";

type AcquisitionAttributionOutcomeModule = {
  parseAcquisitionAttributionResult?: (
    value: unknown,
    submissionFingerprint: string,
  ) => AcquisitionAttributionResult;
  finalCandidateOutcome?: (
    jobRequested: boolean,
    currentOutcome: CandidateLinkOutcome,
  ) => FinalCandidateOutcome;
  applicationReplayAttributionPlan?: (input: {
    acceptedReplay: boolean;
    persisted: unknown;
    requestFingerprint: string;
    applicantId: number;
    jobRequested: boolean;
  }) =>
    | { kind: "repair" }
    | { kind: "invalid" }
    | {
        kind: "reuse";
        finalCandidateOutcome: FinalCandidateOutcome;
        candidateLinkOutcome: CandidateLinkOutcome;
      };
  applicationCandidateFinalizationPlan?: (
    jobRequested: boolean,
    currentOutcome: CandidateLinkOutcome,
  ) =>
    | { kind: "retry" }
    | { kind: "finalize"; outcome: FinalCandidateOutcome };
};

async function loadModule(): Promise<AcquisitionAttributionOutcomeModule> {
  try {
    const modulePath = "./acquisition-attribution-outcome.ts";
    return await import(modulePath) as AcquisitionAttributionOutcomeModule;
  } catch {
    return {};
  }
}

test("recorded and replay results require the exact submission fingerprint", async () => {
  const { parseAcquisitionAttributionResult } = await loadModule();

  assert.equal(typeof parseAcquisitionAttributionResult, "function");
  assert.equal(parseAcquisitionAttributionResult!({
    outcome: "recorded",
    request_fingerprint: "submission-123",
  }, "submission-123"), "recorded");
  assert.equal(parseAcquisitionAttributionResult!({
    outcome: "replay",
    request_fingerprint: "submission-123",
  }, "submission-123"), "replay");
});

test("recorded and replay results fail closed when the submission fingerprint is absent or different", async () => {
  const { parseAcquisitionAttributionResult } = await loadModule();

  assert.equal(typeof parseAcquisitionAttributionResult, "function");
  assert.equal(parseAcquisitionAttributionResult!({
    outcome: "recorded",
    request_fingerprint: "another-submission",
  }, "submission-123"), "failed");
  assert.equal(parseAcquisitionAttributionResult!({
    outcome: "replay",
    request_fingerprint: null,
  }, "submission-123"), "failed");
  assert.equal(parseAcquisitionAttributionResult!({
    outcome: "recorded",
  }, "submission-123"), "failed");
});

test("conflict, missing, and error database outcomes all fail closed", async () => {
  const { parseAcquisitionAttributionResult } = await loadModule();

  assert.equal(typeof parseAcquisitionAttributionResult, "function");
  assert.equal(parseAcquisitionAttributionResult!({
    outcome: "conflict",
    request_fingerprint: "submission-123",
  }, "submission-123"), "failed");
  assert.equal(parseAcquisitionAttributionResult!({
    outcome: "missing",
    request_fingerprint: "submission-123",
  }, "submission-123"), "failed");
  assert.equal(parseAcquisitionAttributionResult!({
    outcome: "error",
    request_fingerprint: "submission-123",
  }, "submission-123"), "failed");
});

test("malformed database results fail closed", async () => {
  const { parseAcquisitionAttributionResult } = await loadModule();

  assert.equal(typeof parseAcquisitionAttributionResult, "function");
  assert.equal(parseAcquisitionAttributionResult!(null, "submission-123"), "failed");
  assert.equal(parseAcquisitionAttributionResult!({}, "submission-123"), "failed");
  assert.equal(parseAcquisitionAttributionResult!({
    outcome: "unknown",
    request_fingerprint: "submission-123",
  }, "submission-123"), "failed");
});

test("final candidate outcome preserves every explicit link result", async () => {
  const { finalCandidateOutcome } = await loadModule();

  assert.equal(typeof finalCandidateOutcome, "function");
  assert.equal(finalCandidateOutcome!(true, "linked"), "linked");
  assert.equal(finalCandidateOutcome!(true, "already_linked"), "already_linked");
  assert.equal(finalCandidateOutcome!(true, "unchanged_closed"), "unchanged_closed");
  assert.equal(finalCandidateOutcome!(true, "unavailable"), "unavailable");
});

test("a missing candidate result is failed when requested and not_requested otherwise", async () => {
  const { finalCandidateOutcome } = await loadModule();

  assert.equal(typeof finalCandidateOutcome, "function");
  assert.equal(finalCandidateOutcome!(true, null), "failed");
  assert.equal(finalCandidateOutcome!(false, null), "not_requested");
});

test("an accepted replay reuses its immutable finalized candidate outcome", async () => {
  const { applicationReplayAttributionPlan } = await loadModule();
  const fingerprint = "a".repeat(64);

  assert.equal(typeof applicationReplayAttributionPlan, "function");
  assert.deepEqual(applicationReplayAttributionPlan!({
    acceptedReplay: true,
    persisted: {
      request_fingerprint: fingerprint,
      applicant_id: 42,
      candidate_link_outcome: "unavailable",
    },
    requestFingerprint: fingerprint,
    applicantId: 42,
    jobRequested: true,
  }), {
    kind: "reuse",
    finalCandidateOutcome: "unavailable",
    candidateLinkOutcome: "unavailable",
  });
  assert.deepEqual(applicationReplayAttributionPlan!({
    acceptedReplay: true,
    persisted: {
      request_fingerprint: fingerprint,
      applicant_id: 42,
      candidate_link_outcome: "already_linked",
    },
    requestFingerprint: fingerprint,
    applicantId: 42,
    jobRequested: true,
  }), {
    kind: "reuse",
    finalCandidateOutcome: "already_linked",
    candidateLinkOutcome: "already_linked",
  });
  assert.deepEqual(applicationReplayAttributionPlan!({
    acceptedReplay: true,
    persisted: {
      request_fingerprint: fingerprint,
      applicant_id: 42,
      candidate_link_outcome: "failed",
    },
    requestFingerprint: fingerprint,
    applicantId: 42,
    jobRequested: true,
  }), {
    kind: "reuse",
    finalCandidateOutcome: "failed",
    candidateLinkOutcome: null,
  });
});

test("a replay only repairs a missing outcome and rejects mismatched durable data", async () => {
  const { applicationReplayAttributionPlan } = await loadModule();
  const fingerprint = "b".repeat(64);

  assert.equal(typeof applicationReplayAttributionPlan, "function");
  assert.deepEqual(applicationReplayAttributionPlan!({
    acceptedReplay: true,
    persisted: null,
    requestFingerprint: fingerprint,
    applicantId: 7,
    jobRequested: true,
  }), { kind: "repair" });
  assert.deepEqual(applicationReplayAttributionPlan!({
    acceptedReplay: true,
    persisted: {
      request_fingerprint: "c".repeat(64),
      applicant_id: 7,
      candidate_link_outcome: "linked",
    },
    requestFingerprint: fingerprint,
    applicantId: 7,
    jobRequested: true,
  }), { kind: "invalid" });
  assert.deepEqual(applicationReplayAttributionPlan!({
    acceptedReplay: true,
    persisted: {
      request_fingerprint: fingerprint,
      applicant_id: 7,
      candidate_link_outcome: "not_requested",
    },
    requestFingerprint: fingerprint,
    applicantId: 7,
    jobRequested: false,
  }), {
    kind: "reuse",
    finalCandidateOutcome: "not_requested",
    candidateLinkOutcome: null,
  });
});

test("a requested job with no candidate result stays retryable instead of finalizing failed", async () => {
  const { applicationCandidateFinalizationPlan } = await loadModule();

  assert.equal(typeof applicationCandidateFinalizationPlan, "function");
  assert.deepEqual(applicationCandidateFinalizationPlan!(true, null), { kind: "retry" });
  assert.deepEqual(applicationCandidateFinalizationPlan!(true, "linked"), {
    kind: "finalize",
    outcome: "linked",
  });
  assert.deepEqual(applicationCandidateFinalizationPlan!(false, null), {
    kind: "finalize",
    outcome: "not_requested",
  });
});
