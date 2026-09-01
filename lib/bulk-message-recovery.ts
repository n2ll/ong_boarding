export interface BulkMessageRecoveryRow {
  recipientKey: string;
  phone: string;
  createdAt: string;
}

export type BulkMessageProviderLookup =
  | { kind: "found"; messageId: string }
  | { kind: "not_found" }
  | { kind: "error"; error: string };

interface RecoverBulkMessageWorkArgs<TRow extends BulkMessageRecoveryRow> {
  sentRows: TRow[];
  providerPendingRows: TRow[];
  finalizeSent: (row: TRow) => Promise<boolean>;
  claimProviderReconciliation: (row: TRow) => Promise<string | null>;
  reconcileProvider: (row: TRow) => Promise<BulkMessageProviderLookup>;
  markProviderSent: (
    row: TRow,
    providerMessageId: string,
    claimToken: string,
  ) => Promise<boolean>;
  markProviderUnresolved: (
    row: TRow,
    lookup: Exclude<BulkMessageProviderLookup, { kind: "found" }>,
    claimToken: string,
  ) => Promise<boolean>;
}

export interface BulkMessageRecoveryCounts {
  finalized: number;
  finalizePending: number;
  providerMatched: number;
  providerUnresolved: number;
  failed: number;
}

/**
 * Durable 상태만 전진시키는 무발송 복구 루프다. 공급자 결과가 불명확한 행은
 * exact correlation으로 확인된 경우에만 sent로 바꾸고, 그 외에는 재발송하지 않는다.
 */
export async function recoverBulkMessageWork<TRow extends BulkMessageRecoveryRow>({
  sentRows,
  providerPendingRows,
  finalizeSent,
  claimProviderReconciliation,
  reconcileProvider,
  markProviderSent,
  markProviderUnresolved,
}: RecoverBulkMessageWorkArgs<TRow>): Promise<BulkMessageRecoveryCounts> {
  const counts: BulkMessageRecoveryCounts = {
    finalized: 0,
    finalizePending: 0,
    providerMatched: 0,
    providerUnresolved: 0,
    failed: 0,
  };

  const finalize = async (row: TRow) => {
    try {
      if (await finalizeSent(row)) counts.finalized += 1;
      else counts.finalizePending += 1;
    } catch {
      counts.finalizePending += 1;
      counts.failed += 1;
    }
  };

  for (const row of sentRows) {
    await finalize(row);
  }

  for (const row of providerPendingRows) {
    let claimToken: string | null;
    try {
      claimToken = await claimProviderReconciliation(row);
      if (!claimToken) {
        counts.providerUnresolved += 1;
        continue;
      }
    } catch {
      counts.providerUnresolved += 1;
      counts.failed += 1;
      continue;
    }

    let lookup: BulkMessageProviderLookup;
    try {
      lookup = await reconcileProvider(row);
    } catch (error) {
      lookup = {
        kind: "error",
        error: error instanceof Error ? error.message : "provider lookup failed",
      };
    }

    if (lookup.kind !== "found") {
      counts.providerUnresolved += 1;
      try {
        if (!(await markProviderUnresolved(row, lookup, claimToken))) counts.failed += 1;
      } catch {
        counts.failed += 1;
      }
      if (lookup.kind === "error") counts.failed += 1;
      continue;
    }

    try {
      if (!(await markProviderSent(row, lookup.messageId, claimToken))) {
        counts.failed += 1;
        continue;
      }
      counts.providerMatched += 1;
      await finalize(row);
    } catch {
      counts.failed += 1;
    }
  }

  return counts;
}
