export type ApplyJobIntent =
  | { kind: "general" }
  | { kind: "job"; id: number }
  | { kind: "invalid" };

export type ApplyJobLoadState = "idle" | "loading" | "loaded" | "unavailable" | "error";

export const APPLICATION_WORK_HOUR_OPTIONS = [
  { key: "평일오전", label: "평일 오전", sub: "월~금 09:00 ~ 14:00", value: "평일(월~금) 오전 타임 (09:00 ~ 14:00)" },
  { key: "평일오후", label: "평일 오후", sub: "월~금 12:00 ~ 17:00", value: "평일(월~금) 오후 타임 (12:00 ~ 17:00)" },
  { key: "주말오전", label: "주말 오전", sub: "토~일 09:00 ~ 14:00", value: "주말(토~일) 오전 타임 (09:00 ~ 14:00)" },
  { key: "주말오후", label: "주말 오후", sub: "토~일 12:00 ~ 17:00", value: "주말(토~일) 오후 타임 (12:00 ~ 17:00)" },
] as const;

export type ApplicationWorkHourKey = typeof APPLICATION_WORK_HOUR_OPTIONS[number]["key"];

export function applicationWorkHourOption(key: unknown) {
  return APPLICATION_WORK_HOUR_OPTIONS.find((option) => option.key === key) ?? null;
}

export function applicationFixedWorkHourKey(input: {
  slot: unknown;
  slotKeys: unknown;
}): ApplicationWorkHourKey | null {
  if (input.slotKeys !== null && input.slotKeys !== undefined) {
    if (!Array.isArray(input.slotKeys)) return null;
    if (input.slotKeys.length > 0) {
      if (input.slotKeys.length !== 1) return null;
      return applicationWorkHourOption(input.slotKeys[0])?.key ?? null;
    }
  }

  const legacySlot = typeof input.slot === "string" ? input.slot.trim() : null;
  return applicationWorkHourOption(legacySlot)?.key ?? null;
}

export function applicationFixedWorkHour(input: {
  slot: unknown;
  slotKeys: unknown;
}): { key: ApplicationWorkHourKey; display: string } | null {
  const key = applicationFixedWorkHourKey(input);
  const option = applicationWorkHourOption(key);
  if (!option) return null;

  const slot = typeof input.slot === "string" ? input.slot.trim() : "";
  return {
    key: option.key,
    display: slot && !applicationWorkHourOption(slot) ? slot : option.label,
  };
}

export function applicationFixedWorkHours(
  current: string[],
  fixedKey: ApplicationWorkHourKey | null,
): string[] {
  const fixedValue = applicationWorkHourOption(fixedKey)?.value;
  if (!fixedValue || (current.length === 1 && current[0] === fixedValue)) return current;
  return [fixedValue];
}

export type ApplyJobLookup<T> =
  | { kind: "found"; job: T }
  | { kind: "missing"; status: 404 }
  | { kind: "retryable"; status: 503 };

export function classifyApplyJobLookup<T>(job: T | null, error: unknown): ApplyJobLookup<T> {
  if (error) return { kind: "retryable", status: 503 };
  if (!job) return { kind: "missing", status: 404 };
  return { kind: "found", job };
}

export function applyJobLoadErrorDescription(timedOut: boolean): string {
  return timedOut
    ? "확인 시간이 길어지고 있어요. 잠시 후 다시 불러오거나 공고 없이 일반 지원서를 작성할 수 있어요."
    : "잠시 후 다시 불러와주세요. 계속되지 않으면 받으신 문자에 답장해 알려주세요.";
}

export function applyJobIntent(raw: string | null): ApplyJobIntent {
  if (raw === null) return { kind: "general" };
  if (!/^[1-9]\d*$/.test(raw)) return { kind: "invalid" };
  const id = Number(raw);
  return Number.isSafeInteger(id) ? { kind: "job", id } : { kind: "invalid" };
}

export function shouldShowApplyForm(input: {
  intent: ApplyJobIntent;
  loadState: ApplyJobLoadState;
  recruiting: boolean | null;
  generalOptIn: boolean;
}): boolean {
  if (input.intent.kind === "general" || input.generalOptIn) return true;
  return input.loadState === "loaded" && input.recruiting === true;
}

export function applySubmissionJobContext(input: {
  verifiedJobId: number | null;
  recruiting: boolean;
  vehicleRequired: boolean;
  generalOptIn: boolean;
}): { jobId: number | null; vehicleRequired: boolean } {
  if (input.generalOptIn || !input.recruiting || input.verifiedJobId === null) {
    return { jobId: null, vehicleRequired: true };
  }
  return {
    jobId: input.verifiedJobId,
    vehicleRequired: input.vehicleRequired,
  };
}

export function isApplicationBranchContextReady(input: {
  intent: ApplyJobIntent;
  generalOptIn: boolean;
  jobLoadState: ApplyJobLoadState;
  jobBranchContextActive: boolean;
  branchLookupRequired: boolean;
  branchListLoadState: ApplyJobLoadState;
}): boolean {
  if (!input.generalOptIn && input.intent.kind === "job") {
    return input.jobLoadState === "loaded" && input.jobBranchContextActive;
  }
  if (!input.generalOptIn && input.intent.kind === "invalid") return false;
  return !input.branchLookupRequired || input.branchListLoadState === "loaded";
}
