/**
 * GET /api/admin/cron/agent-recovery
 *
 * AI 호출 실패(크레딧 소진·API 장애 등)로 paused된 후보를 자동 복구하는 cron (30분 간격).
 *
 * 배경(2026-07-12 실사고): 지원자 답장 처리 중 Claude 크레딧 소진(HTTP 400) → 후보
 * paused('에이전트 호출 실패: Claude HTTP 400') + Slack 인계. 충전 후에도 수동 재개 전까지
 * 침묵 — 지원자에게 재답장을 요구하게 됨. 이 cron이 충전을 감지해 알아서 재개하고
 * 밀린 답장(마지막 inbound)까지 자동 발송한다.
 *
 * 흐름:
 *  1. requireCronAuth + getAgentMode — off면 아무것도 안 함(복구도 사람 손).
 *  2. 대상: agent_stage='paused' AND paused_reason LIKE '에이전트 호출 실패%'
 *     — 매니저 인계 pause(단가 문의·확정 뉘앙스 감지 등)는 마커가 달라 절대 건드리지 않음.
 *     — 포기 마커 '에이전트 호출 실패(자동 복구 포기)'는 NOT LIKE '%자동 복구 포기%'로 제외.
 *     meta.paused_at 기준 48시간 이내만. meta.recovery_attempts >= 3이면 Slack 1회 알림 후
 *     paused_reason을 포기 마커로 바꿔 이후 라운드에서 대상 제외(재시도 중단).
 *  3. 헬스체크 1회로 라운드 판정: Anthropic API 최소 호출(가장 싼 모델·max_tokens 1,
 *     프로젝트와 동일한 CLAUDE_API 키·fetch 방식). 실패면 이번 라운드 복구 전체 스킵
 *     (attempts 증가 없음 — 크레딧이 아직 안 찬 것).
 *  4. 복구(후보별): attempts +1 기록과 함께 agent_stage를 meta.paused_from_stage
 *     (없으면 'screening')로 복귀 + paused_reason 클리어 → 그 지원자의 가장 최신 inbound를
 *     웹훅(supabase-new-message)과 동일한 방식으로 runAgentForCandidate에 태워 응답 생성·발송.
 *     재처리 중 또 실패하면 stage의 failResult가 다시 pause로 만듦(자연 재시도).
 *  5. 중복 응답 가드: 마지막 메시지가 이미 outbound(매니저가 답했거나 다른 경로 응답)면
 *     재처리 생략하고 재개만.
 *  6. Slack 요약(복구 N·재처리 발송 N·포기 N) — 0건이면 무발송.
 *
 * 확정 뉘앙스 금지: 이 cron은 새 문구를 만들지 않는다 — 발송은 전부 기존 라우터 경로
 * (확정 뉘앙스 백스톱 포함)를 그대로 지난다.
 *
 * 인증: Authorization: Bearer CRON_SECRET (requireCronAuth — 미설정 시 fail-closed).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireCronAuth } from "@/lib/cron-auth";
import { sendSlackText } from "@/lib/slack";
import { getAgentMode } from "@/lib/agent/kill-switch";
import { runAgentForCandidate } from "@/lib/agent/router";
import { mergeAgentState } from "@/lib/agent/checklist";
import { recordUsage, type AnthropicUsage } from "@/lib/agent/usage";
import type { AgentState, StageName } from "@/lib/agent/types";

export const dynamic = "force-dynamic";
// 후보별 Claude 재처리 + SMS 발송 — 배치 상한(20명) × 건당 수 초 + 여유
export const maxDuration = 300;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// 헬스체크용 — 프로젝트에서 쓰는 가장 싼 모델(분류용 Haiku)과 동일 문자열
const HEALTHCHECK_MODEL = "claude-haiku-4-5-20251001";

const FAILURE_MARKER = "에이전트 호출 실패";
/** 자동 복구 포기 마커 — FAILURE_MARKER로 시작하지만 아래 쿼리의 NOT LIKE로 대상에서 빠진다. */
const GIVE_UP_MARKER = "에이전트 호출 실패(자동 복구 포기)";
const GIVE_UP_EXCLUDE = "자동 복구 포기";
const RECOVERY_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_RECOVERY_ATTEMPTS = 3;
const BATCH_LIMIT = 20;

