import assert from "node:assert/strict";
import test from "node:test";

type QueueSummary = {
  kind: "loading" | "error" | "attention" | "clear";
  count: number | null;
};

async function loadLiveLayoutModule(): Promise<Record<string, unknown>> {
  try {
    return await import(new URL("./live-layout.ts", import.meta.url).href) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("an unavailable conversation collection never presents a stale count as clear", async () => {
  const layout = await loadLiveLayoutModule();
  const liveQueueSummary = layout.liveQueueSummary as
    | ((state: "loading" | "error" | "empty" | "ready", unansweredCount: number) => QueueSummary)
    | undefined;

  assert.equal(typeof liveQueueSummary, "function");
  assert.deepEqual(liveQueueSummary!("error", 0), { kind: "error", count: null });
});

test("the queue summary distinguishes unknown, actionable, and completed work", async () => {
  const layout = await loadLiveLayoutModule();
  const liveQueueSummary = layout.liveQueueSummary as
    | ((state: "loading" | "error" | "empty" | "ready", unansweredCount: number) => QueueSummary)
    | undefined;

  assert.equal(typeof liveQueueSummary, "function");
  assert.deepEqual(liveQueueSummary!("loading", 4), { kind: "loading", count: null });
  assert.deepEqual(liveQueueSummary!("ready", 4), { kind: "attention", count: 4 });
  assert.deepEqual(liveQueueSummary!("empty", 0), { kind: "clear", count: 0 });
});

test("the compact AI notice distinguishes unknown, stale, stopped, and draft modes", async () => {
  const layout = await loadLiveLayoutModule();
  const liveModeNotice = layout.liveModeNotice as
    | ((view:
      | { state: "loading" | "error"; mode: null }
      | { state: "stale" | "ready"; mode: "auto" | "draft" | "off" }
    ) => "loading" | "error" | "stale" | "off" | "draft" | null)
    | undefined;

  assert.equal(typeof liveModeNotice, "function");
  assert.equal(liveModeNotice!({ state: "loading", mode: null }), "loading");
  assert.equal(liveModeNotice!({ state: "error", mode: null }), "error");
  assert.equal(liveModeNotice!({ state: "stale", mode: "auto" }), "stale");
  assert.equal(liveModeNotice!({ state: "stale", mode: "off" }), "stale");
  assert.equal(liveModeNotice!({ state: "ready", mode: "off" }), "off");
  assert.equal(liveModeNotice!({ state: "ready", mode: "draft" }), "draft");
  assert.equal(liveModeNotice!({ state: "ready", mode: "auto" }), null);
});
