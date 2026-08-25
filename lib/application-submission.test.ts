import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ApplicantFormData } from "./applicant-form.ts";

type JobApplicationOutcome = "linked" | "unchanged" | "unavailable" | "failed" | "not_requested";
type CandidateLinkOutcome = "linked" | "already_linked" | "unchanged_closed" | "unavailable" | null;

interface ApplicationMessageRequest {
  requestFingerprint: string;
  applicantId: number;
  phone: string;
  body: string;
  jobId: number | null;
  sentBy: string;
}

interface ExistingApplicationMessageRequest {
  request_fingerprint: string;
  applicant_id: number;
  applicant_phone: string;
  body: string;
  job_id: number | null;
  sent_by: string;
  status: string | null;
  provider_message_id: string | null;
  message_type: string | null;
  template_id: string | null;
  auto_engagement_required: boolean;
}

interface ApplicationSubmissionAttempt {
  fingerprint: string;
  id: string;
  jobId: number | null;
  vehicleRequired: boolean;
}

interface ApplicationSubmissionContext {
  jobId: number | null;
  vehicleRequired: boolean;
  reusesAttempt: boolean;
}

type ApplicationSubmissionModule = {
  validateApplicationSubmissionId?: (
    value: unknown,
  ) => { ok: true; id: string } | { ok: false; reason: "required" | "invalid" };
  nextApplicationSubmissionAttempt?: (
    current: ApplicationSubmissionAttempt | null,
    request: ApplicantFormData & { source: string; jobId: number | null },
    vehicleRequired: boolean,
    createId: () => string,
  ) => ApplicationSubmissionAttempt;
  resolveApplicationSubmissionContext?: (
    current: ApplicationSubmissionAttempt | null,
    request: ApplicantFormData & { source: string; jobId: number | null },
    vehicleRequired: boolean,
  ) => ApplicationSubmissionContext;
  prepareApplicationSubmission?: (
    current: ApplicationSubmissionAttempt | null,
    request: ApplicantFormData & { source: string; jobId: number | null },
    vehicleRequired: boolean,
    createId: () => string,
  ) => {
    attempt: ApplicationSubmissionAttempt;
    context: ApplicationSubmissionContext;
    payload: ApplicantFormData & { source: string; jobId: number | null; submissionId: string };
  };
  applicationSubmissionPayloadFingerprint?: (
    request: ApplicantFormData & { source: string; jobId: number | null },
  ) => string;
  applicationSubmissionPayloadDigest?: (
    request: ApplicantFormData & { source: string; jobId: number | null },
  ) => Promise<string>;
  shouldAbandonApplicationSubmissionAttempt?: (response: unknown) => boolean;
  shouldStartApplicationAutoEngagement?: (input: {
    updateMode: boolean;
    existingSource: string | null;
    existingStatus: string | null;
    existingFilterPass: string | null;
    existingBirthDate: string | null;
  }) => boolean;
  shouldUpdateApplicationApplicant?: (input: {
    hasExistingApplicant: boolean;
    idempotentReplay: boolean;
    existingSource: string | null;
    existingStatus: string | null;
  }) => boolean;
  applicationInitialMessagePlan?: (input: {
    startAutoEngagement: boolean;
    existingRequest: ExistingApplicationMessageRequest | null;
  }) => "claim" | "replay" | "skip";
  applicationSubmissionMappingDecision?: (input: {
    requestFingerprint: string;
    outbox: { applicantId: number; requestFingerprint: string } | null;
    applicant: { applicantId: number; requestFingerprint: string | null } | null;
  }) =>
    | { kind: "new" }
    | { kind: "reuse"; applicantId: number; source: "outbox" | "applicant" }
    | { kind: "conflict" };
  applicationInitialMessageUiState?: (
    delivery: "sent" | "not_sent" | "unknown",
  ) => "sent" | "not_sent" | "uncertain";
  deliverApplicationMessage?: (args: {
    request: ApplicationMessageRequest;
    claim: () => Promise<
      | { kind: "claimed" }
      | { kind: "existing"; request: ExistingApplicationMessageRequest }
      | { kind: "error" }
    >;
    send: () => Promise<{
      success: boolean;
      messageId?: string;
      messageType: string;
      templateId?: string | null;
      failureKind?: "declared" | "unknown";
      error?: string;
    }>;
    markUnknown: (error: string) => Promise<void>;
    markFailed: (error: string) => Promise<void>;
    markSent: (result: {
      providerMessageId: string | null;
      messageType: string;
      templateId: string | null;
    }) => Promise<boolean>;
    record: (message: {
      applicantId: number;
      phone: string;
      body: string;
      jobId: number | null;
      sentBy: string;
      providerMessageId: string | null;
      messageType: string;
      templateId: string | null;
    }) => Promise<boolean>;
  }) => Promise<{
    delivery: "not_sent" | "unknown" | "sent";
    recorded: boolean;
    deduplicated: boolean;
    conflict?: boolean;
  }>;
  applicationStatusForSubmission?: (existingStatus: string | null, nextStatus: string) => string;
  applicationVehicleRequired?: (input: {
    jobRequested: boolean;
    jobVehicleRequired: boolean | null;
  }) => boolean;
  applicationFilterPasses?: (input: {
    ownVehicle: string;
    licenseType: string;
    selfOwnership: string;
    vehicleRequired: boolean;
  }) => boolean;
  validateApplicationSubmission?: (
    form: ApplicantFormData,
    vehicleRequired: boolean,
  ) => { field: keyof ApplicantFormData; message: string } | null;
  applicationSubmissionProgress?: (
    form: ApplicantFormData,
    vehicleRequired: boolean,
  ) => { completed: number; total: number; percent: number };
  applicationCompletionKind?: (outcome: JobApplicationOutcome) =>
    | "job_linked"
    | "general_job_unchanged"
    | "general_job_unavailable"
    | "general_job_failed"
    | "general";
  applicationJobOutcome?: (input: {
    jobRequested: boolean;
    candidateLinkOutcome: CandidateLinkOutcome;
  }) => JobApplicationOutcome;
  shouldSetApplicationCurrentJob?: (
    filterPass: boolean,
    candidateLinkOutcome: CandidateLinkOutcome,
  ) => boolean;
  isApplicationSubmissionResult?: (value: unknown) => boolean;
  applicationOptionalAnswer?: (input: {
    submitted: string | null | undefined;
    existing: string | null | undefined;
    required: boolean;
  }) => string;
  applicationOperationalFieldsForSubmission?: (input: {
    updateMode: boolean;
    isDuplicate: boolean;
    submittedSource: string | null | undefined;
    nextFilterPass: "Y" | "N";
    existing: {
      status: string | null;
      source: string | null;
      filterPass: string | null;
      note: string | null;
      availableSlots: unknown;
      availableSlotsUpdatedAt: string | null;
    } | null;
  }) => {
    source: string;
    filterPass: string;
    note: string | null;
    availableSlots: unknown;
    availableSlotsUpdatedAt: string | null;
  };
};

