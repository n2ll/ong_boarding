import test from "node:test";
import assert from "node:assert/strict";
import { canOpenStaffingRecord, parseStaffingRecordEntry } from "./staffing-record-entry.ts";
import { emptyStaffingTraining, type StaffingPreparationSnapshot } from "./staffing-preparation.ts";

const empty: StaffingPreparationSnapshot = { applicant_id: 7, event_id: null, preparation: null, invalid: false, updated_at: null, actor: null, history: [] };
const saved: StaffingPreparationSnapshot = { ...empty, event_id: 3, preparation: { source: "manager", dates: [], training_availability: "", training: emptyStaffingTraining(), note: "", records: [] } };

test("entry retains the explicitly selected job, applicant and editor purpose", () => {
  for (const mode of ["follow_up", "training", "participation"] as const) {
    assert.deepEqual(parseStaffingRecordEntry(new URLSearchParams(`record_job=12&record_applicant=7&record_mode=${mode}`)), { jobId: 12, applicantId: 7, mode });
  }
});

test("incomplete or malformed entry cannot fall back to a different target or editor", () => {
  for (const query of ["record_job=12", "record_job=0&record_applicant=7", "record_job=12&record_applicant=-1", "record_job=9007199254740992&record_applicant=7", "record_job=12&record_applicant=7&record_mode=confirmation", "followup_job=12&followup_applicant=7"]) {
    assert.equal(parseStaffingRecordEntry(new URLSearchParams(query)), null, query);
  }
});

test("new entry accepts only explicit empty snapshots; existing follow-ups still require saved records", () => {
  assert.equal(canOpenStaffingRecord(empty, true), true);
  assert.equal(canOpenStaffingRecord(empty, false), false);
  for (const allowEmpty of [true, false]) {
    assert.equal(canOpenStaffingRecord(saved, allowEmpty), true);
    for (const value of [undefined, { ...empty, invalid: true }, { ...saved, invalid: true }, { ...saved, preparation: null }, { ...saved, event_id: null }]) {
      assert.equal(canOpenStaffingRecord(value, allowEmpty), false);
    }
  }
});
