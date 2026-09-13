import assert from "node:assert/strict";
import test from "node:test";
import * as policy from "./staffing-note-draft.ts";
import type { StaffingPreparation } from "./staffing-preparation.ts";

const referenceDate = "2026-09-13";
const note = "오늘 통화. 9월 12일 선탑 완료했고 오전 가능. 백업 진행 희망. 다음 주 월요일 다시 연락.";
const contact = { field: "contact", value: { date: referenceDate, method: "phone", result: "오전 가능" }, evidence: "오늘 통화" };
const training = { field: "training_status", value: "completed", evidence: "선탑 완료" };
const action = { field: "next_action", value: "다시 연락", evidence: "다시 연락" };
const due = { field: "due_date", value: "2026-09-14", evidence: "다음 주 월요일" };
const participation = { field: "participation", value: { kind: "training", date: "2026-09-12", note: "선탑 완료" }, evidence: "9월 12일 선탑 완료" };
const parse = (changes: unknown[], questions: unknown[] = [], source = note, day = referenceDate) => {
  assert.equal(typeof policy.parseStaffingNoteProposal, "function");
  return policy.parseStaffingNoteProposal({ changes, questions }, source, day);
};
const initial = (): StaffingPreparation => ({
  source: "manager", dates: [{ date: "2026-09-20", availability: "available", role: "primary_candidate", confirmation: "confirmed" }],
  training_availability: "오후 가능", note: "기존 매니저 메모",
  training: { status: "scheduled", backup_intent: "unknown", scheduled_at: "2026-09-15T09:00:00+09:00", first_loading_location: "기존 상차지", linked_pro: "담당 프로" },
  records: [{ id: "11111111-1111-4111-8111-111111111111", kind: "backup", date: "2026-09-08", note: "기존 참여" }],
  follow_up: { owner: "김운영", next_action: "기존 연락", due_date: "2026-09-16", status: "done", last_contact: { date: "2026-09-08", method: "sms", result: "안내 완료" } },
});
const apply = (current: StaffingPreparation, changes: unknown[]) => {
  assert.equal(typeof policy.applyStaffingNoteChanges, "function");
  return policy.applyStaffingNoteChanges(current, changes as policy.StaffingNoteChange[]);
};

test("parses supported changes backed by exact manager memo evidence", () => {
  const changes = [contact, { field: "training_availability", value: "오전 가능", evidence: "오전 가능" }, training,
    { field: "backup_intent", value: "interested", evidence: "백업 진행 희망" }, action, due, participation];
  assert.deepEqual(parse(changes, ["연락할 시간을 확인해주세요."]), { changes, questions: ["연락할 시간을 확인해주세요."] });
  assert.deepEqual(parse([], ["실제 참여한 날짜를 확인해주세요."]), { changes: [], questions: ["실제 참여한 날짜를 확인해주세요."] });
});

test("rejects unknown and confirmation or assignment properties at every change boundary", () => {
  assert.equal(typeof policy.parseStaffingNoteProposal, "function");
  for (const raw of [null, [], {}, { changes: [], questions: [], confirmed: true }, { changes: [], questions: [], assignment: "primary" }]) {
    assert.equal(policy.parseStaffingNoteProposal(raw, note, referenceDate), null);
  }
  for (const change of [{ field: "confirmation", value: "confirmed", evidence: "오늘" }, { field: "dates", value: [], evidence: "오늘" },
    { ...training, confirmation: "confirmed" }, { ...training, value: "scheduled" },
    { ...contact, value: { ...contact.value, owner: "김운영" } }, { ...participation, value: { ...participation.value, id: "from-model" } },
    { field: "training_availability", value: { text: "오전 가능" }, evidence: "오전 가능" }, null, [], "invalid"]) {
    assert.equal(parse([change]), null, JSON.stringify(change));
  }
});

test("rejects evidence missing from the exact memo or consisting only of whitespace", () => {
  for (const evidence of ["", " ", "오후 가능", "선탑  완료", null, 1]) assert.equal(parse([{ ...training, evidence }]), null);
  assert.equal(parse([training], [], ""), null);
  assert.equal(parse([training], [], note, "2026-02-30"), null);
});

test("rejects repeated scalar fields, excessive changes and malformed questions", () => {
  assert.equal(parse([training, training]), null);
  assert.equal(parse([training, { ...training, value: "on_hold" }]), null);
  assert.ok(parse([participation, { ...participation, value: { ...participation.value, kind: "backup" } }]));
  assert.equal(parse(Array.from({ length: 13 }, () => participation)), null);
  assert.ok(parse([], Array.from({ length: 5 }, () => "날짜 확인")));
  assert.equal(parse([], Array.from({ length: 6 }, () => "날짜 확인")), null);
  for (const questions of [[null], [" "], [1], ["가".repeat(241)]]) assert.equal(parse([], questions), null);
});

test("allows only real dates and past or reference-day contact and participation", () => {
  assert.ok(parse([contact, participation]));
  for (const date of ["2026-09-14", "2026-02-30", "2026-9-12", "", null]) {
    assert.equal(parse([{ ...contact, value: { ...contact.value, date } }]), null);
    assert.equal(parse([{ ...participation, value: { ...participation.value, date } }]), null);
  }
  assert.ok(parse([action, { ...due, value: "9999-12-31" }]));
  for (const value of ["2026-02-30", "2026-9-14", "", null]) assert.equal(parse([action, { ...due, value }]), null);
  assert.equal(parse([due]), null);
});