async function loadApplicationSubmissionModule(): Promise<ApplicationSubmissionModule> {
  try {
    const modulePath = "./application-submission.ts";
    return await import(modulePath) as ApplicationSubmissionModule;
  } catch {
    return {};
  }
}

const completeForm: ApplicantFormData = {
  name: "김지원",
  birthDate: "600101",
  phone: "01012345678",
  location: "서울시 강남구",
  ownVehicle: "있음",
  licenseType: "2종 보통",
  vehicleType: "승용차",
  branch1: "강남점",
  branch2: "",
  workHours: ["평일 오전"],
  experience: "",
  introduction: "",
  availableDate: "2026-08-21",
  selfOwnership: "문제 없음",
  marketingConsent: false,
};

function existingApplicationMessage(
  overrides: Partial<ExistingApplicationMessageRequest> = {},
): ExistingApplicationMessageRequest {
  return {
    request_fingerprint: "submission-fingerprint",
    applicant_id: 17,
    applicant_phone: "01012345678",
    body: "처음 발송한 접수 안내",
    job_id: 31,
    sent_by: "system-auto",
    status: "sent",
    provider_message_id: "provider-1",
    message_type: "alimtalk",
    template_id: "template-1",
    auto_engagement_required: true,
    ...overrides,
  };
}

const applicationMessageRequest: ApplicationMessageRequest = {
  requestFingerprint: "submission-fingerprint",
  applicantId: 17,
  phone: "01012345678",
  body: "이번 처리에서 만든 접수 안내",
  jobId: 31,
  sentBy: "system-auto",
};

test("an application submission requires a caller-supplied UUID", async () => {
  const { validateApplicationSubmissionId } = await loadApplicationSubmissionModule();

  assert.equal(typeof validateApplicationSubmissionId, "function");
  assert.deepEqual(validateApplicationSubmissionId!(undefined), { ok: false, reason: "required" });
  assert.deepEqual(validateApplicationSubmissionId!(""), { ok: false, reason: "required" });
  assert.deepEqual(validateApplicationSubmissionId!("server-generated"), { ok: false, reason: "invalid" });
  assert.deepEqual(
    validateApplicationSubmissionId!(" 41f82761-a37a-4f6f-8ad5-8b6b93acb8c1 "),
    { ok: true, id: "41f82761-a37a-4f6f-8ad5-8b6b93acb8c1" },
  );
});

test("a response-loss retry reuses the same application submission UUID", async () => {
  const { nextApplicationSubmissionAttempt } = await loadApplicationSubmissionModule();

  assert.equal(typeof nextApplicationSubmissionAttempt, "function");
  let sequence = 0;
  const createId = () => `submission-${++sequence}`;
  const request = { ...completeForm, source: "direct", jobId: 31 };
  const first = nextApplicationSubmissionAttempt!(null, request, false, createId);
  const retry = nextApplicationSubmissionAttempt!(first, { ...request }, false, createId);
  const edited = nextApplicationSubmissionAttempt!(retry, { ...request, branch1: "서초점" }, false, createId);

  assert.deepEqual(retry, first);
  assert.equal(first.id, "submission-1");
  assert.equal(first.jobId, 31);
  assert.equal(first.vehicleRequired, false);
  assert.equal(edited.id, "submission-2");
});

