import assert from "node:assert/strict";
import test from "node:test";
import { parseStaffingPreparation } from "./staffing-preparation.ts";

const legacy = { source: "manager", dates: [], training_availability: "오전 가능", note: "기존 메모" };
const training = { status: "completed", backup_intent: "declined", scheduled_at: "2026-09-15T07:30:00+09:00", first_loading_location: " 첫 상차 교육장 ", linked_pro: " 담당 프로 " };
const parse = (value: unknown) => parseStaffingPreparation(value) as unknown as Record<string, unknown> | null;

test("legacy preparation starts unreviewed without inferring willingness from old notes", () => {
  assert.deepEqual(parse(legacy)?.training, { status: "reviewing", backup_intent: "unknown", scheduled_at: "", first_loading_location: "", linked_pro: "" });
  assert.equal(parse(legacy)?.note, "기존 메모");
});

test("completed training retains the applicant's independent refusal and Korean scheduled time", () => {
  assert.deepEqual(parse({ ...legacy, training })?.training, { ...training, first_loading_location: "첫 상차 교육장", linked_pro: "담당 프로" });
  const result = parse({ ...legacy, training: { ...training, backup_intent: "interested" }, status: "확정인력", agent_stage: "active" });
  assert.equal(result?.status, undefined);
  assert.equal(result?.agent_stage, undefined);
  assert.deepEqual(result?.dates, []);
});

test("invalid progress, willingness and non-Korean or impossible scheduled times are rejected", () => {
  for (const patch of [{ status: "assigned" }, { backup_intent: "confirmed" }, { scheduled_at: "2026-02-30T07:30:00+09:00" }, { scheduled_at: "2026-09-15T07:30" }, { scheduled_at: "2026-09-15T07:30:00Z" }, { first_loading_location: "가".repeat(241) }, { linked_pro: 123 }]) {
    assert.equal(parse({ ...legacy, training: { ...training, ...patch } }), null, JSON.stringify(patch));
  }
  assert.equal(parse({ ...legacy, training: null }), null);
});
