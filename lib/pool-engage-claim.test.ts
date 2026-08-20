import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type ClaimDecision =
  | { kind: "claimed"; maySend: true; mayFinalize: false }
  | { kind: "resume_finalize"; maySend: false; mayFinalize: true }
  | {
      kind: "already_claimed" | "job_conflict" | "unavailable" | "retryable";
      maySend: false;
      mayFinalize: false;
    };

type DeliveryResult =
  | { kind: "sent"; finalized: boolean; retryable: false }
  | { kind: "provider_failed"; retryable: true }
  | { kind: "provider_unknown" | "claim_state_unknown"; retryable: false }
  | { kind: "not_sent"; reason: Exclude<ClaimDecision["kind"], "claimed">; retryable: boolean };

type ClaimModule = {
  poolEngageClaimDecision?: (data: unknown, error: unknown) => ClaimDecision;
  poolEngageFinalizeSucceeded?: (data: unknown, error: unknown) => boolean;
  poolEngageRecoveryDecision?: (
    data: unknown,
    error: unknown
  ) =>
    | { kind: "none" | "failed" }
    | { kind: "blocked"; status: "sending" | "unknown"; messageKind: "screening" | "waitlist" }
    | { kind: "recovered"; messageKind: "screening" | "waitlist" }
    | { kind: "sent_unfinalized"; messageKind: "screening" | "waitlist" }
    | { kind: "retryable" };
  deliverPoolEngageMessage?: (args: {
    claim: () => Promise<ClaimDecision>;
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
  }) => Promise<DeliveryResult>;
};

async function loadModule(): Promise<ClaimModule> {
  try {
    const modulePath = "./pool-engage-claim.ts";
    return await import(modulePath) as ClaimModule;
  } catch {
    return {};
  }
}

test("only the applicant-level database claim winner may send an automated message", async () => {
  const { poolEngageClaimDecision: decide } = await loadModule();

  assert.equal(typeof decide, "function");
  assert.deepEqual(decide!("claimed", null), {
    kind: "claimed",
    maySend: true,
    mayFinalize: false,
  });
  assert.deepEqual(decide!("resume_finalize", null), {
    kind: "resume_finalize",
    maySend: false,
    mayFinalize: true,
  });
  assert.deepEqual(decide!("already_claimed", null), {
    kind: "already_claimed",
    maySend: false,
    mayFinalize: false,
  });
  assert.deepEqual(decide!("job_conflict", null), {
    kind: "job_conflict",
    maySend: false,
    mayFinalize: false,
  });
});

test("a missing, failed, or unknown claim response fails closed", async () => {
  const { poolEngageClaimDecision: decide } = await loadModule();

  assert.equal(typeof decide, "function");
  assert.deepEqual(decide!(null, { message: "function not found" }), {
    kind: "retryable",
    maySend: false,
    mayFinalize: false,
  });
  assert.deepEqual(decide!("unavailable", null), {
    kind: "unavailable",
    maySend: false,
    mayFinalize: false,
  });
  assert.deepEqual(decide!("unexpected", null), {
    kind: "retryable",
    maySend: false,
    mayFinalize: false,
  });
});

test("a replay whose provider success is durable finalizes without invoking the provider again", async () => {
  const { deliverPoolEngageMessage } = await loadModule();
  assert.equal(typeof deliverPoolEngageMessage, "function");

  let sends = 0;
  let finalizes = 0;
  const result = await deliverPoolEngageMessage!({
    claim: async () => ({
      kind: "resume_finalize",
      maySend: false,
      mayFinalize: true,
    }),
    send: async () => {
      sends += 1;
      return { success: true, messageId: "must-not-send" };
    },
    markProviderResult: async () => {
      assert.fail("a durable sent marker must not be written again");
    },
    finalize: async (providerMessageId) => {
      finalizes += 1;
      assert.equal(providerMessageId, null);
      return true;
    },
  });

  assert.equal(sends, 0);
  assert.equal(finalizes, 1);
  assert.deepEqual(result, { kind: "sent", finalized: true, retryable: false });
});

