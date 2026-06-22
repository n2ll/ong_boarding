import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { sendSms } from "@/lib/solapi";

// AI/시스템 자동 발송에 쓰는 sent_by 라벨 — 이 값들 이외는 모두 '매니저 수동 발송'으로 본다.
// 매니저 발송이면 AI 응답 충돌을 막기 위해 자동으로 paused 단계로 전이한다.
const AGENT_OR_SYSTEM_SENT_BY = new Set([
  "agent",
  "agent-practice",
  "system-auto",
  "danggeun-start",
  "baemin-start",
  "danggeun-practice-start",
  "danggeun-recommend",
]);

export async function POST(req: NextRequest) {
  try {
    const { applicant_id, phone, body, sent_by, draft_id, draft_was_edited } = await req.json();

    if (!phone || !body) {
      return NextResponse.json(
        { error: "phone과 body는 필수입니다." },
        { status: 400 }
      );
    }

    // 솔라피로 문자 발송
    const result = await sendSms(phone, body);
    if (!result.success) {
      return NextResponse.json(
        { error: "문자 발송 실패: " + result.error },
        { status: 500 }
      );
    }

    // messages 테이블에 저장
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("messages")
      .insert({
        applicant_id: applicant_id || null,
        applicant_phone: phone,
        direction: "outbound",
        body,
        status: "sent",
        sent_by: sent_by || "관리자",
        solapi_msg_id: result.messageId || null,
      })
      .select()
      .single();

    if (error) {
      console.error("[messages insert error]", error);
      return NextResponse.json(
        { error: "메시지 저장 실패" },
        { status: 500 }
      );
    }

    // 매니저 수동 발송이면 AI 자동 응답을 끄기 위해 paused로 전이.
    // 매니저와 AI가 같은 후보에게 동시에 응답하는 충돌 방지.
    const isManagerSend = !AGENT_OR_SYSTEM_SENT_BY.has(sent_by ?? "");
    if (isManagerSend && applicant_id) {
      const { data: jc } = await supabase
        .from("job_candidates")
        .select("id, agent_stage, agent_state")
        .eq("applicant_id", applicant_id)
        .not("agent_stage", "is", null)
        .neq("agent_stage", "paused")
        .neq("agent_stage", "abort")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (jc) {
        const prevState = (jc.agent_state ?? {}) as Record<string, unknown>;
        const prevMeta = (prevState.meta ?? {}) as Record<string, unknown>;
        await supabase
          .from("job_candidates")
          .update({
            agent_stage: "paused",
            paused_reason: "매니저 직접 응답 — 자동 인계",
            agent_state: {
              ...prevState,
              meta: {
                ...prevMeta,
                paused_from_stage: jc.agent_stage,
                paused_at: new Date().toISOString(),
                paused_by: "manager-send",
              },
            },
          })
          .eq("id", jc.id);
      }
    }

    // 사용된 draft 표시
    if (draft_id) {
      await supabase
        .from("message_drafts")
        .update({
          status: draft_was_edited ? "edited" : "used",
          used_message_id: data.id,
          resolved_at: new Date().toISOString(),
        })
        .eq("id", draft_id);
    } else if (applicant_id) {
      // draft_id 없이 매니저가 직접 입력한 경우 — 해당 지원자의 pending draft를 ignored 처리
      await supabase
        .from("message_drafts")
        .update({
          status: "ignored",
          resolved_at: new Date().toISOString(),
        })
        .eq("applicant_id", applicant_id)
        .in("status", ["pending", "need_info"]);
    }

    return NextResponse.json({ success: true, message: data });
  } catch (err) {
    console.error("[send message error]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