const RESUMABLE_STAGES = ["exploration", "screening", "onboarding", "active"] as const;

/**
 * Anthropic API 헬스체크 — 크레딧 충전/장애 복구 여부를 최소 비용으로 판정.
 * 프로젝트 Claude 호출부와 동일하게 CLAUDE_API 키 + raw fetch. 성공 시 usage를
 * ai_usage_daily에 적재(컨벤션 준수).
 */
async function anthropicHealthCheck(
  supabase: SupabaseClient
): Promise<{ ok: boolean; detail: string }> {
  const apiKey = process.env.CLAUDE_API;
  if (!apiKey) {
    return { ok: false, detail: "CLAUDE_API env missing" };
  }
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: HEALTHCHECK_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return { ok: false, detail: `HTTP ${res.status} ${errBody.slice(0, 200)}` };
    }
    const data = (await res.json()) as { usage?: AnthropicUsage };
    await recordUsage(supabase, {
      model: HEALTHCHECK_MODEL,
      purpose: "recovery_healthcheck",
      usage: data.usage,
    });
    return { ok: true, detail: "ok" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "unknown" };
  }
}

interface CandidateRow {
  id: number;
  job_id: number | null;
  applicant_id: number;
  agent_state: unknown;
  paused_reason: string | null;
  applicants: unknown;
}

interface RecoveryTarget {
  row: CandidateRow;
  state: AgentState;
  attempts: number;
  targetStage: StageName;
}

interface ResultEntry {
  candidate_id: number;
  action: string;
  reason?: string;
  error?: string;
  reply_sent?: boolean;
  draft_created?: boolean;
  next_stage?: string | null;
}

function applicantOf(row: CandidateRow): { name: string | null; phone: string } {
  const a = (row.applicants ?? null) as unknown as {
    name?: string | null;
    phone?: string;
  } | null;
  return { name: a?.name ?? null, phone: a?.phone ?? "-" };
}

