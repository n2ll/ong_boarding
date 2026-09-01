import crypto from "crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BulkMessageRequest = {
  applicantId: number;
  phone: string;
  body: string;
  subject: string;
  purpose: string;
  jobId: number | null;
};

export type BulkMessageBatch = Pick<BulkMessageRequest, "body" | "subject" | "purpose" | "jobId">;

export type BulkMessageOutboxStatus = "sending" | "unknown" | "failed" | "sent" | "recorded";

export type BulkMessageClaimResult =
  | { kind: "claimed" }
  | {
      kind: "existing";
      request: {
        status: BulkMessageOutboxStatus;
        providerMessageId: string | null;
      };
    }
  | { kind: "blocked"; reason: string }
  | { kind: "conflict" }
  | { kind: "error"; error?: string };

export type BulkMessageDeliveryResult = {
  success: boolean;
  state: "recorded" | "sent_unrecorded" | "unknown" | "failed" | "blocked" | "conflict";
  deduplicated: boolean;
  providerMessageId?: string | null;
  recoveryPending?: boolean;
  error?: string;
};

type SmsProviderResult =
  | { success: true; messageId?: string; failureKind?: never; error?: never }
  | {
      success: false;
      failureKind: "declared" | "unknown";
      error?: string;
      messageId?: never;
    };

export type BulkMessageDeliveryCallbacks = {
  claim: () => Promise<BulkMessageClaimResult>;
  send: () => Promise<SmsProviderResult>;
  markUnknown: (error: string) => Promise<void>;
  markFailed: (error: string) => Promise<boolean>;
  markSent: (providerMessageId: string | null) => Promise<boolean>;
  record: (providerMessageId: string | null) => Promise<boolean>;
};

export function validateBulkRequestId(
  value: unknown,
): { ok: true; key: string } | { ok: false; reason: "required" | "invalid" } {
  if (value == null || (typeof value === "string" && !value.trim())) {
    return { ok: false, reason: "required" };
  }
  if (typeof value !== "string") return { ok: false, reason: "invalid" };
  const key = value.trim().toLowerCase();
  return UUID_PATTERN.test(key)
    ? { ok: true, key }
    : { ok: false, reason: "invalid" };
}

