import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isExplicitSmsOptOutText, shouldApplyExplicitSmsOptOut } from "../sms-consent-policy.ts";

async function inbound(mode: string, routeReason = "none", text = "금요일 가능합니다") {
  let classifications = 0;
  const writes: Array<{ table: string; value: Record<string, unknown> }> = [];
  const pending: Promise<unknown>[] = [];
  const applicant = { id: 7, name: "테스트", marketing_consent_at: null, availability: "휴면", sms_opt_out_at: null };
  const db = { from(table: string) {
    const q = {
      select() { return q; }, eq() { return q; }, is() { return q; }, gte() { return q; }, order() { return q; }, limit() { return q; },
      update(value: Record<string, unknown>) { writes.push({ table, value }); return q; },
      insert(value: Record<string, unknown>) { writes.push({ table, value }); return q; },
      maybeSingle: async () => ({ data: applicant, error: null }),
      single: async () => ({ data: applicant, error: null }),
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: table === "messages" ? [{ id: "in-1" }] : [], error: null }).then(resolve); },
    }; return q;
  } };
  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (value: unknown) => value } },
    "@vercel/functions": { waitUntil: (p: Promise<unknown>) => pending.push(p) },
    "@/lib/supabase": { createServiceClient: () => db },
    "@/lib/agent/kill-switch": { getAgentMode: async () => mode },
    "@/lib/agent/availability": { classifyAvailabilitySignal: async () => { classifications++; return { signal: "this_week", confidence: 0.9, reasoning: "fixture" }; } },
    "@/lib/agent/inbound-routing": {
      pickCandidateForInbound: async () => ({ ok: false, reason: routeReason }),
      describeRoute: () => routeReason,
      handleAmbiguousInbound: async () => ({ asked: false, pausedCandidates: 1 }),
    },
    "@/lib/sms-consent-policy": { isExplicitSmsOptOutText, shouldApplyExplicitSmsOptOut },
    "@/lib/agent/router": {}, "@/lib/agent/baemin-triage": {}, "@/lib/agent/engage": {},
    "@/lib/solapi": {}, "@/lib/slack": {}, "@/lib/agent/system-messages": {},
    "@/lib/agent/outbound-safety": {}, "@/lib/agent/usage": {},
  };
  const exports: Record<string, unknown> = {};
  const errors: unknown[] = [];
  const source = readFileSync(new URL("../../app/api/webhooks/supabase-new-message/route.ts", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (name: string) => { assert.ok(name in stubs, name); return stubs[name]; }, Date,
      process: { env: { SUPABASE_WEBHOOK_SECRET: "test-only" } },
      console: { log() {}, warn() {}, error: (...args: unknown[]) => errors.push(args) } });
  await (exports.POST as (req: unknown) => Promise<unknown>)({ headers: { get: () => "Bearer test-only" }, json: async () => ({
    type: "INSERT", table: "messages", record: { id: "in-1", applicant_id: 7, applicant_phone: "01000000000", direction: "inbound", body: text, classification: null, created_at: "2026-09-06T09:00:00Z", job_id: null },
  }) });
  await Promise.all(pending);
  assert.deepEqual(errors, []);
  return { classifications, writes };
}

for (const [mode, route] of [["off", "none"], ["draft", "none"], ["auto", "paused"], ["auto", "ambiguous"]]) {
  test(`${mode}/${route} stores inbound without availability model calls or profile changes`, async () => {
    const result = await inbound(mode, route);
    assert.equal(result.classifications, 0);
    assert.equal(result.writes.filter((w) => w.table === "applicants").length, 0);
    assert.ok(result.writes.some((w) => w.table === "messages" && w.value.applicant_id === 7));
  });
}

test("auto pool reply still classifies and updates availability", async () => {
  const result = await inbound("auto");
  assert.equal(result.classifications, 1);
  assert.ok(result.writes.some((w) => w.table === "applicants" && w.value.availability === "이번주가능"));
});

test("explicit opt-out is persisted even while AI is off without a model call", async () => {
  const result = await inbound("off", "paused", "문자 그만 보내주세요");
  assert.equal(result.classifications, 0);
  assert.ok(result.writes.some((w) => w.table === "applicants" && w.value.sms_opt_out_at && w.value.availability === "휴면"));
});
