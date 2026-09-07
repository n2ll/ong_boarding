/**
 * 답장이 **어느 공고 건인지** 고르는 단일 판정.
 *
 * 왜 필요한가: 같은 질문에 세 답이 있었다.
 *   · 인입 웹훅        — 활성 후보 전부 로드 → '직전 outbound의 job_id'를 앵커로 선택 → 폴백 최신
 *   · inbound-sweeper  — 활성 단계 후보 **최신 1건**(앵커 없음)
 *   · /api/agent/draft — 단계 무관 **최신 1건**(그게 abort면 자동 응대 자체가 안 됨)
 * 같은 답장이 어느 경로로 잡히느냐에 따라 다른 공고로 응대됐다. 공고 6~7개를 동시에 열면
 * 한 사람이 여러 공고에 붙는 것이 기본 상태이므로, 이 갈림이 곧 오귀속이 된다.
 *
 * ⚠️ **앵커에서 대량·캠페인 발송을 제외한다.** 공고 안내를 대량 발송하면 그 문자가 '직전 outbound'가
 *    되어, 다른 공고로 대화 중이던 사람의 답장까지 마지막 발송 공고로 몰린다. 앵커는 **대화**
 *    (에이전트 자동 응답·매니저 답장)만 본다.
 * ⚠️ **추측 금지** — 어느 공고인지 정할 수 없으면 고르지 않고 `ambiguous`로 돌려준다.
 *    부르는 쪽이 되묻거나 매니저에게 넘긴다. 아무거나 골라 응대하면 지원자는 묻지 않은 자리의
 *    답을 받고, 매니저는 그 사실을 알 수 없다.
 * ⚠️ 확정 뉘앙스 금지 — 이 모듈은 '어느 대화인가'만 정한다. 확정·배정과 무관하다.
 */

import { withConversationReplyClaim } from "./conversation-reply-claim.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isJobEffectivelyClosed, isSystemJobTitle } from "../jobs.ts";

/** AI가 자동 응대를 맡는 단계(paused·abort·null 제외). */
export const AUTO_ROUTE_STAGES = ["exploration", "screening", "onboarding", "active"] as const;

export interface RoutedCandidate {
  id: number;
  job_id: number | null;
  agent_stage: string | null;
  agent_state: unknown;
  responded_at: string | null;
  job_title: string | null;
  job_branch: string | null;
  unavailable?: boolean;
}

export type InboundRoute =
  | { ok: true; candidate: RoutedCandidate; how: "single" | "text" | "anchor" | "focus" | "consultation" }
  /** 응대할 후보가 없다 — 풀 답장·수신거부 등 다른 경로의 몫. */
  | { ok: false; reason: "none" }
  /** 활성 후보는 없고 **매니저가 들고 있는 대화(paused)** 만 있다 — AI가 끼어들지 않는다. */
  | { ok: false; reason: "paused" }
  /** 후보가 여럿인데 어느 건인지 정할 수 없다. 고르지 않는다. */
  | {
      ok: false;
      reason: "ambiguous";
      options: { job_id: number | null; title: string | null; branch: string | null }[];
      focusJobId?: number;
      why: "text_multi" | "no_anchor" | "text_vs_anchor" | "text_vs_focus";
    };

/**
 * 앵커로 인정하는 발송 — **대화**만.
 * `system-bulk`(대량·캠페인)·`agent-engage`(공고 자동 안내)는 제외한다: 둘 다 '이쪽으로 말을 걸었다'는
 * 뜻일 뿐이고, 진행 중인 다른 공고 대화를 덮을 근거가 못 된다(발사 때 이 둘이 대량으로 나간다).
 */
export const CONVERSATIONAL_SENT_BY = ["system-auto", "관리자", "agent"] as const;

/** 한글·영문·숫자만 남긴다 — 띄어쓰기·기호 차이로 매칭이 갈리지 않게. */
function squash(s: string): string {
  return s.replace(/[^0-9A-Za-z가-힣]/g, "");
}

