export type ApplyJobIntent =
  | { kind: "general" }
  | { kind: "job"; id: number }
  | { kind: "invalid" };

export type ApplyJobLoadState = "idle" | "loading" | "loaded" | "unavailable" | "error";

export function applyJobIntent(raw: string | null): ApplyJobIntent {
  if (raw === null) return { kind: "general" };
  if (!/^[1-9]\d*$/.test(raw)) return { kind: "invalid" };
  return { kind: "job", id: Number(raw) };
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
