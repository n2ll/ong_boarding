import type { SupabaseClient } from "@supabase/supabase-js";

export type ManualMessageAttentionPhase =
  | "checking"
  | "manual_confirmation"
  | "history_recovery";

export interface ManualMessageAttentionItem {
  applicantId: number;
  jobId: number | null;
  phase: ManualMessageAttentionPhase;
  createdAt: string;
  updatedAt: string;
}

export interface ManualMessageAttentionCollection {
  state: "ready" | "error";
  items: ManualMessageAttentionItem[];
  totalCount: number | null;
  truncated: boolean;
}

export interface ManualMessageAttentionPresentation {
  badgeLabel: string;
  count: number;
  primaryPhase: ManualMessageAttentionPhase;
  description: string;
  resendAllowed: false;
  actions: readonly [];
}

export function manualMessageAttentionRemoteState(
  parentState: "loading" | "error" | "empty" | "ready",
  collection: ManualMessageAttentionCollection | undefined,
): "loading" | "ready" | "error" {
  if (parentState === "error") return "error";
  if (parentState === "loading") return "loading";
  return collection?.state ?? "error";
}

interface ManualMessageAttentionRow {
  applicant_id: number | null;
  job_id: number | null;
  status: string;
  provider_correlation_attached: boolean;
  provider_reconcile_status: string;
  created_at: string;
  updated_at: string;
}

const DEFAULT_ATTENTION_LIMIT = 500;
const MAX_ATTENTION_LIMIT = 1_000;
const ACTIVE_OUTBOX_STATUSES = ["sending", "unknown", "sent"];

function normalizedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ATTENTION_LIMIT;
  return Math.min(MAX_ATTENTION_LIMIT, Math.max(1, Math.floor(value)));
}

function phaseOf(row: ManualMessageAttentionRow): ManualMessageAttentionPhase {
  if (row.status === "sent") return "history_recovery";
  if (
    row.provider_correlation_attached === true
    && row.provider_reconcile_status === "pending"
  ) {
    return "checking";
  }
  return "manual_confirmation";
}

/**
 * 재발송하면 안 되는 수동 SMS outbox만 최소 필드로 읽는다.
 * 조회 실패와 cap 도달을 빈 목록으로 숨기지 않아 관리 화면이 거짓 0건을 만들지 않는다.
 */
export async function loadManualMessageAttention(
  supabase: SupabaseClient,
  options: { applicantId?: number; limit?: number } = {},
): Promise<ManualMessageAttentionCollection> {
  const limit = normalizedLimit(options.limit);

  try {
    let query = supabase
      .from("manual_message_send_requests")
      .select(
        "applicant_id, job_id, status, provider_correlation_attached, provider_reconcile_status, created_at, updated_at",
        { count: "exact" },
      )
      .in("status", ACTIVE_OUTBOX_STATUSES);

    if (typeof options.applicantId === "number" && Number.isFinite(options.applicantId)) {
      query = query.eq("applicant_id", options.applicantId);
    }

    const { data, error, count } = await query
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) {
      console.error("[manual-message-attention] query failed", error);
      return { state: "error", items: [], totalCount: null, truncated: false };
    }

    const rows = (data ?? []) as ManualMessageAttentionRow[];
    const items = rows.flatMap((row): ManualMessageAttentionItem[] => {
      if (typeof row.applicant_id !== "number" || !Number.isFinite(row.applicant_id)) return [];
      return [{
        applicantId: row.applicant_id,
        jobId: typeof row.job_id === "number" && Number.isFinite(row.job_id) ? row.job_id : null,
        phase: phaseOf(row),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }];
    });
    const totalCount = typeof count === "number" ? count : null;

    return {
      state: "ready",
      items,
      totalCount,
      truncated: totalCount !== null ? totalCount > items.length : rows.length >= limit,
    };
  } catch (error) {
    console.error("[manual-message-attention] query failed", error);
    return { state: "error", items: [], totalCount: null, truncated: false };
  }
}

export function indexManualMessageAttention(
  items: ManualMessageAttentionItem[],
): Map<number, ManualMessageAttentionItem[]> {
  const indexed = new Map<number, ManualMessageAttentionItem[]>();
  for (const item of items) {
    const existing = indexed.get(item.applicantId);
    if (existing) existing.push(item);
    else indexed.set(item.applicantId, [item]);
  }
  return indexed;
}

const PHASE_PRIORITY: Record<ManualMessageAttentionPhase, number> = {
  manual_confirmation: 3,
  checking: 2,
  history_recovery: 1,
};

const PHASE_DESCRIPTION: Record<ManualMessageAttentionPhase, string> = {
  manual_confirmation: "자동 확인으로 발송 결과를 확정하지 못했습니다. 중복 발송을 막기 위해 다시 보내지 않습니다.",
  checking: "발송 결과를 자동으로 확인 중입니다. 중복 발송을 막기 위해 다시 보내지 않습니다.",
  history_recovery: "발송은 접수됐지만 대화 기록을 복구 중입니다. 같은 문자를 다시 보내지 않습니다.",
};

export function manualMessageAttentionPresentation(
  items: ManualMessageAttentionItem[],
): ManualMessageAttentionPresentation | null {
  if (items.length === 0) return null;

  const primaryPhase = items.reduce<ManualMessageAttentionPhase>((primary, item) => (
    PHASE_PRIORITY[item.phase] > PHASE_PRIORITY[primary] ? item.phase : primary
  ), items[0].phase);

  return {
    badgeLabel: "발송 확인 필요",
    count: items.length,
    primaryPhase,
    description: PHASE_DESCRIPTION[primaryPhase],
    resendAllowed: false,
    actions: [],
  };
}