/**
 * 지역 낱말의 접미사 변형을 함께 등록한다 — `한남권`·`강남구`처럼 공고 제목엔 접미사가 붙지만
 * 지원자는 `한남`·`강남`이라고 쓴다.
 *
 * 이게 없으면 두 방향으로 틀린다(둘 다 실제로 재현했다):
 *  · `용산·한남권` 공고에 "한남 쪽은요?" → 못 알아본다(되묻기로 새어 매니저 일이 늘어난다).
 *  · `강남권` 공고와 `강남·신사` 공고가 있을 때 "강남 자리요" → 접미사가 달라 서로 다른 낱말로
 *    세어져 **한쪽에만 유일**해지고, 확신에 찬 오판으로 그 공고를 골라버린다.
 */
function tokenVariants(t: string): string[] {
  const out = [t];
  if (t.length >= 3 && /[권구시동읍면리쪽]$/.test(t)) out.push(t.slice(0, -1));
  return out;
}

/**
 * 공고를 **가리키지 못하는 낱말** — 제목에 흔히 들어가지만 자리를 구분하지 않는 말.
 *
 * 이게 없으면 '유일성 검사'가 안전판 역할을 못 한다. 유일성은 그 지원자의 후보(보통 2~3건) 안에서만
 * 세기 때문에, 후보가 적을수록 일반명사가 쉽게 '유일'해진다. 실측으로 재현된 오판:
 * 후보가 `긴급 백업 배송원 모집`과 도시락 공고 두 건일 때 "이 모집 아직 하나요?"·"배송원 지원했는데요"가
 * 긴급 공고로 라우팅됐다. 시간대 낱말은 더 위험하다 — 스크리닝이 지원자에게 직접 묻는 말이
 * "평일 오전·오후, 주말 오전·오후 중 어느 때가 편하세요?"인데, 그 답이 곧 라우팅 근거가 된다.
 */
const NON_DISTINGUISHING = new Set([
  // 직무·모집 일반어
  "모집", "채용", "지원", "배송", "배송원", "기사", "라인", "업무", "근무", "일자리", "구인",
  "긴급", "백업", "대체", "증차", "추가", "상시", "단기", "장기", "정규", "계약", "파트", "알바",
  "초보", "경력", "신입", "남녀", "무관", "기업", "도시락", "식자재", "물류", "센터", "지점",
  // 시간·요일 — 스크리닝 질문의 답이 그대로 들어온다
  "평일", "주말", "매일", "오전", "오후", "야간", "새벽", "아침", "저녁", "점심", "종일", "주5일", "주6일",
  // 급여 단위
  "일당", "주급", "월급", "시급", "건당", "단가", "급여",
]);

/** 그 낱말이 자리를 가리킬 수 있나 — 숫자 포함·일반어는 근거로 쓰지 않는다. */
function usableToken(t: string): boolean {
  if (t.length < 2) return false;
  if (/[0-9]/.test(t)) return false;
  return !NON_DISTINGUISHING.has(t);
}

/**
 * 인바운드 텍스트가 **어느 공고를 명시했는지** — 후보 공고들 사이에서 유일한 낱말만 근거로 쓴다.
 *
 * 예: 공고가 '용산·한남권 도시락', '강남·신사 도시락' 두 개일 때 '용산'은 유일하니 근거가 되고,
 * '도시락'은 둘 다 가지고 있어 근거가 못 된다(그걸로 고르면 절반은 틀린다).
 * 반환은 **매칭된 공고 id 배열** — 정확히 1건일 때만 채택하는 판단은 호출부(pick)가 한다.
 */
export type JobTokenSource = { job_id: number | null; title: string | null; branch: string | null };

