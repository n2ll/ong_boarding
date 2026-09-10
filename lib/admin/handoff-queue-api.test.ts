import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as categories from "../agent/handoff-category.ts";
import * as notificationQuery from "./notification-query-state.ts";
import * as bulkAttention from "./bulk-message-attention.ts";

type Row = Record<string, any>;
const NOW = Date.now();
const daysAgo = (days: number) => new Date(NOW - days * 86400000).toISOString();
const candidate = (id: number, days: number, extra: Row = {}): Row => ({
  id, applicant_id: id, job_id: id, agent_stage: "paused", paused_reason: "문의 확인 필요",
  updated_at: daysAgo(days), agent_state: { meta: { paused_at: daysAgo(days) } },
  jobs: { id, title: "배송 모집", branch: "서울" },
  applicants: { id, name: `후보 ${id}`, phone: null, branch: "서울" }, ...extra,
});

async function harness(rows: Row[], failure = false) {
  const disposition = await import(new URL("./handoff-disposition.ts", import.meta.url).href).catch(() => ({}));
  const db = { from(table: string) {
    let selected = "";
    const filters: Array<[string, unknown]> = [];
    const result = () => {
      if (table === "prompt_examples") return { data: { body: "draft" }, error: null };
      if (table !== "job_candidates") return { data: [], error: null, count: 0 };
      if (failure) return { data: null, error: { message: "unavailable" } };
      const data = rows.filter(row => filters.every(([key, value]) => row[key] === value)).map(row => {
        const projected: Row = {};
        for (const key of ["id", "applicant_id", "job_id", "paused_reason", "agent_state", "updated_at", "jobs", "applicants"]) {
          if (new RegExp(`(?:^|,)\\s*${key}(?:[:,\\s]|$)`).test(selected)) projected[key] = row[key];
        }
        return projected;
      });
      return { data, error: null };
    };
    const query = {
      select(value: string) { selected = value; return query; },
      eq(key: string, value: unknown) { filters.push([key, value]); return query; },
      order() { return query; }, limit() { return query; }, in() { return query; }, lte() { return query; },
      maybeSingle() { return Promise.resolve(result()); },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) { return Promise.resolve(result()).then(resolve, reject); },
    };
    return query;
  } };
  function load(path: string) {
    const exports: Row = {};
    const modules: Row = {
      "next/server": { NextResponse: { json: (body: unknown, init?: { status: number }) => ({ body: JSON.parse(JSON.stringify(body)), status: init?.status ?? 200 }) } },
      "@/lib/supabase": { createServiceClient: () => db },
      "@/lib/agent/handoff-category": categories,
      "@/lib/admin/handoff-disposition": disposition,
      "@/lib/admin/notification-query-state": notificationQuery,
      "@/lib/admin/bulk-message-attention": bulkAttention,
    };
    runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, require: (name: string) => {
      assert.ok(name in modules, `unexpected dependency: ${name}`);
      return modules[name];
    }, console: { error() {} }, Date, process: { env: {} } });
    return exports.GET;
  }
  return {
    handoffs: load("../../app/api/admin/agent/handoffs/route.ts"),
    notifications: load("../../app/api/admin/notifications/route.ts"),
  };
}

test("the real queue and notification routes count the same unresolved work and keep holds accessible", async () => {
  const h = await harness([
    candidate(1, 3, { paused_reason: "단가 문의" }),
    candidate(2, 25, { paused_reason: "매니저 수동 일시정지" }),
    candidate(3, 20, { paused_reason: "관리자 자동 응대 검수 종료" }),
    candidate(4, 30, { jobs: { id: 4, title: "[검수 0907] 낮 배송", branch: null }, paused_reason: "매니저 직접 응답 — 자동 전환" }),
    candidate(5, 1, { paused_reason: "매니저 직접 응답 — 자동 전환" }),
    candidate(6, 10, { agent_state: { meta: { paused_at: daysAgo(10), handoff_resolved: { at: daysAgo(2) } } } }),
    candidate(7, 4, { agent_state: { meta: { paused_at: daysAgo(4), handoff_resolved: { at: daysAgo(20) } } } }),
    // The existing resolve route writes a completion date without backfilling legacy paused_at.
    candidate(8, 30, { agent_state: { meta: { handoff_resolved: { at: daysAgo(2), outcome: "done" } } } }),
    candidate(9, 90, { jobs: null }),
  ]);
  const queue = await h.handoffs({});
  const notices = await h.notifications();
  assert.equal(queue.status, 200);
  assert.deepEqual(queue.body.handoffs.map((row: Row) => row.candidate_id), [7, 1, 5]);
  assert.equal(queue.body.total, 3);
  assert.deepEqual(queue.body.by_category, { policy: 1, pay: 1, auto: 1 });
  assert.deepEqual(queue.body.held.map((row: Row) => row.candidate_id), [4, 2, 3]);
  assert.equal(queue.body.held_total, 3);
  assert.ok(queue.body.held.every((row: Row) => row.hold_label && row.hold_reason));
  assert.equal(notices.status, 200);
  assert.equal(notices.body.counts.interventions, 3);
  assert.equal(notices.body.counts.interventions_oldest_days, 4);
  assert.match(notices.body.items.find((item: Row) => item.id === "live").title, /3건/);
});

test("held-only and failed queries never manufacture actionable notices or successful empty queues", async () => {
  const heldOnly = await harness([candidate(1, 100, { paused_reason: "본인 한정 자동 응대 검수 종료" })]);
  const notices = await heldOnly.notifications();
  assert.equal(notices.body.counts.interventions, 0);
  assert.equal(notices.body.counts.interventions_oldest_days, null);
  assert.equal(notices.body.items.some((item: Row) => item.id === "live"), false);
  const failed = await harness([], true);
  assert.equal((await failed.handoffs({})).status, 500);
  assert.equal((await failed.notifications()).status, 500);
});
