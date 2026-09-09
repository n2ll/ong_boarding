import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as preparationPolicy from "./staffing-preparation.ts";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";

type Row = Record<string, unknown>;
type Response = { status: number; body: Record<string, unknown> };
const KEY = "11111111-1111-4111-8111-111111111111";
const preparation = { source: "manager", dates: [{ date: "2026-09-15", availability: "available", role: "reserve_candidate" }], training_availability: "유급 교육 가능", note: "후보 검토" };
const context = (id = "7") => ({ params: Promise.resolve({ id }) });
const request = (patch: Row = {}) => ({ json: async () => ({ applicant_id: 1, action_key: KEY, ...preparation, ...patch }) });
function event(id: number, meta: unknown = preparation, patch: Row = {}): Row {
  return { id, applicant_id: 1, job_id: 7, event_type: "staffing_preparation", meta, created_at: "2026-09-09T00:00:00.000Z", ...patch };
}

function harness(input: { events?: Row[]; candidates?: Row[]; fail?: (table: string, write: boolean, from?: number) => boolean } = {}) {
  const database: Record<string, Row[]> = { pool_events: input.events ?? [], job_candidates: input.candidates ?? [{ id: 11, job_id: 7, applicant_id: 1 }, { id: 12, job_id: 7, applicant_id: 2 }] };
  const writes: Array<{ table: string; row: Row }> = [];
  class Query {
    private table: string;
    private filters: Array<(row: Row) => boolean> = [];
    private orders: Array<[string, boolean]> = [];
    private insertRow: Row | null = null;
    constructor(table: string) { this.table = table; }
    select() { return this; }
    eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this; }
    in(key: string, values: unknown[]) { this.filters.push((row) => values.includes(row[key])); return this; }
    order(key: string, options: { ascending: boolean }) { this.orders.push([key, options.ascending]); return this; }
    insert(row: Row) { this.insertRow = row; return this; }
    private result(from?: number, to?: number) {
      if (input.fail?.(this.table, !!this.insertRow, from)) return { data: null, error: { code: "XX000", message: "unavailable" } };
      if (this.insertRow) {
        if (database[this.table].some((row) => row.action_key === this.insertRow!.action_key)) return { data: null, error: { code: "23505", message: "duplicate action key" } };
        const row = { id: Math.max(0, ...database[this.table].map((item) => Number(item.id))) + 1, created_at: "2026-09-10T00:00:00.000Z", ...this.insertRow };
        database[this.table].push(row);
        writes.push({ table: this.table, row });
        return { data: [row], error: null };
      }
      const rows = database[this.table].filter((row) => this.filters.every((filter) => filter(row))).sort((a, b) => {
        for (const [key, ascending] of this.orders) {
          if (a[key] !== b[key]) return (a[key]! < b[key]! ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
      return { data: rows.slice(from ?? 0, to === undefined ? 1000 : to + 1), error: null };
    }
    async range(from: number, to: number) { return this.result(from, to); }
    async single() { const result = this.result(); return { ...result, data: result.data?.[0] ?? null }; }
    async maybeSingle() { return this.single(); }
  }
  const exports: Record<string, (req: unknown, context: unknown) => Promise<Response>> = {};
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status: number }) => ({ body, status: init?.status ?? 200 }) } },
    "@/lib/supabase": { createServiceClient: () => ({ from: (table: string) => new Query(table) }) },
    "@/lib/admin/staffing-preparation": preparationPolicy,
    "@/lib/admin/postgrest-pagination": { fetchAllPostgrestRows },
  };
  const routePath = new URL("../../app/api/admin/jobs/[id]/staffing-preparation/route.ts", import.meta.url);
  runInNewContext(ts.transpileModule(readFileSync(routePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (name: string) => modules[name] ?? {}, console: { error() {} }, Date, Map, Set });
  return { route: exports, database, writes };
}

test("GET returns only linked candidates and the latest timestamp/id, with empty snapshots included", async () => {
  const h = harness({ events: [event(1, { ...preparation, note: "old" }), event(2, { ...preparation, note: "latest" }),
    event(3, preparation, { job_id: 8 }), event(4, preparation, { applicant_id: 999 })] });
  const response = await h.route.GET({}, context());
  assert.equal(response.status, 200);
  const rows = response.body.preparations as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.equal((rows[0].preparation as Row).note, "latest");
  assert.equal(rows[0].event_id, 2);
  assert.equal(rows[1].applicant_id, 2);
  assert.equal(rows[1].preparation, null);
  assert.equal(rows[1].invalid, false);
});