test("the database claim happens before the provider and successful delivery is finalized last", async () => {
  const { deliverPoolEngageMessage } = await loadModule();
  assert.equal(typeof deliverPoolEngageMessage, "function");

  const order: string[] = [];
  const result = await deliverPoolEngageMessage!({
    claim: async () => {
      order.push("claim");
      return { kind: "claimed", maySend: true, mayFinalize: false };
    },
    send: async () => {
      order.push("send");
      return { success: true, messageId: "provider-1" };
    },
    markProviderResult: async (status, providerMessageId) => {
      order.push(`mark-${status}`);
      assert.equal(providerMessageId, "provider-1");
      return true;
    },
    finalize: async (providerMessageId) => {
      order.push("finalize");
      assert.equal(providerMessageId, "provider-1");
      return true;
    },
  });

  assert.deepEqual(order, ["claim", "send", "mark-sent", "finalize"]);
  assert.deepEqual(result, { kind: "sent", finalized: true, retryable: false });
});

test("a concurrent loser never invokes the provider", async () => {
  const { deliverPoolEngageMessage } = await loadModule();
  assert.equal(typeof deliverPoolEngageMessage, "function");

  let sends = 0;
  const result = await deliverPoolEngageMessage!({
    claim: async () => ({
      kind: "job_conflict",
      maySend: false,
      mayFinalize: false,
    }),
    send: async () => {
      sends += 1;
      return { success: true };
    },
    markProviderResult: async () => true,
    finalize: async () => true,
  });

  assert.equal(sends, 0);
  assert.deepEqual(result, {
    kind: "not_sent",
    reason: "job_conflict",
    retryable: false,
  });
});

test("a provider-declared failure is retry-safe only after the claim is durably released", async () => {
  const { deliverPoolEngageMessage } = await loadModule();
  assert.equal(typeof deliverPoolEngageMessage, "function");

  for (const persisted of [true, false]) {
    const statuses: string[] = [];
    const result = await deliverPoolEngageMessage!({
      claim: async () => ({ kind: "claimed", maySend: true, mayFinalize: false }),
      send: async () => ({
        success: false,
        failureKind: "declared",
        error: "provider rejected",
      }),
      markProviderResult: async (status, providerMessageId, error) => {
        statuses.push(status);
        assert.equal(providerMessageId, null);
        assert.equal(error, "provider rejected");
        return persisted;
      },
      finalize: async () => {
        assert.fail("a failed provider call must not be finalized");
      },
    });

    assert.deepEqual(statuses, ["failed"]);
    assert.deepEqual(
      result,
      persisted
        ? { kind: "provider_failed", retryable: true }
        : { kind: "claim_state_unknown", retryable: false }
    );
  }
});

test("an ambiguous HTTP provider failure is marked unknown and never releases the claim", async () => {
  const { deliverPoolEngageMessage } = await loadModule();
  assert.equal(typeof deliverPoolEngageMessage, "function");

  const statuses: string[] = [];
  const result = await deliverPoolEngageMessage!({
    claim: async () => ({ kind: "claimed", maySend: true, mayFinalize: false }),
    send: async () => ({
      success: false,
      failureKind: "unknown",
      error: "SOLAPI HTTP 503",
    }),
    markProviderResult: async (status, providerMessageId, error) => {
      statuses.push(status);
      assert.equal(providerMessageId, null);
      assert.equal(error, "SOLAPI HTTP 503");
      return true;
    },
    finalize: async () => {
      assert.fail("an ambiguous provider response must not be finalized");
    },
  });

  assert.deepEqual(statuses, ["unknown"]);
  assert.deepEqual(result, { kind: "provider_unknown", retryable: false });
});

test("a provider exception is marked unknown and is never automatically retried", async () => {
  const { deliverPoolEngageMessage } = await loadModule();
  assert.equal(typeof deliverPoolEngageMessage, "function");

  const statuses: string[] = [];
  const result = await deliverPoolEngageMessage!({
    claim: async () => ({ kind: "claimed", maySend: true, mayFinalize: false }),
    send: async () => {
      throw new Error("connection reset after write");
    },
    markProviderResult: async (status, providerMessageId, error) => {
      statuses.push(status);
      assert.equal(providerMessageId, null);
      assert.equal(error, "connection reset after write");
      return true;
    },
    finalize: async () => {
      assert.fail("an unknown provider result must not be finalized");
    },
  });

  assert.deepEqual(statuses, ["unknown"]);
  assert.deepEqual(result, { kind: "provider_unknown", retryable: false });
});

