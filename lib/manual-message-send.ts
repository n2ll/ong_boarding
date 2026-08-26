export interface ManualMessageAttempt {
  fingerprint: string;
  key: string;
}

export interface ManualMessageFingerprint {
  applicantId: number | null;
  phone: string;
  body: string;
  jobId: number | null;
  sentBy: string;
  draftId: string | null;
  draftWasEdited: boolean;
}

export interface ManualMessageSendPayload {
  applicant_id: number | null;
  phone: string;
  body: string;
  sent_by: string;
  job_id?: number;
  draft_id?: string;
  draft_was_edited?: boolean;
  purpose: "current_application";
  idempotency_key: string;
}

export type ManualMessageFailureCode =
  | "job_scope_mismatch"
  | "job_scope_unavailable"
  | "recipient_mismatch"
  | "recipient_unavailable"
  | "applicant_required"
  | "marketing_consent_required";

/** 값이 있었는데 형식이 틀린 job_id를 공고 미지정 발송으로 낮추지 않는다. */
export function parseManualMessageJobId(
  value: unknown,
): { ok: true; jobId: number | null } | { ok: false } {
  if (value == null) return { ok: true, jobId: null };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return { ok: false };
  }
  return { ok: true, jobId: value };
}

export function manualMessageRecipientEligibility(
  request: { applicantId: number | null; phone: string },
  lookup: { phone: string | null; failed: boolean },
):
  | { ok: true }
  | { ok: false; reason: "applicant_required" | "lookup_failed" | "mismatch" } {
  if (request.applicantId === null) return { ok: false, reason: "applicant_required" };
  if (lookup.failed) return { ok: false, reason: "lookup_failed" };
  const requestedPhone = request.phone.replace(/[^0-9]/g, "");
  const storedPhone = (lookup.phone ?? "").replace(/[^0-9]/g, "");
  return requestedPhone && requestedPhone === storedPhone
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

export function manualMessageJobBindingEligibility(
  request: { applicantId: number | null; jobId: number | null },
  lookup: { found: boolean; failed: boolean },
):
  | { ok: true }
  | { ok: false; reason: "applicant_required" | "lookup_failed" | "mismatch" } {
  if (request.jobId === null) return { ok: true };
  if (request.applicantId === null) return { ok: false, reason: "applicant_required" };
  if (lookup.failed) return { ok: false, reason: "lookup_failed" };
  return lookup.found ? { ok: true } : { ok: false, reason: "mismatch" };
}

export interface ManualMessageDraftRecord {
  applicant_id: number | null;
  job_id: number | null;
  status: string | null;
  send_claim_key: string | null;
}

export interface ExistingManualMessageRequest {
  applicant_id: number | null;
  applicant_phone: string;
  body: string;
  job_id: number | null;
  sent_by: string;
  draft_id: string | null;
  draft_was_edited: boolean;
  status: string | null;
  provider_message_id: string | null;
}

export type ManualMessageReplayDecision =
  | { action: "record"; delivery: "sent"; providerMessageId: string | null }
  | { action: "return"; delivery: "unknown"; recorded: false }
  | { action: "return"; delivery: "failed"; recorded: false }
  | { action: "conflict" };

export type ManualMessageClaimResult =
  | { kind: "claimed" }
  | { kind: "existing"; request: ExistingManualMessageRequest }
  | { kind: "conflict" }
  | { kind: "error" };

export interface ManualMessageDeliveryResult<TMessage> {
  delivery: "not_attempted" | "unknown" | "failed" | "sent";
  recorded: boolean;
  retryable: boolean;
  deduplicated: boolean;
  message: TMessage | null;
  conflict?: boolean;
  providerError?: string;
  failureCode?: ManualMessageFailureCode;
}

interface DeliverManualMessageArgs<TMessage> {
  key: string;
  request: ManualMessageFingerprint;
  claim: () => Promise<ManualMessageClaimResult>;
  send: () => Promise<
    | { success: true; messageId?: string; failureKind?: never; error?: never }
    | {
        success: false;
        failureKind?: "declared" | "unknown";
        error?: string;
        failureCode?: ManualMessageFailureCode;
        messageId?: never;
      }
  >;
  markUnknown: (error: string) => Promise<void>;
  markFailed: (error: string) => Promise<boolean>;
  markSent: (providerMessageId: string | null) => Promise<boolean>;
  record: (providerMessageId: string | null) => Promise<TMessage | null>;
}

export type ManualMessageClientResolution = {
  kind: "sent" | "sent_unrecorded" | "sent_followup_failed" | "unknown" | "failed" | "not_attempted";
  clearComposer: boolean;
  rotateKey: boolean;
  continueAfterSend: boolean;
};

export interface ManualMessagePostprocessResult {
  completed: boolean;
  pausedSkipped: "ambiguous" | "changed" | null;
  pausedJobId: number | null;
}

export type ManualMessagePauseOutcome =
  | { kind: "paused"; jobId: number }
  | { kind: "ambiguous" }
  | { kind: "changed" }
  | { kind: "none" }
  | { kind: "unknown" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 명시된 draft_id가 잘못됐을 때 일반 문자 발송으로 낮추지 않는다. */
export function parseManualMessageDraftId(
  value: unknown,
): { ok: true; draftId: string | null } | { ok: false } {
  if (value == null) return { ok: true, draftId: null };
  if (typeof value !== "string") return { ok: false };
  const draftId = value.trim();
  return UUID_PATTERN.test(draftId)
    ? { ok: true, draftId }
    : { ok: false };
}

/** 외부 SMS 호출 직전에 초안이 현재 지원자·공고의 미처리 건인지 다시 확인한다. */
export function manualDraftSendEligibility(
  draft: ManualMessageDraftRecord | null,
  request: Pick<ManualMessageFingerprint, "applicantId" | "jobId">,
  idempotencyKey: string,
):
  | { ok: true }
  | { ok: false; reason: "missing" | "applicant_mismatch" | "job_mismatch" | "claimed_elsewhere" | "resolved" } {
  if (!draft) return { ok: false, reason: "missing" };
  if (draft.applicant_id !== request.applicantId) return { ok: false, reason: "applicant_mismatch" };
  if (draft.job_id !== request.jobId) return { ok: false, reason: "job_mismatch" };
  if (draft.send_claim_key !== idempotencyKey) return { ok: false, reason: "claimed_elsewhere" };
  if (draft.status !== "pending" && draft.status !== "need_info") {
    return { ok: false, reason: "resolved" };
  }
  return { ok: true };
}

/** 서버가 임의 키를 만들지 않도록 호출부가 보낸 UUID만 허용한다. */
export function validateManualMessageIdempotencyKey(
  value: unknown
): { ok: true; key: string } | { ok: false; reason: "required" | "invalid" } {
  if (value == null || (typeof value === "string" && !value.trim())) {
    return { ok: false, reason: "required" };
  }
  if (typeof value !== "string") return { ok: false, reason: "invalid" };
  const key = value.trim();
  return UUID_PATTERN.test(key)
    ? { ok: true, key }
    : { ok: false, reason: "invalid" };
}

function fingerprint(request: ManualMessageFingerprint): string {
  return JSON.stringify([
    request.applicantId,
    request.phone,
    request.body,
    request.jobId,
    request.sentBy,
    request.draftId,
    request.draftWasEdited,
  ]);
}

/** 같은 발송 의도의 네트워크 재시도에는 같은 키를, 내용이 바뀌면 새 키를 준다. */
export function nextManualMessageAttempt(
  current: ManualMessageAttempt | null,
  request: ManualMessageFingerprint,
  createKey: () => string
): ManualMessageAttempt {
  const nextFingerprint = fingerprint(request);
  if (current?.fingerprint === nextFingerprint) return current;
  return { fingerprint: nextFingerprint, key: createKey() };
}

/** 동일한 발송 의도에서 중복 방지 키와 API payload를 함께 만들어 공고 결속의 어긋남을 막는다. */
export function prepareManualMessageSend(
  current: ManualMessageAttempt | null,
  request: ManualMessageFingerprint,
  createKey: () => string,
): { attempt: ManualMessageAttempt; payload: ManualMessageSendPayload } {
  const attempt = nextManualMessageAttempt(current, request, createKey);
  return {
    attempt,
    payload: {
      applicant_id: request.applicantId,
      phone: request.phone,
      body: request.body,
      sent_by: request.sentBy,
      ...(request.jobId !== null ? { job_id: request.jobId } : {}),
      ...(request.draftId !== null
        ? {
            draft_id: request.draftId,
            draft_was_edited: request.draftWasEdited,
          }
        : {}),
      purpose: "current_application",
      idempotency_key: attempt.key,
    },
  };
}

/**
 * 이미 선점된 키의 서버 재생 결정. 어떤 기존 상태도 `send`를 반환하지 않는다.
 * 명시적 실패를 다시 보내려면 클라이언트가 새 의도로 새 키를 만들어야 한다.
 */
export function manualMessageReplayDecision(
  existing: ExistingManualMessageRequest,
  request: ManualMessageFingerprint
): ManualMessageReplayDecision {
  const sameMessage =
    existing.applicant_id === request.applicantId
    && existing.applicant_phone === request.phone
    && existing.body === request.body
    && existing.job_id === request.jobId
    && existing.sent_by === request.sentBy
    && existing.draft_id === request.draftId
    && existing.draft_was_edited === request.draftWasEdited;
  if (!sameMessage) return { action: "conflict" };
  if (existing.status === "sent" || existing.status === "recorded") {
    return {
      action: "record",
      delivery: "sent",
      providerMessageId: existing.provider_message_id,
    };
  }
  if (existing.status === "failed") {
    return { action: "return", delivery: "failed", recorded: false };
  }
  return { action: "return", delivery: "unknown", recorded: false };
}

/**
 * 수동 문자 발송의 외부 경계 순서를 고정한다.
 * outbox 선점 → SMS → outbox sent 기록 → messages 기록 순서이며,
 * 기존 sent 요청은 SMS 없이 messages 기록만 복구한다.
 */
export async function deliverManualMessage<TMessage>({
  request,
  claim,
  send,
  markUnknown,
  markFailed,
  markSent,
  record,
}: DeliverManualMessageArgs<TMessage>): Promise<ManualMessageDeliveryResult<TMessage>> {
  let claimed: ManualMessageClaimResult;
  try {
    claimed = await claim();
  } catch {
    claimed = { kind: "error" };
  }

  if (claimed.kind === "error") {
    return {
      delivery: "not_attempted",
      recorded: false,
      retryable: true,
      deduplicated: false,
      message: null,
    };
  }

  if (claimed.kind === "conflict") {
    return {
      delivery: "not_attempted",
      recorded: false,
      retryable: false,
      deduplicated: true,
      message: null,
      conflict: true,
    };
  }

  if (claimed.kind === "existing") {
    const replay = manualMessageReplayDecision(claimed.request, request);
    if (replay.action === "conflict") {
      return {
        delivery: "not_attempted",
        recorded: false,
        retryable: false,
        deduplicated: true,
        message: null,
        conflict: true,
      };
    }
    if (replay.action === "return") {
      return {
        delivery: replay.delivery,
        recorded: false,
        retryable: replay.delivery === "failed",
        deduplicated: true,
        message: null,
      };
    }

    let message: TMessage | null = null;
    try {
      message = await record(replay.providerMessageId);
    } catch {
      message = null;
    }
    return {
      delivery: "sent",
      recorded: message !== null,
      retryable: false,
      deduplicated: true,
      message,
    };
  }

  let providerResult: Awaited<ReturnType<typeof send>>;
  try {
    providerResult = await send();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "provider result unknown";
    try {
      await markUnknown(detail);
    } catch {
      // 외부 결과가 불명확하면 상태 기록 실패와 무관하게 절대 재발송하지 않는다.
    }
    return {
      delivery: "unknown",
      recorded: false,
      retryable: false,
      deduplicated: false,
      message: null,
    };
  }

  if (!providerResult.success) {
    const detail = providerResult.error || "provider result unknown";
    if (providerResult.failureKind !== "declared") {
      try {
        await markUnknown(detail);
      } catch {
        // 공급자 응답이 불명확하면 상태 기록 실패와 무관하게 절대 재발송하지 않는다.
      }
      return {
        delivery: "unknown",
        recorded: false,
        retryable: false,
        deduplicated: false,
        message: null,
      };
    }
    let failurePersisted = false;
    try {
      failurePersisted = await markFailed(detail);
    } catch {
      failurePersisted = false;
    }
    return {
      delivery: "failed",
      recorded: false,
      // 실패 확정과 초안 선점 해제가 DB에 함께 기록된 뒤에만 새 키를 허용한다.
      retryable: failurePersisted,
      deduplicated: false,
      message: null,
      providerError: detail,
      ...(providerResult.failureCode ? { failureCode: providerResult.failureCode } : {}),
    };
  }

  const providerMessageId = providerResult.messageId || null;
  let sentPersisted = false;
  try {
    sentPersisted = await markSent(providerMessageId);
  } catch {
    sentPersisted = false;
  }
  if (!sentPersisted) {
    return {
      delivery: "sent",
      recorded: false,
      retryable: false,
      deduplicated: false,
      message: null,
    };
  }

  let message: TMessage | null = null;
  try {
    message = await record(providerMessageId);
  } catch {
    message = null;
  }
  return {
    delivery: "sent",
    recorded: message !== null,
    retryable: false,
    deduplicated: false,
    message,
  };
}

/** API 결과에 따른 작성창·키 수명과 후속 업무 처리 여부를 한 계약으로 유지한다. */
export function manualMessageClientResolution(
  response: Record<string, unknown>,
  httpOk: boolean
): ManualMessageClientResolution {
  if (response.delivery === "sent") {
    if (response.recorded === false) {
      return {
        kind: "sent_unrecorded",
        clearComposer: true,
        rotateKey: false,
        continueAfterSend: true,
      };
    }
    if (response.postprocess_failed === true) {
      return {
        kind: "sent_followup_failed",
        clearComposer: true,
        rotateKey: false,
        continueAfterSend: true,
      };
    }
    return {
      kind: "sent",
      clearComposer: true,
      rotateKey: true,
      continueAfterSend: true,
    };
  }
  if (response.delivery === "unknown") {
    return {
      kind: "unknown",
      clearComposer: true,
      rotateKey: false,
      continueAfterSend: false,
    };
  }
  if (response.delivery === "failed") {
    if (response.retryable === false) {
      return {
        kind: "not_attempted",
        clearComposer: false,
        rotateKey: false,
        continueAfterSend: false,
      };
    }
    return {
      kind: "failed",
      clearComposer: false,
      rotateKey: true,
      continueAfterSend: false,
    };
  }
  // 구버전 성공 응답과 동시에 배포되는 짧은 구간도 성공을 실패로 오표시하지 않는다.
  if (httpOk && response.success === true) {
    return {
      kind: "sent",
      clearComposer: true,
      rotateKey: true,
      continueAfterSend: true,
    };
  }
  return {
    kind: "not_attempted",
    clearComposer: false,
    rotateKey: false,
    continueAfterSend: false,
  };
}

/**
 * 재생 요청은 최초 요청이 이미 AI를 멈췄을 수 있다. 재생 응답의 `paused_job_id=null`만 보고
 * "멈출 AI가 없었다"고 다시 단정하면 실제 서버 상태와 반대 안내가 되므로 후속 설명을 생략한다.
 */
export function shouldDescribeManualPauseOutcome(
  response: Record<string, unknown>
): boolean {
  return response.deduplicated !== true;
}

/** 새 요청에서 DB 후처리가 완료된 결과만 현재 AI 상태 안내에 사용한다. */
export function manualMessagePauseOutcome(
  response: Record<string, unknown>
): ManualMessagePauseOutcome {
  if (
    response.delivery !== "sent"
    || response.recorded !== true
    || response.postprocess_failed === true
    || response.deduplicated === true
  ) {
    return { kind: "unknown" };
  }
  if (typeof response.paused_job_id === "number" && Number.isFinite(response.paused_job_id)) {
    return { kind: "paused", jobId: response.paused_job_id };
  }
  if (response.paused_skipped === "ambiguous") return { kind: "ambiguous" };
  if (response.paused_skipped === "changed") return { kind: "changed" };
  return { kind: "none" };
}

/** DB 트랜잭션이 완료로 확정한 후처리 결과만 UI 응답에 반영한다. */
export function manualMessagePostprocessResult(
  value: unknown
): ManualMessagePostprocessResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { completed: false, pausedSkipped: null, pausedJobId: null };
  }
  const result = value as Record<string, unknown>;
  if (result.outcome !== "processed" && result.outcome !== "completed") {
    return { completed: false, pausedSkipped: null, pausedJobId: null };
  }
  return {
    completed: true,
    pausedSkipped: result.paused_skipped === "ambiguous" || result.paused_skipped === "changed"
      ? result.paused_skipped
      : null,
    pausedJobId: typeof result.paused_job_id === "number" && Number.isFinite(result.paused_job_id)
      ? result.paused_job_id
      : null,
  };
}
