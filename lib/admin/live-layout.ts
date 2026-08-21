import type { RemoteCollectionState } from "./remote-data-state";

export type LiveQueueSummary = {
  kind: "loading" | "error" | "attention" | "clear";
  count: number | null;
};

export function liveQueueSummary(
  state: RemoteCollectionState,
  unansweredCount: number,
): LiveQueueSummary {
  if (state === "loading") return { kind: "loading", count: null };
  if (state === "error") return { kind: "error", count: null };
  if (unansweredCount > 0) return { kind: "attention", count: unansweredCount };
  return { kind: "clear", count: 0 };
}

export function liveModeNotice(
  globalKill: boolean,
  copilotMode: boolean,
): "off" | "draft" | null {
  if (globalKill) return "off";
  if (copilotMode) return "draft";
  return null;
}
