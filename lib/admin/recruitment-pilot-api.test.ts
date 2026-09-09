import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as killSwitch from "../agent/kill-switch.ts";

const original = { body: "1", updated_at: "2026-09-01T00:00:00.000Z" };
const activeBody = () => JSON.stringify({ mode: "pilot", applicant_ids: [99], job_ids: [11], started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() });
function harness(options: { active?: boolean; race?: boolean; prepareFailure?: boolean; prepareThrows?: boolean; replaceOnPrepareFailure?: boolean } = {}) {
  let control = { ...original, ...(options.active ? { body: activeBody() } : {}) };
  let stage: string | null = null;
  let prepareCalls = 0;
  let casCalls = 0;
  const db = { from(table: string) {
    let update: Record<string, unknown> | null = null;
    const filters: Array<[string, unknown]> = [];
    const query = {
      select() { return query; }, eq(key: string, value: unknown) { filters.push([key, value]); return query; },
      is(key: string, value: unknown) { filters.push([key, value]); return query; }, in() { return query; },
      update(value: Record<string, unknown>) { update = value; return query; },
      limit() { return query; },
      then(resolve: (value: unknown) => unknown) {
        if (table === "job_candidates" && update) {
          prepareCalls++;
          if (options.prepareThrows) throw new Error("prepare request rejected");
          if (options.prepareFailure) {
            if (options.replaceOnPrepareFailure) control = { body: activeBody(), updated_at: "other-manager" };
            return Promise.resolve(resolve({ data: null, error: new Error("prepare failure") }));
          }
          stage = "exploration";
          return Promise.resolve(resolve({ data: [], error: null }));
        }
        assert.equal(table, "prompt_examples");
        if (update) {
          casCalls++;
          if (options.race && casCalls === 1) control = { body: activeBody(), updated_at: "other-manager" };
          const matches = filters.every(([key, value]) => key === "category" || key === "title" || control[key as keyof typeof control] === value);
          if (matches) control = { ...control, ...update } as typeof control;
          return Promise.resolve(resolve({ data: matches ? [{ ...control }] : [], error: null }));
        }
        return Promise.resolve(resolve({ data: [{ ...control }], error: null }));
      },
    };
    return query;
  } };
  const exports: { POST?: (req: unknown) => Promise<{ status: number; body: Record<string, unknown> }> } = {};
  const modules: Record<string, unknown> = {
    "@/lib/supabase": { createServiceClient: () => db },
    "@/lib/agent/kill-switch": killSwitch,
    "@/lib/admin/agent-pilot-targets": { loadPilotCandidates: async () => [{ id: 71, applicant_id: 7, job_id: 11, agent_stage: null }] },
    "@/lib/admin/prompt-example-reserved": { AGENT_KILL_SWITCH_CATEGORY: "system_message", AGENT_KILL_SWITCH_TITLE: "agent_kill_switch" },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../../app/api/admin/agent/kill-switch/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => name === "next/server" ? { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } } : modules[name], process: { env: {} }, Date, console: { error() {} } });
  return { post: (expected = original.updated_at) => exports.POST!({ json: async () => ({ mode: "pilot", job_ids: [11], applicant_ids: [7], duration_hours: 1, require_inactive: true, expected_updated_at: expected }) }), state: () => ({ control, stage, prepareCalls }) };
}

for (const kind of ["active", "stale", "race"] as const) test(`recruitment pilot ${kind} never replaces another scope or prepares candidates`, async () => {
  const h = harness({ active: kind === "active", race: kind === "race" });
  const result = await h.post(kind === "stale" ? "old" : undefined);
  assert.equal(result.status, 409);
  assert.equal(h.state().prepareCalls, 0);
  assert.equal(h.state().stage, null);
});

test("matching inactive snapshot starts only selected candidates", async () => {
  const h = harness();
  assert.equal((await h.post()).status, 200);
  assert.deepEqual(JSON.parse(h.state().control.body).applicant_ids, [7]);
  assert.equal(h.state().stage, "exploration");
});

test("preparation failure restores its own mode to OFF", async () => {
  const h = harness({ prepareFailure: true });
  assert.equal((await h.post()).status, 500);
  assert.equal(h.state().control.body, "1");
});

test("a rejected preparation request also restores its own mode to OFF", async () => {
  const h = harness({ prepareThrows: true });
  assert.equal((await h.post()).status, 500);
  assert.equal(h.state().control.body, "1");
});

test("preparation failure cannot roll back another manager's newer setting", async () => {
  const h = harness({ prepareFailure: true, replaceOnPrepareFailure: true });
  assert.equal((await h.post()).status, 500);
  assert.deepEqual(JSON.parse(h.state().control.body).applicant_ids, [99]);
});
