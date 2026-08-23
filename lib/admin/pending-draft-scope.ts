export interface JobScopedPendingDraft {
  job_id: number | null;
}

/** 전체 대화와 공고 미지정 초안 탭이 같은 null jobId를 쓰더라도 초안 범위는 분리한다. */
export function pendingDraftMatchesScope(
  draftJobId: number | null,
  requestedJobId: number | null,
  draftScope: "all" | "unscoped" = "all",
): boolean {
  if (requestedJobId !== null) return draftJobId === requestedJobId;
  if (draftScope === "unscoped") return draftJobId === null;
  return true;
}

/** 최신순 초안 중 현재 공고와 정확히 결속된 첫 건만 고른다. */
export function selectPendingDraftForJob<TDraft extends JobScopedPendingDraft>(
  orderedDrafts: TDraft[],
  requestedJobId: number | null,
): TDraft | null {
  return orderedDrafts.find((draft) => (
    pendingDraftMatchesScope(draft.job_id, requestedJobId)
  )) ?? null;
}
