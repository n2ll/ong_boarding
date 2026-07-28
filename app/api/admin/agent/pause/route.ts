/**
 * POST /api/admin/agent/pause
 *
 * 매니저가 명시적으로 AI 응답을 중단시킨다 (수동 인계).
 *
 * 효과:
 *  - job_candidates.agent_stage를 'paused'로
 *  - meta.paused_from_stage = 현재 stage (재개 시 이 stage로 복귀)
 *  - paused_reason = '매니저 수동 일시정지'
 *  - 이 시점 이후 인입되는 후보 답장은 AI 호출 없이 통과 (매니저 직접 응대)
 *
 * 재개는 /api/admin/agent/resume.
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
      { want: "active" }
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
        { error: "AI가 응대 중인 공고가 없어요 — 이미 중단됐거나 아직 시작되지 않았어요." },
        { status: 404 }
      );
    }
    if (jc.agent_stage === "paused") {
      return NextResponse.json(
        { error: "이미 일시정지 상태입니다." },
        { status: 400 }
      );
    }
    if (jc.agent_stage === "abort") {
      return NextResponse.json(
        { error: "종료(abort) 상태라 일시정지할 수 없습니다." },
        { status: 400 }
      );
    }

    const prevState = (jc.agent_state ?? {}) as Record<string, unknown>;
    const prevMeta = (prevState.meta ?? {}) as Record<string, unknown>;
    const mergedState = {
      ...prevState,
      meta: {
        ...prevMeta,
        paused_from_stage: jc.agent_stage,
        paused_at: new Date().toISOString(),
      },
    };

    const { error } = await supabase
      .from("job_candidates")
      .update({
        agent_stage: "paused",
        agent_state: mergedState,
        paused_reason: "매니저 수동 일시정지",
      })
      .eq("id", jc.id);

    if (error) {
      console.error("[agent/pause] update error", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, paused_from_stage: jc.agent_stage });
  } catch (err) {
    console.error("[agent/pause] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
