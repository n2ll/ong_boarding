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
 *
 * 전역 모드(kill-switch 3단): off면 1) 이전에 즉시 종료, draft(코파일럿)면 3)까지만 실행하고
 * 4)·5) 대신 message_drafts에 초안만 INSERT — 매니저 승인 시 기존 초안 발송 경로가 처리.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSms } from "../solapi";
import { isJobEffectivelyClosed } from "../jobs";
import { isGeneralLineJob } from "./general-line";
import { applyTransition } from "./transitions";
import { explorationStage } from "./stages/exploration";
import { onboardingStage } from "./stages/onboarding";
import { screeningStage } from "./stages/screening";
import { activeStage } from "./stages/active";
import { recordUsage, toMessageTokens, type UsagePurpose } from "./usage";
import { getAgentMode, COPILOT_DRAFT_MARKER, type AgentMode } from "./kill-switch";
import type {
  AgentState,
  ApplicantContext,
  ConversationTurn,
  JobContext,
  OtherActiveJob,
  Stage,
  StageContext,
  StageName,
  StageTransition,
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
  /** 코파일럿(draft) 모드에서 message_drafts에 초안을 만들었는지 */
  draft_created?: boolean;
  next_stage?: StageName | null;
  auto_sent_messages?: number;
  reasoning?: string;
  error?: string;
}

