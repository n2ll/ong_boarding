import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import {
  selectPendingDraftForJob,
  shouldLoadCandidateAgentState,
} from "@/lib/admin/pending-draft-scope";
import { loadManualMessageAttention } from "@/lib/admin/manual-message-attention";
import { fetchCompleteMessageHistory } from "@/lib/admin/message-history";
import {
  fetchReasoningByMessageIds,
  fetchRecentPoolEvents,
} from "@/lib/admin/message-context";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ applicantId: string }> }
) {
  try {
    const routeParams = await params;
    const applicantId = parseInt(routeParams.applicantId);
    if (isNaN(applicantId)) {
      return NextResponse.json(
        { error: "유효하지 않은 ID" },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();
    const manualMessageAttentionPromise = loadManualMessageAttention(supabase, { applicantId });

    // job_id 필터 (선택) — 구인 에이전트 탭에서 공고별 컨텍스트 분리용
    const url = new URL(req.url);
    const jobIdParam = url.searchParams.get("job_id");
    const jobIdFilter = jobIdParam ? Number(jobIdParam) : null;
    if (jobIdParam !== null && (!Number.isSafeInteger(jobIdFilter) || (jobIdFilter ?? 0) <= 0)) {
      return NextResponse.json({ error: "유효하지 않은 공고 ID" }, { status: 400 });
    }
    const draftScopeParam = url.searchParams.get("draft_scope");
    if (draftScopeParam !== null && draftScopeParam !== "unscoped") {
      return NextResponse.json({ error: "유효하지 않은 초안 범위" }, { status: 400 });
    }
    if (jobIdFilter !== null && draftScopeParam === "unscoped") {
      return NextResponse.json({ error: "공고와 미지정 초안 범위는 함께 선택할 수 없습니다." }, { status: 400 });
    }
    const draftScope = draftScopeParam === "unscoped" ? "unscoped" : "all";

    // 지원자 phone 번호 조회 (+access_token — 스레드 빠른 템플릿 #{맞춤링크} 치환용)
    const { data: applicant } = await supabase
      .from("applicants")
      .select("phone, access_token")
      .eq("id", applicantId)
      .single();

    // applicant_id 또는 phone 번호로 대화 내역 조회 (트리거 미실행 대비).
    // job_id 필터는 NULL도 함께 통과시킨다 — 캠페인 핑·과거 수동 발송 등 job_id 없는
    // 메시지가 공고 탭에서 사라져 "매니저 답장이 안 보이는" 문제 방지.
    // 1000행 단위로 끝까지 읽되, 어느 페이지든 실패하면 부분 대화를 정상값으로 반환하지 않는다.
    let messages;
    try {
      messages = await fetchCompleteMessageHistory(supabase, {
        applicantId,
        applicantPhone: typeof applicant?.phone === "string" ? applicant.phone : null,
        jobId: jobIdFilter,
      });
    } catch (messageError) {
      console.error("[messages fetch error]", messageError);
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

    // 최신순 미처리 초안 중 현재 공고와 정확히 결속된 1건. 공고가 다른 최신 초안을
    // 현재 탭 초안으로 오인해 잘못된 job_id로 발송하는 멀티-잡 사고를 막는다.
    let pendingDraftQuery = supabase
      .from("message_drafts")
      .select("id, inbound_message_id, draft_text, reasoning, missing_info, status, job_id, created_at")
      .eq("applicant_id", applicantId)
      .in("status", ["pending", "need_info"])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (jobIdFilter !== null) pendingDraftQuery = pendingDraftQuery.eq("job_id", jobIdFilter);
    else if (draftScopeParam === "unscoped") pendingDraftQuery = pendingDraftQuery.is("job_id", null);
    const { data: pendingDrafts, error: draftsError } = await pendingDraftQuery.limit(1);
    if (draftsError) {
      console.error("[messages draft fetch error]", draftsError);
      return NextResponse.json({ error: "초안 조회 실패" }, { status: 500 });
    }
    const latestDraft = selectPendingDraftForJob(pendingDrafts ?? [], jobIdFilter);

    // 메시지별 reasoning 매핑 — message_drafts.used_message_id 기준
    // (router.ts가 자동 발송 시 status='auto_sent'로 함께 insert함)
    const messagesList = messages;
    const outboundIds = messagesList
      .filter((m) => m.direction === "outbound")
      .map((m) => m.id);
    let reasoningByMessageId = new Map<string, string>();
    let reasoningContextState: "ready" | "error" = "ready";
    try {
      reasoningByMessageId = await fetchReasoningByMessageIds(supabase, outboundIds);
    } catch (reasoningError) {
      console.error("[messages API] reasoning fetch failed", reasoningError);
      reasoningContextState = "error";
    }
    const messagesWithReasoning = messagesList.map((m) => ({
      ...m,
      reasoning: m.direction === "outbound" ? reasoningByMessageId.get(m.id) ?? null : null,
    }));

    // 재컨택 맥락 이벤트(B1) — 발송·링크열람·관심클릭·가용성·수신거부를 스레드에
    // 인라인 마커로 병합 표시하기 위해 함께 반환. 성능: 최근 90일로 제한.
    // (job_id 필터와 무관하게 지원자 단위 — "이 답장이 무엇에 대한 것인지"의 맥락은 공고를 가리지 않는다)
    const RECONTACT_EVENT_TYPES = ["ping_sent", "link_view", "interest_click", "availability_set", "opt_out_set", "handoff_resolved", "job_consultation_observation"];
    const eventsSince = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    let eventsList: Awaited<ReturnType<typeof fetchRecentPoolEvents>> = [];
    let poolEventsContextState: "ready" | "error" = "ready";
    try {
      eventsList = await fetchRecentPoolEvents(supabase, {
        applicantId,
        eventTypes: RECONTACT_EVENT_TYPES,
        since: eventsSince,
      });
    } catch (poolEventsError) {
      console.error("[messages API] pool_events fetch failed", poolEventsError);
      poolEventsContextState = "error";
    }

    // 멀티-잡 인지(Phase 2 UX): 이 대화에 등장하는 공고 라벨 맵.
    // 한 지원자가 여러 공고를 동시 진행할 때, 말풍선에 "어느 공고 건"인지 칩으로 표시하기 위함.
    // 관심클릭 이벤트의 공고명 표시에도 재사용하므로 이벤트 job_id도 포함.
    // 시스템 더미 공고(__ 접두)는 제외 → 칩 미표시.
    const jobIdsInThread = Array.from(
      new Set(
        [
          ...messagesList.map((m) => m.job_id),
          ...eventsList.map((e) => e.job_id),
          latestDraft?.job_id,
        ].filter(
          (x): x is number => typeof x === "number"
        )
      )
    );
    const jobsMap: Record<number, { title: string; branch: string | null }> = {};
    let jobLabelsContextState: "ready" | "error" = "ready";
    if (jobIdsInThread.length > 0) {
      const { data: jobRows, error: jobLabelsError } = await supabase
        .from("jobs")
        .select("id, title, branch")
        .in("id", jobIdsInThread);
      if (jobLabelsError) {
        console.error("[messages API] job labels fetch failed", jobLabelsError);
        jobLabelsContextState = "error";
      } else {
        for (const j of jobRows ?? []) {
          if (typeof j.title === "string" && j.title.startsWith("__")) continue;
          jobsMap[j.id as number] = {
            title: (j.title as string) ?? "",
            branch: (j.branch as string | null) ?? null,
          };
        }
      }
    }

    // 현재 후보의 agent_stage + agent_state (체크리스트)
    let agentStage: string | null = null;
    let agentState: Record<string, unknown> | null = null;
    if (shouldLoadCandidateAgentState(jobIdFilter, draftScope)) {
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
    }

    const manualMessageAttention = await manualMessageAttentionPromise;

    return NextResponse.json({
      data: messagesWithReasoning,
      messages: messagesWithReasoning,
      events: eventsList,
      access_token: applicant?.access_token ?? null,
      draft: latestDraft || null,
      agent_stage: agentStage,
      agent_state: agentState,
      jobs: jobsMap,
      manual_message_attention: manualMessageAttention,
      context_status: {
        reasoning: reasoningContextState,
        pool_events: poolEventsContextState,
        job_labels: jobLabelsContextState,
      },
    });
  } catch (err) {
    console.error("[messages API error]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
