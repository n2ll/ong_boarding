import assert from "node:assert/strict";
import test from "node:test";

type Policy = {
  recruitmentContactAuthorizationMatches?: (event: unknown, scope: unknown, now?: Date) => boolean;
  isLegacyRecruitmentPoolImport?: (applicant: unknown) => boolean;
  hasExplicitRecruitmentContactRefusal?: (history: unknown) => boolean;
};

const modulePath = "./recruitment-contact-authorization.ts";
const policy: Policy = await import(modulePath).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});

const now = new Date("2026-09-09T03:00:00.000Z");
const scope = {
  purpose: "new_job",
  batchId: "87cc5698-c5f7-4dac-89a2-b1b116adfa58",
  applicantId: 101,
  phone: "01012345678",
  jobIds: [50, 51, 52],
  requestFingerprint: "a".repeat(64),
};

function authorization(): { id: number; applicant_id: number; event_type: string; created_at: string; meta: Record<string, unknown> } {
  return {
    id: 901,
    applicant_id: 101,
    event_type: "recruitment_contact_authorized",
    created_at: "2026-09-09T02:00:00.000Z",
    meta: {
      basis: "original_recruitment_pool",
      purpose: "new_job",
      batch_id: "87cc5698-c5f7-4dac-89a2-b1b116adfa58",
      applicant_phone: "01012345678",
      job_ids: [50, 51, 52],
      request_fingerprint: "a".repeat(64),
      confirmed_by: "manager",
      note: "원래 홈페이지 채용풀 신청 목적에 따라 이번 세 공고 연락을 확인함",
      expires_at: "2026-09-10T02:00:00.000Z",
    },
  };
}

function matches(event: unknown, request: unknown = scope, at = now) {
  assert.equal(typeof policy.recruitmentContactAuthorizationMatches, "function");
  return policy.recruitmentContactAuthorizationMatches!(event, request, at);
}

test("a stored manager authorization permits only its exact recruitment batch", () => {
  assert.equal(matches(authorization()), true);
  assert.equal(matches(authorization(), { ...scope, jobIds: [52, 50, 51] }), true);
});

test("authorization cannot move to another applicant, phone, batch, body, purpose, or job set", () => {
  for (const change of [
    { applicantId: 102 },
    { phone: "01087654321" },
    { batchId: "4125da69-fc7a-4639-bf68-48a2c4ee463a" },
    { requestFingerprint: "b".repeat(64) },
    { purpose: "campaign" },
    { purpose: "current_application" },
    { jobIds: [50, 51] },
    { jobIds: [50, 51, 52, 53] },
    { jobIds: [50, 51, 51, 52] },
  ]) assert.equal(matches(authorization(), { ...scope, ...change }), false, JSON.stringify(change));
});

test("missing or malformed stored evidence fails closed", () => {
  for (const value of [null, undefined, {}, [], { meta: authorization().meta }]) {
    assert.equal(matches(value), false);
  }
  for (const change of [
    { id: 0 }, { applicant_id: "101" }, { event_type: "ping_sent" },
    { created_at: "invalid" }, { created_at: null }, { meta: null },
  ]) assert.equal(matches({ ...authorization(), ...change }), false, JSON.stringify(change));
  for (const change of [
    { basis: "marketing_consent" }, { purpose: "campaign" }, { confirmed_by: "applicant" },
    { note: "   " }, { note: "동의함" }, { applicant_phone: "010-1234-5678" },
    { job_ids: [50, "51", 52] }, { job_ids: [50, 51, 51, 52] },
    { request_fingerprint: "" }, { expires_at: null },
  ]) {
    const event = authorization();
    event.meta = { ...event.meta, ...change };
    assert.equal(matches(event), false, JSON.stringify(change));
  }
});

test("malformed scope cannot manufacture a matching authorization", () => {
  for (const [scopeField, metaField, value] of [
    ["batchId", "batch_id", "same-arbitrary-key"],
    ["phone", "applicant_phone", "123"],
    ["requestFingerprint", "request_fingerprint", "same-arbitrary-hash"],
    ["jobIds", "job_ids", []],
    ["jobIds", "job_ids", [0]],
    ["jobIds", "job_ids", [50.5]],
  ] as Array<[string, string, unknown]>) {
    const event = authorization();
    event.meta[metaField] = value;
    assert.equal(matches(event, { ...scope, [scopeField]: value }), false);
  }
});