/** 한 번의 사용자 확인(batch) 안에서 같은 번호는 모든 50명 청크에 걸쳐 같은 키를 쓴다. */
export function bulkRecipientIdempotencyKey(batchId: string, normalizedPhone: string): string {
  const hex = crypto
    .createHash("md5")
    .update(`bulk-send:${batchId}:${normalizedPhone}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function bulkBatchRequestFingerprint(request: BulkMessageBatch): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([request.body, request.subject, request.purpose, request.jobId]))
    .digest("hex");
}

/** batch id는 제외한다. 새 batch key로 같은 불명 발송을 우회하지 못하게 하는 의도 지문이다. */
export function bulkMessageRequestFingerprint(request: BulkMessageRequest): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([
      request.phone,
      request.applicantId,
      request.body,
      request.subject,
      request.purpose,
      request.jobId,
    ]))
    .digest("hex");
}

export function bulkMessageGuardUntil(purpose: string, now = new Date()): Date {
  const duration = purpose === "new_job"
    ? 7 * 24 * 60 * 60 * 1000
    : purpose === "job_closed" || purpose === "campaign"
      ? 24 * 60 * 60 * 1000
      : 10 * 60 * 1000;
  return new Date(now.getTime() + duration);
}

export async function deliverBulkMessage({
  claim,
  send,
  markUnknown,
  markFailed,
  markSent,
  record,
}: BulkMessageDeliveryCallbacks): Promise<BulkMessageDeliveryResult> {
  let claimed: BulkMessageClaimResult;
  try {
    claimed = await claim();
  } catch (error) {
    return {
      success: false,
      state: "blocked",
      deduplicated: false,
      error: error instanceof Error ? error.message : "발송을 안전하게 선점하지 못했습니다.",
    };
  }
  if (claimed.kind === "blocked") {
    return {
      success: false,
      state: "blocked",
      deduplicated: true,
      error: claimed.reason,
    };
  }
  if (claimed.kind === "conflict") {
    return {
      success: false,
      state: "conflict",
      deduplicated: true,
      error: "같은 발송 키가 다른 내용에 사용됐습니다.",
    };
  }
  if (claimed.kind === "error") {
    return {
      success: false,
      state: "blocked",
      deduplicated: false,
      error: claimed.error || "발송을 안전하게 선점하지 못했습니다.",
    };
  }
  if (claimed.kind === "existing") {
    const existing = claimed.request;
    if (existing.status === "recorded") {
      return {
        success: true,
        state: "recorded",
        deduplicated: true,
        providerMessageId: existing.providerMessageId,
      };
    }
    if (existing.status === "sent") {
      const recorded = await record(existing.providerMessageId).catch(() => false);
      return recorded
        ? {
            success: true,
            state: "recorded",
            deduplicated: true,
            providerMessageId: existing.providerMessageId,
          }
        : {
            success: true,
            state: "sent_unrecorded",
            deduplicated: true,
            providerMessageId: existing.providerMessageId,
            recoveryPending: true,
            error: "문자는 발송됐고 기록 복구를 기다리고 있습니다.",
          };
    }
    if (existing.status === "sending" || existing.status === "unknown") {
      return {
        success: false,
        state: "unknown",
        deduplicated: true,
        recoveryPending: true,
        error: "발송 결과를 확인 중이며 중복 방지를 위해 재발송하지 않습니다.",
      };
    }
    return {
      success: false,
      state: "failed",
      deduplicated: true,
      error: "공급자가 발송 실패를 확정했습니다.",
    };
  }

  let sent: SmsProviderResult;
  try {
    sent = await send();
  } catch (error) {
    const message = error instanceof Error ? error.message : "공급자 응답을 확인할 수 없습니다.";
    await markUnknown(message).catch(() => undefined);
    return {
      success: false,
      state: "unknown",
      deduplicated: false,
      recoveryPending: true,
      error: "발송 결과를 확인 중이며 중복 방지를 위해 재발송하지 않습니다.",
    };
  }

  if (!sent.success) {
    const error = sent.error || "발송에 실패했습니다.";
    if (sent.failureKind === "declared") {
      const failureRecorded = await markFailed(error).catch(() => false);
      if (!failureRecorded) {
        return {
          success: false,
          state: "unknown",
          deduplicated: false,
          recoveryPending: true,
          error: "실패 상태를 저장하지 못해 중복 방지를 위해 재발송하지 않습니다.",
        };
      }
      return {
        success: false,
        state: "failed",
        deduplicated: false,
        error,
      };
    }
    await markUnknown(error).catch(() => undefined);
    return {
      success: false,
      state: "unknown",
      deduplicated: false,
      recoveryPending: true,
      error: "발송 결과를 확인 중이며 중복 방지를 위해 재발송하지 않습니다.",
    };
  }

  const providerMessageId = sent.messageId ?? null;
  if (!(await markSent(providerMessageId).catch(() => false))) {
    return {
      success: true,
      state: "sent_unrecorded",
      deduplicated: false,
      providerMessageId,
      recoveryPending: true,
      error: "문자는 발송됐고 기록 복구를 기다리고 있습니다.",
    };
  }
  if (!(await record(providerMessageId).catch(() => false))) {
    return {
      success: true,
      state: "sent_unrecorded",
      deduplicated: false,
      providerMessageId,
      recoveryPending: true,
      error: "문자는 발송됐고 기록 복구를 기다리고 있습니다.",
    };
  }
  return {
    success: true,
    state: "recorded",
    deduplicated: false,
    providerMessageId,
  };
}
