/**
 * 배민 후보 처리용 시스템 더미 공고.
 *
 * 배민 지원자는 본인이 먼저 SMS를 보내며 시작하는 흐름이지만,
 * 인입 라우터(router.ts)가 job_candidates row를 통해 stage를 dispatch하므로
 * job_id가 필요한 더미 row를 시스템이 1개만 보장해서 만든다.
 *
 * 식별자: title === BAEMIN_SYSTEM_JOB_TITLE
 *   - 칸반·기타 UI에는 노출 안 됨 (당근 시스템 공고와 동일 패턴).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const BAEMIN_SYSTEM_JOB_TITLE = "__baemin_system__";

export async function ensureBaeminSystemJob(
  supabase: SupabaseClient
): Promise<number> {
  const { data: existing, error: selectErr } = await supabase
    .from("jobs")
    .select("id")
    .eq("title", BAEMIN_SYSTEM_JOB_TITLE)
    .limit(1)
    .maybeSingle();

  if (selectErr) {
    throw new Error(`배민 시스템 공고 조회 실패: ${selectErr.message}`);
  }
  if (existing?.id) return existing.id as number;

  const { data: inserted, error: insertErr } = await supabase
    .from("jobs")
    .insert({
      title: BAEMIN_SYSTEM_JOB_TITLE,
      body: "배민 유입 후보 처리용 시스템 공고 (매니저 UI에 노출되지 않음)",
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
    throw new Error(`배민 시스템 공고 생성 실패: ${insertErr?.message}`);
  }
  return inserted.id as number;
}
