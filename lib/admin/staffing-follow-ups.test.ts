import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { STAFFING_PREPARATION_EVENT } from "./staffing-preparation.ts";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";

const policyPath = "./staffing-follow-ups.ts";
const policy = await import(policyPath).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
type Row = Record<string, unknown>;
const job = (id: number, patch = {}) => ({ id, title: `배송 ${id}`, ...patch });
const candidate = (applicant_id: number, job_id = 1, patch = {}) => ({ id: applicant_id * 100 + job_id, applicant_id, job_id, applicants: { name: `후보 ${applicant_id}` }, ...patch });
const followUp = (patch = {}) => ({ owner: "김담당", next_action: "다음 일정 연락", due_date: "2026-09-15", status: "open", last_contact: null, ...patch });
const preparation = (follow_up: unknown) => ({ source: "manager", dates: [], training_availability: "", note: "", follow_up });
const event = (id: number, applicant_id: number, job_id = 1, follow_up: unknown = followUp(), patch = {}) => ({ id, applicant_id, job_id,
  event_type: STAFFING_PREPARATION_EVENT, created_at: "2026-09-10T00:00:00.000Z", meta: preparation(follow_up), ...patch });
function build(jobs: unknown[], candidates: unknown[], events: unknown[]) {
  assert.equal(typeof policy.buildStaffingFollowUps, "function");
  return policy.buildStaffingFollowUps({ jobs, candidates, events });
}

test("all open actions remain visible in due-date order with undated actions last", () => {
  const result = build([job(1), job(2)], [candidate(1), candidate(1, 2), candidate(2), candidate(3), candidate(4), candidate(5)], [
    event(1, 1, 1, followUp({ due_date: "" })), event(2, 1, 2, followUp({ due_date: "2026-09-14" })),
    event(3, 2, 1, followUp({ due_date: "2099-01-01" })), event(4, 3),
    event(5, 4, 1, followUp({ status: "done" })), event(6, 5, 1, followUp({ next_action: " ", due_date: "" })),
  ]);
  assert.deepEqual(result.items.map((item: Row) => [item.job_id, item.applicant_id, item.due_date]),
    [[2, 1, "2026-09-14"], [1, 3, "2026-09-15"], [1, 2, "2099-01-01"], [1, 1, ""]]);
  assert.equal(result.invalid_records, 0);
});

test("latest completed, cleared, legacy and invalid snapshots never revive older actions", () => {
  const result = build([job(1)], [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)], [
    event(1, 1), event(2, 1, 1, followUp({ status: "done" })),
    event(9, 2), event(3, 2, 1, null, { created_at: "2026-09-11T00:00:00.000Z" }),
    event(4, 3), event(5, 3, 1, undefined, { meta: { ...preparation(undefined) } }),
    event(6, 4), event(7, 4, 1, null, { meta: null }),
    event(8, 5), event(10, 5, 1, followUp({ status: "broken" })),
  ]);
  assert.deepEqual(result.items, []);
  assert.equal(result.invalid_records, 2);
});

test("linked manager actions survive closed jobs and aborted candidates while system and review jobs stay hidden", () => {
  const jobs = [job(1, { status: "closed" }), job(2, { closes_at: "2020-01-01T00:00:00Z" }),
    job(3, { client: { client_type: "baemin_bmart" } }), job(4, { title: "__system__" }),
    job(5, { title: "[검수 2] 배송" }), job(6, { title: "[운영 검증] E2E 테스트 배송" }), job(7, { title: "테스트 물품 배송" })];
  const result = build(jobs, jobs.map((row) => candidate(1, row.id, { agent_stage: "abort" })), [
    ...jobs.map((row) => event(row.id, 1, row.id)), event(8, 2), event(9, 1, 99), event(10, 1, 1, null, { event_type: "interest_click" }),
  ]);
  assert.deepEqual(result.items.map((item: Row) => item.job_id), [1, 2, 3, 7]);
  assert.equal(result.invalid_records, 0);
});

test("equal dates sort deterministically and response contains only task and navigation fields", () => {
  const jobs = [job(2), job(1)];
  const candidates = [candidate(2), candidate(1, 2), candidate(1, 1, { applicants: [{ name: "이름" }] })];
  const events = [event(3, 2), event(2, 1, 2), event(1, 1, 1, followUp({
    last_contact: { date: "2020-01-01", method: "phone", result: "비공개 연락 결과" },
  }))];
  const result = build(jobs, candidates, events);
  assert.deepEqual(result.items, build(jobs.toReversed(), candidates.toReversed(), events.toReversed()).items);
  assert.deepEqual(result.items[0], { job_id: 1, job_title: "배송 1", applicant_id: 1, candidate_id: 101,
    name: "이름", owner: "김담당", next_action: "다음 일정 연락", due_date: "2026-09-15" });
  assert.deepEqual(result.items.map((item: Row) => [item.job_id, item.applicant_id]), [[1, 1], [1, 2], [2, 1]]);
});