test("the browser-ready payload carries the durable UUID and rotates it with any payload edit", async () => {
  const { prepareApplicationSubmission } = await loadApplicationSubmissionModule();

  assert.equal(typeof prepareApplicationSubmission, "function");
  let sequence = 0;
  const createId = () => `submission-${++sequence}`;
  const request = { ...completeForm, source: "direct", jobId: 31 };
  const first = prepareApplicationSubmission!(null, request, false, createId);
  const retry = prepareApplicationSubmission!(first.attempt, { ...request }, false, createId);
  const edited = prepareApplicationSubmission!(retry.attempt, {
    ...request,
    introduction: "주 5일 근무를 희망합니다.",
  }, false, createId);

  assert.equal(first.payload.submissionId, "submission-1");
  assert.equal(retry.payload.submissionId, "submission-1");
  assert.equal(edited.payload.submissionId, "submission-2");
  assert.deepEqual(first.payload, { ...request, submissionId: "submission-1" });
});

test("an unchanged retry keeps the original job and validation context when the current job becomes unavailable", async () => {
  const {
    prepareApplicationSubmission,
    resolveApplicationSubmissionContext,
    validateApplicationSubmission,
  } = await loadApplicationSubmissionModule();

  assert.equal(typeof prepareApplicationSubmission, "function");
  assert.equal(typeof resolveApplicationSubmissionContext, "function");
  assert.equal(typeof validateApplicationSubmission, "function");
  let sequence = 0;
  const createId = () => `submission-${++sequence}`;
  const noVehicleForm = {
    ...completeForm,
    ownVehicle: "",
    licenseType: "",
    vehicleType: "",
    selfOwnership: "",
  };
  const first = prepareApplicationSubmission!(
    null,
    { ...noVehicleForm, source: "direct", jobId: 31 },
    false,
    createId,
  );
  const currentRequest = { ...noVehicleForm, source: "direct", jobId: null };
  const context = resolveApplicationSubmissionContext!(first.attempt, currentRequest, true);
  const retry = prepareApplicationSubmission!(first.attempt, currentRequest, true, createId);

  assert.deepEqual(context, { jobId: 31, vehicleRequired: false, reusesAttempt: true });
  assert.equal(validateApplicationSubmission!(noVehicleForm, context.vehicleRequired), null);
  assert.equal(retry.payload.submissionId, "submission-1");
  assert.equal(retry.payload.jobId, 31);
  assert.deepEqual(retry.context, context);
});

test("editing a recovered application rotates the UUID and adopts the current job context", async () => {
  const { prepareApplicationSubmission } = await loadApplicationSubmissionModule();

  assert.equal(typeof prepareApplicationSubmission, "function");
  let sequence = 0;
  const createId = () => `submission-${++sequence}`;
  const first = prepareApplicationSubmission!(
    null,
    { ...completeForm, source: "direct", jobId: 31 },
    false,
    createId,
  );
  const edited = prepareApplicationSubmission!(first.attempt, {
    ...completeForm,
    source: "direct",
    jobId: null,
    introduction: "내용을 수정했습니다.",
  }, true, createId);

  assert.equal(edited.payload.submissionId, "submission-2");
  assert.equal(edited.payload.jobId, null);
  assert.deepEqual(edited.context, { jobId: null, vehicleRequired: true, reusesAttempt: false });
});

test("editing the recovered source rotates the UUID and adopts the current context", async () => {
  const { prepareApplicationSubmission } = await loadApplicationSubmissionModule();

  assert.equal(typeof prepareApplicationSubmission, "function");
  let sequence = 0;
  const createId = () => `submission-${++sequence}`;
  const first = prepareApplicationSubmission!(
    null,
    { ...completeForm, source: "direct", jobId: 31 },
    false,
    createId,
  );
  const edited = prepareApplicationSubmission!(first.attempt, {
    ...completeForm,
    source: "baemin",
    jobId: null,
  }, true, createId);

  assert.equal(edited.payload.submissionId, "submission-2");
  assert.equal(edited.payload.jobId, null);
  assert.equal(edited.attempt.vehicleRequired, true);
});

test("an unchanged general-application retry does not attach a newly loaded job", async () => {
  const { prepareApplicationSubmission } = await loadApplicationSubmissionModule();

  assert.equal(typeof prepareApplicationSubmission, "function");
  let sequence = 0;
  const createId = () => `submission-${++sequence}`;
  const first = prepareApplicationSubmission!(
    null,
    { ...completeForm, source: "direct", jobId: null },
    true,
    createId,
  );
  const retry = prepareApplicationSubmission!(first.attempt, {
    ...completeForm,
    source: "direct",
    jobId: 31,
  }, false, createId);

  assert.equal(retry.payload.submissionId, "submission-1");
  assert.equal(retry.payload.jobId, null);
  assert.deepEqual(retry.context, { jobId: null, vehicleRequired: true, reusesAttempt: true });
});