test("GET never falls back to an older valid preparation when the latest is malformed", async () => {
  const h = harness({ events: [event(1), event(2, { ...preparation, dates: [{ date: "2026-02-30" }] })] });
  const response = await h.route.GET({}, context());
  const row = (response.body.preparations as Row[])[0];
  assert.equal(row.preparation, null);
  assert.equal(row.event_id, 2);
  assert.equal(row.invalid, true);
});

test("POST appends only manager review metadata and never changes candidate or applicant state", async () => {
  const h = harness();
  const response = await h.route.POST(request({ source: "applicant", status: "확정인력", agent_stage: "active" }), context());
  assert.equal(response.status, 200);
  assert.equal(response.body.deduplicated, false);
  assert.deepEqual(h.writes.map((write) => write.table), ["pool_events"]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.writes[0].row.meta)), preparation);
  assert.equal(h.writes[0].row.job_id, 7);
  assert.equal(h.writes[0].row.applicant_id, 1);
  assert.equal(h.database.job_candidates[0].agent_stage, undefined);
});

test("concurrent retries with one action key save once and accept semantically identical field ordering", async () => {
  const h = harness();
  const reordered = { note: " 후보 검토 ", training_availability: "유급 교육 가능", dates: [{ role: "reserve_candidate", availability: "available", date: "2026-09-15" }] };
  const responses = await Promise.all([h.route.POST(request(), context()), h.route.POST(request(reordered), context())]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.deepEqual(responses.map((response) => response.body.deduplicated).sort(), [false, true]);
  assert.equal(h.writes.length, 1);
  assert.equal(responses[0].body.event_id, responses[1].body.event_id);
});

test("a reused action key with different content or scope returns conflict without overwriting", async () => {
  const h = harness();
  await h.route.POST(request(), context());
  for (const patch of [{ note: "다른 내용" }, { applicant_id: 2 }]) assert.equal((await h.route.POST(request(patch), context())).status, 409);
  assert.equal(h.writes.length, 1);
});

test("different action keys preserve history and a valid explicit reset can replace a malformed latest row", async () => {
  const h = harness({ events: [event(1, { broken: true })] });
  const response = await h.route.POST(request({ dates: [], training_availability: "", note: "" }), context());
  assert.equal(response.status, 200);
  assert.equal(h.database.pool_events.length, 2);
  assert.equal((response.body.preparation as Row).note, "");
  assert.equal(response.body.invalid, false);
});

test("POST rejects unlinked candidates and malformed IDs, action keys or date roles without writes", async () => {
  const h = harness();
  assert.equal((await h.route.POST(request({ applicant_id: 999 }), context())).status, 404);
  for (const patch of [{ action_key: "bad" }, { applicant_id: 0 }, { dates: [{ date: "2026-09-15", availability: "unknown", role: "primary_candidate" }] }]) {
    assert.equal((await h.route.POST(request(patch), context())).status, 400);
  }
  assert.equal((await h.route.GET({}, context("-1"))).status, 400);
  assert.equal(h.writes.length, 0);
});

test("candidate, history and write failures remain errors instead of empty or successful data", async () => {
  for (const table of ["job_candidates", "pool_events"]) {
    const h = harness({ fail: (name) => name === table });
    assert.equal((await h.route.GET({}, context())).status, 503);
    assert.equal((await h.route.POST(request(), context())).status, 503);
    assert.equal(h.writes.length, 0);
  }
});

test("GET reads the complete history and fails closed when a later page is unavailable", async () => {
  const events = Array.from({ length: 1001 }, (_, i) => event(i + 1, { ...preparation, note: `${i + 1}` }));
  const h = harness({ events });
  const response = await h.route.GET({}, context());
  assert.equal(((response.body.preparations as Row[])[0].preparation as Row).note, "1001");
  const failing = harness({ events, fail: (table, write, from) => table === "pool_events" && !write && from === 1000 });
  assert.equal((await failing.route.GET({}, context())).status, 503);
});
