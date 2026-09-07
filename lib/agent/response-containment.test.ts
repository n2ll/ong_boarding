import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as killSwitch from "./kill-switch.ts";

function route(path: string, modules: Record<string, unknown>) {
  const exports: Record<string, (req?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>> = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => name === "next/server"
    ? { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } }
    : modules[name] ?? {}, process: { env: {} }, Date, console: { error() {} } });
  return exports;
}

for (const payload of [{ mode: "auto" }, { disabled: false }]) {
  test(`global activation ${JSON.stringify(payload)} is rejected before storage`, async () => {
    let dbTouched = false;
    const api = route("../../app/api/admin/agent/kill-switch/route.ts", {
      "@/lib/supabase": { createServiceClient() { dbTouched = true; throw new Error("must not write"); } },
    });
    const result = await api.POST({ json: async () => payload });
    assert.equal(result.status, 409);
    assert.equal(dbTouched, false);
  });
}

for (const mode of ["off", "draft"]) {
  test(`${mode} prevents onboarding reminder queries and provider work`, async () => {
    let queries = 0;
    const api = route("../../app/api/admin/cron/onboarding-reminder/route.ts", {
      "@/lib/cron-auth": { requireCronAuth: () => null },
      "@/lib/supabase": { createServiceClient: () => ({ from() { queries++; throw new Error("reminders must not run"); } }) },
      "@/lib/agent/kill-switch": { getAgentMode: async () => mode },
    });
    const result = await api.GET({});
    assert.equal(result.status, 200);
    assert.equal(queries, 0);
    assert.equal(result.body.skipped, "agent_not_auto");
  });
}

test("test settings reject jobs omitted by an older UI before writing", async () => {
  let writes = 0;
  const query = { select() { return this; }, eq() { return this; },
    limit: async () => ({ data: [{ id: 7, name: "검수 테스트", sms_opt_out_at: null }], error: null }),
    update() { writes++; throw new Error("must not write"); } };
  const api = route("../../app/api/admin/agent/kill-switch/route.ts", {
    "@/lib/supabase": { createServiceClient: () => ({ from: () => query }) },
    "@/lib/agent/kill-switch": killSwitch,
  });
  assert.equal((await api.POST({ json: async () => ({ mode: "test", phone: "01000000000" }) })).status, 400);
  assert.equal(writes, 0);
});

test("an old caller mode cannot reopen interest engagement after OFF", async () => {
  let touches = 0;
  const api = route("./engage.ts", {
    "./kill-switch": { getAgentMode: async () => "off" },
    "../pool-engage-claim": { poolEngageRecoveryDecision: () => ({kind: "none"}) },
  });
  const outcome = await api.runInterestEngage({supabase: {
    rpc: async () => ({data: null, error: null}),
    from() { touches++; throw new Error("must not start engagement"); },
  }, jobId: 11, applicantId: 7, source: "pool", mode: "auto"});
  assert.equal((outcome as unknown as {action: string}).action, "off");
  assert.equal(touches, 0);
});

for (const scenario of [
  { name: "active", jobs: [{ id: 11, title: "검수 배송", status: "active", closes_at: null }], status: 200 },
  { name: "missing", jobs: [], status: 400 },
  { name: "closed", jobs: [{ id: 11, title: "검수 배송", status: "closed", closes_at: null }], status: 400 },
  { name: "expired", jobs: [{ id: 11, title: "검수 배송", status: "active", closes_at: "2000-01-01" }], status: 400 },
  { name: "system", jobs: [{ id: 11, title: "__intake", status: "active", closes_at: null }], status: 400 },
]) test(`test session validates ${scenario.name} jobs before persisting a bounded session`, async () => {
  const writes: Array<{body: string; updated_at: string}> = [];
  const api = route("../../app/api/admin/agent/kill-switch/route.ts", {
    "@/lib/agent/kill-switch": killSwitch,
    "@/lib/supabase": { createServiceClient: () => ({ from(table: string) {
      if (table === "applicants") return { select() { return this; }, eq() { return this; },
        limit: async () => ({data: [{id: 7, name: "검수 테스트", sms_opt_out_at: null}], error: null}) };
      if (table === "jobs") return { select() { return this; }, in: async () => ({data: scenario.jobs, error: null}) };
      if (table === "prompt_examples") return { update(value: {body: string; updated_at: string}) { writes.push(value); return this; },
        eq() { return this; }, select: async () => ({data: writes, error: null}) };
      throw new Error(`unexpected table ${table}`);
    } }) },
  });
  const result = await api.POST({json: async () => ({mode: "test", phone: "01000000000", job_ids: [11]})});
  assert.equal(result.status, scenario.status);
  assert.equal(writes.length, scenario.status === 200 ? 1 : 0);
  if (scenario.status === 200) {
    const session = JSON.parse(writes[0].body);
    assert.equal(session.applicant_id, 7);
    assert.deepEqual(session.job_ids, [11]);
    assert.equal(session.mode, "test");
    assert.ok(Date.parse(session.expires_at) - Date.parse(session.started_at) <= 20 * 60_000 + 1000);
    assert.ok(Date.parse(session.expires_at) - Date.parse(session.started_at) >= 20 * 60_000);
    assert.equal(result.body.mode, "off");
    assert.ok(result.body.test_session);
  }
});
