import assert from "node:assert/strict";
import test from "node:test";
import * as policy from "./staffing-preparation.ts";

const build = (...args: unknown[]) => (policy as unknown as { buildStaffingSuggestions: (...input: unknown[]) => any[] }).buildStaffingSuggestions(...args);
const job = { id: 7, start_date: "2027-04-20", work_period: "단기" };
const received = "2027-04-09T15:30:00.000Z";
const message = (body = "22일 가능", patch = {}) => ({ id: "sms-1", applicant_id: 1, direction: "inbound", body, created_at: received, ...patch });
const observation = (quote = "22일 가능", patch = {}) => ({ id: 1, applicant_id: 1, job_id: 7, event_type: "job_consultation_observation", created_at: received,
  meta: { source: "inbound_sms", source_message_id: "sms-1", source_created_at: received, observations: [{ kind: "availability", quote }] }, ...patch });

test("clear date-only replies resolve from matching job and Korean receipt month, retaining original evidence", () => {
  const [suggestion] = build([observation()], [message()], job);
  assert.equal(suggestion.date, "2027-04-22");
  assert.equal(suggestion.availability, "available");
  assert.equal(suggestion.quote, "22일 가능");
  assert.equal(suggestion.source_message_id, "sms-1");
  assert.equal(suggestion.source_created_at, received);
  assert.equal(suggestion.event_id, 1);
});

test("explicit refusals stay unavailable; questions, mixed dates, training and conditions need review", () => {
  for (const body of ["22일 불가", "22일 가능하지 않아요", "22일 안돼요"]) {
    const [suggestion] = build([observation(body)], [message(body)], job);
    assert.equal(suggestion.date, "2027-04-22", body);
    assert.equal(suggestion.availability, "unavailable", body);
  }
  for (const body of ["22일 가능?", "22일 가능할 것 같아요", "22일 오전만 가능", "22일 선탑 가능", "22일 불가 23일 가능", "22일 가능하다는 뜻인가요?"]) {
    const [suggestion] = build([observation(body)], [message(body)], job);
    assert.equal(suggestion.date, null, body);
    assert.equal(suggestion.availability, "unknown", body);
    assert.ok(suggestion.reason, body);
  }
});

test("cropped positive quotes, wrong source owners/directions and source lookup failures never become available", () => {
  for (const source of [message("22일 가능?"), message("22일 가능", { applicant_id: 2 }), message("22일 가능", { direction: "outbound" }), message("다른 답변"), message("22일 가능", { created_at: "2027-04-10T00:00:00Z" }), null]) {
    const [suggestion] = build([observation()], source ? [source] : [], job);
    assert.equal(suggestion.date, null);
    assert.equal(suggestion.availability, "unknown");
  }
});

test("ambiguous month/year, impossible/past dates and a different one-day job date stay unparsed", () => {
  for (const [body, context, receipt] of [
    ["22일 가능", { ...job, start_date: "2027-05-20" }, received],
    ["31일 가능", job, received], ["4/19 가능", job, received],
    ["22일 가능", { ...job, work_period: "하루" }, received],
    ["22일 가능", job, "2027-04-22T15:00:00Z"],
    ["5/22 가능", job, received], ["22일 가능", { ...job, start_date: null }, received],
  ] as const) {
    const event = observation(body, { meta: { ...observation().meta, source_created_at: receipt, observations: [{ kind: "availability", quote: body }] } });
    assert.equal(build([event], [message(body, { created_at: receipt })], context)[0].date, null, body);
  }
  assert.equal(build([observation("2027-04-22 가능합니다")], [message("2027-04-22 가능합니다")], job)[0].date, "2027-04-22");
});

test("a newer ambiguous or malformed observation suppresses an older positive proposal", () => {
  const later = observation("22일 가능?", { id: 2, created_at: "2027-04-11T00:00:00Z", meta: { ...observation().meta, source_created_at: "2027-04-11T00:00:00Z", source_message_id: "sms-2", observations: [{ kind: "availability", quote: "22일 가능?" }] } });
  const suggestions = build([observation(), later], [message(), message("22일 가능?", { id: "sms-2", created_at: "2027-04-11T00:00:00Z" })], job);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].event_id, 2);
  assert.equal(suggestions[0].date, null);
  assert.equal(build([observation(), observation("", { id: 3, meta: null })], [message()], job)[0].date, null);
});

test("applying a proposal only adds an unassigned candidate date and never overwrites manager input", () => {
  const apply = (policy as unknown as { applyStaffingSuggestion: (...args: any[]) => any }).applyStaffingSuggestion;
  const draft = { source: "manager", dates: [], training_availability: "오후 조율", note: "기존 메모" };
  const suggestion = build([observation()], [message()], job)[0];
  const added = apply(draft, suggestion);
  assert.deepEqual(added.dates, [{ date: "2027-04-22", availability: "available", role: "unassigned" }]);
  assert.equal(added.training_availability, draft.training_availability);
  assert.equal(draft.dates.length, 0);
  for (const availability of ["unknown", "unavailable", "available"]) {
    const saved = { ...draft, dates: [{ date: "2027-04-22", availability, role: "unassigned" }] };
    assert.deepEqual(apply(saved, suggestion), saved);
  }
  assert.deepEqual(apply(draft, { ...suggestion, date: null }), draft);
});

test("plain numbers are not dates, and late insertion of an older message cannot revive old availability", () => {
  assert.equal(build([observation("22 가능")], [message("22 가능")], job)[0].date, null);
  const laterSource = message("22일 불가", { id: "sms-2", created_at: "2027-04-11T00:00:00Z" });
  const later = observation("22일 불가", { id: 2, meta: { source: "inbound_sms", source_message_id: laterSource.id,
    source_created_at: laterSource.created_at, observations: [{ kind: "availability", quote: laterSource.body }] } });
  const lateInsertedOld = observation("22일 가능", { id: 3, created_at: "2027-04-12T00:00:00Z" });
  assert.equal(build([later, lateInsertedOld], [message(), laterSource], job)[0].availability, "unavailable");
});

test("standalone job-number selections can precede the date statement without dropping conditions or refusals", () => {
  const body = "1, 3번\n22일 가능";
  const [suggestion] = build([observation()], [message(body)], job);
  assert.equal(suggestion.date, "2027-04-22");
  assert.equal(suggestion.quote, body);
  for (const source of ["1, 3번\n22일 가능\n시간 맞으면", "1, 3번\n22일 가능\n하지만 못 갈 수도 있어요", "1, 3번은 불가\n22일 가능", "3일 모두 가능하며 2번과3번 희망합니다"]) {
    assert.equal(build([observation(source)], [message(source)], job)[0].date, null, source);
  }
});

test("a newer real inbound without an observation invalidates the old positive suggestion", () => {
  for (const body of ["22일 불가", "시간을 다시 확인할게요", "감사합니다"]) {
    const [suggestion] = build([observation()], [message(), message(body, { id: "sms-new", created_at: "2027-04-10T12:00:00Z" })], job);
    assert.equal(suggestion.date, null);
    assert.equal(suggestion.availability, "unknown");
    assert.match(suggestion.reason, /이후.*답장/);
    assert.ok(suggestion.reason.includes(body));
  }
});
