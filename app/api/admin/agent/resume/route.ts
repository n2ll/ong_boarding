/**
 * POST /api/admin/agent/resume
 *
 * 매니저 인계(paused) 상태 후보의 AI 응답을 재개.
 * 매니저가 명시적으로 버튼 클릭 시 호출.
 *
 * 효과:
 *  - job_candidates.agent_stage를 paused_from_stage(없으면 'exploration')로 복귀
 *  - paused_reason null
 *  - 이 시점 이후 들어오는 후보 답장부터 router가 AI를 다시 호출
 *
 * body: { applicant_id: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { applicant_id } = await req.json();
    if (!applicant_id) {
      return NextResponse.json(
        { error: "applicant_id는 필수입니다." },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();
    const { data: jc } = await supabase
      .from("job_candidates")
      .select("id, agent_stage, agent_state")
      .eq("applicant_id", applicant_id)
      .not("agent_stage", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!jc) {
      return NextResponse.json(
        { error: "활성 job_candidate를 찾을 수 없습니다." },
        { status: 404 }
      );
    }
    if (jc.agent_stage !== "paused") {
      return NextResponse.json(
        { error: `현재 stage='${jc.agent_stage}'라 재개 대상이 아닙니다.` },
        { status: 400 }
      );
    }

    const meta = (jc.agent_state as { meta?: { paused_from_stage?: string } } | null)?.meta;
    const restoreStage = (meta?.paused_from_stage as string | undefined) || "exploration";

    const { error } = await supabase
      .from("job_candidates")
      .update({
        agent_stage: restoreStage,
        paused_reason: null,
      })
      .eq("id", jc.id);

    if (error) {
      console.error("[agent/resume] update error", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, restored_stage: restoreStage });
  } catch (err) {
    console.error("[agent/resume] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
