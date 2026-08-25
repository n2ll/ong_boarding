import type { RemoteCollectionState } from "./remote-data-state";
import type { AdminAgentModeView } from "./agent-mode-view";

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
  view: AdminAgentModeView,
): "loading" | "error" | "stale" | "off" | "draft" | null {
  if (view.state === "loading" || view.state === "error" || view.state === "stale") return view.state;
  if (view.mode === "off") return "off";
  if (view.mode === "draft") return "draft";
  return null;
}
