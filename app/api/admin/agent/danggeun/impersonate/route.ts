/**
 * POST /api/admin/agent/danggeun/impersonate
 *
 * 매니저가 "지원자로 빙의"해서 보낸 메시지를 inbound로 기록 + router 호출.
 * 실 SMS 발송 X. 매니저 테스트용.
 *
 * body: { applicant_id: number, text: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { runAgentForCandidate } from "@/lib/agent/router";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { applicant_id, text } = await req.json();
    if (!applicant_id || !text?.trim()) {
      return NextResponse.json(
        { error: "applicant_id, text는 필수입니다." },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();
    const receivedAt = new Date().toISOString();

    const { data: applicant } = await supabase
      .from("applicants")
      .select("id, phone, source")
      .eq("id", applicant_id)
      .single();

    if (!applicant) {
      return NextResponse.json({ error: "지원자를 찾을 수 없습니다." }, { status: 404 });
    }

    // 가장 최근 활성 job_candidate
    const { data: jc } = await supabase
      .from("job_candidates")
      .select("id, job_id, agent_stage, responded_at")
      .eq("applicant_id", applicant.id)
      .not("agent_stage", "is", null)
      .neq("agent_stage", "abort")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // inbound 메시지 INSERT
    const { data: inserted, error: insertErr } = await supabase
      .from("messages")
      .insert({
        applicant_id: applicant.id,
        applicant_phone: applicant.phone,
        direction: "inbound",
        body: text.trim(),
        status: "received",
        sent_by: "manager-impersonate",
        message_type: "sms",
        job_id: jc?.job_id ?? null,
        created_at: receivedAt,
      })
      .select("id")
      .single();

    if (insertErr || !inserted) {
      console.error("[impersonate] messages insert", insertErr);
      return NextResponse.json({ error: "메시지 저장 실패" }, { status: 500 });
    }

    // 첫 응답이면 responded_at 기록
    if (jc && !jc.responded_at) {
      await supabase
        .from("job_candidates")
        .update({ responded_at: receivedAt })
        .eq("id", jc.id);
    }

    // last_message_at 갱신 (unread_count는 빙의 모드라 증가 X — 매니저 본인이 보낸 거)
    await supabase
      .from("applicants")
      .update({ last_message_at: receivedAt })
      .eq("id", applicant.id);

    // job_candidate 없거나 paused/abort/onboarding이면 AI 호출 X
    if (!jc || !jc.agent_stage) {
      return NextResponse.json({
        ok: true,
        message_id: inserted.id,
        agent_invoked: false,
        reason: "no active job_candidate",
      });
    }
    if (
      jc.agent_stage === "paused" ||
      jc.agent_stage === "abort" ||
      jc.agent_stage === "onboarding"
    ) {
      return NextResponse.json({
        ok: true,
        message_id: inserted.id,
        agent_invoked: false,
        reason: `stage=${jc.agent_stage} — AI 호출 skip`,
      });
    }

    const isPractice = applicant.source === "danggeun_practice";
    const agentResult = await runAgentForCandidate({
      supabase,
      candidate_id: jc.id as number,
      inbound_message_id: inserted.id as string,
      inbound_text: text.trim(),
      simulate: isPractice,
    });

    return NextResponse.json({
      ok: true,
      message_id: inserted.id,
      agent_invoked: true,
      agent: agentResult,
    });
  } catch (err) {
    console.error("[impersonate] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
