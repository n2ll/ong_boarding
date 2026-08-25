import assert from "node:assert/strict";
import test from "node:test";

type LiveReplyNavigationModule = {
  nextLiveReplyApplicantId?: (orderedActionableIds: number[], currentApplicantId: number | null) => number | null;
  liveReplySelectionAfterCompletion?: (input: {
    orderedActionableIds: number[];
    selectedApplicantId: number | null;
    completedApplicantId: number;
  }) => { applicantId: number | null; applied: boolean; completedAll: boolean };
  liveReplyQueuePosition?: (orderedActionableIds: number[], currentApplicantId: number | null) => {
    current: number;
    total: number;
  };
  shouldAdvanceLiveReplyAfterSend?: (input: {
    requested: boolean;
    resolutionKind: "sent" | "sent_unrecorded" | "sent_followup_failed" | "unknown" | "failed" | "not_attempted";
    resumeRequired: boolean;
    resumeSucceeded: boolean;
    pauseOutcomeKind: "paused" | "ambiguous" | "changed" | "none" | "unknown";
  }) => boolean;
  liveReplyCompletionContextIsCurrent?: (input: {
    collectionState: "loading" | "error" | "empty" | "ready";
    activeTab: string;
    currentContextKey: string;
    startedContextKey: string;
  }) => boolean;
  liveReplyDeferredCompletionAfterManualTransition?: <T>(input: {
    deferredCompletion: T | null;
    transitionKind: "context-change" | "detail-close";
  }) => T | null;
};

async function loadModule(): Promise<LiveReplyNavigationModule> {
  try {
    return await import(new URL("./live-reply-navigation.ts", import.meta.url).href) as LiveReplyNavigationModule;
  } catch {
    return {};
  }
}

test("reply completion continues with remaining work from any starting point", async () => {
  const { nextLiveReplyApplicantId } = await loadModule();

  assert.equal(typeof nextLiveReplyApplicantId, "function");
  assert.equal(nextLiveReplyApplicantId!([12, 8, 19], 12), 8);
  assert.equal(nextLiveReplyApplicantId!([12, 8, 19], 8), 19);
  assert.equal(nextLiveReplyApplicantId!([12, 8, 19], 19), 12);
  assert.equal(nextLiveReplyApplicantId!([12, 8, 19], 99), 12);
  assert.equal(nextLiveReplyApplicantId!([12], 12), null);
  assert.equal(nextLiveReplyApplicantId!([], 12), null);
});

test("reply completion advances from an already removed current row but preserves a changed selection", async () => {
  const { liveReplySelectionAfterCompletion } = await loadModule();

  assert.equal(typeof liveReplySelectionAfterCompletion, "function");
  assert.deepEqual(liveReplySelectionAfterCompletion!({
    orderedActionableIds: [12, 8, 19],
    selectedApplicantId: 8,
    completedApplicantId: 12,
  }), { applicantId: 8, applied: false, completedAll: false });
  assert.deepEqual(liveReplySelectionAfterCompletion!({
    orderedActionableIds: [8, 19],
    selectedApplicantId: 12,
    completedApplicantId: 12,
  }), { applicantId: 8, applied: true, completedAll: false });
  assert.deepEqual(liveReplySelectionAfterCompletion!({
    orderedActionableIds: [],
    selectedApplicantId: 12,
    completedApplicantId: 12,
  }), { applicantId: null, applied: true, completedAll: true });
  assert.deepEqual(liveReplySelectionAfterCompletion!({
    orderedActionableIds: [12, 8, 19],
    selectedApplicantId: 19,
    completedApplicantId: 19,
  }), { applicantId: 12, applied: true, completedAll: false });
  assert.deepEqual(liveReplySelectionAfterCompletion!({
    orderedActionableIds: [12],
    selectedApplicantId: 12,
    completedApplicantId: 12,
  }), { applicantId: null, applied: true, completedAll: true });
});

