import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parseAgentMode, parseAgentTestSession, invalidateKillSwitchCache } from "../agent/kill-switch.ts";

type Target = { id: number; name: string; sms_opt_out_at: string | null };
async function request(payload: unknown, targets: Target[], forced = false, initialBody = "1") {
  let body = initialBody, writes = 0;
  const db = { from(table: string) {
    let update: { body: string } | null = null;
    const query = {
      eq() { return query; }, select() { return query; },
      update(value: { body: string }) { update = value; return query; },
      limit: async () => ({ data: table === "applicants" ? targets : [{ body }], error: null }),
      then(resolve: (value: unknown) => unknown) {
        if (update) { writes++; body = update.body; }
        return Promise.resolve({ data: [{ body, updated_at: new Date().toISOString() }], error: null }).then(resolve);
      },
    }; return query;
  } };
  const source = readFileSync(new URL("../../app/api/admin/agent/kill-switch/route.ts", import.meta.url), "utf8");
  const mod = { exports: {} as { POST?: (req: unknown) => Promise<{ status: number; value: Record<string, unknown> }> } };
  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (value: unknown, init?: { status?: number }) => ({ value, status: init?.status ?? 200 }) } },
    "@/lib/supabase": { createServiceClient: () => db },
    "@/lib/agent/kill-switch": { parseAgentMode, parseAgentTestSession, invalidateKillSwitchCache },
    "@/lib/admin/prompt-example-reserved": { AGENT_KILL_SWITCH_CATEGORY: "system_message", AGENT_KILL_SWITCH_TITLE: "agent_kill_switch" },
  };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module: mod, exports: mod.exports, Date, process: { env: { AGENT_DISABLED: forced ? "1" : undefined } }, console,
    require(name: string) { assert.ok(name in stubs, name); return stubs[name]; },
  });
  const result = await mod.exports.POST!({ json: async () => payload });
  return { ...result, writes, body };
}
const target: Target = { id: 7, name: "검수(테스트)", sms_opt_out_at: null };

test("authenticated control creates a 20-minute session for one existing test account", async () => {
  const result = await request({ mode: "test", phone: "010-0000-0000" }, [target]);
  assert.equal(result.status, 200);
  const session = parseAgentTestSession(result.body)!;
  assert.equal(session.applicant_id, 7);
  assert.equal(Date.parse(session.expires_at)-Date.parse(session.started_at), 20*60_000);
  assert.equal(result.value.mode, "off", "unscoped callers stay off");
  assert.ok(result.value.test_session);
});

for (const [label, targets] of [
  ["ordinary applicant", [{ ...target, name: "지원자" }]],
  ["duplicate phone", [target, { ...target, id: 8 }]],
  ["opted-out account", [{ ...target, sms_opt_out_at: new Date().toISOString() }]],
  ["missing account", []],
] as Array<[string, Target[]]>) {
  test(`test control rejects ${label} without writes`, async () => {
    const result = await request({ mode: "test", phone: "01000000000" }, targets);
    assert.equal(result.status, 400); assert.equal(result.writes, 0);
  });
}
test("environment stop rejects test activation", async () => {
  const result = await request({ mode: "test", phone: "01000000000" }, [target], true);
  assert.equal(result.status, 409); assert.equal(result.writes, 0);
});
test("off clears the test session in the same control row", async () => {
  const active = await request({ mode: "test", phone: "01000000000" }, [target]);
  const result = await request({ mode: "off" }, [target], false, active.body);
  assert.equal(result.status, 200); assert.equal(result.body, "1"); assert.equal(result.value.test_session, null);
});
