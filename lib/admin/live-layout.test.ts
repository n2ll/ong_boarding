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

test("a global stop takes precedence over draft mode in the compact status notice", async () => {
  const layout = await loadLiveLayoutModule();
  const liveModeNotice = layout.liveModeNotice as
    | ((globalKill: boolean, copilotMode: boolean) => "off" | "draft" | null)
    | undefined;

  assert.equal(typeof liveModeNotice, "function");
  assert.equal(liveModeNotice!(true, true), "off");
  assert.equal(liveModeNotice!(false, true), "draft");
  assert.equal(liveModeNotice!(false, false), null);
});
