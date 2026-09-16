import assert from "node:assert/strict";
import test from "node:test";
import { createStaffingDemandBatch, runStaffingDemandBatch, type StaffingDemandBatchItem } from "./staffing-demand-batch.ts";
import type { StaffingDateBoardCell, StaffingDateBoardData } from "./staffing-date-board.ts";

const dates = ["2099-09-21", "2099-09-22", "2099-09-23", "2099-09-24"];
const cell = (date: string, patch: Partial<StaffingDateBoardCell> = {}): StaffingDateBoardCell => ({
  date, target: null, demand_state: "unknown", demand_event_id: null, invalid_demand: false,
  confirmed: 0, reserve: 0, primary: 0, shortage: null, conflicts: [], invalid_records: 0, ...patch,
});
const board = (): StaffingDateBoardData => ({ start: dates[0], end: dates[3], updated_at: "2099-09-20T00:00:00Z",
  jobs: [11, 12].map(job_id => ({ job_id, title: `배송 ${job_id}`, slot: null, start_date: null, capacity: 9, cells: dates.map(date => cell(date)) })),
});
const input = () => ({ data: board(), jobIds: [11], dates, state: "operating" as const, requiredCount: 1, actorName: " 매니저 " });
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const event = (item: StaffingDemandBatchItem, id = 100) => ({ id, job_id: item.jobId, work_date: item.date,
  state: item.body.state, required_count: item.body.required_count, base_event_id: null, request_key: item.body.action_key,
  actor: { account_id: "verified-manager", name: item.body.actor_name }, created_at: "2099-09-20T00:00:00Z" });

test("batch includes selected blank cells while preserving explicit unknown and damaged demand", () => {
  const draft = input();
  draft.data.jobs[0].cells[1] = cell(dates[1], { demand_event_id: 4 });
  draft.data.jobs[0].cells[2] = cell(dates[2], { invalid_demand: true });
  draft.data.jobs[0].cells[3] = cell(dates[3], { target: 4, demand_state: "operating", demand_event_id: 8 });
  draft.jobIds.push(11);
  draft.dates = [...dates, dates[0]];
  const batch = createStaffingDemandBatch(draft, () => "fixed-key");
  assert.deepEqual(batch.items.map(item => [item.jobId, item.date, item.status]), [[11, dates[0], "pending"]]);
  assert.deepEqual(batch.items[0].body, { date: dates[0], state: "operating", required_count: 1,
    base_event_id: null, action_key: "fixed-key", actor_name: "매니저" });
  assert.deepEqual(batch.skipped.map(item => [item.date, item.reason]), [[dates[1], "existing"], [dates[2], "invalid"], [dates[3], "existing"]]);
  assert.deepEqual(batch.warnings, [{ jobId: 11, title: "배송 11", date: dates[2], message: "수요 기록 확인 필요" }]);
  assert.ok(Object.isFrozen(batch.items[0].body));
  assert.equal(draft.data.jobs[0].capacity, 9);
});

test("batch rejects stale selections and invalid inputs without generating requests", () => {
  let keys = 0;
  for (const patch of [
    { jobIds: [] }, { jobIds: [999] }, { dates: [] }, { dates: ["2099-09-25"] },
    { requiredCount: 0 }, { requiredCount: 1.5 }, { requiredCount: 1000 },
    { actorName: " " }, { actorName: "가".repeat(81) }, { data: { ...board(), end: "2099-09-28" } },
  ]) assert.throws(() => createStaffingDemandBatch({ ...input(), ...patch }, () => String(++keys)));
  assert.equal(keys, 0);
  const draft = input();
  draft.data.jobs[0].cells = [cell(dates[0], { invalid_demand: undefined })];
  assert.equal(createStaffingDemandBatch(draft).items.length, 0);
});

test("off uses zero demand and warns about confirmations or unresolved records without modifying them", () => {
  const draft = input();
  draft.data.jobs[0].cells[0] = cell(dates[0], { confirmed: 2 });
  draft.data.jobs[0].cells[1] = cell(dates[1], { invalid_records: 1 });
  draft.data.jobs[0].cells[2] = cell(dates[2], { conflicts: [{ applicant_id: 3, name: "후보", other_job_id: 12, other_job_title: "다른 배송" }] });
  const before = JSON.stringify(draft.data);
  const batch = createStaffingDemandBatch({ ...draft, state: "off" }, () => "fixed-key");
  assert.ok(batch.items.every(item => item.body.state === "off" && item.body.required_count === 0));
  assert.deepEqual(batch.warnings.map(item => item.date), dates.slice(0, 3));
  assert.ok(batch.warnings.every(item => item.message.length > 0));
  assert.equal(JSON.stringify(draft.data), before);
});

test("partial failures retry only unresolved items with the original payload and bounded concurrency", async () => {
  let keys = 0;
  const batch = createStaffingDemandBatch({ ...input(), jobIds: [11, 12] }, () => `key-${++keys}`);
  const calls: string[] = [], committed = new Map<string, ReturnType<typeof event>>();
  let active = 0, peak = 0, attempt = 0;
  const send = async (item: StaffingDemandBatchItem) => {
    calls.push(JSON.stringify(item.body));
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    if (item.body.action_key === "key-2") return response(409, { error: "동료가 먼저 저장했어요.", latest: null });
    if (item.body.action_key === "key-4" && attempt === 0) return response(503, { error: "일시적인 저장 실패" });
    const saved = committed.get(item.body.action_key) ?? event(item, committed.size + 1);
    committed.set(item.body.action_key, saved);
    if (item.body.action_key === "key-3" && attempt === 0) throw new Error("응답 연결 끊김");
    return response(200, { event: saved });
  };
  const updates: StaffingDemandBatchItem[] = [];
  const first = await runStaffingDemandBatch(batch.items, { send, onResult: item => updates.push(item) });
  assert.deepEqual(first.map(item => item.status), ["saved", "conflict", "failed", "failed", "saved", "saved", "saved", "saved"]);
  assert.equal(updates.length, 8);
  assert.equal(peak, 3);
  assert.ok(batch.items.every(item => item.status === "pending"));
  attempt++;
  const retry = await runStaffingDemandBatch(first, { send });
  assert.deepEqual(retry.map(item => item.status), ["saved", "conflict", "saved", "saved", "saved", "saved", "saved", "saved"]);
  assert.deepEqual(calls.slice(8), [JSON.stringify(batch.items[2].body), JSON.stringify(batch.items[3].body)]);
  assert.equal(committed.size, 7);
});

test("malformed responses remain failed so uncertain saves keep their retry key", async () => {
  const { items } = createStaffingDemandBatch(input(), () => "fixed-key");
  const invalidResponses = [response(200, {}), response(200, { event: { ...event(items[0]), request_key: "another-key" } }),
    new Response("unavailable", { status: 503 }), new Response("expired", { status: 401 })];
  let index = 0;
  const result = await runStaffingDemandBatch(items, { send: async () => invalidResponses[index++] });
  assert.ok(result.every(item => item.status === "failed" && item.error));
  assert.ok(result.every(item => item.body.action_key === "fixed-key"));
});
