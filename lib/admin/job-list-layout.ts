export type JobListSummaryInput = {
  openJobs: number;
  remaining: number;
  unconfiguredCapacity: number;
  attention: number;
  reviewReady: number;
};

export type JobListSummaryState = "ready" | "loading" | "error";

export type JobListSummaryItem = {
  key: "attention" | "reviewReady" | "remaining" | "openJobs";
  label: string;
  value: number | null;
  unit: "명" | "건";
  note: string;
  tone: "critical" | "screening" | "onboarding" | "active" | "neutral";
  unavailableReason: "loading" | "error" | null;
};

export function buildJobListSummary(
  input: JobListSummaryInput,
  state: JobListSummaryState,
): JobListSummaryItem[] {
  const unavailableReason = state === "ready" ? null : state;
  const value = (current: number) => unavailableReason ? null : current;
  const tone = <T extends Exclude<JobListSummaryItem["tone"], "neutral">>(
    current: number,
    activeTone: T,
  ): JobListSummaryItem["tone"] => current > 0 ? activeTone : "neutral";

  return [
    {
      key: "attention",
      label: "사람 확인",
      value: value(input.attention),
      unit: "명",
      note: "수동 응대 · 응대 시작 전",
      tone: tone(input.attention, "critical"),
      unavailableReason,
    },
    {
      key: "reviewReady",
      label: "후보 검토",
      value: value(input.reviewReady),
      unit: "명",
      note: "스크리닝 완료 · 매니저 판단 대기",
      tone: tone(input.reviewReady, "onboarding"),
      unavailableReason,
    },
    {
      key: "remaining",
      label: "남은 충원",
      value: value(input.remaining),
      unit: "명",
      note: input.unconfiguredCapacity > 0
        ? `정원 미설정 ${input.unconfiguredCapacity}건 별도`
        : "매니저 확정 기준",
      tone: tone(input.remaining, "screening"),
      unavailableReason,
    },
    {
      key: "openJobs",
      label: "진행 공고",
      value: value(input.openJobs),
      unit: "건",
      note: "현재 모집 · 응대 중",
      tone: tone(input.openJobs, "active"),
      unavailableReason,
    },
  ];
}
