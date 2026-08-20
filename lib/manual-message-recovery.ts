const IMMEDIATE_POSTPROCESS_ATTEMPTS = 3;

export interface ManualMessagePostprocessRecoveryResult {
  completed: boolean;
  pausedSkipped: "ambiguous" | "changed" | null;
  pausedJobId: number | null;
}

export interface ManualMessageRecoveryRow {
  idempotencyKey: string;
  phone: string;
  createdAt: string;
}

export type ManualMessageProviderLookup =
  | { kind: "found"; messageId: string }
  | { kind: "not_found" }
  | { kind: "error"; error: string };

interface ManualMessagePostprocessCall {
  data: unknown;
  error: { message?: string } | null;
}

interface RecoverManualMessageWorkArgs<TRow extends ManualMessageRecoveryRow> {
  recordedPendingKeys: string[];
  sentRows: TRow[];
  providerPendingRows: TRow[];
  completePostprocess: (key: string) => Promise<boolean>;
  recordSent: (row: TRow, providerMessageId?: string) => Promise<boolean>;
  claimProviderReconciliation: (row: TRow) => Promise<boolean>;
  reconcileProvider: (row: TRow) => Promise<ManualMessageProviderLookup>;
  markProviderSent: (row: TRow, providerMessageId: string) => Promise<boolean>;
  markProviderUnresolved: (
    row: TRow,
    lookup: Exclude<ManualMessageProviderLookup, { kind: "found" }>
  ) => Promise<boolean>;
}

export interface ManualMessageRecoveryCounts {
  postprocessCompleted: number;
  postprocessPending: number;
  historyRecovered: number;
  providerMatched: number;
  providerUnresolved: number;
  failed: number;
}

/**
 * 요청 응답 중 일시적인 DB/RPC 오류만 짧게 흡수한다. 세 번 모두 실패하면
 * outbox의 pending 상태를 그대로 두어 cron이 이어받는다.
 */
export async function retryManualMessagePostprocess(
  call: () => Promise<ManualMessagePostprocessCall>,
  parse: (value: unknown) => ManualMessagePostprocessRecoveryResult
): Promise<{
  result: ManualMessagePostprocessRecoveryResult;
  attempts: number;
  lastError: string | null;
}> {
  let lastResult: ManualMessagePostprocessRecoveryResult = {
    completed: false,
    pausedSkipped: null,
    pausedJobId: null,
  };
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= IMMEDIATE_POSTPROCESS_ATTEMPTS; attempt += 1) {
    try {
      const response = await call();
      lastResult = parse(response.data);
      lastError = response.error?.message ?? null;
      if (!response.error && lastResult.completed) {
        return { result: lastResult, attempts: attempt, lastError: null };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "postprocess call failed";
    }
  }

  return {
    result: lastResult,
    attempts: IMMEDIATE_POSTPROCESS_ATTEMPTS,
    lastError,
  };
}

/**
 * 복구 작업에는 외부 발송 콜백이 의도적으로 없다. 이미 확인된 outbox 상태를
 * messages 원장과 DB 후처리로만 전진시키며, 공급자 조회도 exact correlation일 때만 인정한다.
 */
export async function recoverManualMessageWork<TRow extends ManualMessageRecoveryRow>({
  recordedPendingKeys,
  sentRows,
  providerPendingRows,
  completePostprocess,
  recordSent,
  claimProviderReconciliation,
  reconcileProvider,
  markProviderSent,
  markProviderUnresolved,
}: RecoverManualMessageWorkArgs<TRow>): Promise<ManualMessageRecoveryCounts> {
  const counts: ManualMessageRecoveryCounts = {
    postprocessCompleted: 0,
    postprocessPending: 0,
    historyRecovered: 0,
    providerMatched: 0,
    providerUnresolved: 0,
    failed: 0,
  };

  const complete = async (key: string) => {
    try {
      if (await completePostprocess(key)) counts.postprocessCompleted += 1;
      else counts.postprocessPending += 1;
    } catch {
      counts.postprocessPending += 1;
      counts.failed += 1;
    }
  };

  for (const key of recordedPendingKeys) {
    await complete(key);
  }

  for (const row of sentRows) {
    try {
      if (!(await recordSent(row))) {
        counts.failed += 1;
        continue;
      }
      counts.historyRecovered += 1;
      await complete(row.idempotencyKey);
    } catch {
      counts.failed += 1;
    }
  }

  for (const row of providerPendingRows) {
    try {
      if (!(await claimProviderReconciliation(row))) {
        counts.providerUnresolved += 1;
        continue;
      }
    } catch {
      counts.providerUnresolved += 1;
      counts.failed += 1;
      continue;
    }

    let lookup: ManualMessageProviderLookup;
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
        if (!(await markProviderUnresolved(row, lookup))) counts.failed += 1;
      } catch {
        counts.failed += 1;
      }
      if (lookup.kind === "error") counts.failed += 1;
      continue;
    }

    counts.providerMatched += 1;
    try {
      if (!(await markProviderSent(row, lookup.messageId))) {
        counts.failed += 1;
        continue;
      }
      if (!(await recordSent(row, lookup.messageId))) {
        counts.failed += 1;
        continue;
      }
      counts.historyRecovered += 1;
      await complete(row.idempotencyKey);
    } catch {
      counts.failed += 1;
    }
  }

  return counts;
}