/** 공고별 **유일 낱말** 집합 — 매칭과 되묻기 문구가 같은 계산을 쓰게 하는 단일 소스. */
function uniqueTokensByJob(jobs: JobTokenSource[]): Map<number, string[]> {
  const tokensByJob = new Map<number, Set<string>>();
  const freq = new Map<string, number>();
  for (const j of jobs) {
    if (j.job_id == null) continue;
    const set = new Set<string>();
    const add = (raw: string | null | undefined, maxLen: number) => {
      const t = squash(raw ?? "");
      if (t.length < 2 || t.length > maxLen) return;
      for (const v of tokenVariants(t)) if (usableToken(v)) set.add(v);
    };
    add(j.branch, 12);
    const title = (j.title ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
    for (const part of title.split(/[^0-9A-Za-z가-힣]+/)) {
      // 제목 낱말은 지역·라인 이름 길이대로만(2~5자).
      add(part, 5);
    }
    tokensByJob.set(j.job_id, set);
    for (const t of set) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const out = new Map<number, string[]>();
  for (const [jobId, set] of tokensByJob) {
    // **다른 후보 공고와 겹치지 않는 낱말**만 근거로 인정한다.
    out.set(jobId, [...set].filter((t) => (freq.get(t) ?? 0) === 1).sort((a, b) => b.length - a.length));
  }
  return out;
}

/**
 * 되묻기 문구에 쓸 **그 공고를 가리키는 한 낱말**(유일 낱말 중 가장 긴 것). 없으면 null.
 * 문구와 매처가 다른 계산을 쓰면, 지원자가 문구대로 답해도 매칭이 안 되는 일이 생긴다(실제로 났다).
 */
export function distinguishingTokens(jobs: JobTokenSource[]): Map<number, string | null> {
  const uniq = uniqueTokensByJob(jobs);
  const out = new Map<number, string | null>();
  for (const [jobId, list] of uniq) out.set(jobId, list[0] ?? null);
  return out;
}

export function matchJobsByText(text: string, jobs: JobTokenSource[]): number[] {
  const hay = squash(text);
  if (hay.length < 2) return [];
  const hit: number[] = [];
  for (const [jobId, tokens] of uniqueTokensByJob(jobs)) {
    if (tokens.some((t) => hay.includes(t))) hit.push(jobId);
  }
  return hit;
}

/** 명시적으로 선택한 공고가 준비되지 않았으면 다른 후보로 우회하지 않는다. */
export function chooseInboundCandidate(args: {
  candidates: RoutedCandidate[];
  inboundText: string;
  focusJobId: number | null;
  anchorJobId: number | null;
  focusAt?: string | null;
  receivedAt?: string | null;
  /** 상담 시 candidate는 잠금·처리 이력의 소유자일 뿐, 문의 대상/진행 공고를 바꾸지 않는다. */
  allowConsultation?: boolean;
}): InboundRoute {
  const { candidates: all, inboundText, focusJobId, anchorJobId } = args;
  if (focusJobId != null && args.focusAt && (!args.receivedAt || !Number.isFinite(Date.parse(args.receivedAt)) || Date.parse(args.receivedAt) < Date.parse(args.focusAt))) {
    return { ok: false, reason: "paused" };
  }
  const cands = all.filter((c) => (AUTO_ROUTE_STAGES as readonly string[]).includes(c.agent_stage ?? ""));
  const focus = focusJobId == null ? null : cands.find((c) => c.job_id === focusJobId);
  if (focusJobId != null && (!focus || focus.unavailable)) return { ok: false, reason: "paused" };
  if (!cands.length) return { ok: false, reason: all.some((c) => c.agent_stage === "paused") ? "paused" : "none" };

  // 관심만 남긴 공고의 이름도 충돌 신호로 인식한다.
  const real = all.filter((c) => !isSystemJobTitle(c.job_title));
  const pool = real.length ? real : all;
  const options = pool.map((c) => ({ job_id: c.job_id, title: c.job_title, branch: c.job_branch }));
  const named = matchJobsByText(inboundText, options);
  const anchor = cands.find((c) => c.job_id === anchorJobId && !c.unavailable);
  if (args.allowConsultation) {
    const owner = focus ?? anchor ?? cands.find((c) => !c.unavailable);
    const crossesOwner = owner && named.some((id) => id !== owner.job_id);
    if (owner && (named.length > 1 || crossesOwner || (!focus && !anchor && cands.length > 1))) {
      return { ok: true, candidate: owner, how: "consultation" };
    }
  }
  if (named.length > 1) return { ok: false, reason: "ambiguous", options, ...(focusJobId == null ? {} : { focusJobId }), why: "text_multi" };
  if (focus) {
    if (named.length && named[0] !== focus.job_id) return { ok: false, reason: "ambiguous", options, focusJobId: focus.job_id ?? undefined, why: "text_vs_focus" };
    return { ok: true, candidate: focus, how: "focus" };
  }
  if (named.length === 1) {
    const hit = cands.find((c) => c.job_id === named[0]);
    if (!hit) return { ok: false, reason: "paused" };
    if (anchor && anchor.job_id !== hit.job_id) return { ok: false, reason: "ambiguous", options, why: "text_vs_anchor" };
    return { ok: true, candidate: hit, how: "text" };
  }
  if (anchor) return { ok: true, candidate: anchor, how: "anchor" };
  if (cands.length === 1) return { ok: true, candidate: cands[0], how: "single" };
  return { ok: false, reason: "ambiguous", options, why: "no_anchor" };
}

export async function pickCandidateForInbound(
  supabase: SupabaseClient,
  applicantId: number,
  inboundText: string,
  receivedAt?: string
): Promise<InboundRoute> {
  const { data, error } = await supabase
    .from("job_candidates")
    .select("id, job_id, agent_stage, agent_state, responded_at, created_at, closed_at, closed_reason, jobs:job_id ( title, branch, status, closes_at )")
    .eq("applicant_id", applicantId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[inbound-routing] 후보 조회 실패", error);
    return { ok: false, reason: "paused" };
  }

  const all: RoutedCandidate[] = (data ?? []).map((r) => {
    const j = (r.jobs ?? null) as unknown as { title: string | null; branch: string | null; status: string | null; closes_at: string | null } | null;
    return {
      id: r.id as number,
      job_id: (r.job_id as number | null) ?? null,
      agent_stage: (r.agent_stage as string | null) ?? null,
      agent_state: r.agent_state ?? null,
      responded_at: (r.responded_at as string | null) ?? null,
      job_title: j?.title ?? null,
      job_branch: j?.branch ?? null,
      unavailable: !!r.closed_at || !!r.closed_reason || (!isSystemJobTitle(j?.title) && (!j || isJobEffectivelyClosed(j.status, j.closes_at))),
    };
  });

  const { data: applicant, error: focusError } = await supabase.from("applicants")
    .select("conversation_focus_job_id, conversation_focus_at").eq("id", applicantId).maybeSingle();
  if (focusError || !applicant) return { ok: false, reason: "paused" };
  const focusJobId = (applicant.conversation_focus_job_id as number | null) ?? null;
  if (focusJobId != null) return chooseInboundCandidate({ candidates: all, inboundText, focusJobId, anchorJobId: null, focusAt: applicant.conversation_focus_at, receivedAt, allowConsultation: true });

  // 대화 앵커 — 대량·캠페인 발송은 제외한다(발사 때 그게 마지막 outbound가 된다).
  // **시스템 더미 공고 후보까지 포함해** 찾는다. 예전엔 실공고만 남기고 앵커를 봐서, 당근·배민
  // 일반라인으로 대화 중인 사람이 실공고에 후보로 올라간 순간 그 대화가 실공고로 통째 재라우팅됐다.
  const { data: lastOut } = await supabase
    .from("messages")
    .select("job_id")
    .eq("applicant_id", applicantId)
    .eq("direction", "outbound")
    .in("sent_by", CONVERSATIONAL_SENT_BY as unknown as string[])
    .not("job_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const anchorJobId = (lastOut?.job_id as number | null) ?? null;
  return chooseInboundCandidate({ candidates: all, inboundText, focusJobId, anchorJobId, allowConsultation: true });
}

/** 공고 제목을 문자에 넣을 만큼 짧게 — 괄호 수식어를 떼고 앞부분만. */
function shortJobLabel(o: { job_id: number | null; title: string | null; branch: string | null }): string {
  const t = (o.title ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const base = t || `공고 ${o.job_id ?? "?"}`;
  const head = base.length > 16 ? base.slice(0, 16) + "…" : base;
  // 제목이 같고 지점만 다른 공고가 있으면 문자에 똑같은 줄이 두 번 찍힌다 — 지점을 붙여 구분한다.
  return o.branch && o.branch.trim() ? `${head} (${o.branch.trim()})` : head;
}

/** 되묻기 이력(24시간) — 같은 사람에게 되묻기를 반복하지 않기 위한 근거. */
export const ROUTE_ASK_EVENT = "route_ask";

/**
 * 어느 공고인지 정할 수 없을 때의 처리 — **세 인입 경로가 똑같이 행동하게** 여기 모아 둔다.
 *
 * · AI 전역 '중지(off)'면 **아무것도 하지 않는다** — 되묻기도 보류도 없다(킬스위치 계약).
 * · AI 자동 모드이고, 이번 답장이 수신거부 신호가 아니고, 24시간 안에 되묻지 않았고,
 *   **각 자리를 가리킬 낱말이 실제로 있으면** → 한 번만 되묻는다.
 * · 그 외 → 활성 후보를 보류로 내리고 매니저에게 넘긴다. 아무 공고나 골라 응대하는 것보다 안전하고,
 *   실무자 큐는 '한 사람 = 한 카드'로 묶여 보인다(M5).
 *
 * 되묻기 문자는 `job_id`를 비워서 기록한다 — 채우면 그 문자가 다음 답장의 '대화 앵커'가 되어,
 * 판별 못 한 공고를 판별한 것처럼 만들어 버린다.
 */
export async function handleAmbiguousInbound(
  supabase: SupabaseClient,
  args: Parameters<typeof handleClaimedAmbiguousInbound>[1]
): Promise<{ asked: boolean; pausedCandidates: number }> {
  if (args.mode === "off") return { asked: false, pausedCandidates: 0 };
  const jobId = args.focusJobId ?? args.options.find((option) => option.job_id != null)?.job_id;
  if (jobId == null) return { asked: false, pausedCandidates: 0 };
  const claimed = await withConversationReplyClaim({
    applicantId: args.applicantId, jobId, receivedAt: args.receivedAt, inboundMessageId: args.inboundMessageId,
    rpc: (name, params) => supabase.rpc(name, params),
    run: () => handleClaimedAmbiguousInbound(supabase, args),
    retainClaim: (result) => result.delivery_uncertain === true,
  });
  return claimed.executed ? claimed.result : { asked: false, pausedCandidates: 0 };
}

async function handleClaimedAmbiguousInbound(
  supabase: SupabaseClient,
  args: {
    applicantId: number;
    phone: string | null;
    applicantName: string | null;
    options: { job_id: number | null; title: string | null; branch: string | null }[];
    why: "text_multi" | "no_anchor" | "text_vs_anchor" | "text_vs_focus";
    mode: "auto" | "draft" | "off";
    /** 이번 답장이 '그만 보내세요'로 분류됐나(null=분류 못 함). true면 되묻기 문자를 보내지 않는다. */
    inboundOptOut?: boolean | null;
    focusJobId?: number;
    receivedAt?: string;
    inboundMessageId?: string;
    sendSms: (phone: string, text: string) => Promise<{ success: boolean; messageId?: string | null; error?: string; failureKind?: "declared" | "unknown" }>;
    canRespond?: () => Promise<boolean>;
    notify?: (text: string) => Promise<unknown>;
  }
): Promise<{ asked: boolean; pausedCandidates: number; delivery_uncertain?: boolean }> {
  const { applicantId, phone, applicantName, options, why, mode } = args;
  let deliveryUncertain = false;

  // 전역 '완전 중지'는 아무 전이도 하지 않는다 — router·sweeper와 같은 계약.
  // 이 답장은 매니저가 실시간 응대에서 직접 본다.
  if (mode === "off") return { asked: false, pausedCandidates: 0 };

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: asks } = await supabase
    .from("pool_events")
    .select("id")
    .eq("applicant_id", applicantId)
    .eq("event_type", ROUTE_ASK_EVENT)
    .gte("created_at", since);
  const askedRecently = (asks ?? []).length > 0;

  const { data: appRow } = await supabase
    .from("applicants")
    .select("sms_opt_out_at")
    .eq("id", applicantId)
    .maybeSingle();
  const optedOut = (appRow as { sms_opt_out_at?: string | null } | null)?.sms_opt_out_at != null;

  const label = `${applicantName ?? `지원자 ${applicantId}`}님`;
  const listed = options.map(shortJobLabel).join(" / ");

  // **되묻기 문구는 매처와 같은 계산으로 만든다.** 예전엔 "지역 이름으로 답장해 주세요"라고만 적었는데,
  // 후보 제목이 `강남권`·`강남·신사`처럼 겹치면 '강남'은 유일 낱말이 아니어서 원리상 매칭이 안 된다 —
  // 지원자가 지시대로 답해도 다시 판별 불가가 되고, 그때는 이미 되물은 뒤라 전 공고가 보류로 떨어졌다.
  const tokens = distinguishingTokens(options);
  const askable = options.every((o) => o.job_id != null && tokens.get(o.job_id));

  let sendFailed = false;
  if (why !== "text_vs_focus" && mode === "auto" && !askedRecently && phone && !optedOut && args.inboundOptOut !== true && askable) {
    // 확정 뉘앙스 금지 — 어느 자리 이야기인지만 묻는다. 진행·합격 암시 없음.
    const lines = options.map((o) => `· ${shortJobLabel(o)} → '${tokens.get(o.job_id as number)}'`);
    const text = [
      `${label} 지금 여러 자리를 함께 안내드리고 있어 어느 자리 말씀인지 확인이 필요해요.`,
      ...lines,
      `따옴표 안 낱말을 그대로 보내주시면 그 자리 기준으로 안내드릴게요.`,
    ].join("\n");
    if (args.canRespond && !await args.canRespond()) return { asked: false, pausedCandidates: 0 };
    const r = await args.sendSms(phone, text);
    if (r.success) {
      const { error: recordError } = await supabase.from("messages").insert({
        applicant_id: applicantId,
        applicant_phone: phone,
        direction: "outbound",
        body: text,
        status: "sent",
        sent_by: "system-auto",
        solapi_msg_id: r.messageId ?? null,
        message_type: "sms",
        // job_id는 비운다 — 이 문자가 앵커가 되면 판별 못 한 공고를 판별한 것처럼 만든다.
        job_id: null,
      });
      if (recordError) {
        // 성공한 발송의 원장을 저장하지 못하면 다시 묻지 않고 잠금을 유지한다.
        console.error("[inbound-routing] 되묻기 발송 원장 저장 실패", recordError);
        return { asked: true, pausedCandidates: 0, delivery_uncertain: true };
      }
      await supabase.from("pool_events").insert({
        applicant_id: applicantId,
        event_type: ROUTE_ASK_EVENT,
        meta: { why, options: options.map((o) => o.job_id) },
      });
      await args.notify?.(`❓ ${label} 답장이 어느 공고 건인지 판별 불가(${why}) — 한 번 되물었어요. 후보: ${listed}`);
      return { asked: true, pausedCandidates: 0 };
    }
    sendFailed = true;
    deliveryUncertain = r.failureKind !== "declared";
    console.error("[inbound-routing] 되묻기 발송 실패", r.error);
  }

  if (!sendFailed && mode === "auto" && args.canRespond && !await args.canRespond()) return { asked: false, pausedCandidates: 0 };

  // 되묻지 못했거나 이미 되물었다 → 매니저에게 넘긴다(활성 후보 전부 보류).
  // **직전 단계를 행마다 남긴다** — 없으면 'AI 재개'가 exploration으로 되돌려 온보딩 안내가 다시 나간다
  // (lib/agent/transitions.ts의 pause와 같은 규약: meta.paused_from_stage).
  const { data: activeRows } = await supabase
    .from("job_candidates")
    .select("id, agent_stage, agent_state")
    .eq("applicant_id", applicantId)
    .in("agent_stage", AUTO_ROUTE_STAGES as unknown as string[]);
  const now = new Date().toISOString();
  const reason = "답장이 어느 공고 건인지 판별 불가 — 매니저 확인 필요";
  let paused = 0;
  for (const row of activeRows ?? []) {
    const prevState = ((row.agent_state ?? {}) as Record<string, unknown>) ?? {};
    const prevMeta = ((prevState.meta ?? {}) as Record<string, unknown>) ?? {};
    const { error: upErr } = await supabase
      .from("job_candidates")
      .update({
        agent_stage: "paused",
        paused_reason: reason,
        agent_state: {
          ...prevState,
          meta: {
            ...prevMeta,
            paused_from_stage: row.agent_stage,
            paused_at: now,
            paused_by: "inbound-routing",
            pause: { category: "cross_job", summary: reason, suggested_action: "어느 자리 문의인지 확인하고 그 공고 탭에서 답해 주세요." },
          },
        },
      })
      .eq("id", row.id as number);
    if (upErr) console.error("[inbound-routing] 보류 전환 실패", upErr);
    else paused += 1;
  }

  const whyAsked = sendFailed
    ? "되묻기 문자 발송이 실패했어요"
    : !askable
      ? "공고 제목이 서로 겹쳐 되물을 낱말을 만들 수 없어요"
      : askedRecently
        ? "이미 한 번 되물은 뒤예요"
        : args.inboundOptOut === true
          ? "이번 답장이 수신거부로 분류돼 되묻지 않았어요"
          : `AI 모드 ${mode}`;
  await args.notify?.(
    `🙋 ${label} 답장이 어느 공고 건인지 판별 불가(${why}) — 공고 ${paused}건을 보류로 내리고 넘겼어요. 후보: ${listed} (${whyAsked})`
  );
  return { asked: false, pausedCandidates: paused, delivery_uncertain: deliveryUncertain };
}

/** 되묻기·인계 로그용 한 줄 — 매니저가 Slack·콘솔에서 바로 읽을 수 있게. */
export function describeRoute(route: InboundRoute): string {
  if (route.ok) return `job ${route.candidate.job_id} (${route.how})`;
  if (route.reason === "none") return "응대 대상 후보 없음";
  if (route.reason === "paused") return "매니저가 들고 있는 대화(보류)만 있음";
  if (route.why === "text_vs_anchor" || route.why === "text_vs_focus") {
    return `텍스트가 가리킨 공고와 진행 중 대화가 다름 — 후보 ${route.options.length}건: ${route.options
      .map((o) => o.title ?? `#${o.job_id}`)
      .join(" / ")}`;
  }
  return `공고 판별 불가(${route.why}) — 후보 ${route.options.length}건: ${route.options
    .map((o) => o.title ?? `#${o.job_id}`)
    .join(" / ")}`;
}
