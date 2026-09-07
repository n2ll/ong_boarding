/**
 * pull '관심 있어요' 자동 응대(auto-engage) 공용 헬퍼.
 *
 * 호출처:
 *  - POST /api/pool/[token]/interest — 주간(KST 08~21시) 클릭 시 즉시 실행
 *  - GET  /api/admin/cron/engage-queued — 야간 클릭으로 큐잉(engage_queued_at)된 후보를
 *    아침 9시(KST)에 가드 재검사 후 실행
 *
 * 전역 3단 모드(getAgentMode) 준수:
 *  - off   : 아무 발송 없음 — 기존처럼 관심 큐(agent_stage NULL)에만 남는다.
 *  - draft : 코파일럿 — message_drafts.inbound_message_id가 NOT NULL이라 인바운드 문자가 없는
 *            관심 클릭에는 초안을 만들 수 없다. 발송·초안 없이 종료(copilot_manual)하고
 *            호출자가 Slack으로 '관심 큐에서 수동 컨택'을 유도한다.
 *  - auto  : 첫 문자 즉시 발송 + job_candidates sent_at 기록 + agent_stage='screening' 진입.
 *            이후 지원자 답장은 인입 웹훅이 agent_stage 기준으로 라우터에 연결한다.
 *
 * 충원 완료 공고(매니저 확정 인원(applicants.status='확정인력') ≥ capacity)에는 스크리닝 대신
 * 현재 공고의 충원 완료 사실을 알리는 운영 문자 1통만 보낸다.
 *
 * ⚠️ 확정 뉘앙스 금지 — 모든 문구는 질문/안내일 뿐, 배정·확정·출근 지시 표현을 절대 쓰지 않는다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { sendSms } from "../solapi";
import { isJobEffectivelyClosed, isSystemJobTitle } from "../jobs";
import type { GeoJob } from "../geo";
import {
  deliverPoolEngageMessage,
  poolEngageClaimDecision,
  poolEngageFinalizeSucceeded,
  poolEngageRecoveryDecision,
} from "../pool-engage-claim";
import { getAgentMode, type AgentMode } from "./kill-switch";
import { getSystemMessage, fillTemplate } from "./system-messages";
import { resolveAutomatedOutboundText } from "./outbound-safety";
import { currentJobWaitlistNotice } from "./engage-message";
import { hasFutureJobPromotion } from "../sms-consent-policy";
import {
  isExposed,
  normalizeRule,
  fetchOverridesForApplicant,
  fetchSuntopDone,
  type ExposureApplicant,
} from "../exposure";

/** messages.sent_by 값 — 이 공고로 자동 안내(첫 문자·대기 안내)를 이미 보냈는지 중복 판정에 쓴다. */
export const ENGAGE_SENT_BY = "agent-engage";

/** SMS용 공고 제목 — 끝의 '(…원)' 단가 괄호 제거(문자에선 군더더기, pull 카드와 동일 규칙). */
export function smsJobTitle(title: string): string {
  return title.replace(/\s*\([^)]*원\)\s*$/, "");
}

/** 스크리닝 첫 문자 폴백 — 운영 문구는 system_message 'interest_engage'({{이름}}·{{공고명}})가 우선.
 *  웹발신 가독성: 문장 단위 줄바꿈, 질문은 마지막 줄에 하나. */
const FALLBACK_ENGAGE = (name: string, jobTitle: string) =>
  `${name}님, '${jobTitle}' 관심 감사합니다!\n빠른 진행을 위해 몇 가지만 여쭤볼게요.\n\n지금 운행하시는 차량(차종)이 어떻게 되세요?`;

/** KST 21시~익일 08시 — 야간엔 즉시 발송 대신 큐잉하고 아침 9시 cron이 발송한다. */
export function isNightKst(d: Date = new Date()): boolean {
  const kstHour = (d.getUTCHours() + 9) % 24;
  return kstHour >= 21 || kstHour < 8;
}

