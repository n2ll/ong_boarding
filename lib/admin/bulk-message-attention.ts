import type { SupabaseClient } from "@supabase/supabase-js";

export type BulkMessageAttentionPhase =
  | "checking"
  | "manual_confirmation"
  | "history_recovery";

export interface BulkMessageAttentionItem {
  batchId: string;
  applicantId: number;
  jobId: number | null;
  purpose: string | null;
  phase: BulkMessageAttentionPhase;
  createdAt: string;
  updatedAt: string;
}

export interface BulkMessageAttentionBatch {
  batchId: string;
  jobId: number | null;
  purpose: string | null;
  applicantIds: number[];
  totalCount: number;
  checkingCount: number;
  manualConfirmationCount: number;
  historyRecoveryCount: number;
  oldestCreatedAt: string;
}

export interface BulkMessageAttentionCollection {
  state: "ready" | "error";
  items: BulkMessageAttentionItem[];
  batches: BulkMessageAttentionBatch[];
  batchCount: number;
  totalCount: number | null;
  checkingCount: number;
  manualConfirmationCount: number;
  historyRecoveryCount: number;
  oldestCreatedAt: string | null;
  oldestAgeMinutes: number | null;
  truncated: boolean;
}

export interface BulkMessageAttentionPresentation {
  state: "ready" | "error";
  title: string;
  description: string;
  path: "/pipeline?bulk_attention=1";
  tone: "red" | "amber";
  urgency: "attention" | "critical";
  priorityLabel: "수동 확인" | "복구 진행" | "조회 실패";
  resendAllowed: false;
  actions: readonly [];
}

interface BulkMessageAttentionRow {
  recipient_key: string;
  batch_id: string;
  applicant_id: number | null;
  job_id: number | null;
  effective_purpose: string;
  status: string;
  provider_correlation_attached: boolean;
  provider_reconcile_status: string;
  created_at: string;
  updated_at: string;
}

const DEFAULT_ATTENTION_LIMIT = 500;
const MAX_ATTENTION_LIMIT = 1_000;
const ATTENTION_GRACE_MS = 5 * 60 * 1_000;
const ACTIVE_OUTBOX_STATUSES = ["sending", "unknown", "sent"];

const EMPTY_ERROR_COLLECTION: BulkMessageAttentionCollection = {
  state: "error",
  items: [],
  batches: [],
  batchCount: 0,
  totalCount: null,
  checkingCount: 0,
  manualConfirmationCount: 0,
  historyRecoveryCount: 0,
  oldestCreatedAt: null,
  oldestAgeMinutes: null,
  truncated: false,
};

function normalizedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ATTENTION_LIMIT;
  return Math.min(MAX_ATTENTION_LIMIT, Math.max(1, Math.floor(value)));
}

