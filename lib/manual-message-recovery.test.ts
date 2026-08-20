import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface RecoveryRow {
  idempotencyKey: string;
  phone: string;
  createdAt: string;
}

type ProviderLookup =
  | { kind: "found"; messageId: string }
  | { kind: "not_found" }
  | { kind: "error"; error: string };

type RecoveryModule = {
  retryManualMessagePostprocess?: (
    call: () => Promise<{ data: unknown; error: { message?: string } | null }>,
    parse: (value: unknown) => {
      completed: boolean;
      pausedSkipped: "ambiguous" | "changed" | null;
      pausedJobId: number | null;
    }
  ) => Promise<{
    result: {
      completed: boolean;
      pausedSkipped: "ambiguous" | "changed" | null;
      pausedJobId: number | null;
    };
    attempts: number;
    lastError: string | null;
  }>;
  recoverManualMessageWork?: (args: {
    recordedPendingKeys: string[];
    sentRows: RecoveryRow[];
    providerPendingRows: RecoveryRow[];
    completePostprocess: (key: string) => Promise<boolean>;
    recordSent: (row: RecoveryRow, providerMessageId?: string) => Promise<boolean>;
    claimProviderReconciliation: (row: RecoveryRow) => Promise<boolean>;
    reconcileProvider: (row: RecoveryRow) => Promise<ProviderLookup>;
    markProviderSent: (row: RecoveryRow, providerMessageId: string) => Promise<boolean>;
    markProviderUnresolved: (
      row: RecoveryRow,
      lookup: Exclude<ProviderLookup, { kind: "found" }>
    ) => Promise<boolean>;
  }) => Promise<{
    postprocessCompleted: number;
    postprocessPending: number;
    historyRecovered: number;
    providerMatched: number;
    providerUnresolved: number;
    failed: number;
  }>;
};

async function loadModule(): Promise<RecoveryModule> {
  try {
    return await import(new URL("./manual-message-recovery.ts", import.meta.url).href) as RecoveryModule;
  } catch {
    return {};
  }
}

const row: RecoveryRow = {
  idempotencyKey: "41f82761-a37a-4f6f-8ad5-8b6b93acb8c1",
  phone: "01012345678",
  createdAt: "2026-08-20T01:00:00.000Z",
};

function parsePostprocess(value: unknown) {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    completed: data.outcome === "processed" || data.outcome === "completed",
    pausedSkipped: data.paused_skipped === "ambiguous" || data.paused_skipped === "changed"
      ? data.paused_skipped
      : null,
    pausedJobId: typeof data.paused_job_id === "number" ? data.paused_job_id : null,
  } as const;
}

test("a transient postprocess failure is retried immediately within a fixed bound", async () => {
  const { retryManualMessagePostprocess } = await loadModule();
  assert.equal(typeof retryManualMessagePostprocess, "function");

  let attempts = 0;
  const recovered = await retryManualMessagePostprocess!(
    async () => {
      attempts += 1;
      return attempts < 3
        ? { data: null, error: { message: "temporary database error" } }
        : {
            data: { outcome: "processed", paused_skipped: null, paused_job_id: 31 },
            error: null,
          };
    },
    parsePostprocess
  );

  assert.equal(attempts, 3);
  assert.deepEqual(recovered, {
    result: { completed: true, pausedSkipped: null, pausedJobId: 31 },
    attempts: 3,
    lastError: null,
  });
});

test("an unavailable postprocess RPC stops after three immediate attempts", async () => {
  const { retryManualMessagePostprocess } = await loadModule();
  assert.equal(typeof retryManualMessagePostprocess, "function");

  let attempts = 0;
  const pending = await retryManualMessagePostprocess!(
    async () => {
      attempts += 1;
      return { data: null, error: { message: "database unavailable" } };
    },
    parsePostprocess
  );

  assert.equal(attempts, 3);
  assert.deepEqual(pending, {
    result: { completed: false, pausedSkipped: null, pausedJobId: null },
    attempts: 3,
    lastError: "database unavailable",
  });
});

test("recorded pending and sent-unrecorded rows recover without a provider call", async () => {
  const { recoverManualMessageWork } = await loadModule();
  assert.equal(typeof recoverManualMessageWork, "function");

  const order: string[] = [];
  const result = await recoverManualMessageWork!({
    recordedPendingKeys: ["recorded-key"],
    sentRows: [row],
    providerPendingRows: [],
    completePostprocess: async (key) => {
      order.push(`complete:${key}`);
      return true;
    },
    recordSent: async (candidate) => {
      order.push(`record:${candidate.idempotencyKey}`);
      return true;
    },
    claimProviderReconciliation: async () => {
      throw new Error("provider claim must not run");
    },
    reconcileProvider: async () => {
      throw new Error("provider lookup must not run");
    },
    markProviderSent: async () => {
      throw new Error("provider state must not change");
    },
    markProviderUnresolved: async () => {
      throw new Error("provider state must not change");
    },
  });

  assert.deepEqual(order, [
    "complete:recorded-key",
    `record:${row.idempotencyKey}`,
    `complete:${row.idempotencyKey}`,
  ]);
  assert.deepEqual(result, {
    postprocessCompleted: 2,
    postprocessPending: 0,
    historyRecovered: 1,
    providerMatched: 0,
    providerUnresolved: 0,
    failed: 0,
  });
});