test("only an explicit server context rejection abandons the local submission attempt", async () => {
  const { shouldAbandonApplicationSubmissionAttempt } = await loadApplicationSubmissionModule();

  assert.equal(typeof shouldAbandonApplicationSubmissionAttempt, "function");
  assert.equal(shouldAbandonApplicationSubmissionAttempt!({
    code: "APPLICATION_CONTEXT_CHANGED",
  }), true);
  for (const response of [
    null,
    {},
    { code: "APPLICATION_RATE_LIMITED" },
    { code: "APPLICATION_SUBMISSION_CONFLICT" },
    { error: "temporary failure" },
  ]) {
    assert.equal(shouldAbandonApplicationSubmissionAttempt!(response), false);
  }
});

test("the durable fingerprint covers the complete submitted application payload", async () => {
  const { applicationSubmissionPayloadFingerprint } = await loadApplicationSubmissionModule();

  assert.equal(typeof applicationSubmissionPayloadFingerprint, "function");
  const request = { ...completeForm, source: "direct", jobId: 31 };
  const baseline = applicationSubmissionPayloadFingerprint!(request);
  for (const changed of [
    { ...request, birthDate: "610101" },
    { ...request, location: "서울시 서초구" },
    { ...request, introduction: "경력 2년" },
    { ...request, marketingConsent: true },
    { ...request, source: "baemin" },
    { ...request, jobId: 32 },
  ]) {
    assert.notEqual(applicationSubmissionPayloadFingerprint!(changed), baseline);
  }
});

test("the persisted request fingerprint is a digest rather than applicant PII", async () => {
  const { applicationSubmissionPayloadDigest } = await loadApplicationSubmissionModule();

  assert.equal(typeof applicationSubmissionPayloadDigest, "function");
  const request = { ...completeForm, source: "direct", jobId: 31 };
  const digest = await applicationSubmissionPayloadDigest!(request);
  const changed = await applicationSubmissionPayloadDigest!({
    ...request,
    location: "서울시 서초구",
  });

  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.notEqual(digest, changed);
  assert.equal(digest.includes(request.name), false);
  assert.equal(digest.includes(request.birthDate), false);
  assert.equal(digest.includes(request.phone), false);
});

test("only a Baemin placeholder update is treated as its first automatic engagement", async () => {
  const { shouldStartApplicationAutoEngagement } = await loadApplicationSubmissionModule();

  assert.equal(typeof shouldStartApplicationAutoEngagement, "function");
  assert.equal(shouldStartApplicationAutoEngagement!({
    updateMode: false,
    existingSource: null,
    existingStatus: null,
    existingFilterPass: null,
    existingBirthDate: null,
  }), true);
  assert.equal(shouldStartApplicationAutoEngagement!({
    updateMode: true,
    existingSource: "direct",
    existingStatus: "스크리닝 전",
    existingFilterPass: null,
    existingBirthDate: "미확인",
  }), false);
  assert.equal(shouldStartApplicationAutoEngagement!({
    updateMode: true,
    existingSource: "baemin",
    existingStatus: "스크리닝 전",
    existingFilterPass: null,
    existingBirthDate: "미확인",
  }), true);
  assert.equal(shouldStartApplicationAutoEngagement!({
    updateMode: true,
    existingSource: "baemin",
    existingStatus: "스크리닝 중",
    existingFilterPass: null,
    existingBirthDate: "미확인",
  }), false);
  assert.equal(shouldStartApplicationAutoEngagement!({
    updateMode: true,
    existingSource: "baemin",
    existingStatus: "스크리닝 전",
    existingFilterPass: "Y",
    existingBirthDate: "600101",
  }), false);
});

test("an idempotent replay can recover its initial message without reopening auto engagement", async () => {
  const { applicationInitialMessagePlan } = await loadApplicationSubmissionModule();

  assert.equal(typeof applicationInitialMessagePlan, "function");
  assert.equal(applicationInitialMessagePlan!({
    startAutoEngagement: true,
    existingRequest: null,
  }), "claim");
  assert.equal(applicationInitialMessagePlan!({
    startAutoEngagement: true,
    existingRequest: existingApplicationMessage(),
  }), "replay");
  assert.equal(applicationInitialMessagePlan!({
    startAutoEngagement: false,
    existingRequest: existingApplicationMessage(),
  }), "replay");
  assert.equal(applicationInitialMessagePlan!({
    startAutoEngagement: false,
    existingRequest: null,
  }), "skip");
});

test("a durable submission mapping wins over phone and pipeline status when resolving a retry", async () => {
  const { applicationSubmissionMappingDecision } = await loadApplicationSubmissionModule();

  assert.equal(typeof applicationSubmissionMappingDecision, "function");
  assert.deepEqual(applicationSubmissionMappingDecision!({
    requestFingerprint: "same-fingerprint",
    outbox: { applicantId: 17, requestFingerprint: "same-fingerprint" },
    applicant: { applicantId: 99, requestFingerprint: "same-fingerprint" },
  }), { kind: "reuse", applicantId: 17, source: "outbox" });
  assert.deepEqual(applicationSubmissionMappingDecision!({
    requestFingerprint: "same-fingerprint",
    outbox: null,
    applicant: { applicantId: 17, requestFingerprint: "same-fingerprint" },
  }), { kind: "reuse", applicantId: 17, source: "applicant" });
  assert.deepEqual(applicationSubmissionMappingDecision!({
    requestFingerprint: "changed-fingerprint",
    outbox: { applicantId: 17, requestFingerprint: "first-fingerprint" },
    applicant: null,
  }), { kind: "conflict" });
});

