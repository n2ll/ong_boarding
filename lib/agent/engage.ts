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
 * 투명한 대기 안내 1통만 보낸다 — 자리·새 공고 시 재안내 약속 포함.
 *
 * ⚠️ 확정 뉘앙스 금지 — 모든 문구는 질문/안내일 뿐, 배정·확정·출근 지시 표현을 절대 쓰지 않는다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSms } from "../solapi";
import { isJobEffectivelyClosed, isSystemJobTitle } from "../jobs";
import { haversineKm } from "../kakao-geocode";
import { getAgentMode, type AgentMode } from "./kill-switch";
import { getSystemMessage, fillTemplate } from "./system-messages";
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

/** 충원 완료 대기 안내 — 자리·새 공고 시 재안내를 약속하는 투명한 안내(확정 뉘앙스 없음). */
const WAITLIST_NOTICE = (name: string, jobTitle: string) =>
  `${name}님, '${jobTitle}' 관심 감사합니다!\n지금은 이 공고 자리가 모두 차 있어요.\n자리가 나거나 조건이 맞는 새 공고가 올라오면 이 번호로 먼저 안내드릴게요.`;

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
  | "already_engaged";

export type EngageOutcome =
  | { action: "off" }
  | { action: "copilot_manual" }
  | { action: "skipped"; reason: EngageSkipReason }
  | { action: "send_failed"; error?: string }
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

/** engage_queued_at 클리어 — 컬럼 미적용(마이그레이션 전) 환경에서도 본 흐름이 죽지 않게 non-fatal. */
async function clearQueueFlag(supabase: SupabaseClient, jcId: number): Promise<void> {
  const { error } = await supabase
    .from("job_candidates")
    .update({ engage_queued_at: null })
    .eq("id", jcId);
  if (error) {
    console.error(
      "[engage] engage_queued_at clear failed (docs/migrations/2026-07-jc-engage-queued.sql 적용 확인)",
      error
    );
  }
}

/** 매니저 확정 인원(applicants.status='확정인력') ≥ capacity — jobs GET의 confirmed_count와 동일 기준. */
async function isJobFullyStaffed(
  supabase: SupabaseClient,
  jobId: number,
  capacity: number
): Promise<boolean> {
  const { data: cands, error } = await supabase
    .from("job_candidates")
    .select("applicant_id, applicants:applicant_id ( status )")
    .eq("job_id", jobId)
    .limit(1000);
  if (error) {
    console.error("[engage] staffed check failed", error);
    return false; // 판정 실패 시 스크리닝 진행 — 발송 자체가 위험하지 않음(질문/안내일 뿐)
  }
  let confirmed = 0;
  for (const c of cands ?? []) {
    // supabase 조인은 1:1이어도 배열/객체로 올 수 있어 둘 다 방어 (jobs GET과 동일).
    const rel = (c as { applicants?: { status?: string | null } | { status?: string | null }[] | null })
      .applicants;
    const a = Array.isArray(rel) ? rel[0] : rel;
    if (a?.status === "확정인력") confirmed++;
  }
  return confirmed >= capacity;
}

async function recordEngageMessage(
  supabase: SupabaseClient,
  args: { applicantId: number; phone: string; jobId: number; text: string; messageId: string | null }
): Promise<void> {
  const { error } = await supabase.from("messages").insert({
    applicant_id: args.applicantId,
    applicant_phone: args.phone,
    direction: "outbound",
    body: args.text,
    status: "sent",
    sent_by: ENGAGE_SENT_BY,
    solapi_msg_id: args.messageId,
    message_type: "sms",
    job_id: args.jobId,
  });
  if (error) console.error("[engage] messages insert failed", error);
}

/**
 * 관심 클릭 자동 응대 1건 실행 — 가드 통과 시 첫 문자(또는 충원 완료 대기 안내) 발송.
 * 종결(발송/스킵/코파일럿) 시 engage_queued_at을 클리어한다.
 * 발송 실패와 off는 클리어하지 않는다 — 야간 큐 건은 다음날 아침 cron이 재시도.
 */