test("an exact provider correlation recovers history before postprocessing", async () => {
  const { recoverManualMessageWork } = await loadModule();
  assert.equal(typeof recoverManualMessageWork, "function");

  const order: string[] = [];
  const result = await recoverManualMessageWork!({
    recordedPendingKeys: [],
    sentRows: [],
    providerPendingRows: [row],
    completePostprocess: async (key) => {
      order.push(`complete:${key}`);
      return true;
    },
    recordSent: async (candidate, providerMessageId) => {
      order.push(`record:${candidate.idempotencyKey}:${providerMessageId}`);
      return true;
    },
    claimProviderReconciliation: async () => {
      order.push("claim");
      return true;
    },
    reconcileProvider: async () => {
      order.push("lookup");
      return { kind: "found", messageId: "provider-message-1" };
    },
    markProviderSent: async (_candidate, providerMessageId) => {
      order.push(`mark:${providerMessageId}`);
      return true;
    },
    markProviderUnresolved: async () => {
      throw new Error("an exact match must not be marked unresolved");
    },
  });

  assert.deepEqual(order, [
    "claim",
    "lookup",
    "mark:provider-message-1",
    `record:${row.idempotencyKey}:provider-message-1`,
    `complete:${row.idempotencyKey}`,
  ]);
  assert.deepEqual(result, {
    postprocessCompleted: 1,
    postprocessPending: 0,
    historyRecovered: 1,
    providerMatched: 1,
    providerUnresolved: 0,
    failed: 0,
  });
});

test("a missing provider correlation remains unresolved and changes no send state", async () => {
  const { recoverManualMessageWork } = await loadModule();
  assert.equal(typeof recoverManualMessageWork, "function");

  let stateChanges = 0;
  const result = await recoverManualMessageWork!({
    recordedPendingKeys: [],
    sentRows: [],
    providerPendingRows: [row],
    completePostprocess: async () => {
      stateChanges += 1;
      return true;
    },
    recordSent: async () => {
      stateChanges += 1;
      return true;
    },
    claimProviderReconciliation: async () => true,
    reconcileProvider: async () => ({ kind: "not_found" }),
    markProviderSent: async () => {
      stateChanges += 1;
      return true;
    },
    markProviderUnresolved: async (_candidate, lookup) => {
      assert.deepEqual(lookup, { kind: "not_found" });
      return true;
    },
  });

  assert.equal(stateChanges, 0);
  assert.deepEqual(result, {
    postprocessCompleted: 0,
    postprocessPending: 0,
    historyRecovered: 0,
    providerMatched: 0,
    providerUnresolved: 1,
    failed: 0,
  });
});

test("an exhausted provider-reconciliation claim performs no provider lookup or state change", async () => {
  const { recoverManualMessageWork } = await loadModule();
  assert.equal(typeof recoverManualMessageWork, "function");

  let providerCalls = 0;
  const result = await recoverManualMessageWork!({
    recordedPendingKeys: [],
    sentRows: [],
    providerPendingRows: [row],
    completePostprocess: async () => {
      assert.fail("an exhausted row cannot be postprocessed");
    },
    recordSent: async () => {
      assert.fail("an exhausted row cannot be recorded");
    },
    claimProviderReconciliation: async () => false,
    reconcileProvider: async () => {
      providerCalls += 1;
      return { kind: "found", messageId: "must-not-be-used" };
    },
    markProviderSent: async () => {
      assert.fail("an exhausted row cannot be marked sent");
    },
    markProviderUnresolved: async () => {
      assert.fail("the database claim already owns the exhausted transition");
    },
  });

  assert.equal(providerCalls, 0);
  assert.deepEqual(result, {
    postprocessCompleted: 0,
    postprocessPending: 0,
    historyRecovered: 0,
    providerMatched: 0,
    providerUnresolved: 1,
    failed: 0,
  });
});

test("the scheduled sweep is authenticated, bounded, and advances outbox state without an SMS path", async () => {
  const [route, migration, vercel] = await Promise.all([
    readFile(
      new URL("../app/api/admin/cron/manual-message-recovery/route.ts", import.meta.url),
      "utf8"
    ).catch(() => ""),
    readFile(
      new URL("../docs/migrations/2026-08-manual-message-recovery.sql", import.meta.url),
      "utf8"
    ),
    readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  ]);

  assert.match(route, /requireCronAuth\(req\)/);
  assert.match(route, /recoverManualMessageWork/);
  assert.match(route, /findSmsByClientRequestId/);
  assert.doesNotMatch(route, /\bsendSms\b/);
  assert.match(route, /\.limit\(RECOVERY_BATCH_LIMIT\)/);

  assert.match(migration, /create or replace function public\.claim_manual_message_provider_reconciliation/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /provider_reconcile_attempts\s*>=\s*p_max_attempts/i);
  assert.match(migration, /provider_reconcile_status\s*=\s*'unresolved'/i);
  assert.match(migration, /create or replace function public\.record_manual_message_provider_match/i);
  assert.match(migration, /status\s*=\s*'sent'/i);
  assert.match(migration, /revoke execute on function public\.claim_manual_message_provider_reconciliation/i);
  assert.match(migration, /to service_role/i);

  const cron = JSON.parse(vercel) as { crons?: Array<{ path?: string; schedule?: string }> };
  assert.ok(cron.crons?.some((entry) => (
    entry.path === "/api/admin/cron/manual-message-recovery"
    && entry.schedule === "*/10 * * * *"
  )));
});
