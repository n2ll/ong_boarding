import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as killSwitch from "../agent/kill-switch.ts";

const version = "2026-09-09T07:00:00.000Z";
function harness(options: { body?: string; race?: boolean; forced?: boolean; readError?: boolean; writeError?: boolean; duplicate?: boolean } = {}) {
  const initial = JSON.stringify({ mode: "pilot", applicant_ids: [7, 8], job_ids: [11, 12], started_at: new Date(Date.now() - 3600_000).toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() });
  let control = { body: options.body ?? initial, updated_at: version };
  let writes = 0;
  const db = { from(table: string) {
    assert.equal(table, "prompt_examples", "renewal must not prepare candidates or mutate any other table");
    let update: Record<string, unknown> | null = null;
    const filters: Array<[string, unknown]> = [];
    const query = {
      select() { return query; }, eq(key: string, value: unknown) { filters.push([key, value]); return query; },
      limit() { return query; }, update(value: Record<string, unknown>) { update = value; return query; },
      then(resolve: (value: unknown) => unknown) {
        if (!update) return Promise.resolve(resolve({ data: options.readError ? null : options.duplicate ? [control, control] : [{ ...control }], error: options.readError ? new Error("read failed") : null }));
        writes++;
        if (options.race) control = { body: "1", updated_at: "2026-09-10T07:00:00.000Z" };
        if (options.writeError) return Promise.resolve(resolve({ data: null, error: new Error("write failed") }));
        const matches = filters.every(([key, value]) => key === "category" || key === "title" || control[key as keyof typeof control] === value);
        if (matches) control = { ...control, ...update } as typeof control;
        return Promise.resolve(resolve({ data: matches ? [{ ...control }] : [], error: null }));
      },
    };
    return query;
  } };
  const exports: { GET?: () => Promise<{ status: number; body: Record<string, unknown> }>; POST?: (req: unknown) => Promise<{ status: number; body: Record<string, unknown> }> } = {};
  const modules: Record<string, unknown> = {
    "@/lib/supabase": { createServiceClient: () => db }, "@/lib/agent/kill-switch": killSwitch,
    "@/lib/admin/agent-pilot-targets": { loadPilotCandidates: async () => { throw new Error("renewal must not reselect or prepare paused candidates"); } },
    "@/lib/admin/prompt-example-reserved": { AGENT_KILL_SWITCH_CATEGORY: "system_message", AGENT_KILL_SWITCH_TITLE: "agent_kill_switch" },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../../app/api/admin/agent/kill-switch/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name: string) => name === "next/server" ? { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } } : modules[name], process: { env: options.forced ? { AGENT_DISABLED: "1" } : {} }, Date, console: { error() {} } });
  return { initial, post: (patch: Record<string, unknown> = {}) => exports.POST!({ json: async () => ({ action: "extend_pilot", duration_hours: 336, expected_updated_at: version, ...patch }) }), get: () => exports.GET!(), state: () => ({ control, writes }) };
}

for (const hours of [24, 168, 336]) test(`an active pilot extends ${hours} hours without changing its scope or original inbound cutoff`, async () => {
  const h = harness();
  const result = await h.post({ duration_hours: hours });
  assert.equal(result.status, 200);
  const saved = JSON.parse(h.state().control.body), before = JSON.parse(h.initial);
  assert.deepEqual(saved.applicant_ids, [7, 8]);
  assert.deepEqual(saved.job_ids, [11, 12]);
  assert.equal(saved.started_at, before.started_at);
  assert.equal(Date.parse(saved.expires_at) - Date.parse(saved.renewed_at), hours * 3600_000);
  assert.equal(result.body.mode, "off");
  assert.deepEqual(JSON.parse(JSON.stringify(result.body.pilot_session)), saved);
  assert.equal((await h.get()).body.updated_at, result.body.updated_at);
  assert.equal(h.state().writes, 1);
});

test("expired, stopped, malformed and test sessions cannot be extended", async () => {
  for (const body of ["1", "draft", "{broken", JSON.stringify({ mode: "test", applicant_id: 7, job_ids: [11], started_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() }), JSON.stringify({ mode: "pilot", applicant_ids: [7], job_ids: [11], started_at: new Date(Date.now() - 3600_000).toISOString(), expires_at: new Date(Date.now() - 1).toISOString() })]) {
    const h = harness({ body });
    assert.equal((await h.post()).status, 409);
    assert.equal(h.state().control.body, body);
    assert.equal(h.state().writes, 0);
  }
});

test("renewal rejects missing versions, unsupported durations and scope-changing payloads", async () => {
  for (const patch of [{ expected_updated_at: undefined }, { expected_updated_at: null }, { duration_hours: 337 }, { duration_hours: "336" }, { applicant_ids: [7, 8] }, { job_ids: [11, 12] }, { mode: "pilot" }, { started_at: "2020-01-01" }, { renewed_at: "2020-01-01" }]) {
    const h = harness();
    assert.equal((await h.post(patch)).status, 400);
    assert.equal(h.state().writes, 0);
  }
});

test("a stale version or concurrent stop cannot be overwritten by renewal", async () => {
  const stale = harness();
  assert.equal((await stale.post({ expected_updated_at: "2026-09-08T00:00:00.000Z" })).status, 409);
  assert.equal(stale.state().writes, 0);
  const race = harness({ race: true });
  assert.equal((await race.post()).status, 409);
  assert.equal(race.state().control.body, "1");
});

test("forced stop, duplicate control and database failures never produce a renewed session", async () => {
  for (const [options, status] of [[{ forced: true }, 409], [{ duplicate: true }, 409], [{ readError: true }, 503], [{ writeError: true }, 500]] as const) {
    const h = harness(options);
    assert.equal((await h.post()).status, status);
    assert.equal(h.state().control.body, h.initial);
  }
});

test("a renewal cannot shorten an already renewed session", async () => {
  const h = harness({ body: JSON.stringify({ mode: "pilot", applicant_ids: [7], job_ids: [11], started_at: new Date(Date.now() - 30 * 86400_000).toISOString(), renewed_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() }) });
  assert.equal((await h.post({ duration_hours: 24 })).status, 409);
  assert.equal(h.state().writes, 0);
});
