/**
 * GET /api/admin/cron/inbound-sweeper
 *
 * 유실 인입 회수 cron (10분 간격) — 마지막 안전망.
 *
 * 배경(2026-07-13 실사고): 지원자 답장이 DB에 저장되고 웹훅도 발사됐지만, 배포 직후
 * 콜드 스타트 + pg_net 10초 강제 종료가 겹쳐 처리 함수가 흔적 없이 소멸(송시권 "QM6입니다"
 * 20시간 무응답). 웹훅은 1회 발사·재시도 없음이라 어떤 복구 장치에도 안 걸렸다.
 * 웹훅 즉시 ACK 분리(waitUntil)로 원인의 대부분을 제거했지만, 핸들러 시작 전 취소 같은
 * 극단 케이스는 남는다 — 이 cron이 원인 불문 15분 내 회수를 보장한다.
 *
 * 흐름:
 *  1. requireCronAuth + getAgentMode — off면 아무것도 안 함(사람이 전역 정지한 상태).
 *  2. KST 09~21시만 동작(야간엔 대상 유지, 아침 첫 주기에 자연 처리 — recovery와 동일 원칙).
 *  3. 대상: 최근 13시간 내(야간 공백 21→09시 커버) + 5분 유예(정상 웹훅 처리는 답장 텀 포함
 *     최대 ~2분 — 진행 중인 건과의 이중 응답 방지)가 지난 인바운드 중,
 *     지원자별 최신 인바운드가 다음을 모두 만족:
 *       a. 지원자에게 AI 담당 단계(exploration/screening/onboarding/active) 후보가 있음
 *          (paused=매니저 인계, abort/null=응대 대상 아님 → 제외)
 *       b. 그 인바운드 이후 어떤 outbound도 없음 (AI 답장·매니저 답장·마감 안내 등이
 *          있었다면 이미 응답된 것)
 *       c. 그 인바운드에 대한 message_drafts가 없음 (코파일럿 초안 대기 = 처리된 것)
 *       d. agent_state.meta.last_run_at < 인바운드 시각 (AI가 이미 소화한 턴 제외 —
 *          빈 응답 stay 같은 희귀 케이스의 재응답 루프 방지)
 *  4. 회수: 웹훅과 동일하게 runAgentForCandidate(최신 인바운드) — received_at이 과거라
 *     답장 텀 없이 즉시 처리. 킬스위치·확정 뉘앙스 백스톱·마감 안내 모드 전부 기존 경로 그대로.
 *  5. Slack 요약(회수 N건) — 0건이면 무발송. 회수는 유실이 실제 있었다는 뜻이라 반드시 알린다.
 *
 * 조회창을 13시간으로 제한하는 이유: 너무 오래된 인입에 뒤늦은 AI 답장이 나가는 것을 방지
 * (그런 건은 미답 큐에서 매니저가 판단). 2026-07-13 유실분(QM6)도 이 창 밖이라 대상이 아니다
 * — 해당 건은 #33 마감 안내로 별도 해소.
 *
 * 인증: Authorization: Bearer CRON_SECRET (requireCronAuth — 미설정 시 fail-closed).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { requireCronAuth } from "@/lib/cron-auth";
import { sendSlackText } from "@/lib/slack";
import { getAgentMode } from "@/lib/agent/kill-switch";
import { runAgentForCandidate } from "@/lib/agent/router";
import { pickCandidateForInbound, handleAmbiguousInbound } from "@/lib/agent/inbound-routing";
import { classifyAvailabilitySignal } from "@/lib/agent/availability";
import { sendSms } from "@/lib/solapi";
import type { AgentState } from "@/lib/agent/types";

export const dynamic = "force-dynamic";
// 회수 건당 Claude 호출 + SMS 발송 — 배치 상한(10명) × 건당 수 초 + 여유
export const maxDuration = 300;

const SWEEP_WINDOW_MS = 13 * 60 * 60 * 1000; // 야간 공백(21→09시, 12h) + 여유 1h
const GRACE_MS = 5 * 60 * 1000; // 정상 웹훅 처리(답장 텀 최대 ~2분)와의 경합 방지
const BATCH_LIMIT = 10;

const ACTIVE_STAGES = ["exploration", "screening", "onboarding", "active"] as const;

interface InboundRow {
  id: string | number;
  applicant_id: number;
  body: string | null;
  created_at: string;
}

interface ResultEntry {
  applicant_id: number;
  candidate_id?: number;
  action: string;
  reason?: string;
  reply_sent?: boolean;
  draft_created?: boolean;
}

export async function GET(req: NextRequest) {
  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  const supabase = createServiceClient();

  const mode = await getAgentMode(supabase);
  if (mode === "off") {
    return NextResponse.json({ mode, swept: 0, note: "mode off — 회수 안 함" });
  }

  const kstHour = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
  if (kstHour < 9 || kstHour >= 21) {
    return NextResponse.json({ mode, swept: 0, note: `야간(KST ${kstHour}시) — 09시 이후 처리` });
  }

  const now = Date.now();
  const since = new Date(now - SWEEP_WINDOW_MS).toISOString();
  const until = new Date(now - GRACE_MS).toISOString();

  // 조회창 내 인바운드 → 지원자별 최신 1건만 (오래된 것부터 정렬 후 Map 덮어쓰기)
  const { data: inbounds, error: inErr } = await supabase
    .from("messages")
    .select("id, applicant_id, body, created_at")
    .eq("direction", "inbound")
    .not("applicant_id", "is", null)
    .gte("created_at", since)
    .lte("created_at", until)
    .order("created_at", { ascending: true })
    .limit(500);
  if (inErr) {
    console.error("[inbound-sweeper] inbound query error", inErr);
    return NextResponse.json({ error: inErr.message }, { status: 500 });
  }
  const latestByApplicant = new Map<number, InboundRow>();
  for (const m of (inbounds ?? []) as InboundRow[]) {
    latestByApplicant.set(m.applicant_id, m);
  }
  if (latestByApplicant.size === 0) {
    return NextResponse.json({ mode, swept: 0, checked: 0 });
  }

  const results: ResultEntry[] = [];
  let swept = 0;
  const sweptNames: string[] = [];

  for (const [applicantId, inbound] of latestByApplicant) {
    if (swept >= BATCH_LIMIT) break;
    try {
      // b) 인바운드 이후 outbound가 있으면 이미 응답된 것 — 제외
      const { data: outAfter } = await supabase
        .from("messages")
        .select("id")
        .eq("applicant_id", applicantId)
        .eq("direction", "outbound")
        .gt("created_at", inbound.created_at)
        .limit(1);
      if (outAfter && outAfter.length > 0) continue;

      // a) 이 인바운드에 대한 초안(코파일럿 pending/auto_sent 기록)이 있으면 처리된 것 — 제외
      //    ⚠️ 라우팅·보류보다 **먼저** 본다. 이미 초안이 걸린 인바운드로 후보를 보류시키면
      //    매니저가 검토 중인 대화를 뒤에서 멈추는 셈이 된다.
      const { data: drafts } = await supabase
        .from("message_drafts")
        .select("id")
        .eq("inbound_message_id", String(inbound.id))
        .limit(1);
      if (drafts && drafts.length > 0) continue;

      // b) AI가 이 인바운드 이후 이미 실행됐으면(빈 응답 stay 등) 제외 — 재응답 루프 방지.
      //    판정은 후보 1건이 아니라 **그 지원자의 모든 후보 중 최신 실행 시각**으로 한다.
      //    한 사람이 여러 라인에 병행 투입되는 것이 정상이고, 실행된 후보가 그 턴에 paused/abort로
      //    빠지면 아래 라우팅이 '다른 활성 후보'를 고르게 되는데, 그 행만 보면 실행 흔적이 없어
      //    같은 인바운드에 auto로 다시 응답해버린다(문자함 등록의 '자동 발송 안 함' 게이트 우회 경로).
      const { data: allCands } = await supabase
        .from("job_candidates")
        .select("agent_state")
        .eq("applicant_id", applicantId);
      const lastRunAt = (allCands ?? []).reduce<string | null>((max, c) => {
        const st = (c.agent_state ?? {}) as AgentState;
        const v = typeof st.meta?.last_run_at === "string" ? st.meta.last_run_at : null;
        return v && (!max || Date.parse(v) > Date.parse(max)) ? v : max;
      }, null);
      if (lastRunAt && Date.parse(lastRunAt) >= Date.parse(inbound.created_at)) continue;

      // c) 어느 공고 건인지는 **웹훅과 같은 함수**가 정한다(lib/agent/inbound-routing).
      //    예전엔 여기서 '활성 단계 최신 1건'을 그냥 골라, 같은 답장이 웹훅으로 잡히면 A 공고
      //    sweeper로 잡히면 B 공고로 응대되는 갈림이 있었다.
      const route = await pickCandidateForInbound(supabase, applicantId, String(inbound.body ?? "").trim());
      if (!route.ok) {
        // 판별 불가는 여기서도 고르지 않는다 — 되묻거나(자동 1회) 매니저에게 넘긴다.
        if (route.reason === "ambiguous") {
          const { data: appRow } = await supabase
            .from("applicants")
            .select("name, phone")
            .eq("id", applicantId)
            .maybeSingle();
          const a = appRow as { name: string | null; phone: string | null } | null;
          // 수신거부 답장에 되묻기 문자가 나가지 않게, 웹훅과 **같은 분류 함수**로 판정한다.
          // (sweeper가 잡는 건 웹훅이 놓친 문자라 분류 자체가 안 된 상태다.)
          let inboundOptOut: boolean | null = null;
          try {
            const cls = await classifyAvailabilitySignal({ body: String(inbound.body ?? "") });
            inboundOptOut = cls.signal === "opt_out";
          } catch (e) {
            console.error("[inbound-sweeper] 수신거부 분류 실패(unknown으로 진행)", e);
          }
          const handled = await handleAmbiguousInbound(supabase, {
            applicantId,
            phone: a?.phone ?? null,
            applicantName: a?.name ?? null,
            options: route.options,
            why: route.why,
            mode,
            inboundOptOut,
            sendSms: (to, body) => sendSms(to, body),
            notify: (t) => sendSlackText(t),
          });
          results.push({
            applicant_id: applicantId,
            action: handled.asked ? "job_ambiguous_asked" : "job_ambiguous_paused",
            reason: `공고 판별 불가(${route.why}) — 후보 ${route.options.length}건`,
          });
        }
        continue;
      }
      const jc = route.candidate;

      // 회수 — 웹훅과 동일 라우터 경로. received_at이 과거라 답장 텀 sleep 없이 즉시,
      // 이 메시지가 그 지원자의 최신 인바운드라 coalesce 가드에도 걸리지 않는다.
      const agentResult = await runAgentForCandidate({
        supabase,
        candidate_id: jc.id,
        inbound_message_id: String(inbound.id),
        inbound_text: String(inbound.body ?? "").trim(),
        received_at: inbound.created_at,
      });
      swept++;
      results.push({
        applicant_id: applicantId,
        candidate_id: jc.id,
        action: "swept",
        reply_sent: agentResult.reply_sent ?? false,
        draft_created: agentResult.draft_created ?? false,
        reason: agentResult.skipped ?? agentResult.error,
      });
      if (agentResult.reply_sent || agentResult.draft_created || agentResult.next_stage) {
        const { data: aRow } = await supabase
          .from("applicants")
          .select("name, phone")
          .eq("id", applicantId)
          .maybeSingle();
        const a = aRow as { name: string | null; phone: string | null } | null;
        sweptNames.push(`${a?.name?.trim() || a?.phone || `#${applicantId}`}`);
      }
      // 발송 간 간격 — SOLAPI 연속 호출 완화 (engage-queued·recovery와 동일)
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      console.error("[inbound-sweeper] sweep failed", applicantId, e);
      results.push({
        applicant_id: applicantId,
        action: "failed",
        reason: e instanceof Error ? e.message : "unknown",
      });
    }
  }

  // 회수 = 유실이 실제로 있었다는 신호 — 반드시 Slack으로 알린다 (0건이면 무발송)
  if (sweptNames.length > 0) {
    await sendSlackText(
      [
        "🧹 *유실 인입 회수(inbound-sweeper)*",
        `무응답 상태로 남아있던 답장 ${sweptNames.length}건을 재처리했습니다: ${sweptNames.join(", ")}`,
        "웹훅 유실(배포 교체·콜드 스타트 등)이 실제 발생했다는 뜻이니 빈도가 잦으면 확인이 필요합니다.",
      ].join("\n")
    ).catch(() => false);
  }

  return NextResponse.json({
    mode,
    checked: latestByApplicant.size,
    swept,
    results,
  });
}
