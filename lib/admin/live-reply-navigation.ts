export type LiveReplySendResolutionKind =
  | "sent"
  | "sent_unrecorded"
  | "sent_followup_failed"
  | "unknown"
  | "failed"
  | "not_attempted";

export type LiveReplyManualTransitionKind = "context-change" | "detail-close";

export function liveReplyDeferredCompletionAfterManualTransition<T>(input: {
  deferredCompletion: T | null;
  transitionKind: LiveReplyManualTransitionKind;
}): T | null {
  return input.transitionKind === "detail-close" ? input.deferredCompletion : null;
}

export function nextLiveReplyApplicantId(
  orderedActionableIds: number[],
  currentApplicantId: number | null,
): number | null {
  if (orderedActionableIds.length === 0) return null;
  const currentIndex = currentApplicantId == null
    ? -1
    : orderedActionableIds.indexOf(currentApplicantId);
  if (currentIndex < 0) return orderedActionableIds[0] ?? null;
  if (orderedActionableIds.length === 1) return null;
  return orderedActionableIds[(currentIndex + 1) % orderedActionableIds.length] ?? null;
}

export function liveReplySelectionAfterCompletion(input: {
  orderedActionableIds: number[];
  selectedApplicantId: number | null;
  completedApplicantId: number;
}): { applicantId: number | null; applied: boolean; completedAll: boolean } {
  if (input.selectedApplicantId !== input.completedApplicantId) {
    return {
      applicantId: input.selectedApplicantId,
      applied: false,
      completedAll: false,
    };
  }
  if (!input.orderedActionableIds.includes(input.completedApplicantId)) {
    return {
      applicantId: input.selectedApplicantId,
      applied: false,
      completedAll: false,
    };
  }
  const applicantId = nextLiveReplyApplicantId(
    input.orderedActionableIds,
    input.completedApplicantId,
  );
  return {
    applicantId,
    applied: true,
    completedAll: applicantId == null,
  };
}

export function liveReplyCompletionContextIsCurrent(input: {
  collectionState: "loading" | "error" | "empty" | "ready";
  activeTab: string;
  currentContextKey: string;
  startedContextKey: string;
}): boolean {
  return input.collectionState === "ready"
    && input.activeTab === "all"
    && input.currentContextKey === input.startedContextKey;
}

export function liveReplyQueuePosition(
  orderedActionableIds: number[],
  currentApplicantId: number | null,
): { current: number; total: number } {
  const index = currentApplicantId == null
    ? -1
    : orderedActionableIds.indexOf(currentApplicantId);
  return {
    current: index < 0 ? 0 : index + 1,
    total: orderedActionableIds.length,
  };
}

export function shouldAdvanceLiveReplyAfterSend(input: {
  requested: boolean;
  resolutionKind: LiveReplySendResolutionKind;
  resumeRequired: boolean;
  resumeSucceeded: boolean;
  pauseOutcomeKind: "paused" | "ambiguous" | "changed" | "none" | "unknown";
}): boolean {
  if (!input.requested || input.resolutionKind !== "sent") return false;
  if (input.resumeRequired) return input.resumeSucceeded;
  return input.pauseOutcomeKind === "paused" || input.pauseOutcomeKind === "none";
}
