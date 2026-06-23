/**
 * 에이전트 라우터.
 *
 * SMS Gateway → /api/messages/inbound → runAgentForCandidate()
 *
 * 1) job_candidates row 로드
 * 2) agent_stage에 맞는 stage 모듈 dispatch
 * 3) Claude 호출 (stage.process)
 * 4) 응답 발송 (SOLAPI)
 * 5) transitions.applyTransition() — 단계 전이 + 자동 발송 + state 저장
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSms } from "../solapi";
import { applyTransition } from "./transitions";
import { explorationStage } from "./stages/exploration";
import { onboardingStage } from "./stages/onboarding";
import { screeningStage } from "./stages/screening";
import { activeStage } from "./stages/active";
import { recordUsage, toMessageTokens, type UsagePurpose } from "./usage";
import { isAgentDisabled } from "./kill-switch";
import type {
  AgentState,
  ApplicantContext,
  ConversationTurn,
  JobContext,
  OtherActiveJob,
  Stage,
  StageContext,
  StageName,
} from "./types";

const STAGES: Record<Exclude<StageName, "paused" | "abort">, Stage> = {
  exploration: explorationStage,
  screening: screeningStage,
  onboarding: onboardingStage,
  active: activeStage,
};

export interface RunAgentInput {
  supabase: SupabaseClient;
  candidate_id: number;
  inbound_message_id: string;
  inbound_text: string;
  /** true면 SOLAPI 발송을 건너뛰고 DB(messages)에만 outbound 기록 — 연습용 빙의 모드에서 사용. */
  simulate?: boolean;
  /** 인입 SMS 수신 시각(ISO). 제공되면 received_at + REPLY_DELAY까지 대기 후 응답한다.
   *  '바로 답장' 느낌을 줄이기 위한 인위적 텀. simulate=true나 값 없으면 즉시 응답. */
  received_at?: string;
}

const REPLY_DELAY_MS = 60_000;       // 인입 시각 기준 답장 목표 지연 (1분)
const MAX_REPLY_SLEEP_MS = 45_000;   // 함수 timeout 안전 마진 (Vercel maxDuration ≥ 60s 가정)

export interface RunAgentResult {
  ok: boolean;
  skipped?: string;            // 스킵 사유
  reply_sent?: boolean;
  next_stage?: StageName | null;
  auto_sent_messages?: number;
  reasoning?: string;
  error?: string;
}

