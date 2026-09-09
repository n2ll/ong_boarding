import assert from "node:assert/strict";
import test from "node:test";

type Preparation = { source: "manager"; dates: Array<{ date: string; availability: string; role: string }>; training_availability: string; note: string };
const modulePath = "./staffing-preparation.ts";
const policy = await import(modulePath).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
}) as { parseStaffingPreparation?: (value: unknown) => Preparation | null };
function parse(value: unknown) {
  assert.equal(typeof policy.parseStaffingPreparation, "function");
  return policy.parseStaffingPreparation!(value);
}
function preparation(patch: Record<string, unknown> = {}) {
  return { source: "manager", dates: [{ date: "2026-09-15", availability: "available", role: "reserve_candidate" }], training_availability: "월요일 오전", note: "교육 후 후보 검토", ...patch };
}

test("staffing preparation normalizes manager review fields without confirming work", () => {
  assert.deepEqual(parse(preparation({ dates: [
    { date: "2026-09-16", availability: "unknown", role: "unassigned" },
    { date: "2026-09-15", availability: "available", role: "primary_candidate" },
  ], training_availability: " 월요일 오전 ", note: " 검토 중 ", status: "확정인력", agent_stage: "active" })), preparation({ dates: [
    { date: "2026-09-15", availability: "available", role: "primary_candidate" },
    { date: "2026-09-16", availability: "unknown", role: "unassigned" },
  ], training_availability: "월요일 오전", note: "검토 중" }));
});

test("candidate roles require available dates and never accept assignment roles", () => {
  for (const date of [
    { date: "2026-09-15", availability: "unknown", role: "primary_candidate" },
    { date: "2026-09-15", availability: "unavailable", role: "reserve_candidate" },
    { date: "2026-09-15", availability: "available", role: "confirmed" },
  ]) assert.equal(parse(preparation({ dates: [date] })), null);
  assert.ok(parse(preparation({ dates: [{ date: "2026-09-15", availability: "unavailable", role: "unassigned" }] })));
});

test("calendar dates must exist and be unique, with at most 31 review dates", () => {
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-9-15", "2026-09-15T00:00:00Z"]) {
    assert.equal(parse(preparation({ dates: [{ date, availability: "available", role: "unassigned" }] })), null, date);
  }
  assert.ok(parse(preparation({ dates: [{ date: "2028-02-29", availability: "available", role: "unassigned" }] })));
  const dates = Array.from({ length: 31 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, availability: "unknown", role: "unassigned" }));
  assert.equal(parse(preparation({ dates }))?.dates.length, 31);
  assert.equal(parse(preparation({ dates: [...dates, { ...dates[0], date: "2026-11-01" }] })), null);
  assert.equal(parse(preparation({ dates: [dates[0], dates[0]] })), null);
});

test("empty review dates allow training-only notes and oversized or malformed data is rejected", () => {
  assert.deepEqual(parse(preparation({ dates: [], training_availability: "", note: "" })), preparation({ dates: [], training_availability: "", note: "" }));
  assert.ok(parse(preparation({ training_availability: "가".repeat(240), note: "가".repeat(1000) })));
  for (const patch of [{ source: "applicant" }, { dates: null }, { training_availability: "가".repeat(241) }, { note: "가".repeat(1001) }, { note: null }]) {
    assert.equal(parse(preparation(patch)), null);
  }
  for (const value of [null, [], "broken"]) assert.equal(parse(value), null);
});
