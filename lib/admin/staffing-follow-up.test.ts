import assert from "node:assert/strict";
import test from "node:test";
import * as policy from "./staffing-preparation.ts";

const preparation = { source: "manager", dates: [], training_availability: "", note: "기존 메모" };
const empty = { owner: "", next_action: "", due_date: "", status: "open", last_contact: null };
const followUp = { owner: "김운영", next_action: "다음 일정 연락", due_date: "2026-09-15", status: "open",
  last_contact: { date: "2026-09-08", method: "phone", result: "오후에 다시 연락 요청" } };
const parse = (follow_up: unknown) => policy.parseStaffingPreparation({ ...preparation, follow_up });

test("follow-up preserves legacy omission, explicit clearing and independent empty defaults", () => {
  assert.equal(Object.hasOwn(policy.parseStaffingPreparation(preparation)!, "follow_up"), false);
  assert.equal(parse(null)?.follow_up, null);
  assert.equal(typeof policy.emptyStaffingFollowUp, "function");
  assert.deepEqual(policy.emptyStaffingFollowUp(), empty);
  assert.notEqual(policy.emptyStaffingFollowUp(), policy.emptyStaffingFollowUp());
  assert.deepEqual(policy.followUpContactMethodLabels, { phone: "전화", sms: "문자", other: "기타" });
});

test("follow-up trims manual fields and allows owner or contact only without inventing a pending task", () => {
  const result = parse({ ...followUp, owner: " 김운영 ", next_action: " 다음 일정 연락 ",
    last_contact: { ...followUp.last_contact, result: " 오후에 다시 연락 요청 " } });
  assert.deepEqual(result?.follow_up, followUp);
  assert.equal(result?.note, preparation.note);
  assert.deepEqual(result?.dates, []);
  assert.deepEqual(parse({ ...empty, owner: "김운영", last_contact: followUp.last_contact })?.follow_up,
    { ...empty, owner: "김운영", last_contact: followUp.last_contact });
  assert.ok(parse({ ...followUp, status: "done" }));
  for (const patch of [{ next_action: " ", due_date: "2026-09-15" }, { next_action: "", due_date: "", status: "done" }]) {
    assert.equal(parse({ ...followUp, ...patch }), null);
  }
});

test("follow-up validates bounded text, real due dates and nonempty past or Korean-today contact results", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-09T15:01:00Z").getTime() });
  assert.ok(parse({ ...followUp, owner: "가".repeat(80), next_action: "가".repeat(240), due_date: "9999-01-01",
    last_contact: { date: "2026-09-10", method: "sms", result: "가".repeat(1000) } }));
  assert.ok(parse({ ...followUp, due_date: "" }));
  for (const follow_up of [[], "broken", {}, { ...followUp, owner: "가".repeat(81) }, { ...followUp, next_action: "가".repeat(241) },
    { ...followUp, due_date: "2026-02-30" }, { ...followUp, due_date: "2026-9-15" }, { ...followUp, status: "scheduled" },
    { ...followUp, last_contact: {} }, { ...followUp, last_contact: [] }]) assert.equal(parse(follow_up), null, JSON.stringify(follow_up));
  for (const patch of [{ date: "2026-09-11" }, { date: "2026-02-30" }, { date: "2026-9-8" }, { method: "email" }, { method: ["phone"] },
    { result: " " }, { result: "가".repeat(1001) }]) {
    assert.equal(parse({ ...followUp, last_contact: { ...followUp.last_contact, ...patch } }), null, JSON.stringify(patch));
  }
});
