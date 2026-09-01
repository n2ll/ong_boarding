import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface RecoveryRow {
  recipientKey: string;
  phone: string;
  createdAt: string;
}

type ProviderLookup =
  | { kind: "found"; messageId: string }
  | { kind: "not_found" }
  | { kind: "error"; error: string };

type RecoveryModule = {
  recoverBulkMessageWork?: (args: {
    sentRows: RecoveryRow[];
    providerPendingRows: RecoveryRow[];
    finalizeSent: (row: RecoveryRow) => Promise<boolean>;
    claimProviderReconciliation: (row: RecoveryRow) => Promise<string | null>;
    reconcileProvider: (row: RecoveryRow) => Promise<ProviderLookup>;
    markProviderSent: (
      row: RecoveryRow,
      providerMessageId: string,
      claimToken: string,
    ) => Promise<boolean>;
    markProviderUnresolved: (
      row: RecoveryRow,
      lookup: Exclude<ProviderLookup, { kind: "found" }>,
      claimToken: string,
    ) => Promise<boolean>;
  }) => Promise<{
    finalized: number;
    finalizePending: number;
    providerMatched: number;
    providerUnresolved: number;
    failed: number;
  }>;
};

async function loadModule(): Promise<RecoveryModule> {
  try {
    return await import(new URL("./bulk-message-recovery.ts", import.meta.url).href) as RecoveryModule;
  } catch {
    return {};
  }
}

const row: RecoveryRow = {
  recipientKey: "41f82761-a37a-4f6f-8ad5-8b6b93acb8c1",
  phone: "01012345678",
  createdAt: "2026-09-01T01:00:00.000Z",
};

test("a durable sent bulk row is finalized without consulting the provider", async () => {
  const { recoverBulkMessageWork } = await loadModule();
  assert.equal(typeof recoverBulkMessageWork, "function");

  const order: string[] = [];
  const counts = await recoverBulkMessageWork!({
    sentRows: [row],
    providerPendingRows: [],
    finalizeSent: async (candidate) => {
      order.push(`finalize:${candidate.recipientKey}`);
      return true;
    },
    claimProviderReconciliation: async () => {
      assert.fail("sent recovery must not claim provider reconciliation");
    },
    reconcileProvider: async () => {
      assert.fail("sent recovery must not query the provider");
    },
    markProviderSent: async () => {
      assert.fail("sent recovery must not rewrite provider state");
    },
    markProviderUnresolved: async () => {
      assert.fail("sent recovery must not rewrite provider state");
    },
  });

  assert.deepEqual(order, [`finalize:${row.recipientKey}`]);
  assert.deepEqual(counts, {
    finalized: 1,
    finalizePending: 0,
    providerMatched: 0,
    providerUnresolved: 0,
    failed: 0,
  });
});

test("an exact provider match is persisted before the bulk row is finalized", async () => {
  const { recoverBulkMessageWork } = await loadModule();
  assert.equal(typeof recoverBulkMessageWork, "function");

  const order: string[] = [];
  const counts = await recoverBulkMessageWork!({
    sentRows: [],
    providerPendingRows: [row],
    finalizeSent: async () => {
      order.push("finalize");
      return true;
    },
    claimProviderReconciliation: async () => {
      order.push("claim");
      return "claim-token-1";
    },
    reconcileProvider: async () => {
      order.push("lookup");
      return { kind: "found", messageId: "provider-message-1" };
    },
    markProviderSent: async (_candidate, providerMessageId, claimToken) => {
      assert.equal(claimToken, "claim-token-1");
      order.push(`mark:${providerMessageId}`);
      return true;
    },
    markProviderUnresolved: async () => {
      assert.fail("an exact provider match cannot be marked unresolved");
    },
  });

  assert.deepEqual(order, ["claim", "lookup", "mark:provider-message-1", "finalize"]);
  assert.deepEqual(counts, {
    finalized: 1,
    finalizePending: 0,
    providerMatched: 1,
    providerUnresolved: 0,
    failed: 0,
  });
});

test("a provider miss remains unresolved and never advances delivery or finalization", async () => {
  const { recoverBulkMessageWork } = await loadModule();
  assert.equal(typeof recoverBulkMessageWork, "function");

  let deliveryAdvances = 0;
  const counts = await recoverBulkMessageWork!({
    sentRows: [],
    providerPendingRows: [row],
    finalizeSent: async () => {
      deliveryAdvances += 1;
      return true;
    },
    claimProviderReconciliation: async () => "claim-token-2",
    reconcileProvider: async () => ({ kind: "not_found" }),
    markProviderSent: async () => {
      deliveryAdvances += 1;
      return true;
    },
    markProviderUnresolved: async (_candidate, lookup, claimToken) => {
      assert.deepEqual(lookup, { kind: "not_found" });
      assert.equal(claimToken, "claim-token-2");
      return true;
    },
  });

  assert.equal(deliveryAdvances, 0);
  assert.deepEqual(counts, {
    finalized: 0,
    finalizePending: 0,
    providerMatched: 0,
    providerUnresolved: 1,
    failed: 0,
  });
});

test("an exhausted provider claim performs no lookup and remains no-resend", async () => {
  const { recoverBulkMessageWork } = await loadModule();
  assert.equal(typeof recoverBulkMessageWork, "function");

  let lookups = 0;
  const counts = await recoverBulkMessageWork!({
    sentRows: [],
    providerPendingRows: [row],
    finalizeSent: async () => {
      assert.fail("an exhausted row cannot be finalized");
    },
    claimProviderReconciliation: async () => null,
    reconcileProvider: async () => {
      lookups += 1;
      return { kind: "found", messageId: "must-not-be-used" };
    },
    markProviderSent: async () => {
      assert.fail("an exhausted row cannot be marked sent");
    },
    markProviderUnresolved: async () => {
      assert.fail("the database claim owns the exhausted transition");
    },
  });

  assert.equal(lookups, 0);
  assert.deepEqual(counts, {
    finalized: 0,
    finalizePending: 0,
    providerMatched: 0,
    providerUnresolved: 1,
    failed: 0,
  });
});

test("the bulk recovery cron is authenticated, bounded, exact-correlated, and never sends", async () => {
  const [route, vercel] = await Promise.all([
    readFile(
      new URL("../app/api/admin/cron/bulk-message-recovery/route.ts", import.meta.url),
      "utf8",
    ).catch(() => ""),
    readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  ]);

  assert.match(route, /requireCronAuth\(req\)/);
  assert.match(route, /recoverBulkMessageWork/);
  assert.match(route, /findSmsByClientRequestId/);
  assert.match(route, /RECOVERY_GRACE_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
  assert.match(route, /PROVIDER_RECONCILIATION_MAX_ATTEMPTS\s*=\s*3/);
  assert.match(route, /\.limit\(RECOVERY_BATCH_LIMIT\)/);
  assert.doesNotMatch(route, /\bsendSms\b/);

  const cron = JSON.parse(vercel) as { crons?: Array<{ path?: string; schedule?: string }> };
  assert.ok(cron.crons?.some((entry) => (
    entry.path === "/api/admin/cron/bulk-message-recovery"
    && entry.schedule === "*/10 * * * *"
  )));
});
