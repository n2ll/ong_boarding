import assert from "node:assert/strict";
import test from "node:test";

type ApplicationServerReplayPlan =
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

type ApplicationServerReplayModule = {
  applicationServerReplayPlan?: (input: {
    acceptedReplay: boolean;
    storedFilterPass: string | null;
    sameAttemptApplicant: boolean;
  }) => ApplicationServerReplayPlan;
  applicationReplayCandidateOutcome?: (input: {
    found: boolean;
    agentStage: string | null;
    closedAt: string | null;
    closedReason: string | null;
    candidateCreatedAt: string | null;
    submissionMappedAt: string | null;
    sameAttemptApplicant: boolean;
  }) => "linked" | "already_linked" | "unchanged_closed" | null;
};

async function loadModule(): Promise<ApplicationServerReplayModule> {
  try {
    return await import(new URL("./application-server-replay.ts", import.meta.url).href) as ApplicationServerReplayModule;
  } catch {
    return {};
  }
}

test("an accepted exact replay skips mutable job preflight and applicant persistence", async () => {
  const { applicationServerReplayPlan } = await loadModule();

  assert.equal(typeof applicationServerReplayPlan, "function");
  assert.deepEqual(applicationServerReplayPlan!({
    acceptedReplay: true,
    storedFilterPass: "Y",
    sameAttemptApplicant: true,
  }), {
    kind: "accepted_replay",
    requiresJobPreflight: false,
    persistsApplicant: false,
    filterPass: true,
    repairsMissingSideEffects: true,
  });
});

test("an accepted replay preserves a stored rejection instead of recomputing it", async () => {
  const { applicationServerReplayPlan } = await loadModule();

  assert.equal(typeof applicationServerReplayPlan, "function");
  assert.deepEqual(applicationServerReplayPlan!({
    acceptedReplay: true,
    storedFilterPass: "N",
    sameAttemptApplicant: true,
  }), {
    kind: "accepted_replay",
    requiresJobPreflight: false,
    persistsApplicant: false,
    filterPass: false,
    repairsMissingSideEffects: true,
  });
});

test("a new submission retains current job preflight and applicant persistence", async () => {
  const { applicationServerReplayPlan } = await loadModule();

  assert.equal(typeof applicationServerReplayPlan, "function");
  assert.deepEqual(applicationServerReplayPlan!({
    acceptedReplay: false,
    storedFilterPass: null,
    sameAttemptApplicant: false,
  }), {
    kind: "new_submission",
    requiresJobPreflight: true,
    persistsApplicant: true,
    filterPass: null,
    repairsMissingSideEffects: true,
  });
});

test("a replay mapped to an applicant now owned by a newer attempt does not invent missing side effects", async () => {
  const { applicationServerReplayPlan } = await loadModule();

  assert.equal(typeof applicationServerReplayPlan, "function");
  assert.deepEqual(applicationServerReplayPlan!({
    acceptedReplay: true,
    storedFilterPass: "Y",
    sameAttemptApplicant: false,
  }), {
    kind: "accepted_replay",
    requiresJobPreflight: false,
    persistsApplicant: false,
    filterPass: null,
    repairsMissingSideEffects: false,
  });
});

test("an accepted replay preserves linked when the same submission created the candidate", async () => {
  const { applicationReplayCandidateOutcome } = await loadModule();

  assert.equal(typeof applicationReplayCandidateOutcome, "function");
  assert.equal(applicationReplayCandidateOutcome!({
    found: true,
    agentStage: "screening",
    closedAt: null,
    closedReason: null,
    candidateCreatedAt: "2026-08-25T00:00:01.000Z",
    submissionMappedAt: "2026-08-25T00:00:00.000Z",
    sameAttemptApplicant: true,
  }), "linked");
});

test("an accepted replay keeps linked after the same submission candidate is later closed", async () => {
  const { applicationReplayCandidateOutcome } = await loadModule();

  assert.equal(typeof applicationReplayCandidateOutcome, "function");
  assert.equal(applicationReplayCandidateOutcome!({
    found: true,
    agentStage: "abort",
    closedAt: "2026-08-25T00:00:00.000Z",
    closedReason: "auto: 자동 필터 부적합",
    candidateCreatedAt: "2026-08-25T00:00:01.000Z",
    submissionMappedAt: "2026-08-25T00:00:00.000Z",
    sameAttemptApplicant: true,
  }), "linked");
  assert.equal(applicationReplayCandidateOutcome!({
    found: true,
    agentStage: "abort",
    closedAt: "2026-08-25T00:00:00.000Z",
    closedReason: "manager: 모집 종료",
    candidateCreatedAt: "2026-08-25T00:00:01.000Z",
    submissionMappedAt: "2026-08-25T00:00:00.000Z",
    sameAttemptApplicant: true,
  }), "linked");
  assert.equal(applicationReplayCandidateOutcome!({
    found: true,
    agentStage: "abort",
    closedAt: "2026-08-24T00:00:00.000Z",
    closedReason: "auto: 자동 필터 부적합",
    candidateCreatedAt: "2026-08-24T00:00:00.000Z",
    submissionMappedAt: "2026-08-25T00:00:00.000Z",
    sameAttemptApplicant: true,
  }), "unchanged_closed");
  assert.equal(applicationReplayCandidateOutcome!({
    found: true,
    agentStage: "abort",
    closedAt: "2026-08-26T00:00:00.000Z",
    closedReason: "auto: 자동 필터 부적합",
    candidateCreatedAt: "2026-08-26T00:00:00.000Z",
    submissionMappedAt: "2026-08-25T00:00:00.000Z",
    sameAttemptApplicant: false,
  }), "unchanged_closed");
  assert.equal(applicationReplayCandidateOutcome!({
    found: false,
    agentStage: null,
    closedAt: null,
    closedReason: null,
    candidateCreatedAt: null,
    submissionMappedAt: null,
    sameAttemptApplicant: true,
  }), null);
});