export async function runInterestEngage(params: {
  supabase: SupabaseClient;
  jobId: number;
  applicantId: number;
  /** 호출자가 이미 조회한 모드가 있으면 재사용(없으면 여기서 조회) */
  mode?: AgentMode;
  /** pool_events.meta.source — 'interest_click' | 'engage_queued_cron' */
  source: string;
}): Promise<EngageOutcome> {
  const { supabase, jobId, applicantId, source } = params;
  const mode = params.mode ?? (await getAgentMode(supabase));
  if (mode === "off") return { action: "off" };

  const [{ data: applicantRow }, { data: jobRow }, { data: jcRow }] = await Promise.all([
    supabase
      .from("applicants")
      .select("id, name, phone, sms_opt_out_at, current_job_id")
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

  // 마감/시스템 공고 — 발송 없이 종료(밤사이 마감된 야간 큐 건 정리)
  if (isSystemJobTitle(job.title) || isJobEffectivelyClosed(job.status, job.closes_at)) {
    await clearQueueFlag(supabase, jc.id);
    return { action: "skipped", reason: "job_closed" };
  }

  // 코파일럿(draft) — 인바운드 문자가 없어 초안(message_drafts) 생성 불가 → 수동 컨택 유도
  if (mode === "draft") {
    await clearQueueFlag(supabase, jc.id);
    return { action: "copilot_manual" };
  }

  // ─── 가드 (모두 통과해야 발송) ───
  if (jc.agent_stage) {
    await clearQueueFlag(supabase, jc.id);
    return { action: "skipped", reason: "already_in_progress" };
  }
  if (!applicant.phone) {
    await clearQueueFlag(supabase, jc.id);
    return { action: "skipped", reason: "no_phone" };
  }
  // 수신거부 하드 가드 — '그만' 답장 등으로 기록된 지원자는 영구 제외
  if (applicant.sms_opt_out_at) {
    await clearQueueFlag(supabase, jc.id);
    return { action: "skipped", reason: "opt_out" };
  }
  // 정책: 한 사람 = 하나의 '진행 중' 공고 (dispatch와 동일)
  if (applicant.current_job_id && applicant.current_job_id !== jobId) {
    await clearQueueFlag(supabase, jc.id);
    return { action: "skipped", reason: "job_conflict" };
  }
  // 이 공고로 이미 자동 안내(첫 문자·대기 안내)를 보냈으면 중복 발송 금지
  if (await hasEngageMessage(supabase, jobId, applicantId)) {
    await clearQueueFlag(supabase, jc.id);
    return { action: "skipped", reason: "already_engaged" };
  }

  const name = applicant.name?.trim() || "고객";
  const capacity = typeof job.capacity === "number" && job.capacity > 0 ? job.capacity : 1;

  // ─── 충원 완료 → 투명한 대기 안내 1통 (스크리닝 시작 안 함, 확정 뉘앙스 없음) ───
  if (await isJobFullyStaffed(supabase, jobId, capacity)) {
    const text = WAITLIST_NOTICE(name, smsJobTitle(job.title));
    const send = await sendSms(applicant.phone, text);
    if (!send.success) {
      console.error("[engage] waitlist SMS fail", applicantId, send.error);
      return { action: "send_failed", error: send.error };
    }
    await recordEngageMessage(supabase, {
      applicantId,
      phone: applicant.phone,
      jobId,
      text,
      messageId: send.messageId ?? null,
    });
    const { error: evErr } = await supabase.from("pool_events").insert({
      applicant_id: applicantId,
      job_id: jobId,
      event_type: "waitlist_notice",
      meta: { source },
    });
    if (evErr) console.error("[engage] pool_events waitlist_notice failed", evErr);
    await clearQueueFlag(supabase, jc.id);
    return { action: "waitlist_sent" };
  }

  // ─── 스크리닝 시작 — 첫 질문 문자 발송 ───
  const stored = (await getSystemMessage(supabase, "interest_engage"))?.trim();
  const cleanTitle = smsJobTitle(job.title);
  const text = stored
    ? fillTemplate(stored, { 이름: name, 공고명: cleanTitle })
    : FALLBACK_ENGAGE(name, cleanTitle);
  const send = await sendSms(applicant.phone, text);
  if (!send.success) {
    console.error("[engage] engage SMS fail", applicantId, send.error);
    return { action: "send_failed", error: send.error };
  }

  // 발송 성공 후 상태 갱신 — dispatch 패턴과 동일 축(sent_at·agent_stage·current_job_id·messages)
  const { error: jcErr } = await supabase
    .from("job_candidates")
    .update({ sent_at: new Date().toISOString(), agent_stage: "screening" })
    .eq("id", jc.id);
  if (jcErr) console.error("[engage] jc update failed", jcErr);
  await clearQueueFlag(supabase, jc.id);
  const { error: aErr } = await supabase
    .from("applicants")
    .update({ current_job_id: jobId })
    .eq("id", applicantId);
  if (aErr) console.error("[engage] current_job_id update failed", aErr);
  await recordEngageMessage(supabase, {
    applicantId,
    phone: applicant.phone,
    jobId,
    text,
    messageId: send.messageId ?? null,
  });
  const { error: evErr } = await supabase.from("pool_events").insert({
    applicant_id: applicantId,
    job_id: jobId,
    event_type: "auto_engage",
    meta: { source },
  });
  if (evErr) console.error("[engage] pool_events auto_engage failed", evErr);
  return { action: "engaged" };
}

/** pickJobForCampaignReply 선택 근거 — pool_events meta·로그용. */
export type CampaignReplyJobPickedBy = "interest_candidate" | "nearest_anchor" | "latest_active";

export interface CampaignReplyJobPick {
  jobId: number;
  jobTitle: string;
  pickedBy: CampaignReplyJobPickedBy;
}

/**
 * 캠페인 문자에 '답장으로만' 반응한 지원자(활성 후보 없음)를 편입할 공고 선택.
 *
 * 우선순위:
 *  ① 이 지원자의 stage NULL 후보가 걸린 활성 공고 — 관심 클릭했던 곳(최신 우선)
 *  ② 지원자 좌표가 있으면 활성 공고 앵커(상차지·마지막 경유지) 최근접
 *  ③ 최신 활성 공고
 *
 * 시스템 공고(`__` 프리픽스)·실질 마감(isJobEffectivelyClosed)은 제외. 후보 없으면 null.
 */
export async function pickJobForCampaignReply(
  supabase: SupabaseClient,
  applicant: { id: number; lat: number | null; lng: number | null }
): Promise<CampaignReplyJobPick | null> {
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
    .select("id, title, status, closes_at, exposure, exposure_rule, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng")
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

  // 지정 노출(targeted) 게이트 — 노출 대상이 아닌 공고로 자동 편입하면 AI 문자로 공고 상세가
  // 미대상에게 새는 우회 경로가 된다(pull 게이팅과 동일 판정). 판정 실패 시 targeted 전부 제외(fail-closed).
  if (jobs.some((j) => j.exposure === "targeted")) {
    try {
      const { data: appRow } = await supabase
        .from("applicants")
        .select("sido, availability, applied_at, created_at")
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
        availability: (appRow as { availability?: string | null } | null)?.availability ?? null,
        applied_at: (appRow as { applied_at?: string | null } | null)?.applied_at ?? null,
        created_at: (appRow as { created_at?: string | null } | null)?.created_at ?? null,
        suntopDone,
      };
      jobs = jobs.filter(
        (j) => j.exposure !== "targeted" || isExposed(exA, normalizeRule(j.exposure_rule), overrides.get(j.id))
      );
    } catch (e) {
      console.error("[engage] campaign-reply exposure gate failed — targeted 공고 제외(fail-closed)", e);
      jobs = jobs.filter((j) => j.exposure !== "targeted");
    }
  }
  if (jobs.length === 0) return null;

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

  // ② 좌표 있으면 앵커(상차지·마지막 경유지 중 가까운 쪽) 최근접 — 파이프라인 거리 정렬과 동일 원칙
  if (typeof applicant.lat === "number" && typeof applicant.lng === "number") {
    const alat = applicant.lat;
    const alng = applicant.lng;
    let best: { job: JobRow; km: number } | null = null;
    for (const j of jobs) {
      const anchors: { lat: number; lng: number }[] = [];
      if (typeof j.pickup_lat === "number" && typeof j.pickup_lng === "number") {
        anchors.push({ lat: j.pickup_lat, lng: j.pickup_lng });
      }
      if (typeof j.dropoff_lat === "number" && typeof j.dropoff_lng === "number") {
        anchors.push({ lat: j.dropoff_lat, lng: j.dropoff_lng });
      }
      if (anchors.length === 0) continue;
      const km = Math.min(...anchors.map((p) => haversineKm(alat, alng, p.lat, p.lng)));
      if (!best || km < best.km) best = { job: j, km };
    }
    if (best) return { jobId: best.job.id, jobTitle: best.job.title, pickedBy: "nearest_anchor" };
  }

  // ③ 최신 활성 공고
  return { jobId: jobs[0].id, jobTitle: jobs[0].title, pickedBy: "latest_active" };
}

/** 관심 클릭 Slack 알림에 병기할 자동 응대 결과 한 줄. 빈 문자열이면 표기 생략. */
export function engageOutcomeLabel(outcome: EngageOutcome): string {
  switch (outcome.action) {
    case "engaged":
      return "⚡ AI 스크리닝 시작됨 — 첫 질문 문자를 자동 발송했어요.";
    case "waitlist_sent":
      return "충원 완료 공고 — 대기 안내 문자 1통 발송(자리·새 공고 시 재안내 약속).";
    case "copilot_manual":
      return "🤖 코파일럿 모드 — 인바운드가 없어 초안 생성 불가. 관심 큐에서 [빠른 컨택]으로 수동 진행해주세요.";
    case "send_failed":
      return "⚠️ AI 첫 문자 발송 실패 — 수동 컨택 필요.";
    case "skipped":
      switch (outcome.reason) {
        case "already_in_progress":
          return "이미 진행 중인 후보 — 자동 발송 생략.";
        case "already_engaged":
          return "이미 이 공고 안내 문자를 받은 후보 — 중복 발송 방지로 생략.";
        case "opt_out":
          return "수신거부 지원자 — 자동 발송 생략.";
        case "job_conflict":
          return "다른 공고 진행 중 — 자동 발송 생략(수동 확인 필요).";
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
