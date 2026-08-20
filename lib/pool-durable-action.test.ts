import assert from "node:assert/strict";
import test from "node:test";

type DurableDecision =
  | { kind: "recorded"; runSideEffects: true }
  | { kind: "deduped"; runSideEffects: false }
  | { kind: "unchanged_closed"; runSideEffects: false }
  | { kind: "unavailable"; runSideEffects: false }
  | { kind: "retryable"; runSideEffects: false };

type InterestEngageIntent = "off" | "draft" | "auto_now" | "auto_queue";

type InterestEngageIntentDecision =
  | { kind: "missing" | "retryable" | "conflict" }
  | {
      kind: "pending";
      intent: InterestEngageIntent;
      queueCreated: boolean;
    }
  | { kind: "completed"; outcome: string };

async function loadModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./pool-durable-action.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("a database error is retryable and never permits Slack or engage side effects", async () => {
  const durableModule = await loadModule();
  const decide = durableModule.poolDurableActionDecision as
    ((data: unknown, error: unknown) => DurableDecision) | undefined;

  assert.equal(typeof decide, "function");
  assert.deepEqual(decide!(null, { message: "insert failed" }), {
    kind: "retryable",
    runSideEffects: false,
  });
});

test("only a newly recorded action permits external side effects", async () => {
  const durableModule = await loadModule();
  const decide = durableModule.poolDurableActionDecision as
    ((data: unknown, error: unknown) => DurableDecision) | undefined;

  assert.equal(typeof decide, "function");
  assert.deepEqual(decide!("recorded", null), { kind: "recorded", runSideEffects: true });
  assert.deepEqual(decide!("deduped", null), { kind: "deduped", runSideEffects: false });
  assert.deepEqual(decide!("unchanged_closed", null), {
    kind: "unchanged_closed",
    runSideEffects: false,
  });
  assert.deepEqual(decide!("unavailable", null), { kind: "unavailable", runSideEffects: false });
  assert.deepEqual(decide!("unexpected", null), { kind: "retryable", runSideEffects: false });
});

test("action id validation accepts UUIDs and rejects missing or malformed ids", async () => {
  const durableModule = await loadModule();
  const isPoolActionId = durableModule.isPoolActionId as ((value: unknown) => boolean) | undefined;

  assert.equal(typeof isPoolActionId, "function");
  assert.equal(isPoolActionId!("99999999-9999-4999-8999-999999999999"), true);
  assert.equal(isPoolActionId!("not-a-uuid"), false);
  assert.equal(isPoolActionId!(null), false);
});

test("an exact completed replay is deduped before current job eligibility is checked", async () => {
  const durableModule = await loadModule();
  const decideReplay = durableModule.poolActionReplayDecision as
    ((
      row: { applicant_id: number; job_id: number | null; event_type: string; meta: unknown } | null,
      error: unknown,
      request: { applicantId: number; jobId: number; eventType: "interest_click"; immediate: boolean },
    ) => "missing" | "deduped" | "conflict" | "retryable") | undefined;

  assert.equal(typeof decideReplay, "function");
  assert.equal(decideReplay!(
    { applicant_id: 7, job_id: 31, event_type: "interest_click", meta: { immediate: true } },
    null,
    { applicantId: 7, jobId: 31, eventType: "interest_click", immediate: true },
  ), "deduped");
  assert.equal(decideReplay!(
    { applicant_id: 7, job_id: 31, event_type: "interest_click", meta: null },
    null,
    { applicantId: 7, jobId: 31, eventType: "interest_click", immediate: false },
  ), "deduped");
});

test("an action key reused for a changed request is rejected instead of silently deduped", async () => {
  const durableModule = await loadModule();
  const decideReplay = durableModule.poolActionReplayDecision as
    ((
      row: { applicant_id: number; job_id: number | null; event_type: string; meta: unknown } | null,
      error: unknown,
      request: { applicantId: number; jobId: number; eventType: "interest_click" | "notify_request"; immediate?: boolean },
    ) => "missing" | "deduped" | "conflict" | "retryable") | undefined;

  assert.equal(typeof decideReplay, "function");
  const row = { applicant_id: 7, job_id: 31, event_type: "interest_click", meta: null };
  assert.equal(decideReplay!(row, null, {
    applicantId: 7,
    jobId: 31,
    eventType: "interest_click",
    immediate: true,
  }), "conflict");
  assert.equal(decideReplay!(row, null, {
    applicantId: 7,
    jobId: 32,
    eventType: "interest_click",
    immediate: false,
  }), "conflict");
  assert.equal(decideReplay!(row, null, {
    applicantId: 7,
    jobId: 31,
    eventType: "notify_request",
  }), "conflict");
  assert.equal(decideReplay!(null, null, {
    applicantId: 7,
    jobId: 31,
    eventType: "interest_click",
    immediate: false,
  }), "missing");
  assert.equal(decideReplay!(null, { message: "lookup failed" }, {
    applicantId: 7,
    jobId: 31,
    eventType: "interest_click",
    immediate: false,
  }), "retryable");
});

