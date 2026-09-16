import assert from "node:assert/strict";
import test from "node:test";
import type { StaffingDateBoardCell, StaffingDateBoardData } from "./staffing-date-board.ts";

const path = "./dashboard-staffing-gaps.ts";
const policy = await import(path).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const start = "2026-09-16";
const end = "2026-09-22";
const cell = (patch: Partial<StaffingDateBoardCell> = {}): StaffingDateBoardCell => ({
  date: start, target: 3, demand_state: "operating", demand_event_id: 1, invalid_demand: false,
  confirmed: 1, reserve: 0, primary: 1, shortage: 2, conflicts: [], invalid_records: 0, ...patch,
});
const job = (job_id: number, cells: StaffingDateBoardCell[]): StaffingDateBoardData["jobs"][number] => ({
  job_id, title: `배송 ${job_id}`, slot: "오전", start_date: start, capacity: 20, cells,
});
function build(jobs: StaffingDateBoardData["jobs"]) {
  assert.equal(typeof policy.buildDashboardStaffingGaps, "function");
  return policy.buildDashboardStaffingGaps({ start, end, jobs, updated_at: "2026-09-16T01:00:00.000Z" });
}

test("reserve and primary candidates never fill a saved daily shortage", () => {
  assert.deepEqual(build([job(1, [cell({ reserve: 8, primary: 12 })])]), {
    items: [{ job_id: 1, title: "배송 1", date: start, kind: "shortage", label: "2명 부족", detail: "필요 3명 · 확정 1명 · 예비 후보 8명" }],
    unknownCount: 0, firstUnknownDate: null,
  });
});

test("unknown demand is counted separately without falling back to capacity or start date", () => {
  const result = build([job(1, [
    cell({ date: end, demand_state: "unknown", target: null, shortage: null }),
    cell({ demand_state: "unknown", target: null, shortage: 19 }),
  ])]);
  assert.deepEqual(result, { items: [], unknownCount: 2, firstUnknownDate: start });
});

test("corrupt demand becomes review work without claiming a shortage", () => {
  const result = build([job(1, [cell({ invalid_demand: true })])]);
  assert.equal(result.items[0].kind, "review");
  assert.match(result.items[0].detail, /수요 기록/);
  assert.doesNotMatch(`${result.items[0].label} ${result.items[0].detail}`, /부족|필요 3명/);
  assert.equal(result.unknownCount, 1);
});

test("corrupt preparation records suppress a numeric shortage claim", () => {
  const result = build([job(1, [cell({ invalid_records: 2 })])]);
  assert.equal(result.items[0].kind, "review");
  assert.match(result.items[0].detail, /최근 기록 2명 확인 불가/);
  assert.doesNotMatch(`${result.items[0].label} ${result.items[0].detail}`, /부족/);
});

test("same-day confirmations expose candidate names and other job titles even when filled", () => {
  const result = build([job(1, [cell({ confirmed: 3, shortage: 0, conflicts: [
    { applicant_id: 1, name: "김영수", other_job_id: 2, other_job_title: "강남 배송" },
    { applicant_id: 2, name: "이정희", other_job_id: 3, other_job_title: "서초 배송" },
  ] })])]);
  assert.equal(result.items[0].kind, "review");
  for (const text of ["같은 날", "김영수", "강남 배송", "이정희", "서초 배송"]) assert.ok(result.items[0].detail.includes(text));
});

test("an off date with confirmed people remains review work", () => {
  const result = build([job(1, [cell({ demand_state: "off", target: 0, confirmed: 1, shortage: 0 })])]);
  assert.equal(result.items[0].kind, "review");
  assert.match(result.items[0].detail, /운행 없는 날에 확정 인원 있음/);
});

test("confirmed people above a valid daily target require review", () => {
  const result = build([job(1, [cell({ target: 1, confirmed: 2, shortage: 0 })])]);
  assert.equal(result.items[0].kind, "review");
  assert.match(result.items[0].detail, /필요 인원보다 확정 인원 많음/);
});

test("simultaneous record, duplicate-confirmation, and excess-target risks remain visible", () => {
  const result = build([job(1, [cell({ target: 1, confirmed: 2, shortage: 0, invalid_records: 1,
    conflicts: [{ applicant_id: 1, name: "김영수", other_job_id: 2, other_job_title: "강남 배송" }],
  })])]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, "review");
  for (const text of ["최근 기록", "김영수", "강남 배송", "필요 인원보다"]) assert.ok(result.items[0].detail.includes(text));
});

test("unknown demand with a conflict is both counted as unknown and shown for review", () => {
  const result = build([job(1, [cell({ demand_state: "unknown", target: null, shortage: null,
    conflicts: [{ applicant_id: 1, name: "김영수", other_job_id: 2, other_job_title: "강남 배송" }],
  })])]);
  assert.equal(result.items[0].kind, "review");
  assert.equal(result.unknownCount, 1);
  assert.equal(result.firstUnknownDate, start);
});

test("healthy off and filled dates are omitted and an empty board stays empty", () => {
  const expected = { items: [], unknownCount: 0, firstUnknownDate: null };
  assert.deepEqual(build([job(1, [cell({ confirmed: 3, shortage: 0 }), cell({ date: end, demand_state: "off", target: 0, confirmed: 0, shortage: 0 })])]), expected);
  assert.deepEqual(build([]), expected);
});

test("only dates within the window are sorted by date and stable job order without mutating input", () => {
  const jobs = [job(5, [cell({ date: end }), cell(), cell({ date: "2026-09-15" })]),
    job(2, [cell(), cell({ date: "2026-09-23", target: null, demand_state: "unknown" }), cell({ date: end })])];
  const before = structuredClone(jobs);
  const result = build(jobs);
  assert.deepEqual(result.items.map((item: { date: string; job_id: number }) => [item.date, item.job_id]),
    [[start, 5], [start, 2], [end, 5], [end, 2]]);
  assert.equal(result.unknownCount, 0);
  assert.deepEqual(jobs, before);
});
