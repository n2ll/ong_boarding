import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { sendSms } from "@/lib/solapi";
import { COPILOT_DRAFT_MARKER } from "@/lib/agent/kill-switch";

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
    const { applicant_id, phone, body, sent_by, draft_id, draft_was_edited, job_id } = await req.json();
    // 매니저 답장의 공고 컨텍스트 — 스레드 job_id 필터·인계 큐 매칭이 어긋나지 않게 함께 저장.
    const jobId: number | null = typeof job_id === "number" && Number.isFinite(job_id) ? job_id : null;

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
        job_id: jobId,
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

    // 코파일럿 초안 승인 여부 — 초안 reasoning의 마커로 판정.
    // 코파일럿 모드에서는 발송 주체가 매니저(승인)여도 대화는 계속 'AI 초안 → 매니저 승인' 루프에
    // 있어야 하므로 아래 자동 pause 전이를 건너뛴다(전이하면 다음 인입부터 초안이 안 생긴다).
    let isCopilotDraftApproval = false;
    if (draft_id) {
      const { data: d } = await supabase
        .from("message_drafts")
        .select("reasoning")
        .eq("id", draft_id)
        .maybeSingle();
      isCopilotDraftApproval = ((d?.reasoning as string | null) ?? "").startsWith(COPILOT_DRAFT_MARKER);
    }

    // 매니저 수동 발송이면 AI 자동 응답을 끄기 위해 paused로 전이.
    // 매니저와 AI가 같은 후보에게 동시에 응답하는 충돌 방지.
    const isManagerSend = !AGENT_OR_SYSTEM_SENT_BY.has(sent_by ?? "") && !isCopilotDraftApproval;
    if (isManagerSend && applicant_id) {
      // 전이 대상 후보: 발송된 공고(job_id)의 후보를 우선, 없으면 최신 활성 후보로 폴백.
      let jc: { id: number; agent_stage: string | null; agent_state: unknown } | null = null;
      if (jobId != null) {
        const { data } = await supabase
          .from("job_candidates")
          .select("id, agent_stage, agent_state")
          .eq("applicant_id", applicant_id)
          .eq("job_id", jobId)
          .not("agent_stage", "is", null)
          .neq("agent_stage", "paused")
          .neq("agent_stage", "abort")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        jc = data;
      }
      if (!jc) {
        const { data } = await supabase
          .from("job_candidates")
          .select("id, agent_stage, agent_state")
          .eq("applicant_id", applicant_id)
          .not("agent_stage", "is", null)
          .neq("agent_stage", "paused")
          .neq("agent_stage", "abort")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        jc = data;
      }
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
