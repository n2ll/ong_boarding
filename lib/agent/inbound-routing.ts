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

import type { SupabaseClient } from "@supabase/supabase-js";
import { isSystemJobTitle } from "../jobs";

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
}

export type InboundRoute =
  | { ok: true; candidate: RoutedCandidate; how: "single" | "text" | "anchor" }
  /** 응대할 후보가 없다 — 풀 답장·수신거부 등 다른 경로의 몫. */
  | { ok: false; reason: "none" }
  /** 활성 후보는 없고 **매니저가 들고 있는 대화(paused)** 만 있다 — AI가 끼어들지 않는다. */
  | { ok: false; reason: "paused" }
  /** 후보가 여럿인데 어느 건인지 정할 수 없다. 고르지 않는다. */
  | { ok: false; reason: "ambiguous"; options: { job_id: number | null; title: string | null }[]; why: "text_multi" | "no_anchor" };

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
 * 인바운드 텍스트가 **어느 공고를 명시했는지** — 후보 공고들 사이에서 유일한 낱말만 근거로 쓴다.
 *
 * 예: 공고가 '용산·한남권 도시락', '강남·신사 도시락' 두 개일 때 '용산'은 유일하니 근거가 되고,
 * '도시락'은 둘 다 가지고 있어 근거가 못 된다(그걸로 고르면 절반은 틀린다).
 * 반환은 **매칭된 공고 id 배열** — 정확히 1건일 때만 채택하는 판단은 호출부(pick)가 한다.
 */
