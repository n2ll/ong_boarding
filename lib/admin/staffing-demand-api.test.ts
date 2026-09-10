import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as demandPolicy from "./staffing-demand.ts";
import { isStaffingDateBoardJob } from "./staffing-date-board.ts";

type Row = Record<string, unknown>;
type Response = { status: number; body: { event?: Row; latest?: Row | null; error?: string } };
const TABLE = "job_staffing_demand_events";
const KEY = "11111111-1111-4111-8111-111111111111";
const NEXT_KEY = "22222222-2222-4222-8222-222222222222";
const context = (id = "7") => ({ params: Promise.resolve({ id }) });
const request = (patch: Row = {}) => ({ cookies: { getAll: () => [] }, json: async () => ({
  date: "2026-09-15", state: "operating", required_count: 3, base_event_id: null, action_key: KEY, actor_name: "김운영", ...patch,
}) });
const job = (patch: Row = {}) => ({ id: 7, title: "일반 배송 A", status: "active", closes_at: null, slot: null, start_date: null, capacity: 9, client: null, ...patch });

function harness(input: { user?: string | null; jobs?: Row[]; fail?: (table: string, write: boolean, filters: Array<[string, unknown]>) => boolean;
  beforeRead?: (table: string, filters: Array<[string, unknown]>, rows: Row[]) => void } = {}) {
  const database: Record<string, Row[]> = { jobs: input.jobs ?? [job(), job({ id: 8 })], [TABLE]: [] };
  const writes: Array<{ table: string; row: Row }> = [];
  class Query {
    filters: Array<[string, unknown]> = [];
    orders: Array<[string, boolean]> = [];
    count = 1000;
    inserted: Row | null = null;
    table: string;
    constructor(table: string) { this.table = table; }
    select() { return this; }
    eq(key: string, value: unknown) { this.filters.push([key, value]); return this; }
    order(key: string, options: { ascending: boolean }) { this.orders.push([key, options.ascending]); return this; }
    limit(count: number) { this.count = count; return this; }
    insert(row: Row) { this.inserted = row; return this; }
    result() {
      if (input.fail?.(this.table, this.inserted !== null, this.filters)) return { data: null, error: { code: "XX000", message: "unavailable" } };
      if (!(this.table in database)) throw new Error(`Unexpected table: ${this.table}`);
      const rows = database[this.table];
      if (this.inserted) {
        const value = this.inserted;
        if (rows.some((row) => row.request_key === value.request_key
          || (row.job_id === value.job_id && row.work_date === value.work_date && row.base_event_id === value.base_event_id))) {
          return { data: null, error: { code: "23505", message: "unique demand version or request" } };
        }
        const row = { id: rows.length + 1, created_at: "2026-09-10T00:00:00.000Z", ...value };
        rows.push(row);
        writes.push({ table: this.table, row });
        return { data: row, error: null };
      }
      input.beforeRead?.(this.table, this.filters, rows);
      const selected = rows.filter((row) => this.filters.every(([key, value]) => row[key] === value)).sort((a, b) => {
        for (const [key, ascending] of this.orders) if (a[key] !== b[key]) return (a[key]! < b[key]! ? -1 : 1) * (ascending ? 1 : -1);
        return 0;
      }).slice(0, this.count);
      return { data: selected[0] ?? null, error: null };
    }
    async single() { return this.result(); }
    async maybeSingle() { return this.result(); }
  }
  const exports: { POST?: (req: unknown, context: unknown) => Promise<Response> } = {};
  const modules: Record<string, unknown> = {
    "@supabase/ssr": { createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: input.user === null ? null : { id: input.user ?? "verified-account" } }, error: null }) } }) },
    "next/server": { NextResponse: { json: (body: unknown, init?: { status: number }) => ({ body, status: init?.status ?? 200 }) } },
    "@/lib/supabase": { createServiceClient: () => ({ from: (table: string) => new Query(table) }) },
    "@/lib/admin/staffing-demand": demandPolicy,
    "@/lib/admin/staffing-date-board": { isStaffingDateBoardJob },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("../../app/api/admin/jobs/[id]/staffing-demand/route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports, require: (name: string) => { if (!(name in modules)) throw new Error(`Unexpected module: ${name}`); return modules[name]; },
    console: { error() {} }, Date, process: { env: { NEXT_PUBLIC_SUPABASE_URL: "http://auth.example.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture" } } });
  return { post: (req = request(), ctx = context()) => exports.POST!(req, ctx), database, writes };
}

