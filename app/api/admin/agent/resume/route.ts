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
import { resolveCandidateTarget } from "@/lib/agent/candidate-target";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { applicant_id, job_id } = await req.json();
    if (!applicant_id) {
      return NextResponse.json(
        { error: "applicant_id는 필수입니다." },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();
    // 대상 후보 판정은 공동 함수로(lib/agent/candidate-target) — 공고를 명시하면 그 공고만 보고,
    // 명시하지 않았는데 대상이 여러 개면 아무 것도 건드리지 않고 골라 달라고 되돌린다.
    // (예전엔 '없으면 최신 후보' 폴백이라 엉뚱한 공고의 AI를 끄고, 그 뒤 재개가 400으로 실패했다.)
    const target = await resolveCandidateTarget(
      supabase,
      Number(applicant_id),
      job_id != null && Number.isFinite(Number(job_id)) ? Number(job_id) : null,
      { want: "paused" }
    );
    if (!target.ok && target.reason === "ambiguous") {
      return NextResponse.json(
        {
          error: "진행 중인 공고가 여러 개예요 — 어느 공고인지 골라 주세요.",
          code: "ambiguous_job",
          options: target.options,
        },
        { status: 409 }
      );
    }
    const jc = target.ok ? target.candidate : null;

    if (!jc) {
      return NextResponse.json(
        { error: "재개할 공고가 없어요 — 중단된 공고 후보가 없습니다." },
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