test("a mapped retry updates its original applicant even after the first attempt was rejected", async () => {
  const { shouldUpdateApplicationApplicant } = await loadApplicationSubmissionModule();

  assert.equal(typeof shouldUpdateApplicationApplicant, "function");
  for (const existingStatus of ["부적합", "이탈"]) {
    assert.equal(shouldUpdateApplicationApplicant!({
      hasExistingApplicant: true,
      idempotentReplay: true,
      existingSource: "direct",
      existingStatus,
    }), true);
  }
  assert.equal(shouldUpdateApplicationApplicant!({
    hasExistingApplicant: true,
    idempotentReplay: false,
    existingSource: "direct",
    existingStatus: "부적합",
  }), false);
});

test("the first initial message is claimed before the provider is called", async () => {
  const { deliverApplicationMessage } = await loadApplicationSubmissionModule();

  assert.equal(typeof deliverApplicationMessage, "function");
  const order: string[] = [];
  const result = await deliverApplicationMessage!({
    request: applicationMessageRequest,
    claim: async () => {
      order.push("claim");
      return { kind: "claimed" };
    },
    send: async () => {
      order.push("send");
      return {
        success: true,
        messageId: "provider-1",
        messageType: "alimtalk",
        templateId: "template-1",
      };
    },
    markUnknown: async () => { order.push("unknown"); },
    markFailed: async () => { order.push("failed"); },
    markSent: async () => {
      order.push("mark-sent");
      return true;
    },
    record: async () => {
      order.push("record");
      return true;
    },
  });

  assert.deepEqual(order, ["claim", "send", "mark-sent", "record"]);
  assert.deepEqual(result, {
    delivery: "sent",
    recorded: true,
    deduplicated: false,
  });
});

test("a sent application replay repairs history with the stored message and never resends", async () => {
  const { deliverApplicationMessage } = await loadApplicationSubmissionModule();

  assert.equal(typeof deliverApplicationMessage, "function");
  let sends = 0;
  let recordedBody = "";
  const result = await deliverApplicationMessage!({
    request: applicationMessageRequest,
    claim: async () => ({ kind: "existing", request: existingApplicationMessage() }),
    send: async () => {
      sends += 1;
      return { success: true, messageType: "sms" };
    },
    markUnknown: async () => {},
    markFailed: async () => {},
    markSent: async () => true,
    record: async (message) => {
      recordedBody = message.body;
      assert.equal(message.providerMessageId, "provider-1");
      assert.equal(message.messageType, "alimtalk");
      assert.equal(message.templateId, "template-1");
      return true;
    },
  });

  assert.equal(sends, 0);
  assert.equal(recordedBody, "처음 발송한 접수 안내");
  assert.deepEqual(result, {
    delivery: "sent",
    recorded: true,
    deduplicated: true,
  });
});

test("every non-sent application replay fails closed without invoking the provider", async () => {
  const { deliverApplicationMessage } = await loadApplicationSubmissionModule();

  assert.equal(typeof deliverApplicationMessage, "function");
  for (const existing of [
    existingApplicationMessage({ status: "sending" }),
    existingApplicationMessage({ status: "unknown" }),
    existingApplicationMessage({ status: "failed" }),
    existingApplicationMessage({ request_fingerprint: "different-submission" }),
  ]) {
    let sends = 0;
    let records = 0;
    const result = await deliverApplicationMessage!({
      request: applicationMessageRequest,
      claim: async () => ({ kind: "existing", request: existing }),
      send: async () => {
        sends += 1;
        return { success: true, messageType: "sms" };
      },
      markUnknown: async () => {},
      markFailed: async () => {},
      markSent: async () => true,
      record: async () => {
        records += 1;
        return true;
      },
    });

    assert.equal(sends, 0, String(existing.status));
    assert.equal(records, 0, String(existing.status));
    assert.notEqual(result.delivery, "sent", String(existing.status));
  }
});

test("only an explicit provider rejection is definitely not sent", async () => {
  const { deliverApplicationMessage } = await loadApplicationSubmissionModule();

  assert.equal(typeof deliverApplicationMessage, "function");
  for (const provider of [
    { success: false, failureKind: "declared" as const, error: "invalid recipient", expected: "not_sent" as const },
    { success: false, failureKind: "unknown" as const, error: "upstream timeout", expected: "unknown" as const },
  ]) {
    const transitions: string[] = [];
    const result = await deliverApplicationMessage!({
      request: applicationMessageRequest,
      claim: async () => ({ kind: "claimed" }),
      send: async () => ({
        success: provider.success,
        failureKind: provider.failureKind,
        error: provider.error,
        messageType: "alimtalk",
      }),
      markUnknown: async () => { transitions.push("unknown"); },
      markFailed: async () => { transitions.push("failed"); },
      markSent: async () => {
        assert.fail("a failed provider result cannot be marked sent");
      },
      record: async () => {
        assert.fail("a failed provider result cannot be recorded");
      },
    });

    assert.equal(result.delivery, provider.expected);
    assert.deepEqual(
      transitions,
      [provider.failureKind === "declared" ? "failed" : "unknown"],
    );
  }
});

