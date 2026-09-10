import assert from "node:assert/strict";
import test from "node:test";
import { parseStaffingPreparation } from "./staffing-preparation.ts";

const legacy = { source: "manager", dates: [{ date: "2026-09-15", availability: "available", role: "reserve_candidate" }], training_availability: "오전 가능", note: "기존 팀 메모" };
const training = { status: "completed", backup_intent: "interested", scheduled_at: "2026-09-08T09:00:00+09:00", first_loading_location: "가상 교육장", linked_pro: "가상 프로" };
const first = { id: "11111111-1111-4111-8111-111111111111", kind: "training", date: "2026-09-08", note: " 실제 동승 확인 " };
const second = { id: "22222222-2222-4222-8222-222222222222", kind: "backup", date: "2026-09-09", note: "배송 수행 확인" };

test("old plans and completed training never create actual participation records", () => {
  assert.deepEqual(parseStaffingPreparation(legacy)?.records, []);
  const result = parseStaffingPreparation({ ...legacy, training });
  assert.deepEqual(result?.records, []);
  assert.deepEqual(result?.dates, legacy.dates);
});

test("multiple actual records retain identity and notes without changing planned dates or training status", () => {
  const result = parseStaffingPreparation({ ...legacy, records: [first, second], status: "확정인력" });
  assert.deepEqual(result?.records, [second, { ...first, note: "실제 동승 확인" }]);
  assert.deepEqual(result?.dates, legacy.dates);
  assert.equal(result?.training.status, "reviewing");
  assert.equal((result as unknown as Record<string, unknown>).status, undefined);
  assert.deepEqual(parseStaffingPreparation({ ...legacy, records: [{ note: second.note, date: second.date, kind: second.kind, id: second.id }, first] }), result);
});

test("actual records require unique IDs, valid past or Korean-today dates and bounded notes", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-09T15:01:00Z").getTime() });
  assert.ok(parseStaffingPreparation({ ...legacy, records: [{ ...first, date: "2026-09-10" }] }));
  for (const patch of [{ id: "" }, { id: null }, { kind: "scheduled" }, { date: "2026-09-11" }, { date: "2026-02-30" }, { date: "2026-9-8" }, { note: "가".repeat(1001) }]) {
    assert.equal(parseStaffingPreparation({ ...legacy, records: [{ ...first, ...patch }] }), null, JSON.stringify(patch));
  }
  for (const records of [null, {}, [null], [first, { ...first, kind: "backup" }]]) {
    assert.equal(parseStaffingPreparation({ ...legacy, records }), null);
  }
  assert.equal(parseStaffingPreparation({ ...legacy, records: Array.from({ length: 201 }, (_, i) => ({ ...first, id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` })) }), null);
});
