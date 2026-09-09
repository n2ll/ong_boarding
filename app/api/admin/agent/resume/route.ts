/** 매니저가 명시적으로 재개. reply_to_latest=true일 때만 기존 대기 문자까지 처리한다. */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { resolveCandidateTarget } from "@/lib/agent/candidate-target";
import { loadPendingAgentReply } from "@/lib/agent/pending-reply";
import { getAgentMode } from "@/lib/agent/kill-switch";
import { runAgentForCandidate } from "@/lib/agent/router";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { applicant_id, job_id, reply_to_latest, inbound_message_id } = await req.json();
    const applicantId = Number(applicant_id);
    const jobId = job_id == null ? null : Number(job_id);
    if (!Number.isSafeInteger(applicantId) || applicantId <= 0 ||
      (jobId !== null && (!Number.isSafeInteger(jobId) || jobId <= 0)) ||
      (reply_to_latest !== undefined && typeof reply_to_latest !== "boolean") ||
      (inbound_message_id !== undefined && (typeof inbound_message_id !== "string" || !inbound_message_id.trim()))) {
      return NextResponse.json({ error: "지원자·공고와 재개 요청을 확인해 주세요." }, { status: 400 });
    }
    const supabase = createServiceClient();
    const target = await resolveCandidateTarget(supabase, applicantId, jobId, { want: "paused" });
    if (!target.ok) {
      return NextResponse.json(target.reason === "ambiguous"
        ? { error: "진행 중인 공고가 여러 개예요 — 어느 공고인지 골라 주세요.", code: "ambiguous_job", options: target.options }
        : { error: "재개할 공고가 없어요 — 중단된 공고 후보가 없습니다." },
      { status: target.reason === "ambiguous" ? 409 : 404 });
    }
    const snapshot = await supabase.from("job_candidates")
      .select("id, job_id, agent_stage, agent_state, paused_reason, updated_at")
      .eq("id", target.candidate.id).eq("applicant_id", applicantId).eq("agent_stage", "paused").maybeSingle();
    if (snapshot.error) return NextResponse.json({ error: "현재 중단 상태를 확인하지 못했어요." }, { status: 503 });
    const jc = snapshot.data;
    if (!jc) return NextResponse.json({ error: "이미 상태가 바뀌었어요. 새로고침해 주세요." }, { status: 409 });
    const savedStage = (jc.agent_state as { meta?: { paused_from_stage?: string } } | null)?.meta?.paused_from_stage;
    const restoreStage = savedStage && ["exploration", "screening", "onboarding", "active"].includes(savedStage) ? savedStage : "exploration";

    let pending: { id: string; body: string; created_at: string } | null = null;
    if (reply_to_latest === true) {
      const checked = await loadPendingAgentReply(supabase, applicantId, inbound_message_id, true);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 409 });
      pending = checked.message;
      const mode = await getAgentMode(supabase, { applicantId, jobIds: [jc.job_id], receivedAt: pending.created_at }, true);
      if (mode !== "auto") return NextResponse.json({ error: "이 지원자·공고·수신 시각은 현재 자동 응대 범위에 포함되지 않아요." }, { status: 409 });
    }

    const resumedAt = new Date().toISOString();
    const resumed = await supabase.from("job_candidates")
      .update({ agent_stage: restoreStage, paused_reason: null, updated_at: resumedAt })
      .eq("id", jc.id).eq("agent_stage", "paused").eq("updated_at", jc.updated_at)
      .select("id, updated_at").maybeSingle();
    if (resumed.error) return NextResponse.json({ error: "재개 상태를 저장하지 못했어요." }, { status: 503 });
    if (!resumed.data) return NextResponse.json({ error: "다른 요청으로 상태가 바뀌었어요. 중복 재개하지 않았어요." }, { status: 409 });
    if (!pending) return NextResponse.json({ success: true, restored_stage: restoreStage });

    const result = await runAgentForCandidate({
      supabase, candidate_id: jc.id, inbound_message_id: pending.id,
      inbound_text: pending.body, received_at: pending.created_at, onlyIfUnanswered: true,
    });
    if (result.delivery_uncertain) {
      return NextResponse.json({ error: "발송 결과를 확인 중이에요. 중복 방지를 위해 다시 처리하지 마세요.", delivery_uncertain: true }, { status: 503 });
    }
    if (result.reply_sent || (result.auto_sent_messages ?? 0) > 0) return NextResponse.json({ success: true, reply_sent: true, restored_stage: result.next_stage ?? restoreStage });

    // 라우터가 새 인계 사유나 응대 상태를 저장했다면 덮어쓰지 않는다.
    const rollback = await supabase.from("job_candidates")
      .update({ agent_stage: "paused", paused_reason: jc.paused_reason, updated_at: new Date().toISOString() })
      .eq("id", jc.id).eq("agent_stage", restoreStage).eq("updated_at", resumed.data.updated_at)
      .select("id").maybeSingle();
    if (rollback.error) console.error("[agent/resume] pause restore failed", rollback.error);
    return NextResponse.json({ error: result.skipped || "자동 답장을 보내지 못했어요. 대화의 검토 사유를 확인해 주세요.", reply_sent: false }, { status: 409 });
  } catch (err) {
    console.error("[agent/resume] exception", err);
    return NextResponse.json({ error: "처리 결과를 확인하지 못했어요. 대화를 새로고침하고 발송 여부를 확인해 주세요." }, { status: 503 });
  }
}
