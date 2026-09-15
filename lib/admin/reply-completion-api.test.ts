import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";

type Row = Record<string, any>;
const inbound = (id: number, applicant_id = 1, job_id = 10): Row => ({ id, applicant_id, job_id, direction: "inbound", created_at: `2026-09-16T00:00:${String(id).padStart(2, "0")}Z` });
const request = (patch: Row = {}) => ({ json: async () => ({ applicant_id: 1, message_id: 1, outcome: "no_reply", ...patch }) });

async function harness(options: { messages?: Row[]; candidates?: Row[]; drafts?: Row[]; fail?: string; afterRead?: () => void } = {}) {
  const database: Record<string, Row[]> = { messages: options.messages ?? [inbound(1)], job_candidates: options.candidates ?? [], message_drafts: options.drafts ?? [], pool_events: [] };
  const db = { from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const orders: Array<[string, boolean]> = [];
    let start = 0, end = Infinity, insertRow: Row | null = null;
    const value = (row: Row, key: string) => key === "meta->>message_id" ? String(row.meta?.message_id) : row[key];
    const result = () => {
      if (options.fail === table) return { data: null, error: { message: `${table} unavailable` } };
      if (insertRow) {
        if (database[table].some(row => row.action_key === insertRow!.action_key)) return { data: null, error: { code: "23505" } };
        database[table].push(JSON.parse(JSON.stringify({ id: database[table].length + 1, ...insertRow })));
        return { data: null, error: null };
      }
      const rows = database[table].filter(row => filters.every(filter => filter(row))).sort((a, b) => {
        for (const [key, ascending] of orders) { if (a[key] !== b[key]) return (a[key] > b[key] ? 1 : -1) * (ascending ? 1 : -1); }
        return 0;
      }).slice(start, end);
      return { data: rows, error: null };
    };
    const q = {
      select() { return q; },
      eq(key: string, v: unknown) { filters.push(row => value(row, key) === v); return q; },
      in(key: string, values: unknown[]) { filters.push(row => values.includes(value(row, key))); return q; },
      order(key: string, config?: { ascending: boolean }) { orders.push([key, config?.ascending !== false]); return q; },
      limit(n: number) { end = n; return q; },
      range(from: number, to: number) { start = from; end = to + 1; return Promise.resolve(result()); },
      maybeSingle() { const r = result(); if (table === "messages") options.afterRead?.(); return Promise.resolve({ ...r, data: r.data?.[0] ?? null }); },
      insert(row: Row) { assert.equal(table, "pool_events", "only an event may be written"); insertRow = row; return q; },
      then(resolve: any, reject: any) { return Promise.resolve(result()).then(resolve, reject); },
    };
    return q;
  } };
  const status = await import(new URL("./reply-completion-status.ts", import.meta.url).href).catch(() => ({}));
  const completion = await import(new URL("./reply-completion.ts", import.meta.url).href).catch(() => ({}));
  const exports: Row = {};
  let source = "";
  try { source = readFileSync(new URL("../../app/api/admin/messages/complete/route.ts", import.meta.url), "utf8"); } catch {}
  const modules: Row = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status: number }) => ({ body: JSON.parse(JSON.stringify(body)), status: init?.status ?? 200 }) } },
    "@/lib/supabase": { createServiceClient: () => db },
    "@/lib/admin/reply-completion": completion,
    "@/lib/admin/reply-completion-status": status,
    "node:crypto": crypto,
  };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }, console: { error() {} }, Number });
  assert.equal(typeof exports.POST, "function");
  return { post: exports.POST, database, db };
}

test("completion stores one event for the observed inbound and retries do not duplicate it", async () => {
  const h = await harness();
  assert.equal((await h.post(request({ outcome: "call", note: " 전화 확인 " }))).status, 200);
  assert.equal((await h.post(request({ outcome: "call", note: " 전화 확인 " }))).status, 200);
  assert.equal(h.database.pool_events.length, 1);
  assert.equal((await h.post(request({ outcome: "no_reply" }))).status, 409);
  assert.equal(h.database.pool_events[0].event_type, "reply_completed");
  assert.deepEqual(h.database.pool_events[0].meta, { message_id: 1, outcome: "call", note: "전화 확인" });
  assert.deepEqual(h.database.messages, [inbound(1)]);
});

test("newer inbound on another job prevents completion of an old tab", async () => {
  const h = await harness({ messages: [inbound(1), inbound(2, 1, 20)] });
  assert.equal((await h.post(request())).status, 409);
  assert.equal(h.database.pool_events.length, 0);
});

test("an outbound or a message owned by another applicant cannot be completed", async () => {
  for (const messages of [[{ ...inbound(1), direction: "outbound" }], [inbound(1, 2)]]) {
    const h = await harness({ messages });
    assert.equal((await h.post(request())).status, 409);
    assert.equal(h.database.pool_events.length, 0);
  }
});

for (const options of [
  { drafts: [{ id: 1, applicant_id: 1, job_id: 20, status: "pending" }] },
  { candidates: [
    { id: 1, applicant_id: 1, agent_stage: "paused", jobs: { title: "오전 배송" }, agent_state: { meta: { handoff_resolved: { at: "2026-09-16T00:00:00Z" } } } },
    { id: 2, applicant_id: 1, agent_stage: "paused", jobs: { title: "마감된 오후 배송" }, paused_reason: "문의 확인 필요" },
  ] },
]) test("pending review or an unresolved handoff on any job prevents reply completion", async () => {
  const h = await harness(options);
  assert.equal((await h.post(request())).status, 409);
  assert.equal(h.database.pool_events.length, 0);
});

for (const fail of ["messages", "message_drafts", "pool_events", "job_candidates"]) {
  test(`failed ${fail} verification never writes completion`, async () => {
    const h = await harness({ fail });
    assert.equal((await h.post(request())).status, 503);
    assert.equal(h.database.pool_events.length, 0);
  });
}

test("only positive integer ids and documented outcomes are accepted", async () => {
  const h = await harness();
  for (const patch of [{ applicant_id: "1" }, { applicant_id: 0 }, { message_id: 1.2 }, { message_id: null }, { outcome: "closed" }, { note: {} }]) {
    assert.equal((await h.post(request(patch))).status, 400);
  }
  assert.equal(h.database.pool_events.length, 0);
});

test("a fresh inbound arriving after the check is never marked complete by the old event", async () => {
  const messages = [inbound(1)];
  const h = await harness({ messages, afterRead: () => { messages.push(inbound(2, 1, 20)); } });
  assert.equal((await h.post(request())).status, 200);
  assert.equal(h.database.pool_events[0].meta.message_id, 1);
  const { gatherMessagePreviews } = await import(new URL("../message-preview.ts", import.meta.url).href);
  const preview = await gatherMessagePreviews(h.db, [1], { requireComplete: true });
  assert.equal(preview[1].message_id, 2);
  assert.equal(preview[1].reply_completed, false);
  assert.equal((await h.post(request())).status, 409);
});

test("malformed bodies are rejected without recording an event", async () => {
  const h = await harness();
  for (const json of [async () => null, async () => [], async () => { throw new Error("invalid JSON"); }]) {
    assert.equal((await h.post({ json })).status, 400);
  }
  assert.equal(h.database.pool_events.length, 0);
});

test("simultaneous retries create a single completion event", async () => {
  const h = await harness();
  const responses = await Promise.all([h.post(request()), h.post(request())]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(h.database.pool_events.length, 1);
});
