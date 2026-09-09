import assert from "node:assert/strict";
import test from "node:test";
import * as launch from "./recruitment-launch.ts";

const targets = [{ applicant_id: 1, name: "가", phone: "010-1234-5678" }, { applicant_id: 2, name: "나", phone: "01022223333" }];
const reviewed = { reviewed_at: "2026-09-09T01:00:00.000Z", recipients: [
  { ...targets[0], phone: "01012345678", state: "consented" },
  { ...targets[1], state: "authorization_required" },
] };

test("review requires every selected identity and never treats missing or other phone evidence as approved", () => {
  assert.ok(launch.parseRecruitmentReview(reviewed, targets));
  for (const recipients of [reviewed.recipients.slice(0, 1), [reviewed.recipients[0], reviewed.recipients[0]],
    [reviewed.recipients[0], { ...reviewed.recipients[1], phone: "01099999999" }],
    [reviewed.recipients[0], { ...reviewed.recipients[1], state: "eligible" }]]) {
    assert.equal(launch.parseRecruitmentReview({ ...reviewed, recipients }, targets), null);
  }
});

test("send recipients require existing consent or stored authorization and retain explicit selection", () => {
  const review = launch.parseRecruitmentReview(reviewed, targets)!;
  assert.deepEqual(launch.recruitmentSendRecipients(review), [{ applicant_id: 1, phone: "01012345678" }]);
  review.recipients[1].state = "authorized";
  assert.deepEqual(launch.recruitmentSendRecipients(review).map(row => row.applicant_id), [1, 2]);
  review.recipients[0].state = "blocked";
  assert.deepEqual(launch.recruitmentSendRecipients(review).map(row => row.applicant_id), [2]);
});

test("only recorded success becomes a candidate; provider acceptance and unknown remain attention", () => {
  const recipients = [{ applicant_id: 1, phone: "01012345678" }, { applicant_id: 2, phone: "01022223333" }];
  const recorded = { ...recipients[0], success: true, state: "recorded", deduplicated: true, recovery_pending: false };
  const result = launch.recruitmentSendResults({ results: [recorded, { ...recipients[1], success: true, state: "sent_unrecorded", deduplicated: false, recovery_pending: true }] }, recipients);
  assert.deepEqual(result.map(row => row.state), ["recorded", "attention"]);
  for (const response of [null, { results: [recorded] }, { results: [recorded, { ...recorded, applicant_id: 2 }] }]) {
    assert.ok(launch.recruitmentSendResults(response, recipients).every(row => row.state === "attention"));
  }
});

test("declared failures and blocked recipients cannot enter success linking", () => {
  const recipients = [{ applicant_id: 1, phone: "01012345678" }, { applicant_id: 2, phone: "01022223333" }];
  const response = { results: recipients.map((row, index) => ({ ...row, success: false, state: index ? "blocked" : "failed", deduplicated: false, error: "보내지 않음" })) };
  assert.deepEqual(launch.recruitmentSendResults(response, recipients).map(row => row.state), ["failed", "blocked"]);
});

test("pilot suggestions stay within this job and successfully linked applicants", () => {
  const targets = [{ id: 1, job_ids: [7] }, { id: 2, job_ids: [8] }, { id: 3, job_ids: [7, 8] }];
  assert.deepEqual(launch.recruitmentPilotTargets(targets, { jobId: 7, applicantIds: [1, 2] }), [targets[0]]);
  assert.deepEqual(launch.recruitmentPilotTargets(targets, { jobId: 7, applicantIds: [] }), []);
});