test("authorization expires within 24 hours and cannot be used before creation", () => {
  assert.equal(matches(authorization(), scope, new Date("2026-09-09T02:00:00.000Z")), true);
  assert.equal(matches(authorization(), scope, new Date("2026-09-09T01:59:59.999Z")), false);
  assert.equal(matches(authorization(), scope, new Date("2026-09-10T02:00:00.000Z")), false);
  assert.equal(matches(authorization(), scope, new Date("invalid")), false);
  for (const expiry of ["invalid", "2026-09-09T01:00:00.000Z", "2026-09-10T02:00:00.001Z"]) {
    const event = authorization();
    event.meta.expires_at = expiry;
    assert.equal(matches(event), false, expiry);
  }
});

const importedApplicant = {
  source: "homepage",
  airtable_record_id: "recOriginalApplicant",
  airtable_raw: { "Submitted at": "2026-01-01T00:00:00.000Z", "성함을 작성해주세요": "테스트" },
  marketing_consent: false,
  marketing_consent_at: null,
  sms_opt_out_at: null,
};

test("only homepage or direct Airtable imports with unknown consent provenance are candidates", () => {
  assert.equal(typeof policy.isLegacyRecruitmentPoolImport, "function");
  assert.equal(policy.isLegacyRecruitmentPoolImport!(importedApplicant), true);
  assert.equal(policy.isLegacyRecruitmentPoolImport!({ ...importedApplicant, source: "direct", marketing_consent: null }), true);
  for (const change of [
    { source: "manual" }, { source: "baemin" }, { source: null },
    { airtable_record_id: "" }, { airtable_record_id: null },
    { airtable_raw: {} }, { airtable_raw: [] }, { airtable_raw: null },
    { marketing_consent: true }, { marketing_consent: undefined }, { marketing_consent: "false" },
    { marketing_consent_at: "2026-08-01T00:00:00.000Z" }, { marketing_consent_at: "invalid" },
    { marketing_consent_at: undefined }, { sms_opt_out_at: "2026-08-01T00:00:00.000Z" },
    { sms_opt_out_at: undefined },
  ]) assert.equal(policy.isLegacyRecruitmentPoolImport!({ ...importedApplicant, ...change }), false, JSON.stringify(change));
});

function message(direction: string, body: unknown, created_at: string) { return { direction, body, created_at }; }
const question = message("outbound", "다음 일자리 안내 문자를 받으시겠어요?", "2026-08-01T01:00:00.000Z");

test("explicit contact refusals block the imported-default path even without an opt-out timestamp", () => {
  assert.equal(typeof policy.hasExplicitRecruitmentContactRefusal, "function");
  for (const body of ["그만", "문자 보내지 마세요", "새 일자리 안내 문자는 받지 않겠습니다"]) {
    assert.equal(policy.hasExplicitRecruitmentContactRefusal!([
      message("inbound", body, "2026-08-01T02:00:00.000Z"),
    ]), true, body);
  }
  assert.equal(policy.hasExplicitRecruitmentContactRefusal!([
    message("inbound", "아니요", "2026-08-01T02:00:00.000Z"), question,
  ]), true);
});

test("ordinary application answers and consent questions are not recorded as refusal", () => {
  assert.equal(typeof policy.hasExplicitRecruitmentContactRefusal, "function");
  assert.equal(policy.hasExplicitRecruitmentContactRefusal!([]), false);
  assert.equal(policy.hasExplicitRecruitmentContactRefusal!([question]), false);
  assert.equal(policy.hasExplicitRecruitmentContactRefusal!([
    question, message("inbound", "네", "2026-08-01T02:00:00.000Z"),
  ]), false);
  assert.equal(policy.hasExplicitRecruitmentContactRefusal!([
    message("outbound", "자차가 있으신가요?", "2026-08-01T01:00:00.000Z"),
    message("inbound", "아니요", "2026-08-01T02:00:00.000Z"),
  ]), false);
});

test("unreadable contact history fails closed instead of looking like no refusal", () => {
  assert.equal(typeof policy.hasExplicitRecruitmentContactRefusal, "function");
  for (const history of [null, undefined, {}, [null], [message("inbound", "네", "invalid")], [message("inbound", null, "2026-08-01T02:00:00.000Z")]]) {
    assert.equal(policy.hasExplicitRecruitmentContactRefusal!(history), true);
  }
});

test("same-timestamp history cannot hide a contextual refusal through query ordering", () => {
  assert.equal(typeof policy.hasExplicitRecruitmentContactRefusal, "function");
  assert.equal(policy.hasExplicitRecruitmentContactRefusal!([
    message("inbound", "아니요", question.created_at), question,
  ]), true);
});