export type EngageSkipReason =
  | "not_found"
  | "job_closed"
  | "already_in_progress"
  | "no_phone"
  | "opt_out"
  | "job_conflict"
  | "already_engaged"
  | "engage_claimed"
  | "claim_unavailable"
  | "claim_retryable"
  | "unsafe_message";

export type EngageOutcome =
  | { action: "off" }
  | { action: "copilot_manual" }
  | { action: "skipped"; reason: EngageSkipReason }
  | { action: "send_failed"; error?: string }
  | { action: "send_unknown"; error?: string }
  | { action: "sent_unfinalized"; error?: string }
  | { action: "recovered"; messageKind: "screening" | "waitlist" }
  | { action: "waitlist_sent" }
  | { action: "engaged" };

/** 이 공고로 이미 자동 안내 문자(sent_by='agent-engage')를 보냈는지 — 중복 발송 판정. */
export async function hasEngageMessage(
  supabase: SupabaseClient,
  jobId: number,
  applicantId: number
): Promise<boolean> {
  const { data, error } = await supabase
    .from("messages")
    .select("id")
    .eq("job_id", jobId)
    .eq("applicant_id", applicantId)
    .eq("sent_by", ENGAGE_SENT_BY)
    .limit(1);
  if (error) {
    console.error("[engage] dup check failed", error);
    return true; // 판정 실패 시 발송하지 않는다 — 중복 방지 우선
  }
  return (data?.length ?? 0) > 0;
}

/** 선택 당시 초점이 유지된 경우에만 예약을 정리한다. 오류 시 예약을 보존한다. */
async function clearQueueFlag(supabase: SupabaseClient, jcId: number, focusActionKey: string | null): Promise<void> {
  // 새 선택으로 생긴 같은 공고의 예약을 과거 요청이 지우지 못하도록 DB 잠금에서 확인한다.
  const { error } = await supabase.rpc("clear_pool_engage_queue", {
    p_candidate_id: jcId, p_expected_focus_action_key: focusActionKey,
  });
  if (error) console.error("[engage] guarded queue clear failed", error);
}

/** 매니저 확정 인원(applicants.status='확정인력') ≥ capacity — jobs GET의 confirmed_count와 동일 기준. */
async function isJobFullyStaffed(
  supabase: SupabaseClient,
  jobId: number,
  capacity: number
): Promise<boolean> {
  const { data: cands, error } = await supabase
    .from("job_candidates")
    .select("applicant_id, agent_stage, applicants:applicant_id ( status, current_job_id )")
    .eq("job_id", jobId)
    .limit(1000);
  if (error) {
    console.error("[engage] staffed check failed", error);
    return false; // 판정 실패 시 스크리닝 진행 — 발송 자체가 위험하지 않음(질문/안내일 뿐)
  }
  let confirmed = 0;
  for (const c of cands ?? []) {
    // supabase 조인은 1:1이어도 배열/객체로 올 수 있어 둘 다 방어 (jobs GET과 동일).
    const rel = (
      c as {
        applicants?:
          | { status?: string | null; current_job_id?: number | null }
          | { status?: string | null; current_job_id?: number | null }[]
          | null;
      }
    ).applicants;
    const a = Array.isArray(rel) ? rel[0] : rel;
    // 공고탭 충원율(app/api/admin/jobs GET)과 **같은 규칙**: 확정이 이 공고에 결속(current_job_id)됐고
    // 이탈 링크가 아닐 때만 센다. 공고가 여럿일 때 다른 라인 확정자가 이 공고에 링크만 있어도
    // 충원 완료로 오판해, 신규 관심자에게 '자리가 모두 차 있어요' 한 통만 보내고 스크리닝을 영구 미시작하던 문제.
    if (
      a?.status === "확정인력" &&
      a?.current_job_id === jobId &&
      (c as { agent_stage?: string | null }).agent_stage !== "abort"
    ) {
      confirmed++;
    }
  }
  return confirmed >= capacity;
}

