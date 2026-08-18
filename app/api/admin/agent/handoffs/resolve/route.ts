/**
 * POST /api/admin/agent/handoffs/resolve
 *
 * 인계 큐(사람 확인 필요)의 '처리 완료' — 매니저가 전화·문자로 직접 해결한 건을 큐에서 내보낸다.
 *
 * 왜 필요한가: 큐 조건이 agent_stage='paused' 하나뿐이라, 매니저가 전화로 해결해도
 * 카드가 그대로 남아 방치 일수만 계속 올랐다(실측 30일·22일). 유일한 탈출구가
 * 'AI 재개'였는데 그건 방금 통화한 사람에게 봇을 다시 붙이는 동작이라 아무도 누르지
 * 않았고, 큐가 줄지 않는 이유가 게으름이 아니라 **출구 부재**였다(2026-08-14 감사).
 *
 * 효과:
 *  - agent_stage는 'paused' **그대로** — AI는 계속 정지. 사람이 이어받은 대화에
 *    봇이 다시 끼어들지 않는다(재개하고 싶으면 'AI 재개' 버튼이 따로 있다).
 *  - agent_state.meta.handoff_resolved = { at, outcome, note } 기록
 *    → 인계 큐 GET이 이 표식을 보고 목록에서 제외한다.
 *  - pool_events에 handoff_resolved 이벤트 insert → 대화 타임라인에 시스템 칩으로 남아
 *    "언제 누가 어떻게 처리했는지"를 다음 사람이 볼 수 있다. 통화 결과가 처음으로
 *    제품 안에 기록된다(예전엔 자유 텍스트 note뿐이라 유선면접이 제품 밖에 있었다).
 *
 * 이후 이 지원자가 새 답장을 보내면: stage가 paused라 AI는 답하지 않고,
 * '내가 답할 차례'(미답) 큐에 뜬다. 인계 큐에 다시 들어오지는 않는다 —
 * 다시 넣으려면 에이전트가 pause를 새로 emit해야 한다(의도된 동작).
 *
 * body: { candidate_id: number, outcome: 'call' | 'sms' | 'closed', note?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const OUTCOMES = new Set(["call", "sms", "closed"]);

export async function POST(req: NextRequest) {
  try {
    const { candidate_id, outcome, note } = await req.json();
    if (!candidate_id || !Number.isFinite(Number(candidate_id))) {
      return NextResponse.json({ error: "candidate_id는 필수입니다." }, { status: 400 });
    }
    if (!OUTCOMES.has(String(outcome))) {
      return NextResponse.json({ error: "outcome은 call/sms/closed 중 하나여야 합니다." }, { status: 400 });
    }

    const supabase = createServiceClient();
    const { data: jc, error: jcErr } = await supabase
      .from("job_candidates")
      .select("id, applicant_id, job_id, agent_stage, agent_state, paused_reason")
      .eq("id", Number(candidate_id))
      .maybeSingle();
    if (jcErr) {
      console.error("[handoffs/resolve] fetch", jcErr);
      return NextResponse.json({ error: jcErr.message }, { status: 500 });
    }
    if (!jc) return NextResponse.json({ error: "해당 인계 건이 없습니다." }, { status: 404 });
    if (jc.agent_stage !== "paused") {
      return NextResponse.json(
        { error: `현재 stage='${jc.agent_stage}'라 인계 상태가 아닙니다.` },
        { status: 400 }
      );
    }

    const state = (jc.agent_state as Record<string, unknown> | null) ?? {};
    const meta = (state.meta as Record<string, unknown> | undefined) ?? {};
    const resolvedNote = typeof note === "string" ? note.trim().slice(0, 300) : "";
    const nextState = {
      ...state,
      meta: {
        ...meta,
        handoff_resolved: {
          at: new Date().toISOString(),
          outcome: String(outcome),
          ...(resolvedNote ? { note: resolvedNote } : {}),
        },
      },
    };

    const { error: upErr } = await supabase
      .from("job_candidates")
      .update({ agent_state: nextState })
      .eq("id", jc.id);
    if (upErr) {
      console.error("[handoffs/resolve] update", upErr);
      return NextResponse.json({ error: upErr.message }, { status: 500 });
    }

    // 타임라인 기록 — 실패해도 처리 완료 자체는 성공으로 둔다(부가 기록).
    const { error: evErr } = await supabase.from("pool_events").insert({
      applicant_id: jc.applicant_id,
      job_id: jc.job_id,
      event_type: "handoff_resolved",
      meta: {
        outcome: String(outcome),
        ...(resolvedNote ? { note: resolvedNote } : {}),
        ...(jc.paused_reason ? { paused_reason: jc.paused_reason } : {}),
      },
    });
    if (evErr) console.error("[handoffs/resolve] pool_events", evErr);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[handoffs/resolve] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
