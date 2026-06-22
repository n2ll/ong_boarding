/**
 * 당근 후보 처리용 시스템 더미 공고.
 *
 * 당근 후보는 매니저가 직접 모집한 사람이라 공고 단위 칸반과 무관하지만,
 * 인입 라우터(router.ts)가 job_candidates row를 통해 stage를 dispatch한다.
 * 그 row를 만들려면 job_id가 있어야 하므로 시스템이 1개만 보장하는 더미 row를 만든다.
 *
 * 식별자: title === DANGGEUN_SYSTEM_JOB_TITLE
 *   - /api/admin/jobs GET에서 필터링되어 칸반·기타 UI에 노출되지 않음.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const DANGGEUN_SYSTEM_JOB_TITLE = "__danggeun_system__";

export async function ensureDanggeunSystemJob(
  supabase: SupabaseClient
): Promise<number> {
  const { data: existing, error: selectErr } = await supabase
    .from("jobs")
    .select("id")
    .eq("title", DANGGEUN_SYSTEM_JOB_TITLE)
    .limit(1)
    .maybeSingle();

  if (selectErr) {
    throw new Error(`당근 시스템 공고 조회 실패: ${selectErr.message}`);
  }
  if (existing?.id) return existing.id as number;

  const { data: inserted, error: insertErr } = await supabase
    .from("jobs")
    .insert({
      title: DANGGEUN_SYSTEM_JOB_TITLE,
      body: "당근 유입 후보 처리용 시스템 공고 (매니저 UI에 노출되지 않음)",
      branch: null,
      slot: null,
      start_date: null,
      vehicle_required: false,
      capacity: 9999,
      status: "active",
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    throw new Error(`당근 시스템 공고 생성 실패: ${insertErr?.message}`);
  }
  return inserted.id as number;
}
