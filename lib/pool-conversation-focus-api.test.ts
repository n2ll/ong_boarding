import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as durable from "./pool-durable-action.ts";
import * as jobs from "./jobs.ts";

const actionId = "11111111-1111-4111-8111-111111111111";
const token = "22222222-2222-4222-8222-222222222222";
async function request(path: string, body: Record<string, unknown>, options: { outcome?: string; replay?: Record<string, unknown>; focus?: number | null; focusAction?: string; intent?: string; hidden?: boolean } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const app = { id: 7, name: "테스트", conversation_focus_job_id: options.focus === undefined ? 22 : options.focus, conversation_focus_action_key: options.focusAction ?? actionId };
  const supabase = {
    from(table: string) {
      const data = table === "applicants" ? app
        : table === "jobs" ? { id: 22, title: "마포 배송", status: "active", recruit_mode: options.hidden ? "external" : "both", exposure: "all" }
        : table === "pool_events" ? options.replay ?? null
        : table === "pool_interest_engage_intents" ? { applicant_id: 7, job_id: 22, intent: options.intent ?? "off", queue_created: options.intent === "auto_queue", status: "pending", outcome: null }
        : null;
      const query = { select() { return query; }, eq() { return query; }, maybeSingle: async () => ({ data, error: null }) };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) { calls.push({ name, args }); return { data: options.outcome ?? "recorded", error: null }; },
  };
  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (data: unknown, init?: ResponseInit) => Response.json(data, init) } },
    "@/lib/supabase": { createServiceClient: () => supabase },
    "@/lib/geo": { EXPOSURE_JOB_GEO_COLUMNS: "lat,lng" },
    "@/lib/slack": { sendSlackText: async () => true },
    "@/lib/pool-durable-action": durable,
    "@/lib/jobs": jobs,
    "@/lib/agent/kill-switch": { getAgentMode: async () => "off" },
    "@/lib/exposure": {},
    "@/lib/agent/engage": { isNightKst: () => false, engageOutcomeLabel: () => "off" },
  };
  const exports: Record<string, unknown> = {};
  const source = readFileSync(new URL("../app/api/pool/[token]/interest/route.ts", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (name: string) => { if (!(name in stubs)) throw new Error(name); return stubs[name]; }, console, URL });
  const post = exports.POST as (req: unknown, params: unknown) => Promise<Response>;
  const response = await post({ json: async () => ({ job_id: 22, action_id: actionId, ...body }), nextUrl: new URL(`https://example.test/api/pool/${token}/${path}`) }, { params: Promise.resolve({ token }) });
  return { response, body: await response.json(), calls };
}
test("interest-only uses atomic off intent and cannot initiate SMS", async () => {
  const result = await request("interest", { interest_only: true });
  assert.equal(result.response.status, 200);
  assert.equal(result.calls[0].name, "record_pool_interest_only");
});
test("focus switches use the atomic guarded RPC", async () => {
  const result = await request("focus", {});
  assert.equal(result.response.status, 200);
  assert.equal(result.calls[0].name, "select_pool_conversation_focus");
  assert.equal(result.body.focus_job_id, 22);
});
test("busy reply leaves focus untouched and never starts followup work", async () => {
  const result = await request("focus", {}, { outcome: "busy" });
  assert.equal(result.response.status, 409);
  assert.equal(result.calls.length, 1);
});
test("an existing interest-only action cannot be reused to switch a conversation", async () => {
  const result = await request("focus", {}, { replay: { applicant_id: 7, job_id: 22, event_type: "interest_click", meta: { immediate: false, interest_only: true } } });
  assert.equal(result.response.status, 409);
  assert.equal(result.calls.length, 0);
});
test("non-exposed jobs are rejected before focus mutation", async () => {
  const result = await request("focus", {}, { hidden: true });
  assert.equal(result.response.status, 400);
  assert.equal(result.calls.length, 0);
});

test("an old same-job replay cannot promise a superseded queued SMS", async () => {
  const result = await request("focus", {}, { focus: 22, focusAction: "33333333-3333-4333-8333-333333333333", intent: "auto_queue",
    replay: { applicant_id: 7, job_id: 22, event_type: "interest_click", meta: { immediate: false, conversation_focus: true } } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.focus_job_id, 22);
  assert.equal(result.body.engage, "superseded");
  assert.ok(!result.calls.some((call) => call.name === "select_pool_conversation_focus"));
});
test("replaying an old focus does not expose a different current job", async () => {
  const result = await request("focus", {}, { focus: 999,
    replay: { applicant_id: 7, job_id: 22, event_type: "interest_click", meta: { immediate: false, conversation_focus: true } } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.focus_job_id, null);
});
