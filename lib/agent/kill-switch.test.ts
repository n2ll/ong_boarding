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
    getAgentMode: (client: never, scope?: { applicantId: number; receivedAt: string }) => Promise<"auto" | "draft" | "off">;
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

function testBody(start = Date.now() - 1000, end = Date.now() + 60_000) {
  return JSON.stringify({ mode: "test", applicant_id: 7, started_at: new Date(start).toISOString(), expires_at: new Date(end).toISOString() });
}

test("test session permits only new inbound from one applicant, including with a shared cache", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  invalidateKillSwitchCache();
  const client = fakeClient({ data: [{ body: testBody() }], error: null }) as never;
  const receivedAt = new Date().toISOString();
  assert.equal(await getAgentMode(client, { applicantId: 7, receivedAt }), "auto");
  assert.equal(await getAgentMode(client, { applicantId: 8, receivedAt }), "off");
  assert.equal(await getAgentMode(client), "off", "unscoped cron must remain stopped");
  assert.equal(await getAgentMode(client, { applicantId: 7, receivedAt: new Date(Date.now() - 5000).toISOString() }), "off");
  assert.equal(await getAgentMode(client, { applicantId: 7, receivedAt: "invalid" }), "off");
});

test("expired, future, overly long or malformed test sessions fail closed", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  for (const body of [testBody(Date.now()-5000, Date.now()-1000), testBody(Date.now()+1000, Date.now()+5000), testBody(Date.now()-1000, Date.now()+3600_000), '{"mode":"test","applicant_id":7}']) {
    invalidateKillSwitchCache();
    assert.equal(await getAgentMode(fakeClient({ data: [{ body }], error: null }) as never, { applicantId: 7, receivedAt: new Date().toISOString() }), "off");
  }
});

test("environment kill switch overrides a valid test session", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  const before = process.env.AGENT_DISABLED;
  try {
    invalidateKillSwitchCache(); process.env.AGENT_DISABLED = "1";
    assert.equal(await getAgentMode(fakeClient({ data: [{ body: testBody() }], error: null }) as never, { applicantId: 7, receivedAt: new Date().toISOString() }), "off");
  } finally {
    if (before === undefined) delete process.env.AGENT_DISABLED; else process.env.AGENT_DISABLED = before;
    invalidateKillSwitchCache();
  }
});
