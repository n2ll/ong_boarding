import assert from "node:assert/strict";
import test from "node:test";

type QueuePriority = "unanswered" | "draft" | "send_attention" | "awaiting" | "rest";

type QueueItem = {
  id: string;
  priority: QueuePriority;
  activityAt: string | null;
};

type LiveQueueOrderModule = {
  orderLiveQueueItems?: <T>(
    items: readonly T[],
    priorityOf: (item: T) => QueuePriority,
    activityAt: (item: T) => string | null | undefined,
  ) => T[];
};

async function loadModule(): Promise<LiveQueueOrderModule> {
  try {
    return await import(new URL("./live-queue-order.ts", import.meta.url).href) as LiveQueueOrderModule;
  } catch {
    return {};
  }
}

const priorityOf = (item: QueueItem) => item.priority;
const activityAt = (item: QueueItem) => item.activityAt;

test("live queue puts actionable waits oldest-first while keeping passive history recent-first", async () => {
  const { orderLiveQueueItems } = await loadModule();
  const items: QueueItem[] = [
    { id: "rest-old", priority: "rest", activityAt: "2026-01-01T00:00:00.000Z" },
    { id: "awaiting-new", priority: "awaiting", activityAt: "2026-08-20T00:00:00.000Z" },
    { id: "unanswered-new", priority: "unanswered", activityAt: "2026-08-21T00:00:00.000Z" },
    { id: "draft-new", priority: "draft", activityAt: "2026-08-22T00:00:00.000Z" },
    { id: "send-attention-new", priority: "send_attention", activityAt: "2026-08-23T00:00:00.000Z" },
    { id: "unanswered-old", priority: "unanswered", activityAt: "2026-08-01T00:00:00.000Z" },
    { id: "draft-old", priority: "draft", activityAt: "2026-08-02T00:00:00.000Z" },
    { id: "send-attention-old", priority: "send_attention", activityAt: "2026-08-02T12:00:00.000Z" },
    { id: "awaiting-old", priority: "awaiting", activityAt: "2026-08-03T00:00:00.000Z" },
    { id: "rest-new", priority: "rest", activityAt: "2026-08-23T00:00:00.000Z" },
  ];

  assert.equal(typeof orderLiveQueueItems, "function");
  assert.deepEqual(
    orderLiveQueueItems!(items, priorityOf, activityAt).map((item) => item.id),
    [
      "unanswered-old",
      "unanswered-new",
      "draft-old",
      "draft-new",
      "send-attention-old",
      "send-attention-new",
      "awaiting-old",
      "awaiting-new",
      "rest-new",
      "rest-old",
    ],
  );
});

test("live queue puts missing or invalid activity dates after known waits and keeps their source order", async () => {
  const { orderLiveQueueItems } = await loadModule();
  const items: QueueItem[] = [
    { id: "missing-first", priority: "unanswered", activityAt: null },
    { id: "known-new", priority: "unanswered", activityAt: "2026-08-22T00:00:00.000Z" },
    { id: "invalid-second", priority: "unanswered", activityAt: "not-a-date" },
    { id: "known-old", priority: "unanswered", activityAt: "2026-08-01T00:00:00.000Z" },
  ];

  assert.equal(typeof orderLiveQueueItems, "function");
  assert.deepEqual(
    orderLiveQueueItems!(items, priorityOf, activityAt).map((item) => item.id),
    ["known-old", "known-new", "missing-first", "invalid-second"],
  );
});

test("live queue preserves source order for equal timestamps", async () => {
  const { orderLiveQueueItems } = await loadModule();
  const items: QueueItem[] = [
    { id: "first", priority: "draft", activityAt: "2026-08-10T00:00:00.000Z" },
    { id: "second", priority: "draft", activityAt: "2026-08-10T00:00:00.000Z" },
  ];

  assert.equal(typeof orderLiveQueueItems, "function");
  assert.deepEqual(
    orderLiveQueueItems!(items, priorityOf, activityAt).map((item) => item.id),
    ["first", "second"],
  );
});

test("live queue ordering does not mutate the source list", async () => {
  const { orderLiveQueueItems } = await loadModule();
  const items: QueueItem[] = [
    { id: "new", priority: "rest", activityAt: "2026-08-20T00:00:00.000Z" },
    { id: "old", priority: "rest", activityAt: "2026-08-01T00:00:00.000Z" },
  ];

  assert.equal(typeof orderLiveQueueItems, "function");
  orderLiveQueueItems!(items, priorityOf, activityAt);
  assert.deepEqual(items.map((item) => item.id), ["new", "old"]);
});
