import assert from "node:assert/strict";
import test from "node:test";
import { parseStaffingPreparation } from "./staffing-preparation.ts";
import { applyStaffingNoteChanges } from "./staffing-note-draft.ts";

const modulePath = "./staffing-missing-results.ts";
const policy = await import(modulePath).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const scheduled = { status: "scheduled", backup_intent: "interested", scheduled_at: "2026-09-14T23:30:00+09:00", first_loading_location: "", linked_pro: "" };
const confirmed = { date: "2026-09-15", availability: "available", role: "primary_candidate", confirmation: "confirmed" };
const preparation = (patch = {}) => ({ source: "manager", dates: [confirmed], training_availability: "", training: scheduled, records: [], note: "", ...patch });
const absence = { kind: "backup", date: "2026-09-15", note: " 본인 미참여 확인 " };
function missing(patch = {}, today = "2026-09-16") {
  assert.equal(typeof policy.getStaffingMissingResults, "function");
  const parsed = parseStaffingPreparation(preparation(patch));
  assert.ok(parsed);
  return policy.getStaffingMissingResults(parsed, today);
}

test("nonparticipation preserves manager plans and legacy omission without creating actual participation", () => {
  assert.equal(Object.hasOwn(parseStaffingPreparation(preparation())!, "non_participations"), false);
  const parsed = parseStaffingPreparation(preparation({ non_participations: [absence] }));
  assert.deepEqual(parsed?.non_participations, [{ ...absence, note: "본인 미참여 확인" }]);
  assert.deepEqual(parsed?.records, []);
  assert.deepEqual(parsed?.dates, [confirmed]);
  assert.deepEqual(parsed?.training, scheduled);
  assert.deepEqual(parseStaffingPreparation(preparation({ non_participations: [] }))?.non_participations, []);
});

test("nonparticipation rejects conflicting results, duplicate kind/date, malformed and future dates", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-09-15T15:00:00Z"));
  assert.ok(parseStaffingPreparation(preparation({ non_participations: [{ ...absence, date: "2026-09-16" }] })));
  for (const value of [null, {}, [null], [absence, absence], [{ ...absence, kind: "scheduled" }], [{ ...absence, kind: ["backup"] }], [{ ...absence, date: "2026-02-30" }],
    [{ ...absence, date: "2026-9-15" }], [{ ...absence, date: "2026-09-17" }], [{ ...absence, note: "가".repeat(1001) }]]) {
    assert.equal(parseStaffingPreparation(preparation({ non_participations: value })), null, JSON.stringify(value));
  }
  assert.equal(parseStaffingPreparation(preparation({ non_participations: [absence],
    records: [{ id: "11111111-1111-4111-8111-111111111111", kind: "backup", date: "2026-09-15", note: "참여" }] })), null);
  assert.ok(parseStaffingPreparation(preparation({ non_participations: [absence, { ...absence, kind: "training" }] })));
  const many = Array.from({ length: 201 }, (_, index) => ({ ...absence,
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10) }));
  assert.ok(parseStaffingPreparation(preparation({ non_participations: many.slice(0, 200) })));
  assert.equal(parseStaffingPreparation(preparation({ non_participations: many })), null);
});

test("missing results begin the next Korean day and require explicit scheduled training or confirmed backup", () => {
  assert.deepEqual(missing({}, "2026-09-14"), []);
  assert.deepEqual(missing({}, "2026-09-15"), [{ kind: "training", date: "2026-09-14" }]);
  assert.deepEqual(missing(), [{ kind: "training", date: "2026-09-14" }, { kind: "backup", date: "2026-09-15" }]);
  for (const status of ["reviewing", "coordinating", "on_hold"]) {
    assert.deepEqual(missing({ training: { ...scheduled, status }, dates: [{ ...confirmed, confirmation: "unconfirmed" }] }), []);
  }
  assert.deepEqual(missing({ training: { ...scheduled, status: "completed" }, dates: [] }), [{ kind: "training", date: "2026-09-14" }]);
  assert.deepEqual(missing({ training: { ...scheduled, scheduled_at: "" }, dates: [{ ...confirmed, confirmation: undefined }] }), []);
});

test("only a result for the same kind and date resolves a missing result", () => {
  const record = { id: "11111111-1111-4111-8111-111111111111", kind: "training", date: "2026-09-14", note: "참여" };
  assert.deepEqual(missing({ records: [record], non_participations: [absence] }), []);
  assert.deepEqual(missing({ records: [{ ...record, date: "2026-09-13" }], non_participations: [{ ...absence, date: "2026-09-13" }] }),
    [{ kind: "training", date: "2026-09-14" }, { kind: "backup", date: "2026-09-15" }]);
});

test("AI note edits preserve nonparticipation and reject an actual participation proposal for the same date", () => {
  const current = parseStaffingPreparation(preparation({ non_participations: [absence] }))!;
  const edited = applyStaffingNoteChanges(current, [{ field: "training_availability", value: "오전 가능", evidence: "오전 가능" }]);
  assert.deepEqual(edited?.non_participations, [{ ...absence, note: "본인 미참여 확인" }]);
  assert.equal(applyStaffingNoteChanges(current, [{ field: "participation", value: { kind: "backup", date: "2026-09-15", note: "참여" }, evidence: "참여" }]), null);
});
