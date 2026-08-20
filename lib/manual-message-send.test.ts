import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface Attempt {
  fingerprint: string;
  key: string;
}

interface RequestFingerprint {
  applicantId: number | null;
  phone: string;
  body: string;
  jobId: number | null;
  sentBy: string;
  draftId: string | null;
  draftWasEdited: boolean;
}

interface ExistingOutboxRequest {
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

type ManualMessageModule = {
  validateManualMessageIdempotencyKey?: (
    value: unknown
  ) => { ok: true; key: string } | { ok: false; reason: "required" | "invalid" };
  nextManualMessageAttempt?: (
    current: Attempt | null,
    request: RequestFingerprint,
    createKey: () => string
  ) => Attempt;
  manualMessageReplayDecision?: (
    existing: ExistingOutboxRequest,
    request: RequestFingerprint
  ) =>
    | { action: "record"; delivery: "sent"; providerMessageId: string | null }
    | { action: "return"; delivery: "unknown"; recorded: false }
    | { action: "return"; delivery: "failed"; recorded: false }
    | { action: "conflict" };
  deliverManualMessage?: <TMessage>(args: {
    key: string;
    request: RequestFingerprint;
    claim: () => Promise<
      | { kind: "claimed" }
      | { kind: "existing"; request: ExistingOutboxRequest }
      | { kind: "error" }
    >;
    send: () => Promise<{ success: boolean; messageId?: string; error?: string }>;
    markUnknown: (error: string) => Promise<void>;
    markFailed: (error: string) => Promise<void>;
    markSent: (providerMessageId: string | null) => Promise<boolean>;
    record: (providerMessageId: string | null) => Promise<TMessage | null>;
  }) => Promise<{
    delivery: "not_attempted" | "unknown" | "failed" | "sent";
    recorded: boolean;
    retryable: boolean;
    deduplicated: boolean;
    message: TMessage | null;
    conflict?: boolean;
    providerError?: string;
  }>;
  manualMessageClientResolution?: (
    response: Record<string, unknown>,
    httpOk: boolean
  ) => {
    kind: "sent" | "sent_unrecorded" | "sent_followup_failed" | "unknown" | "failed" | "not_attempted";
    clearComposer: boolean;
    rotateKey: boolean;
    continueAfterSend: boolean;
  };
  shouldDescribeManualPauseOutcome?: (response: Record<string, unknown>) => boolean;
  manualMessagePostprocessResult?: (value: unknown) => {
    completed: boolean;
    pausedSkipped: "ambiguous" | "changed" | null;
    pausedJobId: number | null;
  };
  manualMessagePauseOutcome?: (response: Record<string, unknown>) =>
    | { kind: "paused"; jobId: number }
    | { kind: "ambiguous" }
    | { kind: "changed" }
    | { kind: "none" }
    | { kind: "unknown" };
};

async function loadModule(): Promise<ManualMessageModule> {
  try {
    return await import(new URL("./manual-message-send.ts", import.meta.url).href) as ManualMessageModule;
  } catch {
    return {};
  }
}

const request: RequestFingerprint = {
  applicantId: 17,
  phone: "01012345678",
  body: "안녕하세요. 확인 후 안내드릴게요.",
  jobId: 31,
  sentBy: "관리자",
  draftId: null,
  draftWasEdited: false,
};

function existingOutbox(overrides: Partial<ExistingOutboxRequest> = {}): ExistingOutboxRequest {
  return {
    applicant_id: request.applicantId,
    applicant_phone: request.phone,
    body: request.body,
    job_id: request.jobId,
    sent_by: request.sentBy,
    draft_id: request.draftId,
    draft_was_edited: request.draftWasEdited,
    status: "sent",
    provider_message_id: "provider-1",
    ...overrides,
  };
}

test("a manual message requires a caller-supplied UUID", async () => {
  const { validateManualMessageIdempotencyKey } = await loadModule();
  assert.equal(typeof validateManualMessageIdempotencyKey, "function");

  assert.deepEqual(validateManualMessageIdempotencyKey!(undefined), { ok: false, reason: "required" });
  assert.deepEqual(validateManualMessageIdempotencyKey!(""), { ok: false, reason: "required" });
  assert.deepEqual(validateManualMessageIdempotencyKey!("generated-on-server"), { ok: false, reason: "invalid" });
  assert.deepEqual(
    validateManualMessageIdempotencyKey!(" 41f82761-a37a-4f6f-8ad5-8b6b93acb8c1 "),
    { ok: true, key: "41f82761-a37a-4f6f-8ad5-8b6b93acb8c1" }
  );
});

test("a retry of the same manual message reuses its idempotency key", async () => {
  const { nextManualMessageAttempt } = await loadModule();
  assert.equal(typeof nextManualMessageAttempt, "function");

  let sequence = 0;
  const createKey = () => `key-${++sequence}`;
  const first = nextManualMessageAttempt!(null, request, createKey);
  const retry = nextManualMessageAttempt!(first, { ...request }, createKey);

  assert.deepEqual(first, retry);
  assert.equal(sequence, 1);
});

test("editing the message creates a new attempt key", async () => {
  const { nextManualMessageAttempt } = await loadModule();
  assert.equal(typeof nextManualMessageAttempt, "function");

  let sequence = 0;
  const createKey = () => `key-${++sequence}`;
  const first = nextManualMessageAttempt!(null, request, createKey);
  const edited = nextManualMessageAttempt!(first, { ...request, body: `${request.body} 수정` }, createKey);

  assert.equal(first.key, "key-1");
  assert.equal(edited.key, "key-2");
});

test("changing a post-send input creates a new attempt key", async () => {
  const { nextManualMessageAttempt } = await loadModule();
  assert.equal(typeof nextManualMessageAttempt, "function");

  let sequence = 0;
  const createKey = () => `key-${++sequence}`;
  const first = nextManualMessageAttempt!(null, request, createKey);
  const differentSender = nextManualMessageAttempt!(
    first,
    { ...request, sentBy: "agent" },
    createKey
  );
  const editedDraft = nextManualMessageAttempt!(
    differentSender,
    { ...request, sentBy: "agent", draftId: "draft-1", draftWasEdited: true },
    createKey
  );

  assert.equal(differentSender.key, "key-2");
  assert.equal(editedDraft.key, "key-3");
});

test("a sent outbox request is recovered into the message history without another send", async () => {
  const { manualMessageReplayDecision } = await loadModule();
  assert.equal(typeof manualMessageReplayDecision, "function");

  assert.deepEqual(
    manualMessageReplayDecision!(existingOutbox(), request),
    { action: "record", delivery: "sent", providerMessageId: "provider-1" }
  );
});

test("an in-flight or uncertain claim is never sent again", async () => {
  const { manualMessageReplayDecision } = await loadModule();
  assert.equal(typeof manualMessageReplayDecision, "function");

  for (const status of ["sending", "unknown", null]) {
    assert.deepEqual(
      manualMessageReplayDecision!(existingOutbox({ status, provider_message_id: null }), request),
      { action: "return", delivery: "unknown", recorded: false },
      String(status)
    );
  }
});

test("a provider-declared failure requires a fresh attempt instead of replaying the old key", async () => {
  const { manualMessageReplayDecision } = await loadModule();
  assert.equal(typeof manualMessageReplayDecision, "function");

  assert.deepEqual(
    manualMessageReplayDecision!(existingOutbox({ status: "failed", provider_message_id: null }), request),
    { action: "return", delivery: "failed", recorded: false }
  );
});

test("reusing a key with any different send or post-send input is rejected", async () => {
  const { manualMessageReplayDecision } = await loadModule();
  assert.equal(typeof manualMessageReplayDecision, "function");

  const conflicts: ExistingOutboxRequest[] = [
    existingOutbox({ applicant_id: 99 }),
    existingOutbox({ applicant_phone: "01099999999" }),
    existingOutbox({ body: "다른 본문" }),
    existingOutbox({ job_id: 77 }),
    existingOutbox({ sent_by: "agent" }),
    existingOutbox({ draft_id: "draft-2" }),
    existingOutbox({ draft_was_edited: true }),
  ];

  for (const existing of conflicts) {
    assert.deepEqual(
      manualMessageReplayDecision!(existing, request),
      { action: "conflict" }
    );
  }
});

test("the first attempt records a message only after the provider reports success", async () => {
  const { deliverManualMessage } = await loadModule();
  assert.equal(typeof deliverManualMessage, "function");

  const order: string[] = [];
  const result = await deliverManualMessage!({
    key: "request-1",
    request,
    claim: async () => {
      order.push("claim");
      return { kind: "claimed" };
    },
    send: async () => {
      order.push("send");
      return { success: true, messageId: "provider-1" };
    },
    markUnknown: async () => { order.push("unknown"); },
    markFailed: async () => { order.push("failed"); },
    markSent: async () => {
      order.push("mark-sent");
      return true;
    },
    record: async () => {
      order.push("record");
      return { id: "message-1" };
    },
  });

  assert.deepEqual(order, ["claim", "send", "mark-sent", "record"]);
  assert.deepEqual(result, {
    delivery: "sent",
    recorded: true,
    retryable: false,
    deduplicated: false,
    message: { id: "message-1" },
  });
});

test("a provider-unknown response is persisted as unknown and is never made retryable", async () => {
  const { deliverManualMessage } = await loadModule();
  assert.equal(typeof deliverManualMessage, "function");

  const states: string[] = [];
  const result = await deliverManualMessage!({
    key: "request-1",
    request,
    claim: async () => ({ kind: "claimed" }),
    send: async () => ({
      success: false,
      failureKind: "unknown",
      error: "provider response was interrupted",
    }),
    markUnknown: async () => { states.push("unknown"); },
    markFailed: async () => { states.push("failed"); },
    markSent: async () => {
      states.push("sent");
      return true;
    },
    record: async () => {
      states.push("recorded");
      return { id: "message-1" };
    },
  });

  assert.deepEqual(states, ["unknown"]);
  assert.deepEqual(result, {
    delivery: "unknown",
    recorded: false,
    retryable: false,
    deduplicated: false,
    message: null,
  });
});

test("a sent-but-unrecorded replay repairs history without invoking the provider", async () => {
  const { deliverManualMessage } = await loadModule();
  assert.equal(typeof deliverManualMessage, "function");

  let sends = 0;
  let records = 0;
  const result = await deliverManualMessage!({
    key: "request-1",
    request,
    claim: async () => ({ kind: "existing", request: existingOutbox({ status: "sent" }) }),
    send: async () => {
      sends += 1;
      return { success: true, messageId: "provider-2" };
    },
    markUnknown: async () => {},
    markFailed: async () => {},
    markSent: async () => true,
    record: async (providerMessageId) => {
      records += 1;
      assert.equal(providerMessageId, "provider-1");
      return { id: "message-1" };
    },
  });

  assert.equal(sends, 0);
  assert.equal(records, 1);
  assert.equal(result.delivery, "sent");
  assert.equal(result.recorded, true);
  assert.equal(result.deduplicated, true);
});

test("sending, unknown, and failed replays never invoke the provider or create a message", async () => {
  const { deliverManualMessage } = await loadModule();
  assert.equal(typeof deliverManualMessage, "function");

  for (const status of ["sending", "unknown", "failed"] as const) {
    let sends = 0;
    let records = 0;
    const result = await deliverManualMessage!({
      key: `request-${status}`,
      request,
      claim: async () => ({ kind: "existing", request: existingOutbox({ status }) }),
      send: async () => {
        sends += 1;
        return { success: true };
      },
      markUnknown: async () => {},
      markFailed: async () => {},
      markSent: async () => true,
      record: async () => {
        records += 1;
        return { id: "message-1" };
      },
    });

    assert.equal(sends, 0, status);
    assert.equal(records, 0, status);
    assert.equal(result.delivery, status === "failed" ? "failed" : "unknown", status);
  }
});

test("a failed sent-state write never creates a message row", async () => {
  const { deliverManualMessage } = await loadModule();
  assert.equal(typeof deliverManualMessage, "function");

  let records = 0;
  const result = await deliverManualMessage!({
    key: "request-1",
    request,
    claim: async () => ({ kind: "claimed" }),
    send: async () => ({ success: true, messageId: "provider-1" }),
    markUnknown: async () => {},
    markFailed: async () => {},
    markSent: async () => false,
    record: async () => {
      records += 1;
      return { id: "message-1" };
    },
  });

  assert.equal(records, 0);
  assert.equal(result.delivery, "sent");
  assert.equal(result.recorded, false);
});

test("a sent-but-unrecorded response clears the composer without offering a blind retry", async () => {
  const { manualMessageClientResolution } = await loadModule();
  assert.equal(typeof manualMessageClientResolution, "function");

  assert.deepEqual(
    manualMessageClientResolution!({ delivery: "sent", recorded: false, postprocess_failed: true }, true),
    {
      kind: "sent_unrecorded",
      clearComposer: true,
      rotateKey: false,
      continueAfterSend: true,
    }
  );
});

test("a sent message with failed follow-up work keeps its key for recovery without another SMS", async () => {
  const { manualMessageClientResolution } = await loadModule();
  assert.equal(typeof manualMessageClientResolution, "function");

  assert.deepEqual(
    manualMessageClientResolution!(
      { delivery: "sent", recorded: true, postprocess_failed: true },
      true
    ),
    {
      kind: "sent_followup_failed",
      clearComposer: true,
      rotateKey: false,
      continueAfterSend: true,
    }
  );
});

test("only a declared provider failure rotates the key while keeping text for a deliberate retry", async () => {
  const { manualMessageClientResolution } = await loadModule();
  assert.equal(typeof manualMessageClientResolution, "function");

  assert.deepEqual(
    manualMessageClientResolution!({ delivery: "failed", retryable: true }, false),
    {
      kind: "failed",
      clearComposer: false,
      rotateKey: true,
      continueAfterSend: false,
    }
  );
  assert.deepEqual(
    manualMessageClientResolution!({ delivery: "not_attempted", retryable: true }, false),
    {
      kind: "not_attempted",
      clearComposer: false,
      rotateKey: false,
      continueAfterSend: false,
    }
  );
});

test("an uncertain replay clears the composer and does not continue queue or AI actions", async () => {
  const { manualMessageClientResolution } = await loadModule();
  assert.equal(typeof manualMessageClientResolution, "function");

  assert.deepEqual(
    manualMessageClientResolution!({ delivery: "unknown", recorded: false }, true),
    {
      kind: "unknown",
      clearComposer: true,
      rotateKey: false,
      continueAfterSend: false,
    }
  );
});

test("a deduplicated replay does not claim that no AI flow was paused", async () => {
  const { shouldDescribeManualPauseOutcome } = await loadModule();
  assert.equal(typeof shouldDescribeManualPauseOutcome, "function");

  assert.equal(shouldDescribeManualPauseOutcome!({ delivery: "sent" }), true);
  assert.equal(
    shouldDescribeManualPauseOutcome!({ delivery: "sent", deduplicated: true }),
    false
  );
});

test("only a committed database postprocess outcome is treated as complete", async () => {
  const { manualMessagePostprocessResult } = await loadModule();
  assert.equal(typeof manualMessagePostprocessResult, "function");

  assert.deepEqual(
    manualMessagePostprocessResult!({
      outcome: "processed",
      paused_skipped: "ambiguous",
      paused_job_id: null,
    }),
    { completed: true, pausedSkipped: "ambiguous", pausedJobId: null }
  );
  assert.deepEqual(
    manualMessagePostprocessResult!({
      outcome: "completed",
      paused_skipped: null,
      paused_job_id: 31,
    }),
    { completed: true, pausedSkipped: null, pausedJobId: 31 }
  );

  for (const value of [
    { outcome: "waiting_for_record", paused_job_id: 31 },
    { outcome: "not_ready" },
    { outcome: "missing" },
    null,
  ]) {
    assert.deepEqual(
      manualMessagePostprocessResult!(value),
      { completed: false, pausedSkipped: null, pausedJobId: null }
    );
  }
});

test("the client marks AI paused only from a fresh committed pause result", async () => {
  const { manualMessagePauseOutcome } = await loadModule();
  assert.equal(typeof manualMessagePauseOutcome, "function");

  assert.deepEqual(
    manualMessagePauseOutcome!({
      delivery: "sent",
      recorded: true,
      paused_job_id: 31,
    }),
    { kind: "paused", jobId: 31 }
  );
  for (const response of [
    { delivery: "sent", recorded: true, paused_job_id: null },
    { delivery: "sent", recorded: false, paused_job_id: 31 },
    { delivery: "sent", recorded: true, postprocess_failed: true, paused_job_id: 31 },
    { delivery: "sent", recorded: true, deduplicated: true, paused_job_id: 31 },
  ]) {
    assert.notDeepEqual(manualMessagePauseOutcome!(response), { kind: "paused", jobId: 31 });
  }
});

test("manual message postprocessing is claimed and completed in one database transaction", async () => {
  const migration = await readFile(
    new URL("../docs/migrations/2026-08-manual-message-postprocess.sql", import.meta.url),
    "utf8"
  ).catch(() => "");
  const route = await readFile(
    new URL("../app/api/admin/messages/send/route.ts", import.meta.url),
    "utf8"
  );

  assert.match(migration, /postprocess_status/i);
  assert.match(migration, /prepare_manual_message_postprocess/i);
  assert.match(migration, /postprocess_target_candidate_updated_at/i);
  assert.match(migration, /postprocess_target_candidate_state/i);
  assert.match(migration, /create or replace function public\.complete_manual_message_postprocess/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /postprocess_status\s*=\s*'completed'/i);
  assert.match(migration, /created_at\s*<=\s*v_request\.created_at/i);
  assert.match(migration, /updated_at\s*<=\s*v_request\.created_at/i);
  assert.match(migration, /agent_state\s+is\s+not\s+distinct\s+from\s+v_request\.postprocess_target_candidate_state/i);
  assert.match(migration, /client_request_id\s*=\s*p_idempotency_key/i);
  assert.match(migration, /revoke execute on function public\.complete_manual_message_postprocess/i);
  assert.match(route, /\.rpc\(\s*"complete_manual_message_postprocess"/);
  assert.doesNotMatch(route, /\.from\("job_candidates"\)[\s\S]*?\.update\(/);
  assert.doesNotMatch(route, /\.from\("message_drafts"\)[\s\S]*?\.update\(/);
});
