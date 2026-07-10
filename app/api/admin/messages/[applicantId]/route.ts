import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { applicantId: string } }
) {
  try {
    const applicantId = parseInt(params.applicantId);
    if (isNaN(applicantId)) {
      return NextResponse.json(
        { error: "유효하지 않은 ID" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    // job_id 필터 (선택) — 구인 에이전트 탭에서 공고별 컨텍스트 분리용
    const url = new URL(req.url);
    const jobIdParam = url.searchParams.get("job_id");
    const jobIdFilter = jobIdParam ? Number(jobIdParam) : null;

    // 지원자 phone 번호 조회
    const { data: applicant } = await supabase
      .from("applicants")
      .select("phone")
      .eq("id", applicantId)
      .single();

    // applicant_id 또는 phone 번호로 대화 내역 조회 (트리거 미실행 대비)
    let messages;
    let error;

    // job_id 필터는 NULL도 함께 통과시킨다 — 캠페인 핑·과거 수동 발송 등 job_id 없는
    // 메시지가 공고 탭에서 사라져 "매니저 답장이 안 보이는" 문제 방지.
    if (applicant?.phone) {
      let q = supabase
        .from("messages")
        .select("*")
        .or(`applicant_id.eq.${applicantId},applicant_phone.eq.${applicant.phone}`)
        .order("created_at", { ascending: true });
      if (jobIdFilter !== null && Number.isFinite(jobIdFilter)) {
        q = q.or(`job_id.eq.${jobIdFilter},job_id.is.null`);
      }
      const result = await q;
      messages = result.data;
      error = result.error;
    } else {
      let q = supabase
        .from("messages")
        .select("*")
        .eq("applicant_id", applicantId)
        .order("created_at", { ascending: true });
      if (jobIdFilter !== null && Number.isFinite(jobIdFilter)) {
        q = q.or(`job_id.eq.${jobIdFilter},job_id.is.null`);
      }
      const result = await q;
      messages = result.data;
      error = result.error;
    }

    if (error) {
      console.error("[messages fetch error]", error);
      return NextResponse.json(
        { error: "메시지 조회 실패" },
        { status: 500 }
      );
    }

    // 안읽은 메시지 초기화
    await supabase
      .from("applicants")
      .update({ unread_count: 0 })
      .eq("id", applicantId);

    // 가장 최근 pending/need_info 초안 1건
    const { data: latestDraft } = await supabase
      .from("message_drafts")
      .select("id, inbound_message_id, draft_text, reasoning, missing_info, status, created_at")
      .eq("applicant_id", applicantId)
      .in("status", ["pending", "need_info"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // 메시지별 reasoning 매핑 — message_drafts.used_message_id 기준
    // (router.ts가 자동 발송 시 status='auto_sent'로 함께 insert함)
    const messagesList = messages ?? [];
    const outboundIds = messagesList
      .filter((m) => m.direction === "outbound")
      .map((m) => m.id);
    const reasoningByMessageId = new Map<string, string>();
    if (outboundIds.length > 0) {
      const { data: drafts } = await supabase
        .from("message_drafts")
        .select("used_message_id, reasoning")
        .in("used_message_id", outboundIds);
      for (const d of drafts ?? []) {
        if (d.used_message_id && d.reasoning) {
          reasoningByMessageId.set(d.used_message_id as string, d.reasoning as string);
        }
      }
    }
    const messagesWithReasoning = messagesList.map((m) => ({
      ...m,
      reasoning: m.direction === "outbound" ? reasoningByMessageId.get(m.id) ?? null : null,
    }));

    // 멀티-잡 인지(Phase 2 UX): 이 대화에 등장하는 공고 라벨 맵.
    // 한 지원자가 여러 공고를 동시 진행할 때, 말풍선에 "어느 공고 건"인지 칩으로 표시하기 위함.
    // 시스템 더미 공고(__ 접두)는 제외 → 칩 미표시.
    const jobIdsInThread = Array.from(
      new Set(messagesList.map((m) => m.job_id).filter((x): x is number => typeof x === "number"))
    );
    const jobsMap: Record<number, { title: string; branch: string | null }> = {};
    if (jobIdsInThread.length > 0) {
      const { data: jobRows } = await supabase
        .from("jobs")
        .select("id, title, branch")
        .in("id", jobIdsInThread);
      for (const j of jobRows ?? []) {
        if (typeof j.title === "string" && j.title.startsWith("__")) continue;
        jobsMap[j.id as number] = {
          title: (j.title as string) ?? "",
          branch: (j.branch as string | null) ?? null,
        };
      }
    }

    // 현재 후보의 agent_stage + agent_state (체크리스트)
    let agentStage: string | null = null;
    let agentState: Record<string, unknown> | null = null;
    const jcQuery = supabase
      .from("job_candidates")
      .select("agent_stage, agent_state, created_at")
      .eq("applicant_id", applicantId)
      .order("created_at", { ascending: false })
      .limit(1);
    const { data: jc } = jobIdFilter !== null && Number.isFinite(jobIdFilter)
      ? await jcQuery.eq("job_id", jobIdFilter).maybeSingle()
      : await jcQuery.maybeSingle();
    if (jc) {
      agentStage = (jc.agent_stage as string | null) ?? null;
      agentState = (jc.agent_state as Record<string, unknown> | null) ?? null;
    }

    return NextResponse.json({
      data: messagesWithReasoning,
      messages: messagesWithReasoning,
      draft: latestDraft || null,
      agent_stage: agentStage,
      agent_state: agentState,
      jobs: jobsMap,
    });
  } catch (err) {
    console.error("[messages API error]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
