import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { generateDraftReply, AgentApplicantContext, AgentTurn } from "@/lib/agent";
import { sendSlackAgentAlert } from "@/lib/slack";
import { runAgentForCandidate } from "@/lib/agent/router";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 자동 응대로 들어가는 stage 목록 (paused/abort/null은 기존 draft 생성 흐름)
const AUTO_AGENT_STAGES = new Set(["exploration", "screening", "onboarding", "active"]);

interface SupabaseWebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema?: string;
  record?: {
    id: string;
    applicant_id: number | null;
    applicant_phone: string;
    direction: "inbound" | "outbound";
    body: string;
    created_at: string;
  };
}

export async function POST(req: NextRequest) {
  // 시크릿 헤더 검증 (Supabase webhook 설정에서 동일 값 헤더 추가)
  const expectedSecret = process.env.AGENT_WEBHOOK_SECRET;
  if (!expectedSecret) {
    console.error("[agent/draft] AGENT_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }
  const provided = req.headers.get("x-webhook-secret");
  if (provided !== expectedSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: SupabaseWebhookPayload;
  try {
    payload = (await req.json()) as SupabaseWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // INSERT into messages, direction=inbound 만 처리
  if (payload.type !== "INSERT" || payload.table !== "messages") {
    return NextResponse.json({ skip: "not insert/messages" });
  }
  const rec = payload.record;
  if (!rec || rec.direction !== "inbound") {
    return NextResponse.json({ skip: "not inbound" });
  }

  const supabase = createServiceClient();

  // 같은 inbound에 대한 draft가 이미 있으면 중복 생성 방지
  const { data: existing } = await supabase
    .from("message_drafts")
    .select("id")
    .eq("inbound_message_id", rec.id)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ skip: "draft already exists" });
  }

  // 지원자 컨텍스트
  let applicant: AgentApplicantContext | null = null;
  if (rec.applicant_id) {
    const { data } = await supabase
      .from("applicants")
      .select(
        "id, name, phone, branch1, branch2, confirmed_branch, current_branch, work_hours, status, available_date, own_vehicle, introduction"
      )
      .eq("id", rec.applicant_id)
      .single();
    if (data) applicant = data as AgentApplicantContext;
  }
  if (!applicant) {
    // phone으로 보강 시도
    const { data } = await supabase
      .from("applicants")
      .select(
        "id, name, phone, branch1, branch2, confirmed_branch, current_branch, work_hours, status, available_date, own_vehicle, introduction"
      )
      .eq("phone", rec.applicant_phone)
      .maybeSingle();
    if (data) applicant = data as AgentApplicantContext;
  }
  if (!applicant) {
    applicant = {
      id: null,
      name: null,
      phone: rec.applicant_phone,
      branch1: null,
      branch2: null,
      confirmed_branch: null,
      current_branch: null,
      work_hours: null,
      status: null,
      available_date: null,
      own_vehicle: null,
      introduction: null,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // [신규] 진행 중인 job_candidate 있으면 → 자동 응대 (runAgentForCandidate)
  // 없으면 기존 흐름(message_drafts 생성)으로 폴백
  // ─────────────────────────────────────────────────────────────
  if (applicant.id) {
    const { data: jc } = await supabase
      .from("job_candidates")
      .select("id, job_id, agent_stage, responded_at")
      .eq("applicant_id", applicant.id)
      .not("agent_stage", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (jc && AUTO_AGENT_STAGES.has(jc.agent_stage as string)) {
      // 1) messages 행에 job_id 채워주기 — agent가 history 로드 시 그 공고 컨텍스트만 사용
      await supabase
        .from("messages")
        .update({ job_id: jc.job_id })
        .eq("id", rec.id);

      // 2) 첫 응답이면 responded_at 기록
      if (!jc.responded_at) {
        await supabase
          .from("job_candidates")
          .update({ responded_at: rec.created_at })
          .eq("id", jc.id);
      }

      // 3) Agent 호출 (Claude + 응답 발송 + transition 적용)
      const agentResult = await runAgentForCandidate({
        supabase,
        candidate_id: jc.id as number,
        inbound_message_id: rec.id,
        inbound_text: rec.body,
      });

      return NextResponse.json({ route: "agent", ...agentResult });
    }
  }
  // ─────────────────────────────────────────────────────────────

  // 최근 대화 — 가장 최근 30턴을 가져오고, 시간순(오래된 → 최근)으로 재정렬해서 Claude에 전달
  const { data: recentMsgs } = await supabase
    .from("messages")
    .select("direction, body, created_at")
    .or(
      applicant.id
        ? `applicant_id.eq.${applicant.id},applicant_phone.eq.${rec.applicant_phone}`
        : `applicant_phone.eq.${rec.applicant_phone}`
    )
    .lt("created_at", rec.created_at)
    .order("created_at", { ascending: false })
    .limit(30);

  const stripPrefix = (body: string) =>
    body.replace(/^\s*\[(?:Web발신|국제발신|광고)\]\s*/i, "").trim();

  const history: AgentTurn[] = (recentMsgs || [])
    .slice()
    .reverse() // 시간순으로 다시 정렬 (오래된 → 최근)
    .map((m) => ({
      direction: m.direction as "inbound" | "outbound",
      body: stripPrefix(m.body as string),
      created_at: m.created_at as string,
    }));

  // 한국 통신사가 붙이는 [Web발신] 같은 prefix 제거
  const cleanInbound = rec.body
    .replace(/^\s*\[(?:Web발신|국제발신|광고)\]\s*/i, "")
    .trim();

  // Claude 호출
  const draft = await generateDraftReply({
    applicant,
    history,
    latestInbound: cleanInbound,
  });

  if (!draft) {
    await supabase.from("message_drafts").insert({
      inbound_message_id: rec.id,
      applicant_id: applicant.id,
      applicant_phone: rec.applicant_phone,
      draft_text: null,
      reasoning: "Claude API 호출 실패",
      status: "failed",
    });
    return NextResponse.json({ error: "draft generation failed" }, { status: 500 });
  }

  if (draft.status === "need_info") {
    await supabase.from("message_drafts").insert({
      inbound_message_id: rec.id,
      applicant_id: applicant.id,
      applicant_phone: rec.applicant_phone,
      draft_text: null,
      reasoning: draft.reasoning,
      missing_info: draft.missing_info || "정보 부족",
      status: "need_info",
    });

    // 슬랙 알림
    await sendSlackAgentAlert({
      applicant_name: applicant.name,
      applicant_phone: rec.applicant_phone,
      branch: applicant.confirmed_branch || applicant.branch1,
      inbound_text: rec.body,
      missing_info: draft.missing_info || "정보 부족",
    });

    return NextResponse.json({ status: "need_info" });
  }

  await supabase.from("message_drafts").insert({
    inbound_message_id: rec.id,
    applicant_id: applicant.id,
    applicant_phone: rec.applicant_phone,
    draft_text: draft.draft_text,
    reasoning: draft.reasoning,
    status: "pending",
  });

  return NextResponse.json({ status: "pending", draft_text: draft.draft_text });
}
