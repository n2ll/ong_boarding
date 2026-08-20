export type PoolDurableActionDecision =
  | { kind: "recorded"; runSideEffects: true }
  | { kind: "deduped"; runSideEffects: false }
  | { kind: "unchanged_closed"; runSideEffects: false }
  | { kind: "unavailable"; runSideEffects: false }
  | { kind: "retryable"; runSideEffects: false };

export type PoolInterestEngageIntent = "off" | "draft" | "auto_now" | "auto_queue";

export type PoolInterestEngageIntentDecision =
  | { kind: "missing" }
  | { kind: "retryable" }
  | { kind: "conflict" }
  | {
      kind: "pending";
      intent: PoolInterestEngageIntent;
      queueCreated: boolean;
    }
  | { kind: "completed"; outcome: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPoolActionId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export type PoolActionReplayDecision = "missing" | "deduped" | "conflict" | "retryable";

export function poolActionReplayDecision(
  row: {
    applicant_id: number;
    job_id: number | null;
    event_type: string;
    meta: unknown;
  } | null,
  error: unknown,
  request: {
    applicantId: number;
    jobId: number;
    eventType: "interest_click" | "notify_request";
    immediate?: boolean;
  },
): PoolActionReplayDecision {
  if (error) return "retryable";
  if (!row) return "missing";

  const sameIdentity = row.applicant_id === request.applicantId
    && row.job_id === request.jobId
    && row.event_type === request.eventType;
  if (!sameIdentity) return "conflict";
  if (request.eventType === "notify_request") return "deduped";

  const meta = row.meta && typeof row.meta === "object"
    ? row.meta as { immediate?: unknown }
    : null;
  const recordedImmediate = meta?.immediate === true || meta?.immediate === "true";
  return recordedImmediate === (request.immediate === true) ? "deduped" : "conflict";
}

export function poolDurableActionDecision(
  data: unknown,
  error: unknown,
): PoolDurableActionDecision {
  if (error) return { kind: "retryable", runSideEffects: false };
  if (data === "recorded") return { kind: "recorded", runSideEffects: true };
  if (data === "deduped") return { kind: "deduped", runSideEffects: false };
  if (data === "unchanged_closed") return { kind: "unchanged_closed", runSideEffects: false };
  if (data === "unavailable") return { kind: "unavailable", runSideEffects: false };
  return { kind: "retryable", runSideEffects: false };
}

export function poolInterestEngageIntentFor(
  mode: "auto" | "draft" | "off",
  night: boolean,
): PoolInterestEngageIntent {
  if (mode !== "auto") return mode;
  return night ? "auto_queue" : "auto_now";
}

export function poolInterestEngageIntentDecision(
  row: unknown,
  error: unknown,
  owner: { applicantId: number; jobId: number },
): PoolInterestEngageIntentDecision {
  if (error) return { kind: "retryable" };
  if (!row) return { kind: "missing" };
  if (typeof row !== "object" || Array.isArray(row)) return { kind: "retryable" };

  const value = row as {
    applicant_id?: unknown;
    job_id?: unknown;
    intent?: unknown;
    queue_created?: unknown;
    status?: unknown;
    outcome?: unknown;
  };
  if (value.applicant_id !== owner.applicantId || value.job_id !== owner.jobId) {
    return { kind: "conflict" };
  }

  const intent = value.intent;
  if (
    (intent !== "off" && intent !== "draft" && intent !== "auto_now" && intent !== "auto_queue")
    || typeof value.queue_created !== "boolean"
  ) {
    return { kind: "retryable" };
  }
  if (value.status === "pending" && (value.outcome === null || value.outcome === undefined)) {
    return {
      kind: "pending",
      intent,
      queueCreated: value.queue_created,
    };
  }
  if (
    value.status === "completed"
    && typeof value.outcome === "string"
    && value.outcome.trim().length > 0
  ) {
    return { kind: "completed", outcome: value.outcome };
  }
  return { kind: "retryable" };
}

export function shouldCompletePoolInterestEngageIntent(outcome: {
  action: string;
  reason?: string;
  error?: string;
}): boolean {
  if (outcome.action === "skipped") {
    return outcome.reason === "job_closed"
      || outcome.reason === "already_in_progress"
      || outcome.reason === "no_phone"
      || outcome.reason === "opt_out"
      || outcome.reason === "job_conflict"
      || outcome.reason === "already_engaged"
      || outcome.reason === "claim_unavailable"
      || outcome.reason === "unsafe_message";
  }
  if (outcome.action === "send_unknown") {
    return outcome.error !== "provider_sending"
      && outcome.error !== "recovery_state_unknown";
  }
  return outcome.action === "off"
    || outcome.action === "copilot_manual"
    || outcome.action === "send_failed"
    || outcome.action === "recovered"
    || outcome.action === "waitlist_sent"
    || outcome.action === "engaged";
}
