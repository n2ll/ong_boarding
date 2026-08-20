import type {
  ApplicantFormData,
  ApplicantValidationIssue,
} from "./applicant-form";

export type JobApplicationOutcome = "linked" | "unchanged" | "unavailable" | "failed" | "not_requested";
export type CandidateLinkOutcome = "linked" | "already_linked" | "unchanged_closed" | "unavailable" | null;
export type ApplicationInitialMessageDelivery = "sent" | "not_sent" | "unknown";

export interface ApplicationSubmissionAttempt {
  fingerprint: string;
  id: string;
}

export interface ApplicationMessageRequest {
  requestFingerprint: string;
  applicantId: number;
  phone: string;
  body: string;
  jobId: number | null;
  sentBy: string;
}

export interface ExistingApplicationMessageRequest {
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

type ApplicationMessageClaimResult =
  | { kind: "claimed" }
  | { kind: "existing"; request: ExistingApplicationMessageRequest }
  | { kind: "error" };

interface ApplicationMessageProviderResult {
  success: boolean;
  messageId?: string;
  messageType: string;
  templateId?: string | null;
  failureKind?: "declared" | "unknown";
  error?: string;
}

interface ApplicationMessageRecord {
  applicantId: number;
  phone: string;
  body: string;
  jobId: number | null;
  sentBy: string;
  providerMessageId: string | null;
  messageType: string;
  templateId: string | null;
}

interface DeliverApplicationMessageArgs {
  request: ApplicationMessageRequest;
  claim: () => Promise<ApplicationMessageClaimResult>;
  send: () => Promise<ApplicationMessageProviderResult>;
  markUnknown: (error: string) => Promise<void>;
  markFailed: (error: string) => Promise<void>;
  markSent: (result: {
    providerMessageId: string | null;
    messageType: string;
    templateId: string | null;
  }) => Promise<boolean>;
  record: (message: ApplicationMessageRecord) => Promise<boolean>;
}

export interface ApplicationMessageDeliveryResult {
  delivery: ApplicationInitialMessageDelivery;
  recorded: boolean;
  deduplicated: boolean;
  conflict?: boolean;
}

export interface ApplicationSubmissionResult {
  success: true;
  duplicate: boolean;
  jobApplication: JobApplicationOutcome;
  initialMessageSent: boolean;
  initialMessageDelivery: ApplicationInitialMessageDelivery;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateApplicationSubmissionId(
  value: unknown,
): { ok: true; id: string } | { ok: false; reason: "required" | "invalid" } {
  if (value == null || (typeof value === "string" && !value.trim())) {
    return { ok: false, reason: "required" };
  }
  if (typeof value !== "string") return { ok: false, reason: "invalid" };
  const id = value.trim();
  return UUID_PATTERN.test(id)
    ? { ok: true, id }
    : { ok: false, reason: "invalid" };
}

export function applicationSubmissionPayloadFingerprint(
  request: ApplicantFormData & { source: string; jobId: number | null },
): string {
  return JSON.stringify([
    request.name,
    request.birthDate,
    request.phone,
    request.location,
    request.ownVehicle,
    request.licenseType,
    request.vehicleType,
    request.branch1,
    request.branch2,
    request.workHours,
    request.experience,
    request.introduction,
    request.availableDate,
    request.selfOwnership,
    request.marketingConsent,
    request.source,
    request.jobId,
  ]);
}

export async function applicationSubmissionPayloadDigest(
  request: ApplicantFormData & { source: string; jobId: number | null },
): Promise<string> {
  const bytes = new TextEncoder().encode(applicationSubmissionPayloadFingerprint(request));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function nextApplicationSubmissionAttempt(
  current: ApplicationSubmissionAttempt | null,
  request: ApplicantFormData & { source: string; jobId: number | null },
  createId: () => string,
): ApplicationSubmissionAttempt {
  const fingerprint = applicationSubmissionPayloadFingerprint(request);
  return current?.fingerprint === fingerprint
    ? current
    : { fingerprint, id: createId() };
}

export function prepareApplicationSubmission(
  current: ApplicationSubmissionAttempt | null,
  request: ApplicantFormData & { source: string; jobId: number | null },
  createId: () => string,
): {
  attempt: ApplicationSubmissionAttempt;
  payload: ApplicantFormData & { source: string; jobId: number | null; submissionId: string };
} {
  const attempt = nextApplicationSubmissionAttempt(current, request, createId);
  return {
    attempt,
    payload: { ...request, submissionId: attempt.id },
  };
}

/** 일반 active 재제출은 건너뛰고, triage가 만든 배민 임시 행의 첫 폼 완성만 시작한다. */
export function shouldStartApplicationAutoEngagement(input: {
  updateMode: boolean;
  existingSource: string | null;
  existingStatus: string | null;
  existingFilterPass: string | null;
  existingBirthDate: string | null;
}): boolean {
  if (!input.updateMode) return true;
  return input.existingSource === "baemin"
    && (input.existingStatus === "스크리닝 전" || input.existingStatus === null)
    && input.existingFilterPass === null
    && input.existingBirthDate === "미확인";
}

const ACTIVE_APPLICATION_STATUSES = new Set([
  "스크리닝 전",
  "스크리닝 중",
  "스크리닝 완료",
  "확정인력",
  "대기자",
]);

/** 동일 submission replay는 파이프라인 상태와 무관하게 최초 applicant를 갱신한다. */
export function shouldUpdateApplicationApplicant(input: {
  hasExistingApplicant: boolean;
  idempotentReplay: boolean;
  existingSource: string | null;
  existingStatus: string | null;
}): boolean {
  if (!input.hasExistingApplicant) return false;
  if (input.idempotentReplay) return true;
  return (
    input.existingSource === "baemin"
    && (input.existingStatus === "스크리닝 전" || input.existingStatus === null)
  ) || ACTIVE_APPLICATION_STATUSES.has(input.existingStatus ?? "");
}

export function applicationInitialMessagePlan(input: {
  startAutoEngagement: boolean;
  existingRequest: ExistingApplicationMessageRequest | null;
}): "claim" | "replay" | "skip" {
  if (input.existingRequest) return "replay";
  if (input.startAutoEngagement) return "claim";
  return "skip";
}

export function applicationSubmissionMappingDecision(input: {
  requestFingerprint: string;
  outbox: { applicantId: number; requestFingerprint: string } | null;
  applicant: { applicantId: number; requestFingerprint: string | null } | null;
}):
  | { kind: "new" }
  | { kind: "reuse"; applicantId: number; source: "outbox" | "applicant" }
  | { kind: "conflict" } {
  if (input.outbox) {
    return input.outbox.requestFingerprint === input.requestFingerprint
      ? { kind: "reuse", applicantId: input.outbox.applicantId, source: "outbox" }
      : { kind: "conflict" };
  }
  if (input.applicant) {
    return input.applicant.requestFingerprint === input.requestFingerprint
      ? { kind: "reuse", applicantId: input.applicant.applicantId, source: "applicant" }
      : { kind: "conflict" };
  }
  return { kind: "new" };
}

export function applicationInitialMessageUiState(
  delivery: ApplicationInitialMessageDelivery,
): "sent" | "not_sent" | "uncertain" {
  if (delivery === "sent") return "sent";
  return delivery === "unknown" ? "uncertain" : "not_sent";
}

function sameApplicationMessageRequest(
  existing: ExistingApplicationMessageRequest,
  request: ApplicationMessageRequest,
): boolean {
  return existing.request_fingerprint === request.requestFingerprint
    && existing.applicant_id === request.applicantId
    && existing.applicant_phone === request.phone
    && existing.job_id === request.jobId
    && existing.sent_by === request.sentBy;
}

/** outbox 선점 뒤에만 외부 발송하며, 어떤 기존 상태도 공급자를 다시 호출하지 않는다. */
export async function deliverApplicationMessage({
  request,
  claim,
  send,
  markUnknown,
  markFailed,
  markSent,
  record,
}: DeliverApplicationMessageArgs): Promise<ApplicationMessageDeliveryResult> {
  let claimed: ApplicationMessageClaimResult;
  try {
    claimed = await claim();
  } catch {
    claimed = { kind: "error" };
  }

  if (claimed.kind === "error") {
    return { delivery: "not_sent", recorded: false, deduplicated: false };
  }

  if (claimed.kind === "existing") {
    if (!sameApplicationMessageRequest(claimed.request, request)) {
      return {
        delivery: "not_sent",
        recorded: false,
        deduplicated: true,
        conflict: true,
      };
    }
    if (claimed.request.status !== "sent" && claimed.request.status !== "recorded") {
      return {
        delivery: claimed.request.status === "failed" ? "not_sent" : "unknown",
        recorded: false,
        deduplicated: true,
      };
    }

    let recorded = false;
    try {
      recorded = await record({
        applicantId: claimed.request.applicant_id,
        phone: claimed.request.applicant_phone,
        body: claimed.request.body,
        jobId: claimed.request.job_id,
        sentBy: claimed.request.sent_by,
        providerMessageId: claimed.request.provider_message_id,
        messageType: claimed.request.message_type || "sms",
        templateId: claimed.request.template_id,
      });
    } catch {
      recorded = false;
    }
    return { delivery: "sent", recorded, deduplicated: true };
  }

  let providerResult: ApplicationMessageProviderResult;
  try {
    providerResult = await send();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "provider result unknown";
    try {
      await markUnknown(detail);
    } catch {
      // 공급자 결과가 불명확하면 상태 기록 실패와 무관하게 재발송하지 않는다.
    }
    return { delivery: "unknown", recorded: false, deduplicated: false };
  }

  if (!providerResult.success) {
    const detail = providerResult.error || "provider result unknown";
    if (providerResult.failureKind !== "declared") {
      try {
        await markUnknown(detail);
      } catch {
        // 공급자 결과가 불명확하면 상태 기록 실패와 무관하게 재발송하지 않는다.
      }
      return { delivery: "unknown", recorded: false, deduplicated: false };
    }
    try {
      await markFailed(detail);
    } catch {
      // 실패가 확정된 동일 key도 replay하지 않는다.
    }
    return { delivery: "not_sent", recorded: false, deduplicated: false };
  }

  const deliveryRecord = {
    applicantId: request.applicantId,
    phone: request.phone,
    body: request.body,
    jobId: request.jobId,
    sentBy: request.sentBy,
    providerMessageId: providerResult.messageId || null,
    messageType: providerResult.messageType,
    templateId: providerResult.templateId || null,
  };
  let sentPersisted = false;
  try {
    sentPersisted = await markSent({
      providerMessageId: deliveryRecord.providerMessageId,
      messageType: deliveryRecord.messageType,
      templateId: deliveryRecord.templateId,
    });
  } catch {
    sentPersisted = false;
  }
  if (!sentPersisted) {
    return { delivery: "sent", recorded: false, deduplicated: false };
  }

  let recorded = false;
  try {
    recorded = await record(deliveryRecord);
  } catch {
    recorded = false;
  }
  return { delivery: "sent", recorded, deduplicated: false };
}

const ADVANCED_APPLICATION_STATUSES = new Set([
  "스크리닝 중",
  "스크리닝 완료",
  "확정인력",
  "대기자",
]);

const VALID_LICENSES = new Set(["1종 보통", "2종 보통", "1종 대형"]);

export function applicationStatusForSubmission(
  existingStatus: string | null,
  nextStatus: string,
): string {
  return existingStatus && ADVANCED_APPLICATION_STATUSES.has(existingStatus)
    ? existingStatus
    : nextStatus;
}

export function applicationVehicleRequired(input: {
  jobRequested: boolean;
  jobVehicleRequired: boolean | null;
}): boolean {
  return !input.jobRequested || input.jobVehicleRequired !== false;
}

export function applicationFilterPasses(input: {
  ownVehicle: string;
  licenseType: string;
  selfOwnership: string;
  vehicleRequired: boolean;
}): boolean {
  if (!input.vehicleRequired) return true;
  return input.ownVehicle === "있음"
    && VALID_LICENSES.has(input.licenseType)
    && input.selfOwnership === "문제 없음";
}

const BASE_REQUIREMENTS: Array<ApplicantValidationIssue & { isValid: (form: ApplicantFormData) => boolean }> = [
  { field: "name", message: "이름을 입력해주세요.", isValid: (form) => Boolean(form.name.trim()) },
  { field: "birthDate", message: "생년월일 6자리(예: 600101)를 입력해주세요.", isValid: (form) => /^\d{6}$/.test(form.birthDate) },
  { field: "phone", message: "연락처를 정확히 입력해주세요.", isValid: (form) => /^\d{10,11}$/.test(form.phone) },
  { field: "location", message: "거주지 주소를 입력해주세요.", isValid: (form) => Boolean(form.location.trim()) },
  { field: "branch1", message: "희망 지점을 선택해주세요.", isValid: (form) => Boolean(form.branch1) },
  { field: "workHours", message: "희망 근무 시간대를 1개 이상 선택해주세요.", isValid: (form) => form.workHours.length > 0 },
  { field: "availableDate", message: "근무 가능 시작일을 선택해주세요.", isValid: (form) => Boolean(form.availableDate) },
];

const VEHICLE_REQUIREMENTS: Array<ApplicantValidationIssue & { isValid: (form: ApplicantFormData) => boolean }> = [
  { field: "ownVehicle", message: "자차 보유 여부를 선택해주세요.", isValid: (form) => Boolean(form.ownVehicle) },
  { field: "licenseType", message: "운전면허 종류를 선택해주세요.", isValid: (form) => Boolean(form.licenseType) },
  { field: "vehicleType", message: "이동 수단을 입력해주세요.", isValid: (form) => Boolean(form.vehicleType.trim()) },
  { field: "selfOwnership", message: "본인 명의 가능 여부를 선택해주세요.", isValid: (form) => Boolean(form.selfOwnership) },
];

function applicationRequirements(vehicleRequired: boolean) {
  return vehicleRequired
    ? [...BASE_REQUIREMENTS.slice(0, 4), ...VEHICLE_REQUIREMENTS, ...BASE_REQUIREMENTS.slice(4)]
    : BASE_REQUIREMENTS;
}

export function validateApplicationSubmission(
  form: ApplicantFormData,
  vehicleRequired: boolean,
): ApplicantValidationIssue | null {
  const invalid = applicationRequirements(vehicleRequired).find((requirement) => !requirement.isValid(form));
  return invalid ? { field: invalid.field, message: invalid.message } : null;
}

export function applicationSubmissionProgress(
  form: ApplicantFormData,
  vehicleRequired: boolean,
): { completed: number; total: number; percent: number } {
  const requirements = applicationRequirements(vehicleRequired);
  const completed = requirements.filter((requirement) => requirement.isValid(form)).length;
  const total = requirements.length;
  return {
    completed,
    total,
    percent: Math.round((completed / total) * 100),
  };
}

export function applicationCompletionKind(outcome: JobApplicationOutcome):
  | "job_linked"
  | "general_job_unchanged"
  | "general_job_unavailable"
  | "general_job_failed"
  | "general" {
  if (outcome === "linked") return "job_linked";
  if (outcome === "unchanged") return "general_job_unchanged";
  if (outcome === "unavailable") return "general_job_unavailable";
  if (outcome === "failed") return "general_job_failed";
  return "general";
}

export function applicationJobOutcome(input: {
  jobRequested: boolean;
  candidateLinkOutcome: CandidateLinkOutcome;
}): JobApplicationOutcome {
  if (!input.jobRequested) return "not_requested";
  if (input.candidateLinkOutcome === "linked" || input.candidateLinkOutcome === "already_linked") return "linked";
  if (input.candidateLinkOutcome === "unchanged_closed") return "unchanged";
  if (input.candidateLinkOutcome === "unavailable") return "unavailable";
  return "failed";
}

export function shouldSetApplicationCurrentJob(
  filterPass: boolean,
  candidateLinkOutcome: CandidateLinkOutcome,
): boolean {
  return filterPass && (
    candidateLinkOutcome === "linked" || candidateLinkOutcome === "already_linked"
  );
}

const JOB_APPLICATION_OUTCOMES = new Set<JobApplicationOutcome>([
  "linked",
  "unchanged",
  "unavailable",
  "failed",
  "not_requested",
]);

const INITIAL_MESSAGE_DELIVERIES = new Set<ApplicationInitialMessageDelivery>([
  "sent",
  "not_sent",
  "unknown",
]);

export function isApplicationSubmissionResult(value: unknown): value is ApplicationSubmissionResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ApplicationSubmissionResult>;
  return result.success === true
    && typeof result.duplicate === "boolean"
    && typeof result.initialMessageSent === "boolean"
    && INITIAL_MESSAGE_DELIVERIES.has(
      result.initialMessageDelivery as ApplicationInitialMessageDelivery,
    )
    && result.initialMessageSent === (result.initialMessageDelivery === "sent")
    && JOB_APPLICATION_OUTCOMES.has(result.jobApplication as JobApplicationOutcome);
}

export function applicationOperationalFieldsForSubmission(input: {
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
}): {
  source: string;
  filterPass: string;
  note: string | null;
  availableSlots: unknown;
  availableSlotsUpdatedAt: string | null;
} {
  const existing = input.updateMode ? input.existing : null;
  const preserveAdvancedFilter = Boolean(
    existing?.status && ADVANCED_APPLICATION_STATUSES.has(existing.status),
  );
  const preserveConfirmedAvailability = existing?.status === "확정인력";

  return {
    source: existing?.source?.trim() || input.submittedSource?.trim() || "direct",
    filterPass: preserveAdvancedFilter && existing?.filterPass
      ? existing.filterPass
      : input.nextFilterPass,
    // 매니저 메모는 재제출 표시로 덮지 않는다. 신규 중복 row에만 중복 표시를 남긴다.
    note: existing ? existing.note : (input.isDuplicate ? "중복지원" : null),
    // 확정 지점·슬롯의 근거가 되는 마지막 가용성 증거는 확정 레코드에서 보존한다.
    availableSlots: preserveConfirmedAvailability ? existing?.availableSlots ?? null : null,
    availableSlotsUpdatedAt: preserveConfirmedAvailability
      ? existing?.availableSlotsUpdatedAt ?? null
      : null,
  };
}

export function applicationOptionalAnswer(input: {
  submitted: string | null | undefined;
  existing: string | null | undefined;
  required: boolean;
}): string {
  const submitted = input.submitted?.trim();
  if (submitted) return submitted;
  if (!input.required && input.existing?.trim()) return input.existing.trim();
  return "미확인";
}