export async function GET(req: NextRequest) {
  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  const supabase = createServiceClient();

  const mode = await getAgentMode(supabase);
  if (mode === "off") {
    // off = 전역 정지 — 복구도 사람 손으로. 대상은 그대로 두고 종료.
    return NextResponse.json({ mode, processed: 0, note: "mode off — 자동 복구 안 함" });
  }

  // 야간 발송 억제 (KST 09~21시만 복구·재처리) — 밀린 답장이라도 심야에 어르신 폰을 울리지
  // 않는다. engage 야간 규칙과 동일 취지(시작 09시로 통일). 대상은 그대로 두므로(attempts
  // 미증가) 아침 첫 주기(09:00)에 자연 처리된다.
  const kstHour = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
  if (kstHour < 9 || kstHour >= 21) {
    return NextResponse.json({ mode, processed: 0, note: `야간(KST ${kstHour}시) — 09시 이후 처리` });
  }

  const { data, error } = await supabase
    .from("job_candidates")
    .select(
      `id, job_id, applicant_id, agent_state, paused_reason,
       applicants:applicant_id ( name, phone )`
    )
    .eq("agent_stage", "paused")
    .like("paused_reason", `${FAILURE_MARKER}%`)
    .not("paused_reason", "like", `%${GIVE_UP_EXCLUDE}%`)
    .limit(BATCH_LIMIT);
  if (error) {
    console.error("[agent-recovery cron] query error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as unknown as CandidateRow[];

  const counts = {
    resumed: 0,
    reprocess_sent: 0,
    reprocess_draft: 0,
    resumed_only: 0,
    gave_up: 0,
    skipped: 0,
    failed: 0,
  };
  const results: ResultEntry[] = [];
  const recoveryTargets: RecoveryTarget[] = [];

  // ── 1) 후보 분류: 48h 창 / attempts 초과(포기) / 복구 대상 ──────────────
  for (const row of rows) {
    try {
      // 벨트+서스펜더 — DB 필터와 동일 조건을 코드에서도 재확인
      if ((row.paused_reason ?? "").includes(GIVE_UP_EXCLUDE)) continue;

      const state = (row.agent_state ?? {}) as AgentState;
      const meta = state.meta ?? {};

      const pausedAtMs =
        typeof meta.paused_at === "string" ? Date.parse(meta.paused_at) : NaN;
      if (!Number.isFinite(pausedAtMs) || Date.now() - pausedAtMs > RECOVERY_WINDOW_MS) {
        counts.skipped++;
        results.push({
          candidate_id: row.id,
          action: "skipped",
          reason: "paused_at 없음 또는 48시간 초과",
        });
        continue;
      }

      const attempts = Number(meta.recovery_attempts ?? 0) || 0;
      if (attempts >= MAX_RECOVERY_ATTEMPTS) {
        // 포기: 마커 교체 → 다음 라운드 LIKE 매칭에서 제외(알림도 1회로 고정)
        const { error: giveUpErr } = await supabase
          .from("job_candidates")
          .update({ paused_reason: GIVE_UP_MARKER })
          .eq("id", row.id)
          .eq("agent_stage", "paused");
        if (giveUpErr) {
          console.error("[agent-recovery cron] give-up marker update failed", row.id, giveUpErr);
          counts.failed++;
          results.push({ candidate_id: row.id, action: "give_up_failed", error: giveUpErr.message });
          continue;
        }
        const applicant = applicantOf(row);
        await sendSlackText(
          [
            "⚠️ *AI 자동 복구 포기 — 수동 확인 필요*",
            `> *지원자:* ${applicant.name || "(이름 없음)"} (${applicant.phone})`,
            `> 복구 ${MAX_RECOVERY_ATTEMPTS}회 시도에도 에이전트 호출 실패가 반복됩니다.`,
            "관리자 페이지에서 직접 재개/응대해주세요.",
          ].join("\n")
        ).catch(() => false);
        counts.gave_up++;
        results.push({ candidate_id: row.id, action: "gave_up" });
        continue;
      }

      const fromStage = String(meta.paused_from_stage ?? "");
      const targetStage: StageName = (RESUMABLE_STAGES as readonly string[]).includes(fromStage)
        ? (fromStage as StageName)
        : "screening";
      recoveryTargets.push({ row, state, attempts, targetStage });
    } catch (e) {
      console.error("[agent-recovery cron] triage failed", row.id, e);
      counts.failed++;
      results.push({
        candidate_id: row.id,
        action: "triage_failed",
        error: e instanceof Error ? e.message : "unknown",
      });
    }
  }

  // ── 2) 헬스체크 1회로 라운드 판정 — 실패면 복구 전체 스킵(attempts 증가 없음) ──
  let health: { ok: boolean; detail: string } = { ok: true, detail: "skipped — 대상 없음" };
  if (recoveryTargets.length > 0) {
    health = await anthropicHealthCheck(supabase);
    if (!health.ok) {
      console.warn("[agent-recovery cron] healthcheck failed — round skipped:", health.detail);
    }
  }

  // ── 3) 복구: 재개(attempts +1 기록) → 최신 inbound 재처리 ─────────────────
  if (health.ok) {
    for (const t of recoveryTargets) {
      try {
        // 재개 — attempts +1은 복구 시도 시점에 기록. agent_stage='paused' 조건부 갱신으로
        // 그 사이 매니저가 이미 재개한 케이스는 건드리지 않는다(0건이면 skip).
        const nextState = mergeAgentState(t.state, {
          meta: {
            recovery_attempts: t.attempts + 1,
            last_recovery_at: new Date().toISOString(),
          },
        });
        const { data: claimed, error: resumeErr } = await supabase
          .from("job_candidates")
          .update({
            agent_stage: t.targetStage,
            paused_reason: null,
            agent_state: nextState,
          })
          .eq("id", t.row.id)
          .eq("agent_stage", "paused")
          .select("id");
        if (resumeErr) {
          counts.failed++;
          results.push({ candidate_id: t.row.id, action: "resume_failed", error: resumeErr.message });
          continue;
        }
        if (!claimed || claimed.length === 0) {
          counts.skipped++;
          results.push({
            candidate_id: t.row.id,
            action: "skipped",
            reason: "이미 재개됨(매니저 처리) — 미변경",
          });
          continue;
        }
        counts.resumed++;

        // 중복 응답 가드 + 재처리 대상 조회: 마지막 메시지가 outbound면
        // (매니저가 답했거나 다른 경로 응답) 재처리 생략하고 재개만.
        const { data: lastMsgs } = await supabase
          .from("messages")
          .select("id, body, direction, created_at")
          .eq("applicant_id", t.row.applicant_id)
          .order("created_at", { ascending: false })
          .limit(1);
        const last = lastMsgs?.[0] as
          | { id: string | number; body: string | null; direction: string; created_at: string }
          | undefined;
        if (!last || last.direction !== "inbound") {
          counts.resumed_only++;
          results.push({
            candidate_id: t.row.id,
            action: "resumed_only",
            reason: last ? "마지막 메시지가 outbound — 재처리 생략" : "메시지 없음",
          });
          continue;
        }

        // 미응답 inbound 재처리 — 웹훅(supabase-new-message)과 동일한 라우터 호출.
        // received_at이 과거라 답장 텀 sleep 없이 즉시 진행되고, 이 메시지가 최신이라
        // coalesce 가드에도 걸리지 않는다. 재실패 시 stage failResult가 다시 pause로
        // 만들어 다음 라운드에서 자연 재시도된다.
        const agentResult = await runAgentForCandidate({
          supabase,
          candidate_id: t.row.id,
          inbound_message_id: String(last.id),
          inbound_text: String(last.body ?? "").trim(),
          received_at: last.created_at,
        });
        if (agentResult.reply_sent) counts.reprocess_sent++;
        else if (agentResult.draft_created) counts.reprocess_draft++;
        results.push({
          candidate_id: t.row.id,
          action: "reprocessed",
          reply_sent: agentResult.reply_sent ?? false,
          draft_created: agentResult.draft_created ?? false,
          next_stage: agentResult.next_stage ?? null,
          reason: agentResult.skipped,
          error: agentResult.error,
        });
      } catch (e) {
        console.error("[agent-recovery cron] recovery failed", t.row.id, e);
        counts.failed++;
        results.push({
          candidate_id: t.row.id,
          action: "recovery_failed",
          error: e instanceof Error ? e.message : "unknown",
        });
      }
      // 발송 간 간격 — SOLAPI 연속 호출 완화 (engage-queued와 동일)
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // ── 4) Slack 요약 — 복구/포기가 실제로 있었을 때만 (0건 스팸 방지, non-fatal) ──
  if (counts.resumed + counts.gave_up > 0) {
    const lines = ["🔁 *에이전트 자동 복구(cron) 결과*"];
    if (counts.resumed > 0) {
      lines.push(
        `- 재개: ${counts.resumed}명 (재처리 발송 ${counts.reprocess_sent} · 초안 ${counts.reprocess_draft} · 재개만 ${counts.resumed_only})`
      );
    }
    if (counts.gave_up > 0) {
      lines.push(
        `- 자동 복구 포기(${MAX_RECOVERY_ATTEMPTS}회 초과): ${counts.gave_up}명 — 수동 확인 필요`
      );
    }
    if (counts.failed > 0) lines.push(`- ⚠️ 처리 실패: ${counts.failed}건 (로그 확인)`);
    await sendSlackText(lines.join("\n")).catch(() => false);
  }

  return NextResponse.json({
    mode,
    healthcheck: health,
    processed: rows.length,
    counts,
    results,
  });
}
