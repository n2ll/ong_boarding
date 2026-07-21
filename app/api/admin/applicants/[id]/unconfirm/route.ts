/**
 * POST /api/admin/applicants/[id]/unconfirm — 투입 확정 취소(되돌리기).
 *
 * 확정(status='확정인력')을 정정할 동선이 없어, 잘못된 공고로 확정하면 current_job_id·
 * confirmed_*·hired_at·start_date 잔재 + 그 공고 후보가 paused로 남아 AI가 재개되지 않던 문제 해소.
 *
 * 되돌리는 것(확정 commit의 대칭):
 *  - applicants: status→'스크리닝 완료', current_job_id·confirmed_branch·confirmed_slot·hired_at·start_date 클리어
 *  - 확정 대상 공고 후보: '투입 확정 — 매니저 인계'로 paused된 것을 screening으로 재개(AI 응대 복귀)
 * (확정 시 자동 abort된 '마감 공고 링크'는 어차피 죽은 링크라 되살리지 않는다.)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const supabase = createServiceClient();

  const { data: applicant, error } = await supabase
    .from("applicants")
    .select("id, status, current_job_id")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[unconfirm] load failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!applicant) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (applicant.status !== "확정인력") {
    return NextResponse.json({ error: "확정 상태가 아니에요." }, { status: 400 });
  }

  const targetJobId = applicant.current_job_id as number | null;

  const { error: upErr } = await supabase
    .from("applicants")
    .update({
      status: "스크리닝 완료",
      current_job_id: null,
      confirmed_branch: null,
      confirmed_slot: null,
      hired_at: null,
      start_date: null,
    })
    .eq("id", id);
  if (upErr) {
    console.error("[unconfirm] update failed", upErr);
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  // 확정으로 paused된 그 공고 후보 AI 재개 — 사람 단위가 아니라 그 공고 후보만(병행 라인 불간섭).
  if (targetJobId != null) {
    const { error: resumeErr } = await supabase
      .from("job_candidates")
      .update({ agent_stage: "screening", paused_reason: null })
      .eq("applicant_id", id)
      .eq("job_id", targetJobId)
      .eq("agent_stage", "paused")
      .like("paused_reason", "투입 확정%");
    if (resumeErr) console.error("[unconfirm] candidate resume failed", resumeErr);
  }

  return NextResponse.json({ success: true, resumed_job_id: targetJobId });
}