/** 기존 outbox만 조회·복구한다. null일 때만 호출자가 새 claim을 시도할 수 있다. */
export async function recoverInterestEngage(params: {
  supabase: SupabaseClient;
  jobId: number;
  applicantId: number;
  actionKey?: string;
}): Promise<EngageOutcome | null> {
  const { data, error } = await params.supabase.rpc("reconcile_pool_engage", {
    p_action_key: params.actionKey ?? null,
    p_applicant_id: params.applicantId,
    p_job_id: params.jobId,
  });
  const recovery = poolEngageRecoveryDecision(data, error);
  if (recovery.kind === "none") return null;
  if (recovery.kind === "failed") {
    return { action: "send_failed", error: "provider_declared_failure" };
  }
  if (recovery.kind === "recovered") {
    return { action: "recovered", messageKind: recovery.messageKind };
  }
  if (recovery.kind === "sent_unfinalized") {
    return { action: "sent_unfinalized", error: "finalization_failed" };
  }
  if (recovery.kind === "blocked") {
    return {
      action: "send_unknown",
      error: `provider_${recovery.status}`,
    };
  }
  console.error("[engage] outbox reconciliation failed", error ?? data);
  return { action: "send_unknown", error: "recovery_state_unknown" };
}

/**
 * 관심 클릭 자동 응대 1건 실행 — 가드 통과 시 첫 문자(또는 충원 완료 대기 안내) 발송.
 * 정상 발송·종결 가드는 engage_queued_at을 지우고, 다른 공고 진행/claim 오류는 후속 확인을 위해 유지한다.
 * 공급자가 실패를 확정한 건은 큐를 유지해 새 action으로 재시도한다. 결과 불명 건도 큐는
 * 유지하지만 DB claim이 재발송을 막으며, 매니저가 공급자 내역을 확인해야 한다.
 */