// 확정 뉘앙스 금지 — 발송 직전 결정적 백스톱. AI 응답에 근무 확정/배정/출근 지시성 문구가
// 있으면 발송하지 않고 pause로 전환해 매니저 검토 큐로 넘긴다. (프롬프트 규칙의 코드 가드)
// 고정밀 패턴만 — "확정은 매니저가", "확정되면", "시작일" 등 정상 설명 문구는 걸리지 않도록.
const CONFIRMATION_NUANCE_PATTERNS: RegExp[] = [
  /근무\s*(?:가|이|를)?\s*확정/,               // 근무 확정
  /확정\s*(?:됐|되었|되셨|완료)/,               // 확정됐습니다 (조건형 '확정되면'은 제외)
  /배정\s*(?:이|을|가)?\s*(?:완료|됐|되었|드렸|해\s*드)/, // 배정 완료/됐어요
  /(?:내일|모레|다음\s*주|이번\s*주)\s*부터\s*(?:출근|근무|나오)/, // 내일부터 출근
  /(?:근무|출근)\s*시작\s*(?:하시면|하세요|합니다)/,  // 근무 시작하시면 됩니다 ('시작일'은 제외)
  /합격\s*(?:하셨|입니다|이에요|이십니다)/,     // 합격하셨습니다
];
function detectConfirmationNuance(text: string): string | null {
  for (const re of CONFIRMATION_NUANCE_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

// 전이 판단을 사람이 읽을 한 줄 라벨로 — auto_sent reasoning 보관과 코파일럿 초안 요약에 공용.
function transitionLabelOf(transition: StageTransition): string {
  return transition.kind === "advance"
    ? `→ ${transition.to} (${transition.reason})`
    : transition.kind === "pause"
    ? `⏸ pause: ${transition.reason}`
    : transition.kind === "abort"
    ? `⛔ abort: ${transition.reason}`
    : "";
}

export async function runAgentForCandidate(input: RunAgentInput): Promise<RunAgentResult> {
  const { supabase, candidate_id, inbound_message_id, inbound_text, simulate = false, received_at } = input;

  // 전역 모드 스위치 — off(='1')면 어떤 단계든 상관없이 즉시 종료(기존 kill-switch와 동일).
  // draft면 아래에서 발송·전이 대신 초안(message_drafts)만 만든다. simulate(연습 빙의)는 모드 무시.
  const mode: AgentMode = simulate ? "auto" : await getAgentMode(supabase);
  if (mode === "off") {
    return { ok: true, skipped: "agent kill-switch ON — global pause" };
  }
  const draftMode = mode === "draft";

  // 답장 텀 — 인입 시각으로부터 REPLY_DELAY_MS 후를 목표로 대기.
  // 이미 지났으면 즉시 진행. simulate(연습 빙의)는 매니저 테스트라 텀 없이 즉시.
  // draft 모드도 즉시 — 발송이 없으니 '바로 답장' 느낌을 피할 이유가 없다.
  if (!simulate && !draftMode && received_at) {
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
        id, title, body, branch, slot, start_date, vehicle_required, pickup_address, site_manager_id, pay_info, policy_notes, pay_type, pay_amount, ai_facts, recruit_mode, status, closes_at
      ),
      applicants:applicant_id (
        id, name, phone, birth_date, location, own_vehicle, license_type, vehicle_type,
        branch1, branch2, work_hours, available_date, self_ownership, introduction, experience, status, baemin_id
      )
    `)
    .eq("id", candidate_id)
    .single();

  if (jcErr || !jc) {
    return { ok: false, error: `job_candidate not found: ${jcErr?.message}` };
  }

  // 매니저가 '부적합'/'이탈'로 처리한 지원자는 agent_stage가 활성이어도 자동 응답하지 않는다.
  // (kill-switch·답장 텀 sleep 이후, stage 디스패치·Claude 호출 전 초크포인트 — 세 호출자 모두 커버)
  const applicantStatus = (jc.applicants as { status?: string | null } | null)?.status ?? null;
  if (applicantStatus === "부적합" || applicantStatus === "이탈") {
    return { ok: true, skipped: `applicant status=${applicantStatus} — agent silenced` };
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
  // draft(코파일럿) 모드에서는 상태 변경 부수효과 0 — 동기화도 건너뛴다.
  if (expectedStatus && !draftMode) {
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

  // 실질 마감 공고 감지 — 일반 라인이면 스크리닝이 '마감 안내 모드'로 전환된다
  // (충원완료 안내 + 결원 시 우선 안내 약속 + 선탑 전환). 응대를 멈추지 않는다.
  const jobClosed = !!job && isJobEffectivelyClosed(job.status ?? null, job.closes_at ?? null);

  const ctx: StageContext = { job, applicant, history, state, otherActiveJobs, jobClosed };
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
  // draft(코파일럿) 모드에서는 applicants 변경 부수효과 0 — 건너뛴다.
  if (!draftMode && result.applicant_patch && Object.keys(result.applicant_patch).length > 0) {
    const { error: patchErr } = await supabase
      .from("applicants")
      .update(result.applicant_patch)
      .eq("id", applicant.id);
    if (patchErr) console.error("[router] applicant_patch failed", patchErr);
  }

  // 확정 뉘앙스 금지 결정적 가드 — AI가 확정/배정/출근 지시 문구를 만들면 발송하지 않고
  // pause로 전환(매니저 인계 큐 + Slack). stay/advance 무관하게 우선 적용.
  // draft 모드에서도 동일 검사 — 걸리면 초안을 need_info로 강등해 매니저 수정을 유도한다.
  const nuanceHit = result.reply_text ? detectConfirmationNuance(result.reply_text) : null;
  if (nuanceHit) {
    console.warn(`[router] 확정 뉘앙스 감지 → 발송 보류 + pause: "${nuanceHit}"`);
    result.transition = {
      kind: "pause",
      reason: `확정 뉘앙스 문구 감지("${nuanceHit}") — 발송 보류, 매니저 확인 필요`,
      suggestedAction: "AI가 확정/배정/출근 지시 뉘앙스 문구를 생성해 자동 발송을 막았습니다. 내용 확인 후 매니저가 직접 응대하세요.",
    };
  }

  // ─── 코파일럿(draft) 모드 분기 ───────────────────────────────────────
  // 여기서부터의 부수효과(SOLAPI 발송·messages INSERT·applyTransition의 stage 전이/
  // 자동 안내 발송/Slack 인계 알림/state 저장)를 전부 건너뛰고 message_drafts INSERT만 한다.
  // 매니저가 초안 카드에서 승인하면 기존 경로(/api/admin/messages/send + draft_id)가 발송·기록한다.
  // 실패해도 조용히 스킵(로그만) — 인입 파이프라인은 절대 죽이지 않는다.
  if (draftMode) {
    let draftCreated = false;
    try {
      if (result.reply_text) {
        // 같은 inbound에 대한 미처리 초안이 이미 있으면 중복 생성 방지(웹훅 재전송 대비)
        const { data: dup } = await supabase
          .from("message_drafts")
          .select("id")
          .eq("inbound_message_id", inbound_message_id)
          .in("status", ["pending", "need_info"])
          .limit(1);
        if (!dup || dup.length === 0) {
          const label = transitionLabelOf(result.transition);
          // meta 컬럼이 없어 reasoning 앞머리에 마커+단계·전이 제안 요약을 붙인다.
          const headerParts = [COPILOT_DRAFT_MARKER, `[단계: ${stageName}]`];
          if (job?.title && !job.title.startsWith("__")) headerParts.push(`[공고: ${job.title}]`);
          if (label) headerParts.push(`[제안: ${label}]`);
          const { error: draftErr } = await supabase.from("message_drafts").insert({
            applicant_id: applicant.id,
            applicant_phone: applicant.phone,
            inbound_message_id,
            draft_text: result.reply_text,
            reasoning: `${headerParts.join(" ")}\n${result.reasoning ?? ""}`,
            // 확정 뉘앙스가 걸린 초안은 need_info — 초안 카드에 경고 배지가 뜨고 매니저 수정을 유도.
            missing_info: nuanceHit
              ? `확정 뉘앙스 문구 감지("${nuanceHit}") — 확정은 매니저가 합니다. 내용 수정 후 발송하세요.`
              : null,
            status: nuanceHit ? "need_info" : "pending",
          });
          if (draftErr) console.error("[router] copilot draft insert failed", draftErr);
          else draftCreated = true;
        }
      }
    } catch (e) {
      console.error("[router] copilot draft skipped (fail-safe)", e);
    }
    return {
      ok: true,
      reply_sent: false,
      draft_created: draftCreated,
      next_stage: null,
      auto_sent_messages: 0,
      reasoning: result.reasoning,
    };
  }
  // ────────────────────────────────────────────────────────────────────

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
        const transitionLabel = transitionLabelOf(result.transition);
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

  // 마감 안내 모드 응대(일반 라인 + 실질 마감)에서 답장이 나갔으면 '결원·새 공고 먼저 안내' 약속을
  // 원장(pool_events waitlist_notice)에 기록 — announce-targets A그룹(먼저 안내 약속)의 근거.
  // 지원자·공고당 1회만(중복 방지). 실패해도 응대 파이프라인은 죽이지 않는다.
  if (replySent && !simulate && jobClosed && isGeneralLineJob(job)) {
    try {
      const { data: existing } = await supabase
        .from("pool_events")
        .select("id")
        .eq("applicant_id", applicant.id)
        .eq("job_id", jc.job_id)
        .eq("event_type", "waitlist_notice")
        .limit(1);
      if (!existing || existing.length === 0) {
        await supabase.from("pool_events").insert({
          applicant_id: applicant.id,
          job_id: jc.job_id,
          event_type: "waitlist_notice",
          meta: { source: "agent_closed_reply" },
        });
      }
    } catch (e) {
      console.error("[router] closed-mode waitlist_notice insert failed", e);
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