test("today changes at Korean midnight", (t) => {
  const clock = t.mock.method(Date, "now", () => Date.parse("2026-09-15T14:59:59Z"));
  assert.equal(build([], [], []).today, "2026-09-15");
  clock.mock.mockImplementation(() => Date.parse("2026-09-15T15:00:00Z"));
  assert.equal(build([], [], []).today, "2026-09-16");
});

function harness(database: Record<string, Row[]>, fail?: (table: string, from: number) => boolean) {
  class Query {
    private table: string;
    private filters: Array<(row: Row) => boolean> = [];
    private orders: Array<[string, boolean]> = [];
    constructor(table: string) { this.table = table; }
    select() { return this; }
    eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this; }
    in(key: string, values: unknown[]) { this.filters.push((row) => values.includes(row[key])); return this; }
    order(key: string, options: { ascending: boolean }) { this.orders.push([key, options.ascending]); return this; }
    async range(from: number, to: number) {
      if (fail?.(this.table, from)) return { data: null, error: { message: "조회 실패" } };
      const rows = database[this.table].filter((row) => this.filters.every((filter) => filter(row))).sort((a, b) => {
        for (const [key, ascending] of this.orders) if (a[key] !== b[key]) return (a[key]! < b[key]! ? -1 : 1) * (ascending ? 1 : -1);
        return 0;
      });
      return { data: rows.slice(from, to + 1), error: null };
    }
  }
  const exports: Record<string, () => Promise<{ status: number; body: { today: string; items: Row[]; invalid_records: number } }>> = {};
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status: number }) => ({ body, status: init?.status ?? 200 }) } },
    "@/lib/supabase": { createServiceClient: () => ({ from: (table: string) => new Query(table) }) },
    "@/lib/admin/staffing-follow-ups": policy,
    "@/lib/admin/staffing-preparation": { STAFFING_PREPARATION_EVENT },
    "@/lib/admin/postgrest-pagination": { fetchAllPostgrestRows },
  };
  let source = "";
  try { source = readFileSync(new URL("../../app/api/admin/staffing-follow-ups/route.ts", import.meta.url), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (name: string) => modules[name] ?? {}, console: { error() {} }, Date, Map, Set });
  return async () => {
    assert.equal(typeof exports.GET, "function");
    return exports.GET();
  };
}

function largeFixture() {
  return {
    jobs: Array.from({ length: 1001 }, (_, index) => job(index + 1, { title: index === 1000 ? "배송" : "__system__" })),
    job_candidates: Array.from({ length: 1001 }, (_, index) => candidate(index + 1, 1001)),
    // The completed newest event occupies page one; old open history must never revive it.
    pool_events: [...Array.from({ length: 1001 }, (_, index) => event(index + 1, index + 1, 1001)),
      event(1002, 1, 1001, followUp({ status: "done" }))],
  };
}

test("GET reads every job, candidate and history page before reporting pending actions", async () => {
  const response = await harness(largeFixture())();
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 1000);
  assert.equal(response.body.items[0].applicant_id, 2);
  assert.equal(response.body.items[999].applicant_id, 1001);
});

test("GET chunks more than 250 real jobs and returns a complete empty response", async () => {
  const ids = Array.from({ length: 251 }, (_, index) => index + 1);
  const response = await harness({ jobs: ids.map((id) => job(id)), job_candidates: ids.map((id) => candidate(1, id)), pool_events: ids.map((id) => event(id, 1, id)) })();
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 251);
  const empty = await harness({ jobs: [], job_candidates: [], pool_events: [] })();
  assert.equal(empty.status, 200);
  assert.equal(empty.body.items.length, 0);
  assert.equal(empty.body.invalid_records, 0);
});

test("GET returns 503 when any required dataset fails on a later page", async () => {
  for (const table of ["jobs", "job_candidates", "pool_events"]) {
    const response = await harness(largeFixture(), (name, from) => name === table && from === 1000)();
    assert.equal(response.status, 503, table);
    assert.equal(Object.hasOwn(response.body, "items"), false);
  }
});
