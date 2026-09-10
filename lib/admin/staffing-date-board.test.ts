import assert from "node:assert/strict";
import test from "node:test";

const path = "./staffing-date-board.ts";
const policy = await import(path).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const start = "2026-09-15";
const job = (id: number, patch = {}) => ({ id, title: `배송 ${id}`, status: "active", closes_at: null, capacity: 2, slot: "오전", start_date: start, client: null, ...patch });
const candidate = (applicant_id: number, job_id = 1, patch = {}) => ({ id: applicant_id * 100 + job_id, applicant_id, job_id, agent_stage: "active", applicants: { name: `후보 ${applicant_id}`, status: "확정인력" }, ...patch });
const day = (confirmation?: string, role = "primary_candidate", date = start) => ({ date, availability: "available", role, ...(confirmation ? { confirmation } : {}) });
const event = (id: number, applicant_id: number, job_id: number, dates: unknown[], patch = {}) => ({ id, applicant_id, job_id, event_type: "staffing_preparation", created_at: "2026-09-10T00:00:00.000Z", meta: { source: "manager", dates, training_availability: "", note: "" }, ...patch });
function build(jobs: unknown[], candidates: unknown[] = [], events: unknown[] = [], end = start, demands: unknown[] = []) {
  assert.equal(typeof policy.buildStaffingDateBoard, "function");
  return policy.buildStaffingDateBoard({ start, end, jobs, candidates, events, demands, updated_at: "2026-09-10T01:00:00.000Z" });
}

test("comparison dates are real inclusive calendar days and limited to seven", () => {
  assert.equal(typeof policy.staffingDateBoardDates, "function");
  for (const [from, to] of [["2026-02-29", "2026-03-01"], [start, "2026-09-14"], [start, "2026-09-22"], ["2026-9-15", start], [null, start]]) {
    assert.equal(policy.staffingDateBoardDates(from, to), null);
  }
  assert.deepEqual(policy.staffingDateBoardDates("2026-09-29", "2026-10-01"), ["2026-09-29", "2026-09-30", "2026-10-01"]);
  assert.equal(policy.staffingDateBoardDates(start, "2026-09-21").length, 7);
});

test("only explicit date confirmation fills target while reserve, interest and person status remain separate", () => {
  const result = build([job(1)], [candidate(1), candidate(2), candidate(3), candidate(4)], [
    event(1, 1, 1, [day("confirmed")]), event(2, 2, 1, [day(undefined, "reserve_candidate")]),
    event(3, 3, 1, [day()]), event(4, 4, 1, [day("confirmed")], { event_type: "interest_click" }),
  ], "2026-09-16");
  assert.deepEqual(result.jobs[0].cells, [
    { date: start, target: null, demand_state: "unknown", demand_event_id: null, invalid_demand: false, confirmed: 1, reserve: 1, primary: 2, shortage: null, conflicts: [], invalid_records: 0 },
    { date: "2026-09-16", target: null, demand_state: "unknown", demand_event_id: null, invalid_demand: false, confirmed: 0, reserve: 0, primary: 0, shortage: null, conflicts: [], invalid_records: 0 },
  ]);
});

test("legacy job capacity does not imply date-specific demand", () => {
  const result = build([job(1, { capacity: null }), job(2, { capacity: 0 }), job(3, { capacity: 1 })],
    [candidate(1, 3), candidate(2, 3)], [event(1, 1, 3, [day("confirmed")]), event(2, 2, 3, [day("confirmed")])]);
  assert.deepEqual(result.jobs.map((row: { cells: Array<{ shortage: number | null }> }) => row.cells[0].shortage), [null, null, null]);
});

