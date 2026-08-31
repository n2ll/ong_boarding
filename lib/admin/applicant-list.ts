import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";

const APPLICANT_ID_BATCH_SIZE = 200;

export type ApplicantListRow = { id: number } & Record<string, unknown>;

export type ApplicantCandidateRow = {
  id: number;
  applicant_id: number;
  agent_stage: string | null;
  created_at: string | null;
  updated_at: string | null;
  jobs: unknown;
};

/** 목록 필터와 안정 정렬을 매 페이지에 다시 적용해 PostgREST 상한 뒤 행까지 읽는다. */
export async function fetchCompleteApplicantRows(
  supabase: Pick<SupabaseClient, "from">,
  scope: { columns: string; source: string | null },
): Promise<ApplicantListRow[]> {
  return fetchAllPostgrestRows(async (from, to) => {
    let query = supabase
      .from("applicants")
      .select(scope.columns)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (scope.source) query = query.eq("source", scope.source);

    const result = await query.range(from, to);
    return {
      data: result.data as ApplicantListRow[] | null,
      error: result.error,
    };
  }, "지원자 목록");
}

/** 긴 지원자 ID 필터를 나누고 각 묶음도 끝까지 읽어 단계 조립의 조용한 누락을 막는다. */
export async function fetchCompleteApplicantCandidateRows(
  supabase: Pick<SupabaseClient, "from">,
  applicantIds: number[],
): Promise<ApplicantCandidateRow[]> {
  const uniqueIds = Array.from(new Set(applicantIds.filter(Number.isFinite)));
  const batches: number[][] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += APPLICANT_ID_BATCH_SIZE) {
    batches.push(uniqueIds.slice(offset, offset + APPLICANT_ID_BATCH_SIZE));
  }

  const rowsByBatch = await Promise.all(batches.map((idBatch) =>
    fetchAllPostgrestRows(async (from, to) => {
      const result = await supabase
        .from("job_candidates")
        .select("id, applicant_id, agent_stage, created_at, updated_at, jobs:job_id ( title, client:clients ( client_type ) )")
        .in("applicant_id", idBatch)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
      return {
        data: result.data as unknown as ApplicantCandidateRow[] | null,
        error: result.error,
      };
    }, "지원자 공고 단계")
  ));

  return rowsByBatch.flat();
}