test("save appends only the selected job/day demand and attributes the verified account", async () => {
  const h = harness();
  const response = await h.post(request({ actor_name: " 김운영 ", actor: { account_id: "forged" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.event)), { id: 1, job_id: 7, work_date: "2026-09-15", state: "operating", required_count: 3,
    base_event_id: null, request_key: KEY, actor: { account_id: "verified-account", name: "김운영" }, created_at: "2026-09-10T00:00:00.000Z" });
  assert.equal((await h.post(request({ action_key: NEXT_KEY, date: "2026-09-16", state: "off", required_count: 0 }))).status, 200);
  assert.equal(h.writes.length, 2);
  assert.ok(h.writes.every((write) => write.table === TABLE));
  assert.deepEqual(h.database[TABLE].map((row) => [row.work_date, row.required_count]), [["2026-09-15", 3], ["2026-09-16", 0]]);
});

test("unknown is saved explicitly without becoming zero", async () => {
  const h = harness();
  const response = await h.post(request({ state: "unknown", required_count: null }));
  assert.equal(response.status, 200);
  assert.equal(response.body.event?.required_count, null);
});

test("unauthenticated and malformed requests cannot save demand", async () => {
  const anonymous = harness({ user: null });
  assert.equal((await anonymous.post()).status, 401);
  assert.equal(anonymous.writes.length, 0);
  const h = harness();
  for (const patch of [{ date: "2026-02-30" }, { date: "2026-9-15" }, { action_key: "bad" }, { base_event_id: undefined },
    { base_event_id: 0 }, { base_event_id: "1" }, { actor_name: " " }, { actor_name: "가".repeat(81) },
    { state: "off", required_count: 3 }, { state: "unknown", required_count: 0 }, { required_count: "3" }, { required_count: 1000 }]) {
    assert.equal((await h.post(request(patch))).status, 400, JSON.stringify(patch));
  }
  for (const id of ["0", "7.5", "7x", "-7", "9007199254740992"]) assert.equal((await h.post(request(), context(id))).status, 400);
  for (const value of [null, [], "body"]) assert.equal((await h.post({ cookies: { getAll: () => [] }, json: async () => value } as unknown as ReturnType<typeof request>)).status, 400);
  assert.equal(h.writes.length, 0);
});

test("only currently recruiting general delivery jobs accept new demand", async () => {
  for (const patch of [{ status: "closed" }, { closes_at: "2020-01-01T00:00:00Z" }, { title: "__danggeun_system__" },
    { title: "[검수 3] 배송" }, { title: "[운영 검증] 배송 E2E 테스트" }, { client: { client_type: "baemin_bmart" } }]) {
    const h = harness({ jobs: [job(patch)] });
    assert.equal((await h.post()).status, 409, JSON.stringify(patch));
    assert.equal(h.writes.length, 0);
  }
  const absent = harness({ jobs: [] });
  assert.equal((await absent.post()).status, 404);
});

test("a committed retry returns its original event after later edits or job closure", async () => {
  const h = harness();
  const first = await h.post();
  assert.equal((await h.post(request({ base_event_id: 1, action_key: NEXT_KEY, required_count: 5 }))).status, 200);
  h.database.jobs[0].status = "closed";
  const replay = await h.post();
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.event, first.body.event);
  assert.equal(h.writes.length, 2);
});

