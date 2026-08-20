/**
 * GET /api/admin/cron/manual-message-recovery
 *
 * 수동 SMS outbox의 DB 후처리와 발송 원장 기록을 무발송으로 복구한다.
 * sending/unknown은 SOLAPI customFields의 caller UUID가 정확히 일치할 때만 sent로
 * 전진하며, 횟수 상한 뒤에도 자동 재발송하지 않고 unresolved로 남긴다.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase";
import {
  recoverManualMessageWork,
  retryManualMessagePostprocess,
  type ManualMessageProviderLookup,
  type ManualMessageRecoveryRow,
} from "@/lib/manual-message-recovery";
import {
  manualMessagePostprocessResult,
} from "@/lib/manual-message-send";
import { findSmsByClientRequestId } from "@/lib/solapi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RECOVERY_BATCH_LIMIT = 25;
const PROVIDER_RECONCILIATION_MAX_ATTEMPTS = 3;
const RECOVERY_GRACE_MS = 5 * 60 * 1000;

function recoveryRow(value: Record<string, unknown>): ManualMessageRecoveryRow {
  return {
    idempotencyKey: String(value.idempotency_key ?? ""),
    phone: String(value.applicant_phone ?? ""),
    createdAt: String(value.created_at ?? ""),
  };
}

export async function GET(req: NextRequest) {
  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  const supabase = createServiceClient();
  const cutoff = new Date(Date.now() - RECOVERY_GRACE_MS).toISOString();
  const fields = "idempotency_key, applicant_phone, created_at";

  const [recordedResult, sentResult, providerResult] = await Promise.all([
    supabase
      .from("manual_message_send_requests")
      .select(fields)
      .eq("status", "recorded")
      .eq("postprocess_status", "pending")
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(RECOVERY_BATCH_LIMIT),
    supabase
      .from("manual_message_send_requests")
      .select(fields)
      .eq("status", "sent")
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(RECOVERY_BATCH_LIMIT),
    supabase
      .from("manual_message_send_requests")
      .select(fields)
      .in("status", ["sending", "unknown"])
      .eq("provider_correlation_attached", true)
      .eq("provider_reconcile_status", "pending")
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(RECOVERY_BATCH_LIMIT),
  ]);

  const queryError = recordedResult.error || sentResult.error || providerResult.error;
  if (queryError) {
    console.error("[manual-message-recovery] outbox query failed", queryError);
    return NextResponse.json({ error: "manual message recovery query failed" }, { status: 500 });
  }

  const recordedRows = (recordedResult.data ?? []) as Array<Record<string, unknown>>;
  const sentRows = ((sentResult.data ?? []) as Array<Record<string, unknown>>).map(recoveryRow);
  const providerRows = ((providerResult.data ?? []) as Array<Record<string, unknown>>).map(recoveryRow);

  const counts = await recoverManualMessageWork({
    recordedPendingKeys: recordedRows.map((row) => String(row.idempotency_key ?? "")),
    sentRows,
    providerPendingRows: providerRows,
    completePostprocess: async (key) => {
      const recovered = await retryManualMessagePostprocess(
        async () => await supabase.rpc("complete_manual_message_postprocess", {
          p_idempotency_key: key,
        }),
        manualMessagePostprocessResult
      );
      if (!recovered.result.completed) {
        console.error("[manual-message-recovery] postprocess pending", {
          idempotencyKey: key,
          attempts: recovered.attempts,
          error: recovered.lastError,
        });
      }
      return recovered.result.completed;
    },
    recordSent: async (row) => {
      const { data, error } = await supabase.rpc("record_manual_message_history", {
        p_idempotency_key: row.idempotencyKey,
      });
      if (error) {
        console.error("[manual-message-recovery] history recovery failed", error);
        return false;
      }
      return data === "recorded" || data === "deduped";
    },
    claimProviderReconciliation: async (row) => {
      const { data, error } = await supabase.rpc(
        "claim_manual_message_provider_reconciliation",
        {
          p_idempotency_key: row.idempotencyKey,
          p_max_attempts: PROVIDER_RECONCILIATION_MAX_ATTEMPTS,
        }
      );
      if (error) throw error;
      return data === "claimed";
    },
    reconcileProvider: async (row) => await findSmsByClientRequestId({
      phone: row.phone,
      clientRequestId: row.idempotencyKey,
      createdAt: row.createdAt,
    }),
    markProviderSent: async (row, providerMessageId) => {
      const { data, error } = await supabase.rpc("record_manual_message_provider_match", {
        p_idempotency_key: row.idempotencyKey,
        p_provider_message_id: providerMessageId,
      });
      if (error) {
        console.error("[manual-message-recovery] provider match persistence failed", error);
        return false;
      }
      return data === "matched" || data === "deduped";
    },
    markProviderUnresolved: async (row, lookup: Exclude<ManualMessageProviderLookup, { kind: "found" }>) => {
      const { data, error } = await supabase.rpc("record_manual_message_provider_miss", {
        p_idempotency_key: row.idempotencyKey,
        p_max_attempts: PROVIDER_RECONCILIATION_MAX_ATTEMPTS,
        p_error: lookup.kind === "error" ? lookup.error : null,
      });
      if (error) {
        console.error("[manual-message-recovery] provider miss persistence failed", error);
        return false;
      }
      return data === "pending" || data === "unresolved" || data === "unchanged";
    },
  });

  return NextResponse.json({
    success: true,
    scanned: {
      postprocess: recordedRows.length,
      sent: sentRows.length,
      provider: providerRows.length,
    },
    ...counts,
  });
}
