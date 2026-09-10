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
    getAgentMode: (client: never, scope?: { applicantId: number; receivedAt: string; jobIds?: number[] }) => Promise<"auto" | "draft" | "off">;
    invalidateKillSwitchCache: () => void;
    parseAgentMode: (body: string | null | undefined) => "auto" | "draft" | "off";
    parseAgentPilotSession: (body: string, now?: number) => { started_at: string; expires_at: string; renewed_at?: string } | null;
  };
}

test("legacy global auto and missing values fail closed", async () => {
  const { parseAgentMode } = await loadKillSwitch();

  assert.equal(parseAgentMode(undefined), "off");
  assert.equal(parseAgentMode(null), "off");
  assert.equal(parseAgentMode(""), "off");
  assert.equal(parseAgentMode(" 0 "), "off");
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

test("a missing kill-switch row fails closed", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  invalidateKillSwitchCache();
  const client = fakeClient({ data: [], error: null });

  assert.equal(await getAgentMode(client as never), "off");
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
  return JSON.stringify({ mode: "test", applicant_id: 7, job_ids: [11, 12], started_at: new Date(start).toISOString(), expires_at: new Date(end).toISOString() });
}

test("test session permits only new inbound from one applicant, including with a shared cache", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  invalidateKillSwitchCache();
  const client = fakeClient({ data: [{ body: testBody() }], error: null }) as never;
  const receivedAt = new Date().toISOString();
  assert.equal(await getAgentMode(client, { applicantId: 7, receivedAt, jobIds: [11] }), "auto");
  assert.equal(await getAgentMode(client, { applicantId: 8, receivedAt, jobIds: [11] }), "off");
  assert.equal(await getAgentMode(client), "off", "unscoped cron must remain stopped");
  assert.equal(await getAgentMode(client, { applicantId: 7, receivedAt: new Date(Date.now() - 5000).toISOString(), jobIds: [11] }), "off");
  assert.equal(await getAgentMode(client, { applicantId: 7, receivedAt: "invalid", jobIds: [11] }), "off");
});

test("expired, future, overly long or malformed test sessions fail closed", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  for (const body of [testBody(Date.now()-5000, Date.now()-1000), testBody(Date.now()+1000, Date.now()+5000), testBody(Date.now()-1000, Date.now()+3600_000), '{"mode":"test","applicant_id":7}']) {
    invalidateKillSwitchCache();
    assert.equal(await getAgentMode(fakeClient({ data: [{ body }], error: null }) as never, { applicantId: 7, receivedAt: new Date().toISOString(), jobIds: [11] }), "off");
  }
});

test("environment kill switch overrides a valid test session", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  const before = process.env.AGENT_DISABLED;
  try {
    invalidateKillSwitchCache(); process.env.AGENT_DISABLED = "1";
    assert.equal(await getAgentMode(fakeClient({ data: [{ body: testBody() }], error: null }) as never, { applicantId: 7, receivedAt: new Date().toISOString(), jobIds: [11] }), "off");
  } finally {
    if (before === undefined) delete process.env.AGENT_DISABLED; else process.env.AGENT_DISABLED = before;
    invalidateKillSwitchCache();
  }
});

test("test scope requires every job and refuses a missing or unrelated job", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  invalidateKillSwitchCache();
  const db = fakeClient({ data: [{ body: testBody() }], error: null }) as never;
  const scope = { applicantId: 7, receivedAt: new Date().toISOString() };
  assert.equal(await getAgentMode(db, scope), "off");
  assert.equal(await getAgentMode(db, {...scope, jobIds: []}), "off");
  assert.equal(await getAgentMode(db, {...scope, jobIds: [11, 13]}), "off");
  assert.equal(await getAgentMode(db, {...scope, jobIds: [11, 12]}), "auto");
});

test("old unscoped test sessions and malformed job scopes are off", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  for (const job_ids of [undefined, [], [11,11], [0], ["11"], [11,12,13,14]]) {
    invalidateKillSwitchCache();
    const body = JSON.stringify({...JSON.parse(testBody()), job_ids});
    const db = fakeClient({ data: [{body}], error: null }) as never;
    assert.equal(await getAgentMode(db, {applicantId: 7, receivedAt: new Date().toISOString(), jobIds: [11]}), "off");
  }
});

function pilotBody(patch: Record<string, unknown> = {}) {
  return JSON.stringify({ mode: "pilot", applicant_ids: [7, 8], job_ids: [11, 12], started_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), ...patch });
}

