import assert from "node:assert/strict";
import test from "node:test";

import {
  bulkBatchRequestFingerprint,
  bulkMessageGuardUntil,
  bulkMessageRequestFingerprint,
  bulkRecipientIdempotencyKey,
  deliverBulkMessage,
  validateBulkRequestId,
  type BulkMessageDeliveryCallbacks,
  type BulkMessageClaimResult,
} from "./bulk-message-send.ts";

const BATCH_ID = "11111111-1111-4111-8111-111111111111";

test("bulk request ids must be caller-provided UUIDs", () => {
  assert.deepEqual(validateBulkRequestId(BATCH_ID), { ok: true, key: BATCH_ID });
  assert.deepEqual(
    validateBulkRequestId("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
    { ok: true, key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  );
  assert.deepEqual(validateBulkRequestId(undefined), { ok: false, reason: "required" });
  assert.deepEqual(validateBulkRequestId("not-a-uuid"), { ok: false, reason: "invalid" });
});

test("one batch deterministically derives one UUID per normalized phone", () => {
  const first = bulkRecipientIdempotencyKey(BATCH_ID, "01012345678");
  const replay = bulkRecipientIdempotencyKey(BATCH_ID, "01012345678");
  const other = bulkRecipientIdempotencyKey(BATCH_ID, "01099998888");

  assert.equal(first, replay);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("batch fingerprints bind copy and purpose but allow different 50-person chunks", () => {
  const base = {
    body: "#{이름}님, 조건 확인: #{맞춤링크}",
    subject: "옹고잉 채용 안내",
    purpose: "new_job",
    jobId: 31,
  };
  const fingerprint = bulkBatchRequestFingerprint(base);

  assert.equal(fingerprint, bulkBatchRequestFingerprint({ ...base }));
  assert.notEqual(fingerprint, bulkBatchRequestFingerprint({ ...base, body: `${base.body}!` }));
  assert.notEqual(fingerprint, bulkBatchRequestFingerprint({ ...base, jobId: 32 }));
});

test("the request fingerprint covers every delivery-defining field", () => {
  const base = {
    applicantId: 17,
    phone: "01012345678",
    body: "조건 확인: https://example.com/p/token",
    subject: "옹고잉 채용 안내",
    purpose: "new_job",
    jobId: 31,
  };
  const fingerprint = bulkMessageRequestFingerprint(base);

  assert.equal(fingerprint, bulkMessageRequestFingerprint({ ...base }));
  assert.notEqual(fingerprint, bulkMessageRequestFingerprint({ ...base, body: `${base.body}!` }));
  assert.notEqual(fingerprint, bulkMessageRequestFingerprint({ ...base, applicantId: 18 }));
  assert.notEqual(fingerprint, bulkMessageRequestFingerprint({ ...base, purpose: "campaign" }));
});

test("guard windows follow campaign fatigue rules", () => {
  const now = new Date("2026-09-01T00:00:00.000Z");
  assert.equal(
    bulkMessageGuardUntil("new_job", now).toISOString(),
    "2026-09-08T00:00:00.000Z",
  );
  assert.equal(
    bulkMessageGuardUntil("job_closed", now).toISOString(),
    "2026-09-02T00:00:00.000Z",
  );
  assert.equal(
    bulkMessageGuardUntil("campaign", now).toISOString(),
    "2026-09-02T00:00:00.000Z",
  );
  assert.equal(
    bulkMessageGuardUntil("waitlist", now).toISOString(),
    "2026-09-01T00:10:00.000Z",
  );
});

function callbacks(claim: BulkMessageClaimResult) {
  const order: string[] = [];
  const args: BulkMessageDeliveryCallbacks = {
    claim: async () => {
      order.push("claim");
      return claim;
    },
    send: async () => {
      order.push("send");
      return { success: true as const, messageId: "provider-1" };
    },
    markUnknown: async () => {
      order.push("unknown");
    },
    markFailed: async () => {
      order.push("failed");
      return true;
    },
    markSent: async () => {
      order.push("sent");
      return true;
    },
    record: async () => {
      order.push("record");
      return true;
    },
  };
  return {
    order,
    args,
  };
}

test("a fresh claim sends once and durably records in order", async () => {
  const fixture = callbacks({ kind: "claimed" });
  const result = await deliverBulkMessage(fixture.args);

  assert.deepEqual(fixture.order, ["claim", "send", "sent", "record"]);
  assert.deepEqual(result, {
    success: true,
    state: "recorded",
    deduplicated: false,
    providerMessageId: "provider-1",
  });
});

test("recorded and sent replays never call the provider again", async () => {
  const recorded = callbacks({
    kind: "existing",
    request: { status: "recorded", providerMessageId: "provider-1" },
  });
  const recordedResult = await deliverBulkMessage(recorded.args);
  assert.deepEqual(recorded.order, ["claim"]);
  assert.equal(recordedResult.success, true);
  assert.equal(recordedResult.deduplicated, true);

  const sent = callbacks({
    kind: "existing",
    request: { status: "sent", providerMessageId: "provider-1" },
  });
  const sentResult = await deliverBulkMessage(sent.args);
  assert.deepEqual(sent.order, ["claim", "record"]);
  assert.equal(sentResult.state, "recorded");
  assert.equal(sentResult.deduplicated, true);
});

test("sending and unknown replays are fail-closed without another provider call", async () => {
  for (const status of ["sending", "unknown"] as const) {
    const fixture = callbacks({
      kind: "existing",
      request: { status, providerMessageId: null },
    });
    const result = await deliverBulkMessage(fixture.args);

    assert.deepEqual(fixture.order, ["claim"]);
    assert.equal(result.success, false);
    assert.equal(result.state, "unknown");
    assert.equal(result.deduplicated, true);
    assert.match(result.error ?? "", /재발송하지 않/);
  }
});

test("provider ambiguity stays unknown and is never treated as retryable failure", async () => {
  const fixture = callbacks({ kind: "claimed" });
  fixture.args.send = async () => {
    fixture.order.push("send");
    return { success: false as const, failureKind: "unknown" as const, error: "timeout" };
  };
  const result = await deliverBulkMessage(fixture.args);

  assert.deepEqual(fixture.order, ["claim", "send", "unknown"]);
  assert.equal(result.state, "unknown");
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /재발송하지 않/);
});

test("a provider success remains success when DB finalization needs recovery", async () => {
  const fixture = callbacks({ kind: "claimed" });
  fixture.args.markSent = async () => {
    fixture.order.push("sent");
    return false;
  };
  const result = await deliverBulkMessage(fixture.args);

  assert.deepEqual(fixture.order, ["claim", "send", "sent"]);
  assert.equal(result.success, true);
  assert.equal(result.state, "sent_unrecorded");
  assert.equal(result.recoveryPending, true);
});

test("provider success stays visible when durable state callbacks throw", async () => {
  const markFixture = callbacks({ kind: "claimed" });
  markFixture.args.markSent = async () => {
    markFixture.order.push("sent");
    throw new Error("database unavailable");
  };
  const markResult = await deliverBulkMessage(markFixture.args);
  assert.equal(markResult.success, true);
  assert.equal(markResult.state, "sent_unrecorded");
  assert.equal(markResult.recoveryPending, true);

  const recordFixture = callbacks({ kind: "claimed" });
  recordFixture.args.record = async () => {
    recordFixture.order.push("record");
    throw new Error("database unavailable");
  };
  const recordResult = await deliverBulkMessage(recordFixture.args);
  assert.equal(recordResult.success, true);
  assert.equal(recordResult.state, "sent_unrecorded");
  assert.equal(recordResult.recoveryPending, true);
});

test("an exception while preserving provider ambiguity still remains no-resend", async () => {
  const fixture = callbacks({ kind: "claimed" });
  fixture.args.send = async () => {
    fixture.order.push("send");
    return { success: false as const, failureKind: "unknown" as const, error: "timeout" };
  };
  fixture.args.markUnknown = async () => {
    fixture.order.push("unknown");
    throw new Error("database unavailable");
  };

  const result = await deliverBulkMessage(fixture.args);
  assert.equal(result.success, false);
  assert.equal(result.state, "unknown");
  assert.equal(result.recoveryPending, true);
});

test("declared provider failure releases the attempt as failed", async () => {
  const fixture = callbacks({ kind: "claimed" });
  fixture.args.send = async () => {
    fixture.order.push("send");
    return { success: false as const, failureKind: "declared" as const, error: "잔액 부족" };
  };
  const result = await deliverBulkMessage(fixture.args);

  assert.deepEqual(fixture.order, ["claim", "send", "failed"]);
  assert.equal(result.state, "failed");
  assert.equal(result.success, false);
  assert.equal(result.error, "잔액 부족");
});

test("a declared provider failure stays unknown when its durable release cannot be recorded", async () => {
  const fixture = callbacks({ kind: "claimed" });
  fixture.args.send = async () => {
    fixture.order.push("send");
    return { success: false as const, failureKind: "declared" as const, error: "잔액 부족" };
  };
  fixture.args.markFailed = async () => {
    fixture.order.push("failed");
    return false;
  };

  const result = await deliverBulkMessage(fixture.args);

  assert.deepEqual(fixture.order, ["claim", "send", "failed"]);
  assert.equal(result.success, false);
  assert.equal(result.state, "unknown");
  assert.equal(result.recoveryPending, true);
  assert.match(result.error ?? "", /재발송하지 않/);
});