test("latest history wins, corrupt records warn, and unlinked or aborted candidates never count", () => {
  const result = build([job(1)], [candidate(1), candidate(1), candidate(2), candidate(3, 1, { agent_stage: "abort" })], [
    event(1, 1, 1, [day("confirmed")]), event(5, 1, 1, [day("unconfirmed")]),
    event(2, 2, 1, [day("confirmed")]), event(6, 2, 1, [], { meta: null }),
    event(3, 3, 1, [day("confirmed")]), event(4, 4, 1, [day("confirmed")]),
    event(7, 1, 1, [day("confirmed")], { created_at: "2026-09-09T00:00:00.000Z" }),
  ]);
  assert.deepEqual(result.jobs[0].cells[0], { date: start, target: null, demand_state: "unknown", demand_event_id: null, invalid_demand: false, confirmed: 0, reserve: 0, primary: 1, shortage: null, conflicts: [], invalid_records: 1 });
});

test("same-person confirmed dates warn across all eligible lines without inferring time overlap", () => {
  const result = build([job(1), job(2), job(3), job(4, { status: "closed" }), job(5, { title: "__review__" }),
    job(6, { client: [{ client_type: "baemin_bmart" }] }), job(7, { closes_at: "2020-01-01T00:00:00Z" }),
    job(8, { title: "[검수 2] 배송" }), job(9, { title: "[운영 검증] E2E 테스트 배송" }), job(10, { title: "테스트 물품 배송" })],
    [candidate(1, 1), candidate(1, 2), candidate(1, 3), candidate(1, 4), candidate(1, 5), candidate(1, 6), candidate(1, 7)],
    [event(1, 1, 1, [day("confirmed")]), event(2, 1, 2, [day("confirmed")]), event(3, 1, 3, [day()]),
      event(4, 1, 4, [day("confirmed")]), event(5, 1, 5, [day("confirmed")]), event(6, 1, 6, [day("confirmed")]), event(7, 1, 7, [day("confirmed")])]);
  assert.deepEqual(result.jobs.map((row: { job_id: number }) => row.job_id), [1, 2, 3, 10]);
  assert.deepEqual(result.jobs[0].cells[0].conflicts, [{ applicant_id: 1, name: "후보 1", other_job_id: 2, other_job_title: "배송 2" }]);
  assert.deepEqual(result.jobs[1].cells[0].conflicts, [{ applicant_id: 1, name: "후보 1", other_job_id: 1, other_job_title: "배송 1" }]);
  assert.deepEqual(result.jobs[2].cells[0].conflicts, []);
});

const demand = (id: number, job_id: number, state: string, required_count: number | null, work_date = start) => ({ id, job_id, work_date, state, required_count });
test("daily demand replaces capacity only on that date and off never cancels confirmed people", () => {
  const result = build([job(1, { capacity: 9 })], [candidate(1), candidate(2)],
    [event(1, 1, 1, [day("confirmed"), day("confirmed", "primary_candidate", "2026-09-16")]), event(2, 2, 1, [day("confirmed")])],
    "2026-09-17", [demand(1, 1, "operating", 1), demand(2, 1, "off", 0, "2026-09-16")]);
  assert.deepEqual(result.jobs[0].cells.map((cell: Record<string, unknown>) => [cell.demand_state, cell.target, cell.confirmed, cell.shortage]),
    [["operating", 1, 2, 0], ["off", 0, 1, 0], ["unknown", null, 0, null]]);
});
test("latest demand wins by id, explicit unknown clears demand, corrupt latest never falls back", () => {
  const result = build([job(1), job(2), job(3)], [], [], start, [
    demand(2, 1, "operating", 4), demand(1, 1, "operating", 1),
    demand(3, 2, "operating", 2), demand(4, 2, "unknown", null),
    demand(5, 3, "operating", 2), demand(6, 3, "off", 8), demand(7, 999, "operating", 9),
  ]);
  assert.deepEqual(result.jobs.map((row: { cells: Array<Record<string, unknown>> }) => {
    const cell = row.cells[0]; return [cell.target, cell.shortage, cell.demand_event_id, cell.invalid_demand];
  }), [[4, 4, 2, false], [null, null, 4, false], [null, null, 6, true]]);
});