export async function runInterestEngage(params: {
  supabase: SupabaseClient;
  jobId: number;
  applicantId: number;
  /** 호출자가 이미 조회한 모드가 있으면 재사용(없으면 여기서 조회) */
  mode?: AgentMode;
  /** pool_events.meta.source — 'interest_click' | 'engage_queued_cron' */
  source: string;
  /** 풀 클릭 action_id. cron은 실행 건마다 새 키를 만들며 실패가 확정된 건만 다음 회차 재시도한다. */
  actionKey?: string;
}): Promise<EngageOutcome> {
  const { supabase, jobId, applicantId, source } = params;

  // 이미 공급자 성공이 저장된 건은 kill-switch/공고 상태보다 먼저 DB finalize만 복구한다.
  // sending/unknown도 여기서 보이게 반환해 새 action/SMS 경계를 넘지 않는다.
  const recovery = await recoverInterestEngage({
    supabase,
    jobId,
    applicantId,
  });
  if (recovery) return recovery;

  // 호출자가 이전에 읽은 auto 값으로 현재 OFF를 덮어쓰지 않는다. off/draft는 범위를 줄이는 데만 쓴다.
  const currentMode = await getAgentMode(supabase, undefined, true);
  const mode = currentMode === "off" || params.mode === "off" ? "off"
    : currentMode === "draft" || params.mode === "draft" ? "draft" : "auto";
  if (mode === "off") return { action: "off" };

  const [{ data: applicantRow }, { data: jobRow }, { data: jcRow }] = await Promise.all([
    supabase
      .from("applicants")
      .select("id, name, phone, sms_opt_out_at, current_job_id, conversation_focus_job_id, conversation_focus_action_key")
      .eq("id", applicantId)
      .maybeSingle(),
    supabase
      .from("jobs")
      .select("id, title, status, closes_at, capacity")
      .eq("id", jobId)
      .maybeSingle(),
    supabase
      .from("job_candidates")
      .select("id, agent_stage")
      .eq("job_id", jobId)
      .eq("applicant_id", applicantId)
      .maybeSingle(),
  ]);
  const applicant = applicantRow as {
    id: number;
    name: string | null;
    phone: string | null;
    sms_opt_out_at: string | null;
    current_job_id: number | null;
    conversation_focus_job_id: number | null;
    conversation_focus_action_key: string | null;
  } | null;
  const job = jobRow as {
    id: number;
    title: string;
    status: string | null;
    closes_at: string | null;
    capacity: number | null;
  } | null;
  const jc = jcRow as { id: number; agent_stage: string | null } | null;
  if (!applicant || !job || !jc) return { action: "skipped", reason: "not_found" };

  if (applicant.conversation_focus_job_id && (applicant.conversation_focus_job_id !== jobId ||
    (source !== "engage_queued_cron" && params.actionKey !== applicant.conversation_focus_action_key))) {
    return { action: "skipped", reason: "job_conflict" };
  }

  // 마감/시스템 공고 — 발송 없이 종료(밤사이 마감된 야간 큐 건 정리)
  if (isSystemJobTitle(job.title) || isJobEffectivelyClosed(job.status, job.closes_at)) {
    await clearQueueFlag(supabase, jc.id, applicant.conversation_focus_action_key ?? null);
    return { action: "skipped", reason: "job_closed" };
  }

  // 코파일럿(draft) — 인바운드 문자가 없어 초안(message_drafts) 생성 불가 → 수동 컨택 유도
  if (mode === "draft") {
    await clearQueueFlag(supabase, jc.id, applicant.conversation_focus_action_key ?? null);
    return { action: "copilot_manual" };
  }

  // ─── 가드 (모두 통과해야 발송) ───
  if (jc.agent_stage) {
    await clearQueueFlag(supabase, jc.id, applicant.conversation_focus_action_key ?? null);
    return { action: "skipped", reason: "already_in_progress" };
  }
  if (!applicant.phone) {
    await clearQueueFlag(supabase, jc.id, applicant.conversation_focus_action_key ?? null);
    return { action: "skipped", reason: "no_phone" };
  }
  // 수신거부 하드 가드 — '그만' 답장 등으로 기록된 지원자는 영구 제외
  if (applicant.sms_opt_out_at) {
    await clearQueueFlag(supabase, jc.id, applicant.conversation_focus_action_key ?? null);
    return { action: "skipped", reason: "opt_out" };
  }
  // 정책: 한 사람 = 하나의 '진행 중' 공고 (dispatch와 동일)
  if ((applicant.conversation_focus_job_id && applicant.conversation_focus_job_id !== jobId) || (applicant.current_job_id && applicant.current_job_id !== jobId)) {
    // 야간 큐는 유지한다. 기존 흐름이 정상 종료되어 current_job_id가 풀리면 다음 회차에
    // 새 DB claim을 시도할 수 있고, 그전에는 claim/current_job 가드가 중복 발송을 막는다.
    return { action: "skipped", reason: "job_conflict" };
  }
  // 이 공고로 이미 자동 안내(첫 문자·대기 안내)를 보냈으면 중복 발송 금지
  if (await hasEngageMessage(supabase, jobId, applicantId)) {
    await clearQueueFlag(supabase, jc.id, applicant.conversation_focus_action_key ?? null);
    return { action: "skipped", reason: "already_engaged" };
  }

  const name = applicant.name?.trim() || "고객";
  const capacity = typeof job.capacity === "number" && job.capacity > 0 ? job.capacity : 1;
  const waitlist = await isJobFullyStaffed(supabase, jobId, capacity);
  let text: string | null;
  if (waitlist) {
    const waitlistFallback = currentJobWaitlistNotice(name, smsJobTitle(job.title));
    text = resolveAutomatedOutboundText(null, waitlistFallback);
  } else {
    const stored = (await getSystemMessage(supabase, "interest_engage"))?.trim();
    const cleanTitle = smsJobTitle(job.title);
    const fallback = FALLBACK_ENGAGE(name, cleanTitle);
    const filledStored = stored
      ? fillTemplate(stored, { 이름: name, 공고명: cleanTitle })
      : null;
    const resolved = resolveAutomatedOutboundText(filledStored, fallback);
    // 관심 클릭 자동 응대는 현재 공고 안내만 허용한다. 편집 템플릿에 향후 일자리 홍보가 섞였으면
    // 동의 상태를 추정하지 않고 고정된 현재 공고 질문으로 되돌린다.
    text = resolved && hasFutureJobPromotion(resolved)
      ? resolveAutomatedOutboundText(null, fallback)
      : resolved;
  }
  if (!text) return { action: "skipped", reason: "unsafe_message" };

  const actionKey = params.actionKey ?? randomUUID();
  const delivery = await deliverPoolEngageMessage({
    claim: async () => {
      const { data, error } = await supabase.rpc("claim_pool_engage", {
        p_job_id: jobId,
        p_applicant_id: applicantId,
        p_action_key: actionKey,
        p_applicant_phone: applicant.phone,
        p_message_body: text,
        p_message_kind: waitlist ? "waitlist" : "screening",
        p_source: source,
        p_focus_action_key: source === "engage_queued_cron" ? applicant.conversation_focus_action_key ?? null : null,
      });
      if (error) console.error("[engage] applicant-level claim failed", error);
      return poolEngageClaimDecision(data, error);
    },
    send: () => sendSms(applicant.phone!, text!),
    markProviderResult: async (result, providerMessageId, errorText) => {
      const { data, error } = await supabase.rpc("record_pool_engage_provider_result", {
        p_action_key: actionKey,
        p_result: result,
        p_provider_message_id: providerMessageId,
        p_error: errorText,
      });
      if (error || (data !== "recorded" && data !== "deduped")) {
        console.error("[engage] provider result persistence failed", error ?? data);
        return false;
      }
      return true;
    },
    finalize: async () => {
      const { data, error } = await supabase.rpc("finalize_pool_engage", {
        p_action_key: actionKey,
      });
      if (!poolEngageFinalizeSucceeded(data, error)) {
        console.error("[engage] sent message finalization failed", error ?? data);
        return false;
      }
      return true;
    },
  });

  if (delivery.kind === "not_sent") {
    if (delivery.reason === "job_conflict") {
      return { action: "skipped", reason: "job_conflict" };
    }
    if (delivery.reason === "already_claimed") {
      return { action: "skipped", reason: "engage_claimed" };
    }
    if (delivery.reason === "unavailable") {
      await clearQueueFlag(supabase, jc.id, applicant.conversation_focus_action_key ?? null);
      return { action: "skipped", reason: "claim_unavailable" };
    }
    return { action: "skipped", reason: "claim_retryable" };
  }
  if (delivery.kind === "provider_failed") {
    return { action: "send_failed", error: "provider_declared_failure" };
  }
  if (delivery.kind === "provider_unknown" || delivery.kind === "claim_state_unknown") {
    return { action: "send_unknown", error: delivery.kind };
  }
  if (!delivery.finalized) {
    return { action: "sent_unfinalized", error: "finalization_failed" };
  }
  return waitlist ? { action: "waitlist_sent" } : { action: "engaged" };
}