test("an active applicant resubmission preserves every advanced pipeline status", async () => {
  const { applicationStatusForSubmission } = await loadApplicationSubmissionModule();

  assert.equal(typeof applicationStatusForSubmission, "function");
  for (const existingStatus of ["스크리닝 중", "스크리닝 완료", "확정인력", "대기자"]) {
    assert.equal(applicationStatusForSubmission!(existingStatus, "부적합"), existingStatus);
  }
  assert.equal(applicationStatusForSubmission!("스크리닝 전", "부적합"), "부적합");
  assert.equal(applicationStatusForSubmission!(null, "스크리닝 중"), "스크리닝 중");
});

test("a real job without a vehicle requirement skips the legacy vehicle trio", async () => {
  const {
    applicationVehicleRequired,
    applicationFilterPasses,
    validateApplicationSubmission,
    applicationSubmissionProgress,
  } = await loadApplicationSubmissionModule();

  assert.equal(typeof applicationVehicleRequired, "function");
  assert.equal(typeof applicationFilterPasses, "function");
  assert.equal(typeof validateApplicationSubmission, "function");
  assert.equal(typeof applicationSubmissionProgress, "function");

  const vehicleRequired = applicationVehicleRequired!({
    jobRequested: true,
    jobVehicleRequired: false,
  });
  assert.equal(vehicleRequired, false);
  assert.equal(applicationFilterPasses!({
    ownVehicle: "없음",
    licenseType: "없음",
    selfOwnership: "문제 있음",
    vehicleRequired,
  }), true);
  assert.equal(validateApplicationSubmission!({
    ...completeForm,
    ownVehicle: "",
    licenseType: "",
    vehicleType: "",
    selfOwnership: "",
  }, vehicleRequired), null);
  assert.deepEqual(applicationSubmissionProgress!({
    ...completeForm,
    ownVehicle: "",
    licenseType: "",
    vehicleType: "",
    selfOwnership: "",
  }, vehicleRequired), { completed: 7, total: 7, percent: 100 });
  assert.deepEqual(applicationSubmissionProgress!({
    ...completeForm,
    location: "",
  }, vehicleRequired), { completed: 6, total: 7, percent: 86 });
});

test("submission validation rejects impossible birth dates and excludes them from progress", async () => {
  const {
    validateApplicationSubmission,
    applicationSubmissionProgress,
  } = await loadApplicationSubmissionModule();

  assert.equal(typeof validateApplicationSubmission, "function");
  assert.equal(typeof applicationSubmissionProgress, "function");
  const impossibleBirthDate = { ...completeForm, birthDate: "000230" };

  assert.deepEqual(validateApplicationSubmission!(impossibleBirthDate, true), {
    field: "birthDate",
    message: "생년월일을 확인해주세요. 예: 1960년 1월 1일은 600101입니다.",
  });
  assert.deepEqual(
    applicationSubmissionProgress!(impossibleBirthDate, true),
    { completed: 10, total: 11, percent: 91 },
  );
});

test("general and vehicle-required applications retain the legacy vehicle gate", async () => {
  const {
    applicationVehicleRequired,
    applicationFilterPasses,
    validateApplicationSubmission,
  } = await loadApplicationSubmissionModule();

  assert.equal(applicationVehicleRequired!({ jobRequested: false, jobVehicleRequired: null }), true);
  assert.equal(applicationVehicleRequired!({ jobRequested: true, jobVehicleRequired: true }), true);
  assert.equal(applicationFilterPasses!({
    ownVehicle: "없음",
    licenseType: "없음",
    selfOwnership: "문제 있음",
    vehicleRequired: true,
  }), false);
  assert.deepEqual(validateApplicationSubmission!({
    ...completeForm,
    ownVehicle: "",
  }, true), {
    field: "ownVehicle",
    message: "자차 보유 여부를 선택해주세요.",
  });
});

test("vehicle-required validation follows the visible form order", async () => {
  const { validateApplicationSubmission } = await loadApplicationSubmissionModule();

  assert.equal(typeof validateApplicationSubmission, "function");
  assert.deepEqual(validateApplicationSubmission!({
    ...completeForm,
    branch1: "",
    workHours: [],
    availableDate: "",
    selfOwnership: "",
  }, true), {
    field: "branch1",
    message: "희망 지점을 선택해주세요.",
  });
  assert.deepEqual(validateApplicationSubmission!({
    ...completeForm,
    workHours: [],
    availableDate: "",
    selfOwnership: "",
  }, true), {
    field: "workHours",
    message: "희망 근무 시간대를 1개 이상 선택해주세요.",
  });
  assert.deepEqual(validateApplicationSubmission!({
    ...completeForm,
    availableDate: "",
    selfOwnership: "",
  }, true), {
    field: "availableDate",
    message: "근무 가능 시작일을 선택해주세요.",
  });
});

