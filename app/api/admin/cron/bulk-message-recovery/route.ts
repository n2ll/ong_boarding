/**
 * GET /api/admin/cron/bulk-message-recovery
 *
 * 일괄 SMS outbox의 sent 후처리와 공급자 결과 불명 건을 무발송으로 복구한다.
 * sending/unknown은 SOLAPI customFields의 recipient UUID가 정확히 일치할 때만 sent로
 * 전진하며, 조회 횟수 상한 뒤에도 unresolved로 남기고 자동 재발송하지 않는다.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireCronAuth } from "@/lib/cron-auth";
import { createServiceClient } from "@/lib/supabase";
import {
  recoverBulkMessageWork,
  type BulkMessageProviderLookup,
  type BulkMessageRecoveryRow,
} from "@/lib/bulk-message-recovery";
import { findSmsByClientRequestId } from "@/lib/solapi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RECOVERY_BATCH_LIMIT = 25;
const PROVIDER_RECONCILIATION_MAX_ATTEMPTS = 3;
const RECOVERY_GRACE_MS = 5 * 60 * 1000;

function recoveryRow(value: Record<string, unknown>): BulkMessageRecoveryRow {
  return {
    recipientKey: String(value.recipient_key ?? ""),
    phone: String(value.applicant_phone ?? ""),
    createdAt: String(value.created_at ?? ""),
  };
}

export async function GET(req: NextRequest) {
  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  const supabase = createServiceClient();
  const cutoff = new Date(Date.now() - RECOVERY_GRACE_MS).toISOString();
  const fields = "recipient_key, applicant_phone, created_at";

  const [sentResult, providerResult] = await Promise.all([
    supabase
      .from("bulk_message_send_requests")
      .select(fields)
      .eq("status", "sent")
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(RECOVERY_BATCH_LIMIT),
    supabase
      .from("bulk_message_send_requests")
      .select(fields)
      .in("status", ["sending", "unknown"])
      .eq("provider_correlation_attached", true)
      .eq("provider_reconcile_status", "pending")
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(RECOVERY_BATCH_LIMIT),
  ]);

  const queryError = sentResult.error || providerResult.error;
  if (queryError) {
    console.error("[bulk-message-recovery] outbox query failed", queryError);
    return NextResponse.json({ error: "bulk message recovery query failed" }, { status: 500 });
  }

  const sentRows = ((sentResult.data ?? []) as Array<Record<string, unknown>>).map(recoveryRow);
  const providerRows = ((providerResult.data ?? []) as Array<Record<string, unknown>>).map(recoveryRow);

  const counts = await recoverBulkMessageWork({
    sentRows,
    providerPendingRows: providerRows,
    finalizeSent: async (row) => {
      const { data, error } = await supabase.rpc("finalize_bulk_message_send", {
        p_recipient_key: row.recipientKey,
      });
      if (error) {
        console.error("[bulk-message-recovery] finalize failed", error);
        return false;
      }
      return data === "recorded" || data === "deduped";
    },
    claimProviderReconciliation: async (row) => {
      const claimToken = randomUUID();
      const { data, error } = await supabase.rpc(
        "claim_bulk_message_provider_reconciliation",
        {
          p_recipient_key: row.recipientKey,
          p_max_attempts: PROVIDER_RECONCILIATION_MAX_ATTEMPTS,
          p_claim_token: claimToken,
        },
      );
      if (error) throw error;
      return data === "claimed" ? claimToken : null;
    },
    reconcileProvider: async (row) => await findSmsByClientRequestId({
      phone: row.phone,
      clientRequestId: row.recipientKey,
      createdAt: row.createdAt,
    }),
    markProviderSent: async (row, providerMessageId, claimToken) => {
      const { data, error } = await supabase.rpc("record_bulk_message_provider_match", {
        p_recipient_key: row.recipientKey,
        p_provider_message_id: providerMessageId,
        p_claim_token: claimToken,
      });
      if (error) {
        console.error("[bulk-message-recovery] provider match persistence failed", error);
        return false;
      }
      return data === "matched" || data === "deduped";
    },
    markProviderUnresolved: async (
      row,
      lookup: Exclude<BulkMessageProviderLookup, { kind: "found" }>,
      claimToken,
    ) => {
      const { data, error } = await supabase.rpc("record_bulk_message_provider_miss", {
        p_recipient_key: row.recipientKey,
        p_max_attempts: PROVIDER_RECONCILIATION_MAX_ATTEMPTS,
        p_error: lookup.kind === "error" ? lookup.error : null,
        p_claim_token: claimToken,
      });
      if (error) {
        console.error("[bulk-message-recovery] provider miss persistence failed", error);
        return false;
      }
      return data === "pending" || data === "unresolved" || data === "unchanged";
    },
  });

  return NextResponse.json({
    success: true,
    scanned: {
      sent: sentRows.length,
      provider: providerRows.length,
    },
    ...counts,
  });
}