function phaseOf(row: BulkMessageAttentionRow): BulkMessageAttentionPhase {
  if (row.status === "sent") return "history_recovery";
  if (
    row.provider_correlation_attached === true
    && row.provider_reconcile_status === "pending"
  ) {
    return "checking";
  }
  return "manual_confirmation";
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 정상 발송 중인 짧은 구간은 제외하고, 5분 이상 복구가 끝나지 않은 일괄 SMS만 읽는다.
 * 전화번호·본문·공급자 오류는 운영 UI에 필요하지 않아 SELECT부터 제외한다.
 */
export async function loadBulkMessageAttention(
  supabase: SupabaseClient,
  options: { now?: number; limit?: number } = {},
): Promise<BulkMessageAttentionCollection> {
  const now = options.now ?? Date.now();
  const limit = normalizedLimit(options.limit);
  const cutoff = new Date(now - ATTENTION_GRACE_MS).toISOString();

  try {
    const { data, error, count } = await supabase
      .from("bulk_message_send_requests")
      .select(
        "recipient_key, batch_id, applicant_id, job_id, effective_purpose, status, provider_correlation_attached, provider_reconcile_status, created_at, updated_at",
        { count: "exact" },
      )
      .in("status", ACTIVE_OUTBOX_STATUSES)
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      console.error("[bulk-message-attention] query failed", error ?? "invalid count");
      return { ...EMPTY_ERROR_COLLECTION };
    }

    const rows = (data ?? []) as BulkMessageAttentionRow[];
    let checkingCount = 0;
    let manualConfirmationCount = 0;
    let historyRecoveryCount = 0;
    const items: BulkMessageAttentionItem[] = [];
    const batches = new Map<string, BulkMessageAttentionBatch>();

    for (const row of rows) {
      const phase = phaseOf(row);
      if (phase === "checking") checkingCount += 1;
      else if (phase === "manual_confirmation") manualConfirmationCount += 1;
      else historyRecoveryCount += 1;

      const applicantId = nullableNumber(row.applicant_id);
      const jobId = nullableNumber(row.job_id);
      const purpose = nullableText(row.effective_purpose);
      if (applicantId !== null) {
        items.push({
          batchId: String(row.batch_id ?? ""),
          applicantId,
          jobId,
          purpose,
          phase,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }

      const batchId = String(row.batch_id ?? "");
      if (!batchId) continue;
      const batch = batches.get(batchId) ?? {
        batchId,
        jobId,
        purpose,
        applicantIds: [],
        totalCount: 0,
        checkingCount: 0,
        manualConfirmationCount: 0,
        historyRecoveryCount: 0,
        oldestCreatedAt: row.created_at,
      };
      batch.totalCount += 1;
      if (phase === "checking") batch.checkingCount += 1;
      else if (phase === "manual_confirmation") batch.manualConfirmationCount += 1;
      else batch.historyRecoveryCount += 1;
      if (applicantId !== null && !batch.applicantIds.includes(applicantId)) {
        batch.applicantIds.push(applicantId);
      }
      batches.set(batchId, batch);
    }

    const oldestCreatedAt = rows[0]?.created_at ?? null;
    const oldestTime = oldestCreatedAt ? new Date(oldestCreatedAt).getTime() : Number.NaN;

    return {
      state: "ready",
      items,
      batches: [...batches.values()],
      batchCount: batches.size,
      totalCount: count,
      checkingCount,
      manualConfirmationCount,
      historyRecoveryCount,
      oldestCreatedAt,
      oldestAgeMinutes: Number.isFinite(oldestTime)
        ? Math.max(0, Math.floor((now - oldestTime) / 60_000))
        : null,
      truncated: count > rows.length,
    };
  } catch (error) {
    console.error("[bulk-message-attention] query failed", error);
    return { ...EMPTY_ERROR_COLLECTION };
  }
}

export function bulkMessageAttentionPresentation(
  collection: BulkMessageAttentionCollection,
): BulkMessageAttentionPresentation | null {
  if (collection.state === "error") {
    return {
      state: "error",
      title: "문자 발송 상태 확인 실패",
      description: "발송 결과를 확인할 수 없습니다. 확인될 때까지 같은 문자를 다시 보내지 마세요.",
      path: "/pipeline?bulk_attention=1",
      tone: "red",
      urgency: "critical",
      priorityLabel: "조회 실패",
      resendAllowed: false,
      actions: [],
    };
  }
  if (!collection.totalCount) return null;

  const batches = `${collection.batchCount}${collection.truncated ? "개 이상" : "개"}`;
  const phaseSummary = [
    collection.manualConfirmationCount > 0
      ? `수동 확인 ${collection.manualConfirmationCount}`
      : null,
    collection.checkingCount > 0 ? `자동 확인 ${collection.checkingCount}` : null,
    collection.historyRecoveryCount > 0
      ? `기록 복구 ${collection.historyRecoveryCount}`
      : null,
  ].filter(Boolean).join(" · ");
  const needsManualConfirmation = collection.manualConfirmationCount > 0;

  return {
    state: "ready",
    title: `문자 발송 묶음 ${batches} 확인 필요`,
    description: `발송 ${collection.totalCount}건${phaseSummary ? ` · ${collection.truncated ? "표시분 " : ""}${phaseSummary}` : ""}. 같은 문자는 자동 재발송하지 않습니다.`,
    path: "/pipeline?bulk_attention=1",
    tone: needsManualConfirmation ? "red" : "amber",
    urgency: needsManualConfirmation ? "critical" : "attention",
    priorityLabel: needsManualConfirmation ? "수동 확인" : "복구 진행",
    resendAllowed: false,
    actions: [],
  };
}