test("only a confirmed candidate link produces the job-linked completion state", async () => {
  const { applicationCompletionKind } = await loadApplicationSubmissionModule();

  assert.equal(typeof applicationCompletionKind, "function");
  assert.equal(applicationCompletionKind!("linked"), "job_linked");
  assert.equal(applicationCompletionKind!("unchanged"), "general_job_unchanged");
  assert.equal(applicationCompletionKind!("unavailable"), "general_job_unavailable");
  assert.equal(applicationCompletionKind!("failed"), "general_job_failed");
  assert.equal(applicationCompletionKind!("not_requested"), "general");
});

test("a requested job distinguishes a preserved closure from a transient link failure", async () => {
  const { applicationJobOutcome } = await loadApplicationSubmissionModule();

  assert.equal(typeof applicationJobOutcome, "function");
  assert.equal(applicationJobOutcome!({
    jobRequested: false,
    candidateLinkOutcome: null,
  }), "not_requested");
  assert.equal(applicationJobOutcome!({
    jobRequested: true,
    candidateLinkOutcome: "unavailable",
  }), "unavailable");
  assert.equal(applicationJobOutcome!({
    jobRequested: true,
    candidateLinkOutcome: "unchanged_closed",
  }), "unchanged");
  assert.equal(applicationJobOutcome!({
    jobRequested: true,
    candidateLinkOutcome: null,
  }), "failed");
  assert.equal(applicationJobOutcome!({
    jobRequested: true,
    candidateLinkOutcome: "linked",
  }), "linked");
  assert.equal(applicationJobOutcome!({
    jobRequested: true,
    candidateLinkOutcome: "already_linked",
  }), "linked");
});

test("a preserved closed candidate never becomes the applicant's current job", async () => {
  const { shouldSetApplicationCurrentJob } = await loadApplicationSubmissionModule();

  assert.equal(typeof shouldSetApplicationCurrentJob, "function");
  assert.equal(shouldSetApplicationCurrentJob!(true, "linked"), true);
  assert.equal(shouldSetApplicationCurrentJob!(true, "already_linked"), true);
  assert.equal(shouldSetApplicationCurrentJob!(true, "unchanged_closed"), false);
  assert.equal(shouldSetApplicationCurrentJob!(true, "unavailable"), false);
  assert.equal(shouldSetApplicationCurrentJob!(true, null), false);
  assert.equal(shouldSetApplicationCurrentJob!(false, "linked"), false);
});

test("a success response is trusted only when every outcome field is explicit", async () => {
  const { isApplicationSubmissionResult } = await loadApplicationSubmissionModule();

  assert.equal(typeof isApplicationSubmissionResult, "function");
  assert.equal(isApplicationSubmissionResult!({
    success: true,
    duplicate: false,
    jobApplication: "linked",
    initialMessageSent: true,
    initialMessageDelivery: "sent",
  }), true);
  assert.equal(isApplicationSubmissionResult!({
    success: true,
    duplicate: true,
    jobApplication: "unchanged",
    initialMessageSent: false,
    initialMessageDelivery: "unknown",
  }), true);
  assert.equal(isApplicationSubmissionResult!({
    success: true,
    duplicate: true,
    jobApplication: "unchanged",
    initialMessageSent: true,
    initialMessageDelivery: "unknown",
  }), false);
  assert.equal(isApplicationSubmissionResult!({
    success: true,
    duplicate: false,
    jobApplication: "linked",
  }), false);
  assert.equal(isApplicationSubmissionResult!({
    success: true,
    duplicate: false,
    jobApplication: "linked",
    initialMessageSent: true,
  }), false);
  assert.equal(isApplicationSubmissionResult!({
    success: true,
    duplicate: false,
    jobApplication: "unknown",
    initialMessageSent: false,
    initialMessageDelivery: "not_sent",
  }), false);
  assert.equal(isApplicationSubmissionResult!({
    success: true,
    duplicate: false,
    jobApplication: "linked",
    initialMessageSent: false,
    initialMessageDelivery: "invalid",
  }), false);
});

test("an uncertain delivery is not presented as either sent or definitely unsent", async () => {
  const { applicationInitialMessageUiState } = await loadApplicationSubmissionModule();

  assert.equal(typeof applicationInitialMessageUiState, "function");
  assert.equal(applicationInitialMessageUiState!("sent"), "sent");
  assert.equal(applicationInitialMessageUiState!("not_sent"), "not_sent");
  assert.equal(applicationInitialMessageUiState!("unknown"), "uncertain");
});

test("application initial-message outbox is service-only and supports sent-history repair", async () => {
  const migration = await readFile(
    new URL("../docs/migrations/2026-08-apply-message-idempotency.sql", import.meta.url),
    "utf8",
  ).catch(() => "");

  assert.match(migration, /create table if not exists public\.application_message_send_requests/i);
  assert.match(migration, /request_fingerprint text not null/i);
  assert.match(migration, /status in \('sending', 'unknown', 'failed', 'sent', 'recorded'\)/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.application_message_send_requests[\s\S]*anon, authenticated/i);
  assert.match(migration, /grant select, insert, update on table public\.application_message_send_requests to service_role/i);
  assert.match(migration, /add column if not exists client_request_id uuid/i);
  assert.match(migration, /unique index if not exists messages_client_request_id_uidx/i);
});