test("bounds text and rejects empty actions, invalid methods and unsupported enum values", () => {
  assert.ok(parse([{ ...contact, value: { ...contact.value, method: "sms", result: "가".repeat(1000) } }]));
  assert.ok(parse([{ ...contact, value: { ...contact.value, method: "other" } }]));
  assert.ok(parse([{ ...participation, value: { ...participation.value, note: "" } }]));
  assert.ok(parse([{ field: "training_availability", value: "가".repeat(240), evidence: "오전 가능" }]));
  for (const change of [{ ...contact, value: { ...contact.value, method: "email" } }, { ...contact, value: { ...contact.value, result: " " } },
    { ...contact, value: { ...contact.value, result: "가".repeat(1001) } }, { ...participation, value: { ...participation.value, note: "가".repeat(1001) } },
    { ...participation, value: { ...participation.value, kind: "scheduled" } }, { ...action, value: " " }, { ...action, value: "가".repeat(241) },
    { field: "training_availability", value: "가".repeat(241), evidence: "오전 가능" }, { ...training, value: "reviewing" },
    { field: "backup_intent", value: "unknown", evidence: "백업" }]) assert.equal(parse([change]), null, JSON.stringify(change));
  assert.ok(parse([{ ...training, value: "coordinating" }]));
  assert.ok(parse([{ ...training, value: "on_hold" }]));
  assert.ok(parse([{ field: "backup_intent", value: "declined", evidence: "백업" }]));
});

test("applies reviewed fields without altering manager confirmation, plans, notes or source object", () => {
  const current = initial();
  const untouched = structuredClone(current);
  const result = apply(current, [contact, training, { field: "training_availability", value: "오전 가능", evidence: "오전 가능" },
    { field: "backup_intent", value: "interested", evidence: "백업 진행 희망" }]);
  assert.ok(result);
  assert.deepEqual(result, { ...untouched, training_availability: "오전 가능", training: { ...untouched.training, status: "completed", backup_intent: "interested" },
    follow_up: { ...untouched.follow_up, last_contact: contact.value } });
  assert.deepEqual(current, untouched);
  assert.deepEqual(result.records, untouched.records);
});

test("contact-only edits preserve completed task and only create follow-up when needed", () => {
  assert.equal(apply(initial(), [contact])?.follow_up?.status, "done");
  const { follow_up: _followUp, ...legacy } = initial();
  assert.equal(Object.hasOwn(apply(legacy, [training])!, "follow_up"), false);
  assert.equal(apply({ ...legacy, follow_up: null }, [training])?.follow_up, null);
  assert.deepEqual(apply(legacy, [contact])?.follow_up, { owner: "", next_action: "", due_date: "", status: "open", last_contact: contact.value });
});

test("changed next action reopens the task and clears stale due date while preserving owner and contact", () => {
  const current = initial();
  assert.deepEqual(apply(current, [action])?.follow_up, { ...current.follow_up, next_action: "다시 연락", due_date: "", status: "open" });
  assert.deepEqual(apply(current, [due, action])?.follow_up, { ...current.follow_up, next_action: "다시 연락", due_date: "2026-09-14", status: "open" });
  assert.deepEqual(apply(current, [{ ...action, value: "기존 연락" }])?.follow_up, current.follow_up);
});

test("a selected due date requires a current or selected next action and preserves task state otherwise", () => {
  const current = initial();
  assert.deepEqual(apply(current, [due])?.follow_up, { ...current.follow_up, due_date: "2026-09-14" });
  assert.equal(apply({ ...current, follow_up: null }, [due]), null);
  assert.equal(apply({ ...current, follow_up: undefined }, [due]), null);
  assert.deepEqual(apply({ ...current, follow_up: null }, [action, due])?.follow_up,
    { owner: "", next_action: "다시 연락", due_date: "2026-09-14", status: "open", last_contact: null });
});

test("only explicit participation adds a record once per kind and date and preserves existing identity", () => {
  const current = initial();
  const first = apply(current, [participation]);
  assert.ok(first);
  assert.equal(first.records.length, 2);
  assert.deepEqual(first.records[0], current.records[0]);
  assert.match(first.records[1].id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.deepEqual({ ...first.records[1], id: "new" }, { id: "new", kind: "training", date: "2026-09-12", note: "선탑 완료" });
  assert.deepEqual(apply(first, [participation])?.records, first.records);
  assert.equal(apply(current, [participation, participation])?.records.length, 2);
  assert.equal(apply(current, [participation, { ...participation, value: { ...participation.value, kind: "backup" } }])?.records.length, 3);
  assert.deepEqual(first.training, current.training);
});

test("applying malformed selections fails without mutating existing data or exceeding record limit", () => {
  const current = initial();
  const original = structuredClone(current);
  assert.equal(apply(current, [{ ...training, value: "scheduled" }]), null);
  assert.equal(apply(current, [{ ...training, assignment: "primary" }]), null);
  assert.equal(apply(current, [training, training]), null);
  const full = { ...current, records: Array.from({ length: 200 }, (_, i) => ({ ...current.records[0], id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` })) };
  assert.equal(apply(full, [participation]), null);
  assert.deepEqual(current, original);
});

test("change summaries render human-readable labels and values for review", () => {
  assert.equal(typeof policy.staffingNoteChangeLabel, "function");
  assert.equal(typeof policy.staffingNoteChangeValue, "function");
  const parsed = parse([contact, training, participation])!;
  assert.match(policy.staffingNoteChangeLabel(parsed.changes[0]), /연락/);
  assert.match(policy.staffingNoteChangeValue(parsed.changes[0]), /2026-09-13.*전화.*오전 가능/);
  assert.equal(policy.staffingNoteChangeValue(parsed.changes[1]), "선탑 완료");
  assert.match(policy.staffingNoteChangeValue(parsed.changes[2]), /선탑.*2026-09-12.*선탑 완료/);
});