test("the same request key cannot authorize different content, actor, day, or job", async () => {
  const h = harness();
  await h.post();
  for (const patch of [{ required_count: 4 }, { actor_name: "이운영" }, { date: "2026-09-16" }, { base_event_id: 1 }]) {
    assert.equal((await h.post(request(patch))).status, 409);
  }
  const otherJob = await h.post(request(), context("8"));
  assert.equal(otherJob.status, 409);
  assert.equal(otherJob.body.latest, null);
  assert.equal(h.writes.length, 1);
});

test("stale editors receive the latest record without overwriting it", async () => {
  const h = harness();
  await h.post();
  const stale = await h.post(request({ action_key: NEXT_KEY, required_count: 5 }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.latest?.id, 1);
  assert.equal(stale.body.latest?.required_count, 3);
  assert.equal(h.writes.length, 1);
});

test("racing editors on an empty date keep one winner and return its record to the loser", async () => {
  const h = harness();
  const responses = await Promise.all([h.post(), h.post(request({ action_key: NEXT_KEY, required_count: 5 }))]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(h.writes.length, 1);
  assert.equal(responses.find((response) => response.status === 409)?.body.latest?.id, 1);
});

test("concurrent identical retries save once and both return the saved result", async () => {
  const h = harness();
  const responses = await Promise.all([h.post(), h.post()]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(responses[0].body.event?.id, responses[1].body.event?.id);
  assert.equal(h.writes.length, 1);
});

test("concurrent request-key reuse across dates is rejected without a second insert", async () => {
  const h = harness();
  const responses = await Promise.all([h.post(), h.post(request({ date: "2026-09-16" }))]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(h.writes.length, 1);
});

test("job, history, retry, and insert failures return unavailable rather than unknown demand", async () => {
  for (const fail of [
    (table: string) => table === "jobs",
    (table: string, write: boolean, filters: Array<[string, unknown]>) => table === TABLE && !write && filters.some(([key]) => key === "work_date"),
    (table: string, write: boolean, filters: Array<[string, unknown]>) => table === TABLE && !write && filters.some(([key]) => key === "request_key"),
    (table: string, write: boolean) => table === TABLE && write,
  ]) {
    const h = harness({ fail });
    assert.equal((await h.post()).status, 503);
    assert.equal(h.writes.length, 0);
  }
});

test("a failed latest-record read while reporting key reuse returns 503", async () => {
  let failConflictRead = false;
  const h = harness({ fail: (table, write, filters) => failConflictRead && table === TABLE && !write && filters.some(([key]) => key === "work_date") });
  assert.equal((await h.post()).status, 200);
  failConflictRead = true;
  assert.equal((await h.post(request({ required_count: 4 }))).status, 503);
  assert.equal(h.writes.length, 1);
});

const concurrentSavedEvent = { id: 1, job_id: 7, work_date: "2026-09-15", state: "operating", required_count: 3,
  base_event_id: null, request_key: KEY, actor: { account_id: "verified-account", name: "김운영" }, created_at: "2026-09-10T00:00:00.000Z" };
const commitBetweenReads = (table: string, filters: Array<[string, unknown]>, rows: Row[]) => {
  if (table === TABLE && !rows.length && filters.some(([key]) => key === "work_date")) rows.push({ ...concurrentSavedEvent });
};

test("a concurrent retry committed between request and version reads returns the saved event", async () => {
  const h = harness({ beforeRead: commitBetweenReads });
  const response = await h.post();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.event, concurrentSavedEvent);
  assert.equal(h.database[TABLE].length, 1);
  assert.equal(h.writes.length, 0);
});

test("a stale-version retry lookup failure returns 503 and preserves the committed event", async () => {
  let requestReads = 0;
  const h = harness({ beforeRead: commitBetweenReads,
    fail: (table, write, filters) => table === TABLE && !write && filters.some(([key]) => key === "request_key") && ++requestReads > 1 });
  assert.equal((await h.post()).status, 503);
  assert.equal(h.database[TABLE].length, 1);
  assert.equal(h.writes.length, 0);
});