test("legacy application failures with no provider classification become delivery-unknown", async () => {
  const migration = await readFile(
    new URL(
      "../docs/migrations/2026-08-apply-provider-delivery-classification.sql",
      import.meta.url,
    ),
    "utf8",
  ).catch(() => "");

  assert.match(migration, /update public\.application_message_send_requests/i);
  assert.match(migration, /set[\s\S]*status = 'unknown'/i);
  assert.match(migration, /where status = 'failed'/i);
});

test("submission-to-applicant mapping is durable before status-based insert decisions", async () => {
  const [migration, ledgerMigration, route] = await Promise.all([
    readFile(
      new URL("../docs/migrations/2026-08-apply-submission-mapping.sql", import.meta.url),
      "utf8",
    ).catch(() => ""),
    readFile(
      new URL("../docs/migrations/2026-08-apply-submission-recovery-ledger.sql", import.meta.url),
      "utf8",
    ).catch(() => ""),
    readFile(new URL("../app/api/apply/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(migration, /add column if not exists application_submission_id uuid/i);
  assert.match(migration, /add column if not exists application_request_fingerprint text/i);
  assert.match(migration, /add column if not exists application_auto_engagement_required boolean/i);
  assert.match(migration, /unique index if not exists applicants_application_submission_id_uidx/i);
  assert.match(migration, /application_message_send_requests[\s\S]*auto_engagement_required/i);
  assert.match(ledgerMigration, /create table if not exists public\.application_submission_mappings/i);
  assert.match(ledgerMigration, /submission_id uuid primary key/i);
  assert.match(ledgerMigration, /request_fingerprint text not null/i);
  assert.match(ledgerMigration, /applicant_id bigint not null/i);
  assert.match(ledgerMigration, /after insert or update[\s\S]*on public\.applicants/i);
  assert.match(ledgerMigration, /insert into public\.application_submission_mappings/i);
  assert.match(ledgerMigration, /raise exception[\s\S]*errcode\s*=\s*'23505'/i);
  assert.match(
    ledgerMigration,
    /insert into public\.application_submission_mappings[\s\S]*idempotency_key[\s\S]*from public\.application_message_send_requests/i,
  );

  const outboxLookup = route.indexOf('.from("application_message_send_requests")');
  const ledgerLookup = route.indexOf('.from("application_submission_mappings")');
  const phoneLookup = route.indexOf('.eq("phone", phone)');
  assert.ok(outboxLookup >= 0 && outboxLookup < phoneLookup);
  assert.ok(ledgerLookup >= 0 && ledgerLookup < phoneLookup);
  assert.match(route, /application_submission_id:\s*submissionId/);
  assert.match(route, /application_request_fingerprint:\s*submissionFingerprint/);
  assert.match(route, /\.upsert\([\s\S]*onConflict:\s*"job_id,applicant_id"[\s\S]*ignoreDuplicates:\s*true/);
});

test("a confirmed applicant resubmission preserves operational evidence", async () => {
  const { applicationOperationalFieldsForSubmission } = await loadApplicationSubmissionModule();

  assert.equal(typeof applicationOperationalFieldsForSubmission, "function");
  assert.deepEqual(applicationOperationalFieldsForSubmission!({
    updateMode: true,
    isDuplicate: true,
    submittedSource: "direct",
    nextFilterPass: "N",
    existing: {
      status: "확정인력",
      source: "danggeun",
      filterPass: "Y",
      note: "매니저 확인 메모",
      availableSlots: ["평일오전"],
      availableSlotsUpdatedAt: "2026-08-19T01:00:00.000Z",
    },
  }), {
    source: "danggeun",
    filterPass: "Y",
    note: "매니저 확인 메모",
    availableSlots: ["평일오전"],
    availableSlotsUpdatedAt: "2026-08-19T01:00:00.000Z",
  });
});

test("a new or pre-screening application still uses the latest submitted policy", async () => {
  const { applicationOperationalFieldsForSubmission } = await loadApplicationSubmissionModule();

  assert.equal(typeof applicationOperationalFieldsForSubmission, "function");
  assert.deepEqual(applicationOperationalFieldsForSubmission!({
    updateMode: true,
    isDuplicate: true,
    submittedSource: "direct",
    nextFilterPass: "N",
    existing: {
      status: "스크리닝 전",
      source: "baemin",
      filterPass: "Y",
      note: null,
      availableSlots: ["주말오후"],
      availableSlotsUpdatedAt: "2026-08-18T01:00:00.000Z",
    },
  }), {
    source: "baemin",
    filterPass: "N",
    note: null,
    availableSlots: null,
    availableSlotsUpdatedAt: null,
  });
});

test("an omitted vehicle answer keeps a known profile value for a no-vehicle job", async () => {
  const { applicationOptionalAnswer } = await loadApplicationSubmissionModule();

  assert.equal(typeof applicationOptionalAnswer, "function");
  assert.equal(applicationOptionalAnswer!({
    submitted: "",
    existing: "있음",
    required: false,
  }), "있음");
  assert.equal(applicationOptionalAnswer!({
    submitted: "",
    existing: null,
    required: false,
  }), "미확인");
  assert.equal(applicationOptionalAnswer!({
    submitted: "승용차",
    existing: "오토바이",
    required: false,
  }), "승용차");
});