test("a stale reply completion is ignored while the live collection is unavailable", async () => {
  const { liveReplyCompletionContextIsCurrent } = await loadModule();

  assert.equal(typeof liveReplyCompletionContextIsCurrent, "function");
  assert.equal(liveReplyCompletionContextIsCurrent!({
    collectionState: "error",
    activeTab: "all",
    currentContextKey: "all:",
    startedContextKey: "all:",
  }), false);
  assert.equal(liveReplyCompletionContextIsCurrent!({
    collectionState: "ready",
    activeTab: "all",
    currentContextKey: "all:",
    startedContextKey: "all:",
  }), true);
  assert.equal(liveReplyCompletionContextIsCurrent!({
    collectionState: "ready",
    activeTab: "intervention",
    currentContextKey: "intervention:",
    startedContextKey: "all:",
  }), false);
});

test("reply queue position is human-readable and excludes passive conversations", async () => {
  const { liveReplyQueuePosition } = await loadModule();

  assert.equal(typeof liveReplyQueuePosition, "function");
  assert.deepEqual(liveReplyQueuePosition!([12, 8, 19], 8), { current: 2, total: 3 });
  assert.deepEqual(liveReplyQueuePosition!([12, 8, 19], 99), { current: 0, total: 3 });
  assert.deepEqual(liveReplyQueuePosition!([], null), { current: 0, total: 0 });
});

test("only a fully recorded send may advance the reply queue", async () => {
  const { shouldAdvanceLiveReplyAfterSend } = await loadModule();

  assert.equal(typeof shouldAdvanceLiveReplyAfterSend, "function");
  assert.equal(shouldAdvanceLiveReplyAfterSend!({ requested: true, resolutionKind: "sent", resumeRequired: false, resumeSucceeded: false, pauseOutcomeKind: "paused" }), true);
  assert.equal(shouldAdvanceLiveReplyAfterSend!({ requested: true, resolutionKind: "sent", resumeRequired: false, resumeSucceeded: false, pauseOutcomeKind: "none" }), true);
  assert.equal(shouldAdvanceLiveReplyAfterSend!({ requested: false, resolutionKind: "sent", resumeRequired: false, resumeSucceeded: false, pauseOutcomeKind: "paused" }), false);

  for (const resolutionKind of ["sent_unrecorded", "sent_followup_failed", "unknown", "failed", "not_attempted"] as const) {
    assert.equal(shouldAdvanceLiveReplyAfterSend!({ requested: true, resolutionKind, resumeRequired: false, resumeSucceeded: false, pauseOutcomeKind: "paused" }), false);
  }
  for (const pauseOutcomeKind of ["ambiguous", "changed", "unknown"] as const) {
    assert.equal(shouldAdvanceLiveReplyAfterSend!({ requested: true, resolutionKind: "sent", resumeRequired: false, resumeSucceeded: false, pauseOutcomeKind }), false);
  }
});

test("send-and-resume advances only after both operations succeed", async () => {
  const { shouldAdvanceLiveReplyAfterSend } = await loadModule();

  assert.equal(typeof shouldAdvanceLiveReplyAfterSend, "function");
  assert.equal(shouldAdvanceLiveReplyAfterSend!({ requested: true, resolutionKind: "sent", resumeRequired: true, resumeSucceeded: false, pauseOutcomeKind: "unknown" }), false);
  assert.equal(shouldAdvanceLiveReplyAfterSend!({ requested: true, resolutionKind: "sent", resumeRequired: true, resumeSucceeded: true, pauseOutcomeKind: "unknown" }), true);
});

test("closing only the applicant detail preserves a deferred reply completion", async () => {
  const { liveReplyDeferredCompletionAfterManualTransition } = await loadModule();
  const deferred = { applicantId: 42, contextKey: "all:" };

  assert.equal(typeof liveReplyDeferredCompletionAfterManualTransition, "function");
  assert.equal(liveReplyDeferredCompletionAfterManualTransition!({
    deferredCompletion: deferred,
    transitionKind: "detail-close",
  }), deferred);
  assert.equal(liveReplyDeferredCompletionAfterManualTransition!({
    deferredCompletion: deferred,
    transitionKind: "context-change",
  }), null);
});
