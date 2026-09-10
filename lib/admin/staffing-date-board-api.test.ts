import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as boardPolicy from "./staffing-date-board.ts";
import { STAFFING_PREPARATION_EVENT } from "./staffing-preparation.ts";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";

type Row = Record<string, unknown>;
type Response = { status: number; body: boardPolicy.StaffingDateBoardData };
function harness(database: Record<string, Row[]>, fail?: (table: string, from: number) => boolean) {
  const reads: Array<{ table: string; from: number }> = [];
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
      reads.push({ table: this.table, from });
      if (fail?.(this.table, from)) return { data: null, error: { message: "조회 실패" } };
      const rows = database[this.table].filter((row) => this.filters.every((filter) => filter(row))).sort((a, b) => {
        for (const [key, ascending] of this.orders) if (a[key] !== b[key]) return (a[key]! < b[key]! ? -1 : 1) * (ascending ? 1 : -1);
        return 0;
      });
      return { data: rows.slice(from, to + 1), error: null };
    }
  }
  const exports: Record<string, (request: unknown) => Promise<Response>> = {};
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status: number }) => ({ body, status: init?.status ?? 200 }) } },
    "@/lib/supabase": { createServiceClient: () => ({ from: (table: string) => {
      assert.ok(Object.hasOwn(database, table), `Unexpected table: ${table}`);
      return new Query(table);
    } }) },
    "@/lib/admin/staffing-date-board": boardPolicy,
    "@/lib/admin/staffing-preparation": { STAFFING_PREPARATION_EVENT },
    "@/lib/admin/postgrest-pagination": { fetchAllPostgrestRows },
  };
  const path = new URL("../../app/api/admin/staffing-date-board/route.ts", import.meta.url);
  const source = (() => {
    try { return readFileSync(path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  })();
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (name: string) => modules[name] ?? {}, console: { error() {} }, URL, Date, Map, Set });
  const get = (query = "start=2026-09-15&end=2026-09-16") => {
    assert.equal(typeof exports.GET, "function");
    return exports.GET({ url: `http://localhost/api/admin/staffing-date-board?${query}` });
  };
  return { get, reads };
}
function largeFixture() {
  return {
    jobs: Array.from({ length: 1001 }, (_, index) => ({ id: index + 1, title: index === 1000 ? "일반 배송" : "__system__", status: "active",
      closes_at: null, capacity: 2, start_date: "2026-09-15", slot: null, client: null })),
    job_candidates: Array.from({ length: 1001 }, (_, index) => ({ id: index + 1, applicant_id: index + 1, job_id: 1001, agent_stage: null, applicants: { name: `후보 ${index + 1}` } })),
    pool_events: Array.from({ length: 1001 }, (_, index) => ({ id: index + 1, applicant_id: 1001, job_id: 1001, event_type: STAFFING_PREPARATION_EVENT,
      created_at: `2026-09-${index === 1000 ? "11" : "10"}T00:00:00.000Z`,
      meta: { source: "manager", dates: index === 1000 ? [{ date: "2026-09-15", availability: "available", role: "primary_candidate", confirmation: "confirmed" }] : [], training_availability: "", note: "" } })),
  };
}

test("board GET paginates jobs, candidate links and staffing history without messaging or person status", async () => {
  const h = harness(largeFixture());
  const response = await h.get();
  assert.equal(response.status, 200);
  assert.equal(response.body.jobs.length, 1);
  assert.equal(response.body.jobs[0].job_id, 1001);
  assert.equal(response.body.jobs[0].cells[0].confirmed, 1);
  assert.equal(response.body.jobs[0].cells[1].confirmed, 0);
  for (const table of ["jobs", "job_candidates", "pool_events"]) assert.ok(h.reads.some((read) => read.table === table && read.from === 1000));
});

test("invalid comparison ranges fail before database reads and no jobs is a complete empty board", async () => {
  const h = harness({ jobs: [], job_candidates: [], pool_events: [] });
  for (const query of ["", "start=2026-02-29&end=2026-03-01", "start=2026-09-15&end=2026-09-22"]) {
    assert.equal((await h.get(query)).status, 400);
  }
  assert.equal(h.reads.length, 0);
  const empty = await h.get();
  assert.equal(empty.status, 200);
  assert.equal(empty.body.jobs.length, 0);
});

test("a later-page error in any required dataset never becomes zero shortage or partial success", async () => {
  for (const table of ["jobs", "job_candidates", "pool_events"]) {
    const h = harness(largeFixture(), (name, from) => name === table && from === 1000);
    assert.equal((await h.get()).status, 503, table);
  }
});
