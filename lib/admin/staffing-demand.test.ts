import assert from "node:assert/strict";
import test from "node:test";
import { isStaffingDemandDate, parseStaffingDemand } from "./staffing-demand.ts";

test("demand distinguishes unknown, no operation, and a positive staffing requirement", () => {
  assert.deepEqual(parseStaffingDemand({ state: "unknown", required_count: null }), { state: "unknown", required_count: null });
  assert.deepEqual(parseStaffingDemand({ state: "off", required_count: 0 }), { state: "off", required_count: 0 });
  for (const required_count of [1, 17, 999]) {
    assert.deepEqual(parseStaffingDemand({ state: "operating", required_count }), { state: "operating", required_count });
  }
});

test("invalid or missing counts cannot be coerced into a different demand state", () => {
  for (const input of [null, [], "off", {}, { state: "unknown" }, { state: "unknown", required_count: 0 },
    { state: "off", required_count: null }, { state: "off", required_count: 1 }, { state: "active", required_count: 1 },
    ...[null, 0, -1, 1.5, 1000, Infinity, NaN, "3", true].map((required_count) => ({ state: "operating", required_count }))]) {
    assert.equal(parseStaffingDemand(input), null, JSON.stringify(input));
  }
});

test("work dates must be real calendar days in the exact date-only format", () => {
  for (const date of ["2026-09-10", "2028-02-29", "2026-12-31"]) assert.equal(isStaffingDemandDate(date), true, date);
  for (const date of [null, 20260910, "2026-02-29", "2026-02-30", "2026-13-01", "2026-09-00", "2026-9-10", " 2026-09-10", "2026-09-10T00:00:00Z", "0000-01-01"]) {
    assert.equal(isStaffingDemandDate(date), false, String(date));
  }
});
