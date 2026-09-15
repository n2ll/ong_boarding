import type { SupabaseClient } from "@supabase/supabase-js";
import { getHandoffDisposition } from "./handoff-disposition.ts";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";
import { REPLY_COMPLETED_EVENT, isReplyMessageId, type ReplyMessageId } from "./reply-completion.ts";

type LatestMessage = { applicant_id: number; message_id: ReplyMessageId };
type CompletionEvent = { applicant_id: number; meta: { message_id?: unknown } | null };
type Candidate = {
  applicant_id: number;
  paused_reason: string | null;
  agent_state: unknown;
  jobs: { title?: string } | null;
};

/** 한 ID 묶음의 업무 상태. 완료 이력과 모든 공고의 인계를 끝까지 읽어 부분 결과를 숨기지 않는다. */
export async function loadReplyCompletionStatus(
  db: SupabaseClient,
  latest: LatestMessage[],
): Promise<{ completed: Set<number>; handoffRequired: Set<number> }> {
  const completed = new Set<number>();
  const handoffRequired = new Set<number>();
  if (latest.length === 0) return { completed, handoffRequired };
  const ids = latest.map(row => row.applicant_id);
  const messageByApplicant = new Map(latest.map(row => [row.applicant_id, row.message_id]));
  const events = await fetchAllPostgrestRows<CompletionEvent>(async (from, to) => {
    const result = await db.from("pool_events")
      .select("id, applicant_id, meta")
      .eq("event_type", REPLY_COMPLETED_EVENT)
      .in("applicant_id", ids)
      .in("meta->>message_id", latest.map(row => String(row.message_id)))
      .order("id", { ascending: true })
      .range(from, to);
    return { data: result.data as CompletionEvent[] | null, error: result.error };
  }, "답장 처리 완료");
  for (const event of events) {
    if (isReplyMessageId(event.meta?.message_id)
      && messageByApplicant.get(event.applicant_id) === event.meta.message_id) completed.add(event.applicant_id);
  }

  const candidates = await fetchAllPostgrestRows<Candidate>(async (from, to) => {
    const result = await db.from("job_candidates")
      .select("id, applicant_id, paused_reason, agent_state, jobs:job_id ( title )")
      .in("applicant_id", ids)
      .eq("agent_stage", "paused")
      .order("id", { ascending: true })
      .range(from, to);
    return { data: result.data as unknown as Candidate[] | null, error: result.error };
  }, "매니저 인계");
  for (const candidate of candidates) {
    // 인계 API와 같은 집합: 마감/시스템 공고도 포함하되 실제 공고 연결이 없는 행은 제외한다.
    if (typeof candidate.jobs?.title !== "string") continue;
    if (getHandoffDisposition({ ...candidate, job_title: candidate.jobs.title }).state === "action_required") {
      handoffRequired.add(candidate.applicant_id);
    }
  }
  return { completed, handoffRequired };
}
