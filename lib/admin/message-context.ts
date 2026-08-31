import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";

const REASONING_MESSAGE_ID_BATCH_SIZE = 50;

interface MessageDraftReasoningRow {
  id: string;
  used_message_id: string | null;
  reasoning: string | null;
}

export interface MessagePoolEventRow {
  id: number;
  event_type: string;
  job_id: number | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

/** 긴 UUID IN 필터를 작은 요청으로 나누고, 각 요청도 PostgREST 행 상한 이후까지 읽는다. */
export async function fetchReasoningByMessageIds(
  supabase: Pick<SupabaseClient, "from">,
  messageIds: string[],
): Promise<Map<string, string>> {
  const uniqueMessageIds = Array.from(new Set(messageIds.filter((id) => id.length > 0)));
  const rows: MessageDraftReasoningRow[] = [];

  for (let offset = 0; offset < uniqueMessageIds.length; offset += REASONING_MESSAGE_ID_BATCH_SIZE) {
    const idBatch = uniqueMessageIds.slice(offset, offset + REASONING_MESSAGE_ID_BATCH_SIZE);
    const batchRows = await fetchAllPostgrestRows(async (from, to) => {
      const result = await supabase
        .from("message_drafts")
        .select("id, used_message_id, reasoning")
        .in("used_message_id", idBatch)
        .order("used_message_id", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
      return {
        data: result.data as MessageDraftReasoningRow[] | null,
        error: result.error,
      };
    }, "메시지 판단 근거");
    rows.push(...batchRows);
  }

  const reasoningByMessageId = new Map<string, string>();
  for (const row of rows) {
    if (row.used_message_id && row.reasoning) {
      reasoningByMessageId.set(row.used_message_id, row.reasoning);
    }
  }
  return reasoningByMessageId;
}

/** 최근 재컨택 맥락을 안정 정렬하며 PostgREST 행 상한 이후까지 완전히 읽는다. */
export async function fetchRecentPoolEvents(
  supabase: Pick<SupabaseClient, "from">,
  scope: { applicantId: number; eventTypes: string[]; since: string },
): Promise<MessagePoolEventRow[]> {
  if (scope.eventTypes.length === 0) return [];

  return fetchAllPostgrestRows(async (from, to) => {
    const result = await supabase
      .from("pool_events")
      .select("id, event_type, job_id, meta, created_at")
      .eq("applicant_id", scope.applicantId)
      .in("event_type", scope.eventTypes)
      .gte("created_at", scope.since)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    return {
      data: result.data as MessagePoolEventRow[] | null,
      error: result.error,
    };
  }, "재컨택 이벤트");
}