test("provider success with an unpersisted sent marker fails closed without finalizing", async () => {
  const { deliverPoolEngageMessage } = await loadModule();
  assert.equal(typeof deliverPoolEngageMessage, "function");

  let finalizes = 0;
  const result = await deliverPoolEngageMessage!({
    claim: async () => ({ kind: "claimed", maySend: true, mayFinalize: false }),
    send: async () => ({ success: true, messageId: "provider-1" }),
    markProviderResult: async () => false,
    finalize: async () => {
      finalizes += 1;
      return true;
    },
  });

  assert.equal(finalizes, 0);
  assert.deepEqual(result, { kind: "provider_unknown", retryable: false });
});

test("interest engage forwards the durable action key and claims before crossing the SMS boundary", async () => {
  const [route, engage, migration] = await Promise.all([
    readFile(new URL("../app/api/pool/[token]/interest/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./agent/engage.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../docs/migrations/2026-08-pool-engage-claim.sql", import.meta.url),
      "utf8"
    ),
  ]);

  assert.match(route, /runInterestEngage\(\{[\s\S]*?actionKey:\s*actionId/);

  const run = engage.slice(engage.indexOf("export async function runInterestEngage"));
  assert.ok(run.indexOf('"claim_pool_engage"') >= 0);
  assert.ok(run.indexOf('"claim_pool_engage"') < run.indexOf("send: () => sendSms"));

  const claimFunction = migration.slice(
    migration.indexOf("create or replace function public.claim_pool_engage"),
    migration.indexOf("create or replace function public.record_pool_engage_provider_result")
  );
  assert.match(claimFunction, /from public\.applicants[\s\S]*for update/i);
  assert.match(claimFunction, /pool_engage_action_key\s*=\s*p_action_key/i);
});

test("a cleared current job cannot supersede an unresolved send, while terminal sends permit a later claim", async () => {
  const migration = await readFile(
    new URL("../docs/migrations/2026-08-pool-engage-recovery.sql", import.meta.url),
    "utf8"
  );
  const claimFunction = migration.slice(
    migration.indexOf("create or replace function public.claim_pool_engage"),
    migration.indexOf("create or replace function public.reconcile_pool_engage")
  );

  const activeGuard = claimFunction.match(
    /from public\.pool_engage_send_requests[\s\S]*?status\s+in\s*\(\s*'sending'\s*,\s*'unknown'\s*,\s*'sent'\s*\)[\s\S]*?return\s+'already_claimed'/i
  );
  assert.ok(activeGuard, "active outbox states must block a new claim independently of current_job_id");
  assert.ok(
    claimFunction.indexOf(activeGuard[0]) < claimFunction.indexOf("if v_current_job_id is null"),
    "the unresolved-send guard must run before the cleared-current-job branch"
  );
  assert.doesNotMatch(activeGuard[0], /'failed'|'recorded'/i);
  assert.match(claimFunction, /v_existing_status\s*=\s*'sent'[\s\S]*return\s+'resume_finalize'/i);
});

test("the recovery RPC finalizes sent rows only and surfaces unknown or sending rows", async () => {
  const migration = await readFile(
    new URL("../docs/migrations/2026-08-pool-engage-recovery.sql", import.meta.url),
    "utf8"
  );
  const recoveryFunction = migration.slice(
    migration.indexOf("create or replace function public.reconcile_pool_engage"),
    migration.indexOf("revoke execute on function public.claim_pool_engage")
  );

  assert.match(recoveryFunction, /v_status\s*=\s*'sent'[\s\S]*public\.finalize_pool_engage\s*\(\s*v_action_key\s*\)/i);
  assert.match(recoveryFunction, /v_status\s*=\s*'unknown'[\s\S]*jsonb_build_object\s*\(\s*'outcome'\s*,\s*'unknown'/i);
  assert.match(recoveryFunction, /v_status\s*=\s*'sending'[\s\S]*jsonb_build_object\s*\(\s*'outcome'\s*,\s*'sending'/i);

  const applicantRecoveryBranch = recoveryFunction.indexOf(
    "else",
    recoveryFunction.indexOf("if p_action_key is not null")
  );
  const applicantRecoverySelect = recoveryFunction.indexOf(
    "select action_key",
    applicantRecoveryBranch
  );
  const applicantRecoveryLookup = recoveryFunction.slice(
    applicantRecoverySelect,
    recoveryFunction.indexOf("for update;", applicantRecoverySelect)
  );
  assert.match(applicantRecoveryLookup, /applicant_id\s*=\s*p_applicant_id/i);
  assert.doesNotMatch(
    applicantRecoveryLookup,
    /job_id\s*=\s*p_job_id/i,
    "cron recovery must surface an applicant-level active claim even when its current_job_id was cleared"
  );
});

test("recovery results distinguish finalize-only recovery from unresolved provider visibility", async () => {
  const { poolEngageRecoveryDecision: decide } = await loadModule();
  assert.equal(typeof decide, "function");

  assert.deepEqual(decide!({ outcome: "missing" }, null), { kind: "none" });
  assert.deepEqual(
    decide!({ outcome: "recovered", message_kind: "screening" }, null),
    { kind: "recovered", messageKind: "screening" }
  );
  assert.deepEqual(
    decide!({ outcome: "unknown", message_kind: "waitlist" }, null),
    { kind: "blocked", status: "unknown", messageKind: "waitlist" }
  );
  assert.deepEqual(
    decide!({ outcome: "sent_unfinalized", message_kind: "screening" }, null),
    { kind: "sent_unfinalized", messageKind: "screening" }
  );
  assert.deepEqual(decide!(null, { message: "rpc failed" }), { kind: "retryable" });
});

test("a superseded candidate flow is still a completed message finalization", async () => {
  const { poolEngageFinalizeSucceeded: succeeded } = await loadModule();
  assert.equal(typeof succeeded, "function");

  for (const outcome of ["recorded", "deduped", "superseded"]) {
    assert.equal(succeeded!(outcome, null), true, outcome);
  }
  assert.equal(succeeded!("unavailable", null), false);
  assert.equal(succeeded!("recorded", { message: "rpc failed" }), false);
});

test("the claim never takes or clears the job binding of a manager-confirmed applicant", async () => {
  const migration = await readFile(
    new URL("../docs/migrations/2026-08-pool-engage-claim.sql", import.meta.url),
    "utf8"
  );
  const claimFunction = migration.slice(
    migration.indexOf("create or replace function public.claim_pool_engage"),
    migration.indexOf("create or replace function public.record_pool_engage_provider_result")
  );
  const providerFunction = migration.slice(
    migration.indexOf("create or replace function public.record_pool_engage_provider_result"),
    migration.indexOf("create or replace function public.finalize_pool_engage")
  );
  const finalizeFunction = migration.slice(
    migration.indexOf("create or replace function public.finalize_pool_engage"),
    migration.indexOf("revoke execute on function public.claim_pool_engage")
  );

  assert.match(claimFunction, /v_applicant_status\s+in\s*\([^)]*'확정인력'[^)]*\)/i);
  assert.match(providerFunction, /status\s+is\s+distinct\s+from\s+'확정인력'/i);
  assert.match(finalizeFunction, /status\s+is\s+distinct\s+from\s+'확정인력'/i);
  assert.match(finalizeFunction, /v_owner_status\s+is\s+distinct\s+from\s+'확정인력'/i);
  assert.match(finalizeFunction, /v_owner_status\s+is\s+distinct\s+from\s+'인력풀 제외'/i);
});

test("the queued cron reports provider-unknown separately and never promises an automatic retry", async () => {
  const [route, cron, engage] = await Promise.all([
    readFile(new URL("../app/api/pool/[token]/interest/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/cron/engage-queued/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./agent/engage.ts", import.meta.url), "utf8"),
  ]);

  assert.match(route, /replay\s*===\s*"deduped"[\s\S]*resumeInterestEngageIntent/);
  const resume = route.slice(
    route.indexOf("async function resumeInterestEngageIntent"),
    route.indexOf("export async function POST")
  );
  assert.ok(
    resume.indexOf("recoverInterestEngage") < resume.lastIndexOf("runInterestEngage"),
    "a pending daytime intent must reconcile its exact outbox before starting a send"
  );
  const queuedQuery = cron.indexOf('.from("job_candidates")');
  const earlyOffReturn = cron.indexOf('if (mode === "off")');
  assert.ok(
    earlyOffReturn === -1 || earlyOffReturn > queuedQuery,
    "kill-switch off must still permit finalize-only recovery before returning"
  );
  assert.match(cron, /unknown:\s*0/);
  assert.match(cron, /recovered:\s*0/);
  assert.match(cron, /case\s+"recovered"/);
  assert.match(cron, /case\s+"send_unknown"/);
  assert.match(cron, /발송 결과[^\n]*확인[^\n]*자동 재시도하지 않/i);
  assert.match(
    engage,
    /if\s*\(!text\)\s*return\s*\{\s*action:\s*"skipped",\s*reason:\s*"unsafe_message"\s*\}/
  );
});
