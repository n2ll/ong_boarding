import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";

export type MessageHistoryRow = Record<string, unknown> & {
  id: string;
  direction: string | null;
  job_id: number | null;
};

type MessageHistoryScope = {
  applicantId: number;
  applicantPhone: string | null;
  jobId: number | null;
};

/** 지원자·공고 범위를 유지하며 PostgREST 행 상한 이후까지 대화를 완전히 읽는다. */
export async function fetchCompleteMessageHistory(
  supabase: Pick<SupabaseClient, "from">,
  { applicantId, applicantPhone, jobId }: MessageHistoryScope,
): Promise<MessageHistoryRow[]> {
  return fetchAllPostgrestRows(async (from, to) => {
    let query = supabase
      .from("messages")
      .select("*");

    if (applicantPhone) {
      query = query.or(`applicant_id.eq.${applicantId},applicant_phone.eq.${applicantPhone}`);
    } else {
      query = query.eq("applicant_id", applicantId);
    }
    if (jobId !== null) {
      query = query.or(`job_id.eq.${jobId},job_id.is.null`);
    }

    const result = await query
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    return {
      data: result.data as MessageHistoryRow[] | null,
      error: result.error,
    };
  }, "메시지 대화");
}