/** pickJobForCampaignReply 선택 근거 — pool_events meta·로그용. */
export type CampaignReplyJobPickedBy = "interest_candidate" | "notified_job" | "latest_active";

export interface CampaignReplyJobPick {
  jobId: number;
  jobTitle: string;
  pickedBy: CampaignReplyJobPickedBy;
}

/** 자동 편입 보류 — 활성 공고가 여러 개라 '어느 공고 얘기인지' 추측할 수 없는 경우. 호출부가 사람에게 넘긴다. */
export interface CampaignReplyAmbiguous {
  jobId: null;
  ambiguousCount: number;
  /**
   * 열린 공고는 있는데 **전부 이 지원자의 노출 대상이 아니라** 보류(게이트 실패 fail-closed 포함).
   * 공고를 명단으로 좁히면 생기는 새 상태다 — 답장한 사람이 자동 응대도 알림도 못 받는 침묵이 되므로
   * 호출부가 반드시 사람에게 알려야 한다.
   */
  exposureBlockedCount?: number;
  /** true면 '명단 밖'이 아니라 **판정 재료 조회 실패**로 제외된 것(fail-closed) — 문구를 다르게 써야 한다. */
  exposureGateFailed?: boolean;
}

/**
 * 캠페인 문자에 '답장으로만' 반응한 지원자(활성 후보 없음)를 편입할 공고 선택.
 *
 * 우선순위 — **증거만 쓴다**(추측 편입 금지):
 *  ① 이 지원자의 stage NULL 후보가 걸린 활성 공고 — 관심 클릭했던 곳(최신 우선)
 *  ② 그 공고 이름으로 안내 문자를 보낸 공고(ping_sent purpose='new_job')가 **정확히 1개**일 때
 *  ③ 활성 실공고가 **1개**일 때 그 공고
 *  그 외(활성 공고 다수 · 안내가 여러 공고) → 자동 편입 포기(jobId null) → 호출부가 사람에게 넘긴다.
 *
 * 시스템 공고(`__` 프리픽스)·실질 마감(isJobEffectivelyClosed)은 제외. 후보 없으면 null.
 */
