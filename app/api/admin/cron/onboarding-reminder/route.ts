/**
 * GET /api/admin/cron/onboarding-reminder
 *
 * 온보딩 단계 후보에 대해 두 단계의 자동 처리:
 *
 *  단계 A — 리마인더 SMS (가이드 발송 후 24h 미회신)
 *    조건: onboarding_entered_at < now-24h AND reminder_sent_at IS NULL
 *          AND 배민 아이디 미수신
 *    동작: system_message 'onboarding_reminder' 본문으로 SMS 발송
 *          + meta.onboarding_reminder_sent_at 기록 (1회만)
 *
 *  단계 B — 매니저 전화 인계 슬랙 (리마인더 발송 후 3h 미회신)
 *    조건: reminder_sent_at < now-3h AND manager_handoff_alerted_at IS NULL
 *          AND 배민 아이디 미수신
 *    동작: sendSlackOnboardingHandoff 호출 + meta.manager_handoff_alerted_at 기록
 *
 * 둘 다 수신된 후보는 어느 단계도 발동 안 함.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { requireCronAuth } from "@/lib/cron-auth";
import { sendSms } from "@/lib/solapi";
import { sendSlackOnboardingHandoff, sendSlackPausedAlert } from "@/lib/slack";
import { fillTemplate, getSystemMessage } from "@/lib/agent/system-messages";
import { mergeAgentState, isComplete } from "@/lib/agent/checklist";
import type { AgentState } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

const DEADLINE_MS = 24 * 60 * 60 * 1000;       // 가이드 발송 후 리마인더 발송까지 대기
const HANDOFF_DELAY_MS = 3 * 60 * 60 * 1000;   // 리마인더 발송 후 매니저 인계 슬랙까지 대기

const FALLBACK_BODY = (name: string) =>
  [
    `${name}님, 아직 배민 커넥트 아이디 회신이 확인되지 않습니다.`,
    "",
    "진행을 위해 마이페이지 > 내 정보에서 아이디 확인 후 회신 부탁드립니다.",
    "",
    "* 회신이 없을 경우 진행이 자동 중단될 수 있습니다.",
  ].join("\n");

export async function GET(req: NextRequest) {
  // 인증 — Bearer CRON_SECRET만 허용(위조 가능한 user-agent 검사 제거, 미설정 시 fail-closed)
  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  const supabase = createServiceClient();
  const now = Date.now();
  const remindCutoff = new Date(now - DEADLINE_MS).toISOString();
  const handoffCutoff = new Date(now - HANDOFF_DELAY_MS).toISOString();

  // 후보 후보군 로드 — onboarding 단계 전체 로드 후 JS에서 단계별 분기.
  const { data: rows, error } = await supabase
    .from("job_candidates")
    .select(`
      id, applicant_id, job_id, agent_state,
      applicants:applicant_id (id, name, phone, source, branch1)
    `)
    .eq("agent_stage", "onboarding")
    .limit(500);

  if (error) {
    console.error("[onboarding-reminder cron] query error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: Array<{ candidate_id: number; stage: "reminder" | "handoff" | "skip" | "screening_stall"; success: boolean; reason?: string; error?: string }> = [];

  for (const row of rows ?? []) {
    const state = (row.agent_state ?? {}) as AgentState;
    const meta = (state.meta ?? {}) as Record<string, string | undefined>;
    const ob = state.onboarding ?? {};
    const applicant = row.applicants as unknown as {
      id: number; name: string | null; phone: string;
      source: string | null; branch1: string | null;
    };

    // 이미 아이디 수신 — 단계 발동 안 함
    if (ob.배민_아이디_수신 === true) continue;
    if (!meta.onboarding_entered_at) {
      results.push({ candidate_id: row.id as number, stage: "skip", success: false, reason: "no onboarding_entered_at" });
      continue;
    }
    if (!applicant?.phone) {
      results.push({ candidate_id: row.id as number, stage: "skip", success: false, reason: "no phone" });
      continue;
    }

    // ─── 단계 B: 리마인더 발송 후 3h 경과 → 매니저 전화 인계 슬랙 (1회만) ───
    if (
      meta.onboarding_reminder_sent_at &&
      !meta.manager_handoff_alerted_at &&
      meta.onboarding_reminder_sent_at <= handoffCutoff
    ) {
      try {
        if (applicant.source !== "danggeun_practice") {
          await sendSlackOnboardingHandoff({
            applicant_name: applicant.name,
            applicant_phone: applicant.phone,
            branch: applicant.branch1,
          });
        }
      } catch (e) {
        console.error("[onboarding-reminder cron] handoff slack fail", row.id, e);
      }
      const merged = mergeAgentState(state, {
        meta: { manager_handoff_alerted_at: new Date().toISOString() },
      });
      await supabase.from("job_candidates").update({ agent_state: merged }).eq("id", row.id);
      results.push({ candidate_id: row.id as number, stage: "handoff", success: true });
      continue;
    }

    // ─── 단계 A: 가이드 발송 후 24h 경과 + 리마인더 미발송 → 리마인더 SMS ───
    if (
      !meta.onboarding_reminder_sent_at &&
      meta.onboarding_entered_at <= remindCutoff
    ) {
      if (applicant.source === "danggeun_practice") {
        const merged = mergeAgentState(state, {
          meta: { onboarding_reminder_sent_at: new Date().toISOString() },
        });
        await supabase.from("job_candidates").update({ agent_state: merged }).eq("id", row.id);
        results.push({ candidate_id: row.id as number, stage: "reminder", success: true, reason: "practice — skipped real SMS" });
        continue;
      }

      const stored = (await getSystemMessage(supabase, "onboarding_reminder"))?.trim();
      const name = applicant.name ?? "지원자";
      const body = stored ? fillTemplate(stored, { 이름: name }) : FALLBACK_BODY(name);

      const send = await sendSms(applicant.phone, body);
      if (!send.success) {
        console.error("[onboarding-reminder cron] send fail", row.id, send.error);
        results.push({ candidate_id: row.id as number, stage: "reminder", success: false, error: send.error });
        continue;
      }

      const sentAt = new Date().toISOString();
      await supabase.from("messages").insert({
        applicant_id: applicant.id,
        applicant_phone: applicant.phone,
        direction: "outbound",
        body,
        status: "sent",
        sent_by: "system-onboarding-reminder",
        solapi_msg_id: send.messageId ?? null,
        message_type: "sms",
        job_id: row.job_id as number,
      });
      const merged = mergeAgentState(state, {
        meta: { onboarding_reminder_sent_at: sentAt },
      });
      await supabase.from("job_candidates").update({ agent_state: merged }).eq("id", row.id);
      results.push({ candidate_id: row.id as number, stage: "reminder", success: true });
    }
  }

  // ─── 단계 C: 침묵성 스크리닝 정체 → pause + Slack (P1-2 cron backstop) ───
  // agent_stage='screening'인데 48h+ 에이전트 활동 없음(meta.last_run_at) + 체크리스트 미완료 →
  // 지원자가 답 끊긴 채 방치된 케이스. paused로 전환해 인계 큐에 노출 + Slack 알림.
  // last_run_at 14일 초과(오래된/죽은 건)는 스킵해 첫 실행 backlog 폭주 방지.
  const screeningStallCutoff = new Date(now - 48 * 60 * 60 * 1000).toISOString();
  const staleFloor = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: screeningRows } = await supabase
    .from("job_candidates")
    .select(`id, applicant_id, job_id, agent_state, applicants:applicant_id ( id, name, phone, source, branch1 )`)
    .eq("agent_stage", "screening")
    .limit(500);

  for (const row of screeningRows ?? []) {
    const state = (row.agent_state ?? {}) as AgentState;
    const meta = (state.meta ?? {}) as Record<string, string | undefined>;
    const applicant = row.applicants as unknown as {
      id: number; name: string | null; phone: string;
      source: string | null; branch1: string | null;
    };
    const lastRun = meta.last_run_at;
    if (!lastRun) continue;                          // 활동 이력 없음 — 스킵
    if (lastRun > screeningStallCutoff) continue;    // 최근 48h 내 활동 — 정상 진행 중
    if (lastRun < staleFloor) continue;              // 14일 초과 — 오래된 건, 폭주 방지 스킵
    if (isComplete(state, "screening")) continue;    // 이미 완료(방어)
    if (!applicant?.phone) continue;

    const merged = mergeAgentState(state, {
      meta: {
        paused_from_stage: "screening",
        paused_at: new Date().toISOString(),
        pause: {
          category: "auto",
          summary: "스크리닝 침묵 정체 — 48h+ 무응답, 체크리스트 미완료",
          suggested_action: "지원자가 스크리닝 중 답이 끊겼습니다. 대화 확인 후 매니저가 직접 진행하세요.",
        },
      },
    });
    await supabase
      .from("job_candidates")
      .update({ agent_stage: "paused", paused_reason: "스크리닝 침묵 정체 — 48h+ 무응답", agent_state: merged })
      .eq("id", row.id);
    if (applicant.source !== "danggeun_practice") {
      try {
        await sendSlackPausedAlert({
          applicant_name: applicant.name,
          applicant_phone: applicant.phone,
          branch: applicant.branch1,
          reason: "스크리닝 침묵 정체 — 48h+ 무응답, 매니저 확인 필요",
        });
      } catch (e) {
        console.error("[onboarding-reminder cron] screening-stall slack fail", row.id, e);
      }
    }
    results.push({ candidate_id: row.id as number, stage: "screening_stall", success: true });
  }

  return NextResponse.json({
    processed: results.length,
    succeeded: results.filter((r) => r.success).length,
    results,
  });
}
