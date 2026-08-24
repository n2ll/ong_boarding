import assert from "node:assert/strict";
import test from "node:test";

type NotificationQueryStateModule = {
  notificationQueryState?: (sources: {
    inbox: { count?: number | null; error?: unknown };
    inboxOldest: { data?: unknown; error?: unknown };
    handoffs: { data?: unknown; error?: unknown };
    killSwitch: { data?: unknown; error?: unknown };
  }) =>
    | {
        ok: true;
        inboxCount: number;
        inboxOldestRows: unknown[];
        handoffRows: unknown[];
        killSwitchBody: string | null;
      }
    | { ok: false; failed: string[]; cause: unknown };
  notificationAiDisabled?: (envForced: boolean, body: string | null) => boolean;
};

async function loadModule(): Promise<NotificationQueryStateModule> {
  try {
    return await import(new URL("./notification-query-state.ts", import.meta.url).href) as NotificationQueryStateModule;
  } catch {
    return {};
  }
}

test("successful notification queries permit a computed feed", async () => {
  const { notificationQueryState } = await loadModule();

  assert.equal(typeof notificationQueryState, "function");
  assert.deepEqual(notificationQueryState!({
    inbox: { count: 0, error: null },
    inboxOldest: { data: [], error: null },
    handoffs: { data: [], error: null },
    killSwitch: { data: null, error: null },
  }), {
    ok: true,
    inboxCount: 0,
    inboxOldestRows: [],
    handoffRows: [],
    killSwitchBody: null,
  });
});

test("any notification query failure blocks zero-valued fallback counts", async () => {
  const { notificationQueryState } = await loadModule();
  const inboxError = { message: "inbox unavailable" };

  assert.equal(typeof notificationQueryState, "function");
  assert.deepEqual(notificationQueryState!({
    inbox: { count: null, error: inboxError },
    inboxOldest: { data: [], error: null },
    handoffs: { data: [], error: { message: "handoffs unavailable" } },
    killSwitch: { data: null, error: null },
  }), {
    ok: false,
    failed: ["inbox", "handoffs"],
    cause: inboxError,
  });
});

test("incomplete success payloads fail closed instead of becoming zero", async () => {
  const { notificationQueryState } = await loadModule();

  assert.equal(typeof notificationQueryState, "function");
  const state = notificationQueryState!({
    inbox: { count: null, error: null },
    inboxOldest: { data: undefined, error: null },
    handoffs: { data: [], error: null },
    killSwitch: { data: {}, error: null },
  });

  assert.equal(state.ok, false);
  if (!state.ok) {
    assert.deepEqual(state.failed, ["inbox", "inboxOldest", "killSwitch"]);
  }
});

test("the admin notification status honors both DB off and the environment override", async () => {
  const { notificationAiDisabled } = await loadModule();

  assert.equal(typeof notificationAiDisabled, "function");
  assert.equal(notificationAiDisabled!(false, "1"), true);
  assert.equal(notificationAiDisabled!(false, "draft"), false);
  assert.equal(notificationAiDisabled!(true, null), true);
});