export function matchJobsByText(
  text: string,
  jobs: { job_id: number | null; title: string | null; branch: string | null }[]
): number[] {
  const hay = squash(text);
  if (hay.length < 2) return [];

  // 공고별 후보 낱말: 지점명 + 제목에서 뽑은 2~5자 한글 토큰(괄호·대괄호 안 수식어는 버린다).
  const tokensByJob = new Map<number, Set<string>>();
  const freq = new Map<string, number>();
  for (const j of jobs) {
    if (j.job_id == null) continue;
    const set = new Set<string>();
    const add = (raw: string | null | undefined, maxLen: number) => {
      const t = squash(raw ?? "");
      if (t.length < 2 || t.length > maxLen) return;
      for (const v of tokenVariants(t)) set.add(v);
    };
    add(j.branch, 12);
    const title = (j.title ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
    for (const part of title.split(/[^0-9A-Za-z가-힣]+/)) {
      // 제목 낱말은 지역·라인 이름 길이대로만(2~5자). '배송원'·'모집' 같은 공통어는 아래 유일성 검사가 걸러낸다.
      add(part, 5);
    }
    tokensByJob.set(j.job_id, set);
    for (const t of set) freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  const hit: number[] = [];
  for (const [jobId, set] of tokensByJob) {
    // **다른 후보 공고와 겹치지 않는 낱말**만 근거로 인정한다.
    for (const t of set) {
      if ((freq.get(t) ?? 0) !== 1) continue;
      if (hay.includes(t)) {
        hit.push(jobId);
        break;
      }
    }
  }
  return hit;
}

/**
 * 이 답장을 어느 후보(job_candidate)로 처리할지 고른다.
 *
 * 순서:
 *   1. 자동 응대 단계 후보가 **1건** → 그 후보(공고가 하나면 예전과 100% 동일 동작).
 *   2. 여러 건 + 텍스트가 명시한 공고가 **정확히 1건** → 그 후보.
 *   3. 여러 건 + 텍스트 명시가 2건 이상 → `ambiguous`(text_multi). 고르지 않는다.
 *   4. 여러 건 + 텍스트 명시 없음 → **대화 앵커**(마지막 대화성 outbound의 job_id) → 그 후보.
 *   5. 앵커도 없음 → `ambiguous`(no_anchor).
 *
 * `paused` 후보는 선택 대상이 아니다(매니저가 그 대화를 들고 있다). 활성이 하나도 없고 paused만 있으면
 * `paused`를 돌려준다 — 부르는 쪽은 기존처럼 '매니저가 처리' 로 두고 아무 자동 동작도 하지 않는다.
 * (이 구분을 없애면 매니저가 들고 있는 사람이 캠페인 답장 자동 편입 경로로 새어 들어간다.)
 */
export async function pickCandidateForInbound(
  supabase: SupabaseClient,
  applicantId: number,
  inboundText: string
): Promise<InboundRoute> {
  const { data, error } = await supabase
    .from("job_candidates")
    .select("id, job_id, agent_stage, agent_state, responded_at, created_at, jobs:job_id ( title, branch )")
    .eq("applicant_id", applicantId)
    .in("agent_stage", [...AUTO_ROUTE_STAGES, "paused"])
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[inbound-routing] 후보 조회 실패", error);
    return { ok: false, reason: "none" };
  }

  const all: RoutedCandidate[] = (data ?? []).map((r) => {
    const j = (r.jobs ?? null) as unknown as { title: string | null; branch: string | null } | null;
    return {
      id: r.id as number,
      job_id: (r.job_id as number | null) ?? null,
      agent_stage: (r.agent_stage as string | null) ?? null,
      agent_state: r.agent_state ?? null,
      responded_at: (r.responded_at as string | null) ?? null,
      job_title: j?.title ?? null,
      job_branch: j?.branch ?? null,
    };
  });

  const cands = all.filter((c) => (AUTO_ROUTE_STAGES as readonly string[]).includes(c.agent_stage ?? ""));
  if (cands.length === 0) {
    return all.length > 0 ? { ok: false, reason: "paused" } : { ok: false, reason: "none" };
  }
  if (cands.length === 1) return { ok: true, candidate: cands[0], how: "single" };

  // 시스템 더미 공고(당근·배민 일반라인)는 '어느 공고냐'를 물을 대상이 아니다 —
  // 실공고 후보가 함께 있으면 텍스트·앵커 판단에서 빼고, 그것뿐이면 그대로 쓴다.
  const real = cands.filter((c) => !isSystemJobTitle(c.job_title ?? ""));
  const pool = real.length > 0 ? real : cands;
  if (pool.length === 1) return { ok: true, candidate: pool[0], how: "single" };

  const named = matchJobsByText(
    inboundText,
    pool.map((c) => ({ job_id: c.job_id, title: c.job_title, branch: c.job_branch }))
  );
  if (named.length === 1) {
    const hit = pool.find((c) => c.job_id === named[0]);
    if (hit) return { ok: true, candidate: hit, how: "text" };
  }
  const options = pool.map((c) => ({ job_id: c.job_id, title: c.job_title }));
  if (named.length > 1) return { ok: false, reason: "ambiguous", options, why: "text_multi" };

  // 대화 앵커 — 대량·캠페인 발송은 제외한다(발사 때 그게 마지막 outbound가 된다).
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
  if (anchorJobId != null) {
    const hit = pool.find((c) => c.job_id === anchorJobId);
    if (hit) return { ok: true, candidate: hit, how: "anchor" };
  }
  return { ok: false, reason: "ambiguous", options, why: "no_anchor" };
}

/** 공고 제목을 문자에 넣을 만큼 짧게 — 지점명이 있으면 그것을 쓴다. */
function shortJobLabel(o: { job_id: number | null; title: string | null }): string {
  const t = (o.title ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return `공고 ${o.job_id ?? "?"}`;
  return t.length > 16 ? t.slice(0, 16) + "…" : t;
}

/** 되묻기 이력(24시간) — 같은 사람에게 되묻기를 반복하지 않기 위한 근거. */
export const ROUTE_ASK_EVENT = "route_ask";

/**
 * 어느 공고인지 정할 수 없을 때의 처리 — **세 인입 경로가 똑같이 행동하게** 여기 모아 둔다.
 *
 * · AI 자동 모드이고 24시간 안에 되묻지 않았다면 → **한 번만 되묻는다.**
 * · 그 외(코파일럿·중지 모드거나, 이미 되물었는데 또 갈렸다면) → **활성 후보 전부를 보류로 내리고**
 *   매니저에게 넘긴다. 아무 공고나 골라 응대하는 것보다 안전하고, 실무자 큐는 '한 사람 = 한 카드'로
 *   묶여 보이므로(M5) 여러 건이 보류돼도 카드가 불어나지 않는다.
 *
 * 되묻기 문자는 `job_id`를 비워서 기록한다 — 채우면 그 문자가 다음 답장의 '대화 앵커'가 되어,
 * 판별 못 한 공고를 판별한 것처럼 만들어 버린다.
 */
export async function handleAmbiguousInbound(
  supabase: SupabaseClient,
  args: {
    applicantId: number;
    phone: string | null;
    applicantName: string | null;
    options: { job_id: number | null; title: string | null }[];
    why: "text_multi" | "no_anchor";
    mode: "auto" | "draft" | "off";
    sendSms: (phone: string, text: string) => Promise<{ success: boolean; messageId?: string | null; error?: string }>;
    notify?: (text: string) => Promise<unknown>;
  }
): Promise<{ asked: boolean; pausedCandidates: number }> {
  const { applicantId, phone, applicantName, options, why, mode } = args;
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

  if (mode === "auto" && !askedRecently && phone && !optedOut) {
    // 확정 뉘앙스 금지 — 어느 자리 이야기인지만 묻는다. 진행·합격 암시 없음.
    const text =
      `안녕하세요, 옹보딩입니다. 지금 여러 자리를 함께 안내드리고 있어서 어느 자리 말씀인지 확인이 필요해요.\n` +
      `${listed}\n` +
      `지역 이름으로 답장해 주시면 그 자리 기준으로 안내드릴게요.`;
    const r = await args.sendSms(phone, text);
    if (r.success) {
      await supabase.from("messages").insert({
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
      await supabase.from("pool_events").insert({
        applicant_id: applicantId,
        event_type: ROUTE_ASK_EVENT,
        meta: { why, options: options.map((o) => o.job_id) },
      });
      await args.notify?.(`❓ ${label} 답장이 어느 공고 건인지 판별 불가(${why}) — 한 번 되물었어요. 후보: ${listed}`);
      return { asked: true, pausedCandidates: 0 };
    }
    console.error("[inbound-routing] 되묻기 발송 실패", r.error);
  }

  // 되묻지 못했거나 이미 되물었다 → 매니저에게 넘긴다(활성 후보 전부 보류).
  const { data: paused, error: pauseErr } = await supabase
    .from("job_candidates")
    .update({
      agent_stage: "paused",
      paused_reason: "답장이 어느 공고 건인지 판별 불가 — 매니저 확인 필요",
    })
    .eq("applicant_id", applicantId)
    .in("agent_stage", AUTO_ROUTE_STAGES as unknown as string[])
    .select("id");
  if (pauseErr) console.error("[inbound-routing] 보류 전환 실패", pauseErr);
  const n = (paused ?? []).length;
  await args.notify?.(
    `🙋 ${label} 답장이 어느 공고 건인지 판별 불가(${why}) — 공고 ${n}건을 보류로 내리고 넘겼어요. 후보: ${listed}` +
      (mode === "auto" ? " (이미 한 번 되물은 뒤예요)" : ` (AI 모드 ${mode})`)
  );
  return { asked: false, pausedCandidates: n };
}

/** 되묻기·인계 로그용 한 줄 — 매니저가 Slack·콘솔에서 바로 읽을 수 있게. */
export function describeRoute(route: InboundRoute): string {
  if (route.ok) return `job ${route.candidate.job_id} (${route.how})`;
  if (route.reason === "none") return "응대 대상 후보 없음";
  if (route.reason === "paused") return "매니저가 들고 있는 대화(보류)만 있음";
  return `공고 판별 불가(${route.why}) — 후보 ${route.options.length}건: ${route.options
    .map((o) => o.title ?? `#${o.job_id}`)
    .join(" / ")}`;
}