export async function pickJobForCampaignReply(
  supabase: SupabaseClient,
  applicant: { id: number; lat: number | null; lng: number | null }
): Promise<CampaignReplyJobPick | CampaignReplyAmbiguous | null> {
  type JobRow = {
    id: number;
    title: string;
    status: string | null;
    closes_at: string | null;
    exposure: string | null;
    exposure_rule: unknown;
    pickup_lat: number | null;
    pickup_lng: number | null;
    dropoff_lat: number | null;
    dropoff_lng: number | null;
  };
  const { data: jobRows, error: jobsErr } = await supabase
    .from("jobs")
    // distance_basis까지 — 안 읽으면 pickup 기준 공고가 nearest(더 넓은 쪽)로 판정돼 본인 링크에는 없는 공고에 자동 편입된다.
    .select("id, title, status, closes_at, exposure, exposure_rule, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_basis")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(200);
  if (jobsErr) {
    console.error("[engage] campaign-reply jobs load failed", jobsErr);
    return null;
  }
  let jobs = ((jobRows ?? []) as JobRow[]).filter(
    (j) => !isSystemJobTitle(j.title) && !isJobEffectivelyClosed(j.status, j.closes_at)
  );

  // 게이트 전 열린 공고 수 — 게이트로 0개가 된 것과 '열린 공고 자체가 없다'를 구분해야 한다.
  const openBeforeGate = jobs.length;
  // 판정 재료 조회가 실패해 제외한 경우 — '명단 밖'이라고 단정하면 안 된다(원인이 다르다).
  let gateFailed = false;

  // 지정 노출(targeted) 게이트 — 노출 대상이 아닌 공고로 자동 편입하면 AI 문자로 공고 상세가
  // 미대상에게 새는 우회 경로가 된다(pull 게이팅과 동일 판정). 판정 실패 시 targeted 전부 제외(fail-closed).
  if (jobs.some((j) => j.exposure === "targeted")) {
    try {
      const { data: appRow } = await supabase
        .from("applicants")
        .select("sido, sigungu, availability, own_vehicle, work_hours, available_slots, applied_at, created_at")
        .eq("id", applicant.id)
        .maybeSingle();
      const targetedIds = jobs.filter((j) => j.exposure === "targeted").map((j) => j.id);
      const [overrides, suntopDone] = await Promise.all([
        fetchOverridesForApplicant(supabase, applicant.id, targetedIds),
        fetchSuntopDone(supabase, applicant.id),
      ]);
      const exA: ExposureApplicant = {
        id: applicant.id,
        sido: (appRow as { sido?: string | null } | null)?.sido ?? null,
        sigungu: (appRow as { sigungu?: string | null } | null)?.sigungu ?? null,
        availability: (appRow as { availability?: string | null } | null)?.availability ?? null,
        own_vehicle: (appRow as { own_vehicle?: string | null } | null)?.own_vehicle ?? null,
        work_hours: (appRow as { work_hours?: string | null } | null)?.work_hours ?? null,
        available_slots: (appRow as { available_slots?: string[] | null } | null)?.available_slots ?? null,
        lat: applicant.lat,
        lng: applicant.lng,
        applied_at: (appRow as { applied_at?: string | null } | null)?.applied_at ?? null,
        created_at: (appRow as { created_at?: string | null } | null)?.created_at ?? null,
        suntopDone,
      };
      jobs = jobs.filter(
        (j) => j.exposure !== "targeted" || isExposed(exA, normalizeRule(j.exposure_rule), overrides.get(j.id), { job: j as unknown as GeoJob })
      );
    } catch (e) {
      console.error("[engage] campaign-reply exposure gate failed — targeted 공고 제외(fail-closed)", e);
      jobs = jobs.filter((j) => j.exposure !== "targeted");
      gateFailed = true;
    }
  }
  if (jobs.length === 0) {
    // 열린 공고가 있는데 게이트에서 전부 빠졌다 = '이 사람이 모든 명단 밖'(또는 판정 실패 fail-closed).
    // 자동 편입은 여전히 금지지만(미대상 공고 유출), 일할 수 있다고 답장한 사람이 무응답으로 남는
    // 상태이므로 매니저에게 알려야 한다. 열린 공고가 0개일 때만 조용히 끝낸다.
    if (openBeforeGate > 0) {
      return { jobId: null, ambiguousCount: 0, exposureBlockedCount: openBeforeGate, exposureGateFailed: gateFailed };
    }
    return null; // 보낼 공고 자체가 없음 — 알릴 것도 없다
  }

  // ① 관심 클릭 이력(stage NULL 후보) — 지원자가 직접 고른 공고가 최우선(최신순)
  const { data: nullCands, error: candsErr } = await supabase
    .from("job_candidates")
    .select("job_id")
    .eq("applicant_id", applicant.id)
    .is("agent_stage", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (candsErr) console.error("[engage] campaign-reply null-stage cands load failed", candsErr);
  for (const c of (nullCands ?? []) as { job_id: number | null }[]) {
    const hit = c.job_id != null ? jobs.find((j) => j.id === c.job_id) : undefined;
    if (hit) return { jobId: hit.id, jobTitle: hit.title, pickedBy: "interest_candidate" };
  }

  // ② 우리가 **그 공고 이름으로 안내 문자를 보낸** 공고 — 추측이 아니라 증거다.
  //    '새 배송 건이 올라왔어요! {공고명}'을 받고 답장한 것이므로 그 공고가 맞다. 최신 안내 우선.
  //    여러 공고를 안내했다면 어느 쪽인지 알 수 없으므로 아래 다수 판정으로 내려간다.
  const { data: notices, error: noticeErr } = await supabase
    .from("pool_events")
    .select("meta, created_at")
    .eq("applicant_id", applicant.id)
    .eq("event_type", "ping_sent")
    .eq("meta->>purpose", "new_job")
    .order("created_at", { ascending: false })
    .limit(50);
  if (noticeErr) console.error("[engage] campaign-reply notices load failed", noticeErr);
  const noticedJobIds: number[] = [];
  for (const r of (notices ?? []) as { meta: { job_id?: number | string } | null }[]) {
    const jid = Number(r.meta?.job_id);
    if (Number.isFinite(jid) && jobs.some((j) => j.id === jid) && !noticedJobIds.includes(jid)) {
      noticedJobIds.push(jid);
    }
  }
  if (noticedJobIds.length === 1) {
    const hit = jobs.find((j) => j.id === noticedJobIds[0])!;
    return { jobId: hit.id, jobTitle: hit.title, pickedBy: "notified_job" };
  }

  // ③ 최신 활성 공고 — **활성 실공고가 1개일 때만** 쓴다.
  // (예전엔 여기 앞에 '좌표 최근접 공고' 자동 편입이 있었다. 공고가 6~7개 동시에 열리면 그건 추측이고,
  //  지원자가 안내받은 공고가 아니라 집에서 가까운 다른 라인으로 편입돼 AI가 엉뚱한 공고를 응대했다.
  //  거리 최근접은 매니저가 파이프라인에서 대상을 고를 때 쓰는 기준이고, 자동 편입 근거로는 쓰지 않는다.)
  // 여러 개가 동시에 열려 있으면 이건 추측 편입이고, 편입 즉시 current_job_id가 그 공고로 박혀
  // 지원자가 진짜 원하는 공고를 눌러도 이후 아무 문자도 안 가게 된다(한 사람=진행 중 1공고 정책).
  // 그래서 여러 개면 자동 편입을 포기하고 null을 돌려준다 → 호출부가 매니저 확인으로 넘긴다.
  if (jobs.length > 1) {
    console.log("[engage] campaign-reply 자동 편입 보류 — 활성 공고 다수", { applicantId: applicant.id, activeJobs: jobs.length });
    return { jobId: null, ambiguousCount: jobs.length };
  }
  return { jobId: jobs[0].id, jobTitle: jobs[0].title, pickedBy: "latest_active" };
}

/** 관심 클릭 Slack 알림에 병기할 자동 응대 결과 한 줄. 빈 문자열이면 표기 생략. */
export function engageOutcomeLabel(outcome: EngageOutcome): string {
  switch (outcome.action) {
    case "engaged":
      return "⚡ AI 스크리닝 시작됨 — 첫 질문 문자를 자동 발송했어요.";
    case "waitlist_sent":
      return "충원 완료 공고 — 현재 공고의 마감 안내 문자 1통을 발송했어요.";
    case "copilot_manual":
      return "🤖 코파일럿 모드 — 인바운드가 없어 초안 생성 불가. 관심 큐에서 [빠른 컨택]으로 수동 진행해주세요.";
    case "send_failed":
      return "⚠️ 공급자가 문자 발송 실패를 확인했어요 — 자동 확정은 없으며 새 요청으로 재시도하거나 수동 확인이 필요합니다.";
    case "send_unknown":
      return "⚠️ 문자 발송 결과를 확인할 수 없어 중복 방지를 위해 자동 재시도하지 않았어요 — 발송 내역을 확인해 주세요.";
    case "sent_unfinalized":
      return "⚠️ 문자 발송은 접수됐지만 후보 상태 기록을 마치지 못했어요 — 다시 보내지 말고 매니저가 확인해 주세요.";
    case "recovered":
      return recoveryLabel(outcome.messageKind);
    case "skipped":
      switch (outcome.reason) {
        case "already_in_progress":
          return "이미 진행 중인 후보 — 자동 발송 생략.";
        case "already_engaged":
          return "이미 이 공고 안내 문자를 받은 후보 — 중복 발송 방지로 생략.";
        case "opt_out":
          return "수신거부 지원자 — 자동 발송 생략.";
        case "job_conflict":
          return "다른 공고 응대가 먼저 진행 중이라 이 공고 문자는 보내지 않았어요 — 근무 확정은 아니며 수동 확인이 필요합니다.";
        case "engage_claimed":
          return "다른 자동응대 요청이 먼저 처리 중이라 이 공고 문자는 보내지 않았어요 — 근무 확정은 아니며 수동 확인이 필요합니다.";
        case "claim_retryable":
          return "자동응대 선점 상태를 확인하지 못해 문자를 보내지 않았어요 — 중복 방지를 위해 수동 확인이 필요합니다.";
        case "claim_unavailable":
          return "발송 직전 공고·후보 상태가 달라져 문자를 보내지 않았어요 — 근무 확정은 아니며 수동 확인이 필요합니다.";
        case "unsafe_message":
          return "자동 안내 문구의 안전 기준을 충족하지 않아 문자를 보내지 않았어요 — 매니저가 문구를 확인해 주세요.";
        case "no_phone":
          return "전화번호 없음 — 자동 발송 불가.";
        default:
          return "";
      }
    case "off":
    default:
      return "";
  }
}

function recoveryLabel(messageKind: "screening" | "waitlist"): string {
  return messageKind === "waitlist"
    ? "기존 대기 안내 발송을 다시 보내지 않고 기록만 복구했어요 — 근무 확정은 아니며 매니저 확인이 필요합니다."
    : "기존 첫 문자 발송을 다시 보내지 않고 후보 기록만 복구했어요 — 근무 확정은 아니며 매니저 확인이 필요합니다.";
}