export async function runAgentForCandidate(input: RunAgentInput): Promise<RunAgentResult> {
  const { supabase, candidate_id, inbound_message_id, inbound_text, simulate = false, received_at } = input;

  // 전역 일시중지 스위치 — 켜져 있으면 어떤 단계든 상관없이 즉시 종료.
  if (!simulate && (await isAgentDisabled(supabase))) {
    return { ok: true, skipped: "agent kill-switch ON — global pause" };
  }

  // 답장 텀 — 인입 시각으로부터 REPLY_DELAY_MS 후를 목표로 대기.
  // 이미 지났으면 즉시 진행. simulate(연습 빙의)는 매니저 테스트라 텀 없이 즉시.
  if (!simulate && received_at) {
    const target = new Date(received_at).getTime() + REPLY_DELAY_MS;
    const wait = Math.min(MAX_REPLY_SLEEP_MS, target - Date.now());
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  // 1) job_candidate + 관련 데이터 로드
  const { data: jc, error: jcErr } = await supabase
    .from("job_candidates")
    .select(`
      id, job_id, applicant_id, agent_stage, agent_state,
      jobs:job_id (
        id, title, body, branch, slot, start_date, vehicle_required, pickup_address, site_manager_id, pay_info, policy_notes
      ),
      applicants:applicant_id (
        id, name, phone, birth_date, location, own_vehicle, license_type, vehicle_type,
        branch1, branch2, work_hours, available_date, self_ownership, introduction, experience
      )
    `)
    .eq("id", candidate_id)
    .single();

  if (jcErr || !jc) {
    return { ok: false, error: `job_candidate not found: ${jcErr?.message}` };
  }

  const stageName = jc.agent_stage as StageName | null;
  if (!stageName || stageName === "paused" || stageName === "abort") {
    return { ok: true, skipped: `stage=${stageName ?? "null"} — agent skipped` };
  }
  // onboarding도 AI가 응답한다 — 배민 아이디 수집 후 "감사합니다 곧 연락드리겠습니다" 마무리.
  const blockReplyForStage = false;

  // applicants.status가 jc.agent_stage보다 뒤처져 있으면 자동 동기화.
  // (예: jc=onboarding/active 인데 applicants.status='스크리닝 중'에 머문 케이스 복구)
  // 매니저가 직접 둔 상태(확정인력/대기자/부적합/이탈/기타)는 절대 건드리지 않는다.
  const expectedStatus =
    stageName === "onboarding" || stageName === "active" ? "스크리닝 완료"
    : stageName === "screening" ? "스크리닝 중"
    : null;
  if (expectedStatus) {
    const applicantId = (jc.applicants as { id?: number } | null)?.id;
    if (applicantId) {
      await supabase
        .from("applicants")
        .update({ status: expectedStatus })
        .eq("id", applicantId)
        .in("status", ["스크리닝 전", "스크리닝 중", "스크리닝 완료"]);
    }
  }

  // 답장 텀(sleep) 동안 같은 후보가 추가 메시지를 보냈으면, 더 늦은 핸들러가
  // 모든 메시지를 한꺼번에 history로 보고 한 번에 답한다. 내(현재) 핸들러는 양보하고 종료.
  // (사용자 메시지가 무시되지 않으면서도 답장이 중복 발송되는 것을 막는다)
  if (!simulate && received_at) {
    const { data: newer } = await supabase
      .from("messages")
      .select("id")
      .eq("applicant_id", jc.applicant_id as number)
      .eq("direction", "inbound")
      .gt("created_at", received_at)
      .neq("id", inbound_message_id)
      .limit(1);
    if (newer && newer.length > 0) {
      return { ok: true, skipped: "coalesced — newer inbound will handle" };
    }
  }

  const stage = STAGES[stageName];
  if (!stage) {
    return { ok: false, error: `unknown stage: ${stageName}` };
  }

  // 2) 대화 history (이번 인입 제외)
  // job_id만으로 좁히면 시스템 더미 공고(__danggeun_system__)를 공유하는 후보들끼리
  // history가 섞여 AI가 다른 후보 대화를 이 후보 컨텍스트로 인용해버린다.
  // applicant_id로 추가 좁히기 — 한 후보의 대화만 본 후보 history에 포함.
  const applicantIdForHistory = jc.applicant_id as number;
  const { data: msgs } = await supabase
    .from("messages")
    .select("direction, body, created_at")
    .eq("job_id", jc.job_id)
    .eq("applicant_id", applicantIdForHistory)
    .neq("id", inbound_message_id)
    .order("created_at", { ascending: true })
    .limit(50);

  const stripPrefix = (s: string) =>
    s.replace(/^\s*\[(?:Web발신|국제발신|광고)\]\s*/i, "").trim();

  const history: ConversationTurn[] = (msgs ?? []).map((m) => ({
    direction: m.direction as "inbound" | "outbound",
    body: stripPrefix(m.body as string),
    created_at: m.created_at as string,
  }));

  const cleanInbound = stripPrefix(inbound_text);

  // 2b) 멀티-잡 인지 (Phase 1) — 이 지원자가 동시에 진행 중인 '다른' 공고들.
  // 현재 후보/시스템 더미 공고(__)/abort는 제외. 에이전트가 다른 공고 문의를
  // 현재 공고 정보로 잘못 답하지 않도록 컨텍스트로만 제공한다(체크리스트는 건드리지 않음).
  const otherActiveJobs: OtherActiveJob[] = [];
  {
    const { data: others } = await supabase
      .from("job_candidates")
      .select(`agent_stage, jobs:job_id ( id, title, branch )`)
      .eq("applicant_id", applicantIdForHistory)
      .not("agent_stage", "is", null)
      .neq("agent_stage", "abort")
      .neq("id", candidate_id);
    for (const o of others ?? []) {
      const j = (o.jobs ?? null) as unknown as { id: number; title: string; branch: string | null } | null;
      if (!j || typeof j.title !== "string" || j.title.startsWith("__")) continue;
      otherActiveJobs.push({
        job_id: j.id,
        title: j.title,
        branch: j.branch ?? null,
        stage: (o.agent_stage as StageName) ?? "exploration",
      });
    }
  }

  // 3) Stage 호출
  // Supabase 조인 응답은 단일 FK여도 객체/배열이 섞여 들어올 수 있어 unknown 경유
  const job = (jc.jobs ?? null) as unknown as JobContext | null;
  const applicant = jc.applicants as unknown as ApplicantContext;
  const state = (jc.agent_state ?? {}) as AgentState;

  const ctx: StageContext = { job, applicant, history, state, otherActiveJobs };
  const result = await stage.process(ctx, cleanInbound);

  // Claude 사용량 → ai_usage_daily 적재. stage 이름 = purpose.
  if (result.usage?.model) {
    await recordUsage(supabase, {
      model: result.usage.model,
      purpose: stage.name as UsagePurpose,
      usage: result.usage,
    });
  }

  // stage가 applicants 행에 patch할 필드를 실어보냈으면 적용 (예: onboarding의 baemin_id 추출값)
  if (result.applicant_patch && Object.keys(result.applicant_patch).length > 0) {
    const { error: patchErr } = await supabase
      .from("applicants")
      .update(result.applicant_patch)
      .eq("id", applicant.id);
    if (patchErr) console.error("[router] applicant_patch failed", patchErr);
  }

  // 4) 응답 발송 (simulate=true면 SOLAPI 건너뛰고 DB만 기록)
  // advance 전이 시엔 transitions.ts가 안내 묶음(SCREENING_ANNOUNCE/GUIDE 등)을 자동 발송하므로
  // AI가 동시에 reply_text를 넣었어도 중복 방지를 위해 무시한다.
  // 단, advance.to='active'는 자동 발송이 없어서 AI 마무리 멘트를 그대로 보내야 함.
  const skipReplyDueToAdvance =
    result.transition.kind === "advance" &&
    result.transition.to !== "active" &&
    !!result.reply_text;
  // pause 전이 = 매니저 인계 판단이 선 상태. AI가 임의로 사과/응대 메시지를 더 보내지 않고
  // 슬랙 알림만 보낸 뒤 응답 중단한다. (이전엔 reply_text가 있으면 그대로 발송되어
  // "죄송합니다…" 같은 사족이 매니저 인계 전에 한 통 더 나가던 문제 해결)
  const skipReplyDueToPause = result.transition.kind === "pause";
  let replySent = false;
  let outboundId: string | null = null;
  if (result.reply_text && !skipReplyDueToAdvance && !skipReplyDueToPause && !blockReplyForStage) {
    let sendOk = simulate;
    let sendMessageId: string | null = null;
    if (!simulate) {
      const send = await sendSms(applicant.phone, result.reply_text);
      sendOk = send.success;
      sendMessageId = send.messageId ?? null;
      if (!send.success) {
        result.transition = { kind: "pause", reason: `SMS 발송 실패: ${send.error ?? "unknown"}` };
        console.error("[router] SMS send failed", send.error);
      }
    }
    if (sendOk) {
      const tokenCols = toMessageTokens(result.usage?.model ?? "", result.usage ?? null);
      const { data: outMsg } = await supabase
        .from("messages")
        .insert({
          applicant_id: applicant.id,
          applicant_phone: applicant.phone,
          direction: "outbound",
          body: result.reply_text,
          status: simulate ? "simulated" : "sent",
          sent_by: simulate ? "agent-practice" : "agent",
          solapi_msg_id: sendMessageId,
          message_type: "sms",
          job_id: jc.job_id,
          model: tokenCols.model,
          tokens_in: tokenCols.tokens_in,
          tokens_out: tokenCols.tokens_out,
          cache_read_tokens: tokenCols.cache_read_tokens,
        })
        .select("id")
        .single();
      replySent = true;
      outboundId = outMsg?.id ?? null;

      // AI 응답의 reasoning + transition을 message_drafts에 status='auto_sent'로 보관.
      // 매니저가 UI에서 메시지별로 왜 그렇게 답했는지 사후 조회할 수 있게 한다.
      if (outboundId) {
        const transitionLabel =
          result.transition.kind === "advance"
            ? `→ ${result.transition.to} (${result.transition.reason})`
            : result.transition.kind === "pause"
            ? `⏸ pause: ${result.transition.reason}`
            : result.transition.kind === "abort"
            ? `⛔ abort: ${result.transition.reason}`
            : "";
        const reasoningWithTransition = transitionLabel
          ? `[${transitionLabel}]\n${result.reasoning ?? ""}`
          : (result.reasoning ?? "");
        await supabase.from("message_drafts").insert({
          applicant_id: applicant.id,
          inbound_message_id,
          draft_text: result.reply_text,
          reasoning: reasoningWithTransition,
          status: "auto_sent",
          used_message_id: outboundId,
          resolved_at: new Date().toISOString(),
        });
      }
    }
  }

  // 5) Transition + state 저장 + 자동 발송
  const apply = await applyTransition({
    supabase,
    candidate_id: jc.id,
    applicant_id: applicant.id,
    applicant_name: applicant.name,
    applicant_phone: applicant.phone,
    applicant_branch: applicant.branch1 ?? null,
    applicant_work_hours: applicant.work_hours ?? null,
    job_id: jc.job_id,
    job,
    current_stage: stageName,
    state_update: result.state_update,
    transition: result.transition,
    simulate,
  });

  return {
    ok: true,
    reply_sent: replySent,
    next_stage: apply.next_stage,
    auto_sent_messages: apply.auto_sent_messages,
    reasoning: result.reasoning,
  };
}