test("an automatic interest records whether the original click needs a daytime send or a night queue", async () => {
  const durableModule = await loadModule();
  const intentFor = durableModule.poolInterestEngageIntentFor as
    ((mode: "auto" | "draft" | "off", night: boolean) => InterestEngageIntent) | undefined;

  assert.equal(typeof intentFor, "function");
  assert.equal(intentFor!("auto", false), "auto_now");
  assert.equal(intentFor!("auto", true), "auto_queue");
  assert.equal(intentFor!("draft", false), "draft");
  assert.equal(intentFor!("draft", true), "draft");
  assert.equal(intentFor!("off", false), "off");
  assert.equal(intentFor!("off", true), "off");
});

test("a committed pending daytime intent remains resumable when no engage outbox exists yet", async () => {
  const durableModule = await loadModule();
  const decide = durableModule.poolInterestEngageIntentDecision as
    ((
      row: {
        applicant_id: number;
        job_id: number;
        intent: string;
        queue_created: boolean;
        status: string;
        outcome: string | null;
      } | null,
      error: unknown,
      owner: { applicantId: number; jobId: number },
    ) => InterestEngageIntentDecision) | undefined;

  assert.equal(typeof decide, "function");
  assert.deepEqual(decide!(
    {
      applicant_id: 7,
      job_id: 31,
      intent: "auto_now",
      queue_created: false,
      status: "pending",
      outcome: null,
    },
    null,
    { applicantId: 7, jobId: 31 },
  ), {
    kind: "pending",
    intent: "auto_now",
    queueCreated: false,
  });
});

test("interest intent lookup and ownership failures fail closed", async () => {
  const durableModule = await loadModule();
  const decide = durableModule.poolInterestEngageIntentDecision as
    ((row: unknown, error: unknown, owner: { applicantId: number; jobId: number }) => InterestEngageIntentDecision) | undefined;
  const owner = { applicantId: 7, jobId: 31 };

  assert.equal(typeof decide, "function");
  assert.deepEqual(decide!(null, null, owner), { kind: "missing" });
  assert.deepEqual(decide!(null, { message: "lookup failed" }, owner), { kind: "retryable" });
  assert.deepEqual(decide!({
    applicant_id: 8,
    job_id: 31,
    intent: "auto_now",
    queue_created: false,
    status: "pending",
    outcome: null,
  }, null, owner), { kind: "conflict" });
  assert.deepEqual(decide!({
    applicant_id: 7,
    job_id: 31,
    intent: "unexpected",
    queue_created: false,
    status: "pending",
    outcome: null,
  }, null, owner), { kind: "retryable" });
  assert.deepEqual(decide!({
    applicant_id: 7,
    job_id: 31,
    intent: "auto_now",
    queue_created: false,
    status: "completed",
    outcome: "engaged",
  }, null, owner), { kind: "completed", outcome: "engaged" });
});

test("only stable engage outcomes complete the durable interest intent", async () => {
  const durableModule = await loadModule();
  const shouldComplete = durableModule.shouldCompletePoolInterestEngageIntent as
    ((outcome: { action: string; reason?: string }) => boolean) | undefined;

  assert.equal(typeof shouldComplete, "function");
  for (const outcome of [
    { action: "engaged" },
    { action: "waitlist_sent" },
    { action: "recovered" },
    { action: "send_unknown" },
    { action: "send_failed" },
    { action: "off" },
    { action: "copilot_manual" },
    { action: "skipped", reason: "job_conflict" },
  ]) {
    assert.equal(shouldComplete!(outcome), true, JSON.stringify(outcome));
  }
  for (const outcome of [
    { action: "sent_unfinalized" },
    { action: "send_unknown", error: "provider_sending" },
    { action: "send_unknown", error: "recovery_state_unknown" },
    { action: "skipped", reason: "engage_claimed" },
    { action: "skipped", reason: "claim_retryable" },
    { action: "skipped", reason: "not_found" },
  ]) {
    assert.equal(shouldComplete!(outcome), false, JSON.stringify(outcome));
  }
});
