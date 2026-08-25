import assert from "node:assert/strict";
import test from "node:test";

function fakeClient(result: { data: unknown; error: unknown }) {
  const query = {
    select() { return this; },
    eq() { return this; },
    limit() { return Promise.resolve(result); },
    maybeSingle() { return Promise.resolve(result); },
  };
  return { from: () => query };
}

async function loadKillSwitch() {
  const modulePath = "./kill-switch.ts";
  return await import(modulePath) as {
    getAgentMode: (client: never) => Promise<"auto" | "draft" | "off">;
    invalidateKillSwitchCache: () => void;
    parseAgentMode: (body: string | null | undefined) => "auto" | "draft" | "off";
  };
}

test("only known empty or zero values enable automatic mode", async () => {
  const { parseAgentMode } = await loadKillSwitch();

  assert.equal(parseAgentMode(undefined), "auto");
  assert.equal(parseAgentMode(null), "auto");
  assert.equal(parseAgentMode(""), "auto");
  assert.equal(parseAgentMode(" 0 "), "auto");
  assert.equal(parseAgentMode("draft"), "draft");
  assert.equal(parseAgentMode("1"), "off");
  assert.equal(parseAgentMode("garbage"), "off");
});

test("ambiguous duplicate kill-switch rows fail closed instead of silently enabling auto", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  invalidateKillSwitchCache();
  const client = fakeClient({
    data: [{ body: "1" }, { body: "0" }],
    error: null,
  });

  assert.equal(await getAgentMode(client as never), "off");
});

test("a missing kill-switch row keeps the intentional default auto behavior", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  invalidateKillSwitchCache();
  const client = fakeClient({ data: [], error: null });

  assert.equal(await getAgentMode(client as never), "auto");
});

test("a malformed stored kill-switch value fails closed", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  invalidateKillSwitchCache();
  const client = fakeClient({ data: [{ body: "unexpected" }], error: null });

  assert.equal(await getAgentMode(client as never), "off");
});

test("a returned database error fails closed instead of enabling automatic replies", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  invalidateKillSwitchCache();
  const client = fakeClient({
    data: null,
    error: { message: "database unavailable" },
  });

  assert.equal(await getAgentMode(client as never), "off");
});

test("a thrown database exception fails closed instead of enabling automatic replies", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  invalidateKillSwitchCache();
  const client = {
    from() {
      throw new Error("connection failed");
    },
  };

  assert.equal(await getAgentMode(client as never), "off");
});