test("pilot allows selected applicants and jobs but never unscoped cron or old inbound", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  invalidateKillSwitchCache();
  const db = fakeClient({ data: [{ body: pilotBody() }], error: null }) as never;
  const receivedAt = new Date().toISOString();
  assert.equal(await getAgentMode(db, { applicantId: 8, receivedAt, jobIds: [11, 12] }), "auto");
  assert.equal(await getAgentMode(db, { applicantId: 9, receivedAt, jobIds: [11] }), "off");
  assert.equal(await getAgentMode(db, { applicantId: 7, receivedAt, jobIds: [11, 13] }), "off");
  assert.equal(await getAgentMode(db), "off");
  assert.equal(await getAgentMode(db, { applicantId: 7, receivedAt: new Date(Date.now() - 10_000).toISOString(), jobIds: [11] }), "off");
});

test("a 50-person pilot allows its last selected applicant while other applicants remain off", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  invalidateKillSwitchCache();
  const db = fakeClient({ data: [{ body: pilotBody({ applicant_ids: Array.from({ length: 50 }, (_, i) => i + 1) }) }], error: null }) as never;
  const receivedAt = new Date().toISOString();
  assert.equal(await getAgentMode(db, { applicantId: 50, receivedAt, jobIds: [11, 12] }), "auto");
  assert.equal(await getAgentMode(db, { applicantId: 51, receivedAt, jobIds: [11] }), "off");
  assert.equal(await getAgentMode(db), "off");
});

test("pilot invalid membership, expiry and excessive duration fail closed", async () => {
  const { getAgentMode, invalidateKillSwitchCache } = await loadKillSwitch();
  for (const patch of [{ applicant_ids: [] }, { applicant_ids: [7, 7] }, { applicant_ids: ["7"] }, { applicant_ids: Array.from({ length: 51 }, (_, i) => i + 1) }, { expires_at: new Date(Date.now() - 100).toISOString() }, { expires_at: new Date(Date.now() + 25 * 3600_000).toISOString() }, { job_ids: [] }]) {
    invalidateKillSwitchCache();
    assert.equal(await getAgentMode(fakeClient({ data: [{ body: pilotBody(patch) }], error: null }) as never, { applicantId: 7, receivedAt: new Date().toISOString(), jobIds: [11] }), "off");
  }
});

test("a renewed pilot keeps its original inbound window and scope for up to 14 days", async () => {
  const { getAgentMode, invalidateKillSwitchCache, parseAgentPilotSession } = await loadKillSwitch();
  const now = Date.now();
  const body = pilotBody({ started_at: new Date(now - 30 * 86400_000).toISOString(), renewed_at: new Date(now).toISOString(), expires_at: new Date(now + 14 * 86400_000).toISOString() });
  const session = parseAgentPilotSession(body, now);
  assert.equal(session?.renewed_at, new Date(now).toISOString());
  invalidateKillSwitchCache();
  const db = fakeClient({ data: [{ body }], error: null }) as never;
  assert.equal(await getAgentMode(db, { applicantId: 7, receivedAt: new Date(now - 29 * 86400_000).toISOString(), jobIds: [11, 12] }), "auto");
  assert.equal(await getAgentMode(db, { applicantId: 7, receivedAt: new Date(now - 31 * 86400_000).toISOString(), jobIds: [11] }), "off");
  assert.equal(await getAgentMode(db, { applicantId: 9, receivedAt: new Date(now).toISOString(), jobIds: [11] }), "off");
  assert.equal(await getAgentMode(db, { applicantId: 7, receivedAt: new Date(now).toISOString(), jobIds: [13] }), "off");
  assert.equal(await getAgentMode(db), "off");
  assert.equal(parseAgentPilotSession(body, now + 14 * 86400_000), null);
});

test("renewal requires a valid past renewal time and a finite 14-day horizon", async () => {
  const { parseAgentPilotSession } = await loadKillSwitch();
  const now = Date.now();
  const start = new Date(now - 3600_000).toISOString();
  const renewed = new Date(now).toISOString();
  for (const patch of [
    { renewed_at: null }, { renewed_at: 123 }, { renewed_at: "invalid" },
    { renewed_at: new Date(now - 3600_001).toISOString() }, { renewed_at: new Date(now + 1).toISOString() },
    { expires_at: renewed }, { expires_at: new Date(now + 14 * 86400_000 + 1).toISOString() },
    { started_at: [start] }, { expires_at: [new Date(now + 86400_000).toISOString()] },
    { applicant_ids: [] }, { job_ids: [11, 11] },
  ]) assert.equal(parseAgentPilotSession(pilotBody({ started_at: start, renewed_at: renewed, expires_at: new Date(now + 86400_000).toISOString(), ...patch }), now), null);
  assert.equal(parseAgentPilotSession(pilotBody({ started_at: start, expires_at: new Date(now + 86400_000).toISOString() }), now), null, "legacy pilots retain the 24-hour total limit");
});
