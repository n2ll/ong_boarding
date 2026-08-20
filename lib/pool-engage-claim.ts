export type PoolEngageClaimDecision =
  | { kind: "claimed"; maySend: true; mayFinalize: false }
  | { kind: "resume_finalize"; maySend: false; mayFinalize: true }
  | {
      kind: "already_claimed" | "job_conflict" | "unavailable" | "retryable";
      maySend: false;
      mayFinalize: false;
    };

/** Only the applicant-level database claim winner may cross the SMS boundary. */
export function poolEngageClaimDecision(
  data: unknown,
  error: unknown
): PoolEngageClaimDecision {
  if (error) return { kind: "retryable", maySend: false, mayFinalize: false };
  if (data === "claimed") return { kind: "claimed", maySend: true, mayFinalize: false };
  if (data === "resume_finalize") {
    return { kind: "resume_finalize", maySend: false, mayFinalize: true };
  }
  if (data === "already_claimed") {
    return { kind: "already_claimed", maySend: false, mayFinalize: false };
  }
  if (data === "job_conflict") {
    return { kind: "job_conflict", maySend: false, mayFinalize: false };
  }
  if (data === "unavailable") {
    return { kind: "unavailable", maySend: false, mayFinalize: false };
  }
  return { kind: "retryable", maySend: false, mayFinalize: false };
}

export type PoolEngageRecoveryDecision =
  | { kind: "none" | "failed" }
  | {
      kind: "blocked";
      status: "sending" | "unknown";
      messageKind: "screening" | "waitlist";
    }
  | { kind: "recovered"; messageKind: "screening" | "waitlist" }
  | { kind: "sent_unfinalized"; messageKind: "screening" | "waitlist" }
  | { kind: "retryable" };

/** DB reconciliation RPC 결과를 fail-closed 복구 결정으로 좁힌다. */
export function poolEngageRecoveryDecision(
  data: unknown,
  error: unknown
): PoolEngageRecoveryDecision {
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    return { kind: "retryable" };
  }
  const row = data as { outcome?: unknown; message_kind?: unknown };
  if (row.outcome === "missing") return { kind: "none" };
  if (row.outcome === "failed") return { kind: "failed" };
  const messageKind = row.message_kind === "waitlist" ? "waitlist" : "screening";
  if (row.outcome === "recovered" || row.outcome === "recorded") {
    return { kind: "recovered", messageKind };
  }
  if (row.outcome === "sent_unfinalized") {
    return { kind: "sent_unfinalized", messageKind };
  }
  if (row.outcome === "sending" || row.outcome === "unknown") {
    return { kind: "blocked", status: row.outcome, messageKind };
  }
  return { kind: "retryable" };
}

/** finalize RPC가 메시지 원장까지 커밋한 모든 정상 종결 값을 허용한다. */
export function poolEngageFinalizeSucceeded(data: unknown, error: unknown): boolean {
  return !error && (data === "recorded" || data === "deduped" || data === "superseded");
}

export type PoolEngageDeliveryResult =
  | { kind: "sent"; finalized: boolean; retryable: false }
  | { kind: "provider_failed"; retryable: true }
  | { kind: "provider_unknown"; retryable: false }
  | { kind: "claim_state_unknown"; retryable: false }
  | {
      kind: "not_sent";
      reason: Exclude<PoolEngageClaimDecision["kind"], "claimed">;
      retryable: boolean;
    };

interface DeliverPoolEngageMessageArgs {
  claim: () => Promise<PoolEngageClaimDecision>;
  send: () => Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
    failureKind?: "declared" | "unknown";
  }>;
  markProviderResult: (
    result: "failed" | "unknown" | "sent",
    providerMessageId: string | null,
    error: string | null
  ) => Promise<boolean>;
  finalize: (providerMessageId: string | null) => Promise<boolean>;
}

/**
 * Claim → provider → durable provider result → DB finalization.
 * An unknown provider result is never retried automatically; only a provider-declared failure
 * whose release was persisted is safe for a new action to retry.
 */
export async function deliverPoolEngageMessage({
  claim,
  send,
  markProviderResult,
  finalize,
}: DeliverPoolEngageMessageArgs): Promise<PoolEngageDeliveryResult> {
  let claimResult: PoolEngageClaimDecision;
  try {
    claimResult = await claim();
  } catch {
    claimResult = { kind: "retryable", maySend: false, mayFinalize: false };
  }
  if (claimResult.mayFinalize) {
    let finalized = false;
    try {
      finalized = await finalize(null);
    } catch {
      finalized = false;
    }
    return { kind: "sent", finalized, retryable: false };
  }
  if (!claimResult.maySend) {
    return {
      kind: "not_sent",
      reason: claimResult.kind,
      retryable: claimResult.kind === "retryable",
    };
  }

  let providerResult: Awaited<ReturnType<DeliverPoolEngageMessageArgs["send"]>>;
  try {
    providerResult = await send();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "provider result unknown";
    try {
      await markProviderResult("unknown", null, detail);
    } catch {
      // The external result is uncertain either way, so automatic resend remains forbidden.
    }
    return { kind: "provider_unknown", retryable: false };
  }

  if (!providerResult.success) {
    const declaredFailure = providerResult.failureKind === "declared";
    const detail = providerResult.error
      || (declaredFailure ? "provider rejected message" : "provider result unknown");
    if (!declaredFailure) {
      try {
        await markProviderResult("unknown", null, detail);
      } catch {
        // 결과 불명 claim은 해제하지 않는다.
      }
      return { kind: "provider_unknown", retryable: false };
    }
    let released = false;
    try {
      released = await markProviderResult("failed", null, detail);
    } catch {
      released = false;
    }
    return released
      ? { kind: "provider_failed", retryable: true }
      : { kind: "claim_state_unknown", retryable: false };
  }

  const providerMessageId = providerResult.messageId || null;
  let sentPersisted = false;
  try {
    sentPersisted = await markProviderResult("sent", providerMessageId, null);
  } catch {
    sentPersisted = false;
  }
  if (!sentPersisted) {
    return { kind: "provider_unknown", retryable: false };
  }

  let finalized = false;
  try {
    finalized = await finalize(providerMessageId);
  } catch {
    finalized = false;
  }
  return { kind: "sent", finalized, retryable: false };
}
