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
 *    조건: reminder_sent_at < now-3h AND 발송/억제 기록이 모두 없음
 *          AND 배민 아이디 미수신
 *    동작: Slack 2xx면 manager_handoff_alerted_at 기록
 *          전역 OFF면 manager_handoff_slack_suppressed_at 기록(재활성화 후 재발송 안 함)
 *
 * 둘 다 수신된 후보는 어느 단계도 발동 안 함.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase";
import { requireCronAuth } from "@/lib/cron-auth";
import { sendSms } from "@/lib/solapi";
import { sendSlackOnboardingHandoff, sendSlackPausedAlert } from "@/lib/slack";
import {
  buildOnboardingHandoffMarkerUpdate,
  processOnboardingHandoffAttempt,
  shouldAttemptOnboardingHandoff,
} from "@/lib/onboarding-handoff";
import { fillTemplate, getSystemMessage } from "@/lib/agent/system-messages";
import { mergeAgentState, isComplete } from "@/lib/agent/checklist";
import {
  PRECONFIRMATION_ONBOARDING_REMINDER_TEMPLATE,
  resolvePreconfirmationGuideText,
} from "@/lib/agent/outbound-safety";
import type { AgentState } from "@/lib/agent/types";
import { isGeneralLineJob, joinedClientType } from "@/lib/agent/general-line";

export const dynamic = "force-dynamic";

const DEADLINE_MS = 24 * 60 * 60 * 1000;       // 가이드 발송 후 리마인더 발송까지 대기
const HANDOFF_DELAY_MS = 3 * 60 * 60 * 1000;   // 리마인더 발송 후 매니저 인계 슬랙까지 대기
const CLAIM_STALE_MS = 15 * 60 * 1000;          // 함수 종료·공급자 timeout 뒤 결과 불명 claim을 수동 큐로 올리는 유예

const FALLBACK_BODY = (name: string) =>
  PRECONFIRMATION_ONBOARDING_REMINDER_TEMPLATE.replace("#{이름}", name);

export async function GET(req: NextRequest) {
  // 인증 — Bearer CRON_SECRET만 허용(위조 가능한 user-agent 검사 제거, 미설정 시 fail-closed)
  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  const supabase = createServiceClient();
  const now = Date.now();
  const remindCutoff = new Date(now - DEADLINE_MS).toISOString();
  const handoffCutoff = new Date(now - HANDOFF_DELAY_MS).toISOString();
  const claimStaleCutoff = new Date(now - CLAIM_STALE_MS).toISOString();

  // 배민 비마트 임시중단 — 단계 A 리마인더('배민 커넥트 아이디 회신')는 비마트 진행 신호라 배민 유입엔 억제.
  // (source=baemin만 대상 — 당근/일반 라인은 회귀 없이 그대로. 재개 시 플래그를 비우면 자동 복구된다.)
  const baeminSuspended = !!(await getSystemMessage(supabase, "baemin_suspended"))?.trim();

  // 후보 후보군 로드 — onboarding 단계 전체 로드 후 JS에서 단계별 분기.
  const { data: rows, error } = await supabase
    .from("job_candidates")
    .select(`
      id, applicant_id, job_id, agent_state,
      onboarding_reminder_claimed_at, onboarding_reminder_claim_id,
      onboarding_reminder_sent_at, onboarding_reminder_failed_at, onboarding_reminder_failure_kind,
      manager_handoff_alerted_at, manager_handoff_slack_suppressed_at,
      jobs:job_id ( title, client:clients ( client_type ) ),
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
    // 전용 컬럼이 권위 소스. 배포 전 agent_state.meta에 기록된 기존 행만 fallback으로 읽는다.
    const reminderSentAt = (row.onboarding_reminder_sent_at as string | null)
      ?? meta.onboarding_reminder_sent_at;
    const reminderClaimedAt = (row.onboarding_reminder_claimed_at as string | null)
      ?? meta.onboarding_reminder_claimed_at;
    const reminderClaimId = row.onboarding_reminder_claim_id as string | null;
    const ob = state.onboarding ?? {};
    const applicant = row.applicants as unknown as {
      id: number; name: string | null; phone: string;
      source: string | null; branch1: string | null;
    };
    const joinedJob = (row.jobs ?? null) as unknown as { title?: string | null; client?: unknown } | null;
    if (!joinedJob?.title) {
      results.push({ candidate_id: row.id as number, stage: "skip", success: false, reason: "job context missing" });
      continue;
    }
    const job = { title: joinedJob.title, client_type: joinedClientType(joinedJob.client) };

    // 이 크론의 리마인더·인계는 배민 ID 온보딩 전용이다. 일반 라인 후보가 수동 변경/과거 데이터로
    // onboarding에 들어와도 문자·Slack을 보내지 않고 매니저 확인 상태로 격리한다.
    if (isGeneralLineJob(job)) {
      const merged = mergeAgentState(state, {
        meta: {
          paused_from_stage: "onboarding",
          paused_at: new Date().toISOString(),
          pause: {
            category: "routing_guard",
            summary: "일반 화주사 공고가 비마트 온보딩 단계에 진입해 리마인더 차단",
            suggested_action: "공고와 대화를 확인한 뒤 매니저가 직접 다음 일정을 안내하세요.",
          },
        },
      });
      const { error: pauseError } = await supabase
        .from("job_candidates")
        .update({
          agent_stage: "paused",
          paused_reason: "일반 화주사 공고의 비마트 온보딩 진입 — 자동 리마인더 차단",
          agent_state: merged,
        })
        .eq("id", row.id)
        .eq("agent_stage", "onboarding");
      results.push({
        candidate_id: row.id as number,
        stage: "skip",
        success: !pauseError,
        reason: pauseError ? "general line pause failed" : "general line — parked to paused",
        ...(pauseError ? { error: pauseError.message } : {}),
      });
      continue;
    }

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

    // claim 직후 함수 crash/timeout이면 공급자 호출 여부를 확정할 수 없다. 자동 재발송은 하지 않되,
    // 15분이 지난 claim을 영구 침묵 상태로 두지 않고 기존 수동 응대 큐(paused)에 올린다.
    if (reminderClaimedAt && !reminderSentAt) {
      if (reminderClaimId && reminderClaimedAt <= claimStaleCutoff) {
        const { data: swept, error: sweepError } = await supabase
          .from("job_candidates")
          .update({
            onboarding_reminder_failed_at: new Date().toISOString(),
            onboarding_reminder_failure_kind: "unknown",
            agent_stage: "paused",
            paused_reason: "온보딩 리마인더 발송 결과 불명 — 재발송 없이 수동 확인 필요",
          })
          .eq("id", row.id)
          .eq("onboarding_reminder_claim_id", reminderClaimId)
          .eq("agent_stage", "onboarding")
          .is("onboarding_reminder_sent_at", null)
          .select("id")
          .maybeSingle();
        results.push({
          candidate_id: row.id as number,
          stage: "skip",
          success: !sweepError,
          reason: swept ? "stale reminder claim — parked to paused" : "stale reminder claim already handled",
          ...(sweepError ? { error: sweepError.message } : {}),
        });
      } else {
        results.push({ candidate_id: row.id as number, stage: "skip", success: true, reason: "reminder claim in flight" });
      }
      continue;
    }

    // ─── 단계 B: 리마인더 발송 후 3h 경과 → 매니저 전화 인계 Slack (발송/억제 1회) ───
    const handoffMeta = {
      ...meta,
      onboarding_reminder_sent_at: reminderSentAt,
      manager_handoff_alerted_at: row.manager_handoff_alerted_at
        ?? meta.manager_handoff_alerted_at,
      manager_handoff_slack_suppressed_at: row.manager_handoff_slack_suppressed_at
        ?? meta.manager_handoff_slack_suppressed_at,
    };

    if (shouldAttemptOnboardingHandoff(handoffMeta, handoffCutoff)) {
      const outcome = await processOnboardingHandoffAttempt({
        practice: applicant.source === "danggeun_practice",
        deliver: () => sendSlackOnboardingHandoff({
          applicant_name: applicant.name,
          applicant_phone: applicant.phone,
          branch: applicant.branch1,
        }),
        mark: async (marker) => {
          const markedAt = new Date().toISOString();
          const { data: updated, error: updateError } = await supabase
            .from("job_candidates")
            .update(buildOnboardingHandoffMarkerUpdate(marker, markedAt))
            .eq("id", row.id)
            .eq("agent_stage", "onboarding")
            .is("manager_handoff_alerted_at", null)
            .is("manager_handoff_slack_suppressed_at", null)
            .select("id")
            .maybeSingle();
          if (updateError) throw updateError;
          if (!updated) throw new Error("candidate changed before handoff marker write");
        },
      });

      if (outcome.kind === "delivered") {
        results.push({ candidate_id: row.id as number, stage: "handoff", success: true });
      } else if (outcome.kind === "suppressed") {
        results.push({
          candidate_id: row.id as number,
          stage: "handoff",
          success: true,
          reason: outcome.reason === "practice" ? "practice — Slack suppressed" : "Slack globally disabled — suppressed",
        });
      } else {
        console.error("[onboarding-reminder cron] handoff incomplete", row.id, outcome.error);
        results.push({
          candidate_id: row.id as number,
          stage: "handoff",
          success: false,
          error: outcome.error,
        });
      }
      continue;
    }

    // ─── 단계 A: 가이드 발송 후 24h 경과 + 리마인더 미발송 → 리마인더 SMS ───
    if (
      !reminderSentAt &&
      !reminderClaimedAt &&
      meta.onboarding_entered_at <= remindCutoff
    ) {
      // 배민 비마트 중단 중엔 배민 유입 리마인더 스킵(발송·마킹 X → 재개 시 자연 복구).
      if (baeminSuspended && applicant.source === "baemin") {
        results.push({ candidate_id: row.id as number, stage: "skip", success: true, reason: "baemin suspended — reminder held" });
        continue;
      }
      if (applicant.source === "danggeun_practice") {
        const practiceSentAt = new Date().toISOString();
        const merged = mergeAgentState(state, {
          meta: { onboarding_reminder_sent_at: practiceSentAt },
        });
        await supabase
          .from("job_candidates")
          .update({ agent_state: merged, onboarding_reminder_sent_at: practiceSentAt })
          .eq("id", row.id)
          .is("onboarding_reminder_sent_at", null);
        results.push({ candidate_id: row.id as number, stage: "reminder", success: true, reason: "practice — skipped real SMS" });
        continue;
      }

      const stored = (await getSystemMessage(supabase, "onboarding_reminder"))?.trim();
      const name = applicant.name ?? "지원자";
      const storedBody = stored ? fillTemplate(stored, { 이름: name }) : null;
      const body = resolvePreconfirmationGuideText(storedBody, FALLBACK_BODY(name));
      if (!body) {
        results.push({
          candidate_id: row.id as number,
          stage: "reminder",
          success: false,
          error: "안전 검증 실패 — 선택 안내·비확정 고지 필요",
        });
        continue;
      }

      // 공급자 호출 전에 전용 scalar 컬럼을 조건부 UPDATE로 선점한다. agent_state 안에 claim을 넣으면
      // 동시에 진행 중인 router/transition의 오래된 JSON 전체 쓰기에 사라질 수 있어 durable하지 않다.
      // claim은 실패 시에도 자동 해제하지 않는다 — 결과 불명 응답을 재발송해 같은 문자를 두 번 보내는
      // 것보다 수동 확인이 안전하다.
      const reminderClaimId = randomUUID();
      const claimedAt = new Date().toISOString();
      const { data: claimed, error: claimError } = await supabase
        .from("job_candidates")
        .update({
          onboarding_reminder_claimed_at: claimedAt,
          onboarding_reminder_claim_id: reminderClaimId,
        })
        .eq("id", row.id)
        .eq("agent_stage", "onboarding")
        .is("onboarding_reminder_claimed_at", null)
        .is("onboarding_reminder_sent_at", null)
        .select("id")
        .maybeSingle();
      if (claimError) {
        console.error("[onboarding-reminder cron] claim fail", row.id, claimError);
        results.push({ candidate_id: row.id as number, stage: "reminder", success: false, error: `claim failed: ${claimError.message}` });
        continue;
      }
      if (!claimed) {
        results.push({ candidate_id: row.id as number, stage: "skip", success: true, reason: "reminder already claimed or candidate changed" });
        continue;
      }

      let send: Awaited<ReturnType<typeof sendSms>>;
      try {
        send = await sendSms(applicant.phone, body, undefined, { clientRequestId: reminderClaimId });
      } catch (sendError) {
        const { error: failureMarkError } = await supabase
          .from("job_candidates")
          .update({
            onboarding_reminder_failed_at: new Date().toISOString(),
            onboarding_reminder_failure_kind: "unknown",
          })
          .eq("id", row.id)
          .eq("onboarding_reminder_claim_id", reminderClaimId)
          .is("onboarding_reminder_sent_at", null);
        const { error: pauseError } = await supabase
          .from("job_candidates")
          .update({
            agent_stage: "paused",
            paused_reason: "온보딩 리마인더 발송 결과 불명 — 재발송 없이 수동 확인 필요",
          })
          .eq("id", row.id)
          .eq("onboarding_reminder_claim_id", reminderClaimId)
          .eq("agent_stage", "onboarding")
          .is("onboarding_reminder_sent_at", null);
        const message = sendError instanceof Error ? sendError.message : "SMS provider request failed";
        console.error("[onboarding-reminder cron] send exception", row.id, message);
        results.push({
          candidate_id: row.id as number,
          stage: "reminder",
          success: false,
          error: [message, failureMarkError ? `failure marker: ${failureMarkError.message}` : null, pauseError ? `pause: ${pauseError.message}` : null].filter(Boolean).join(" · "),
        });
        continue;
      }
      if (!send.success) {
        const { error: failureMarkError } = await supabase
          .from("job_candidates")
          .update({
            onboarding_reminder_failed_at: new Date().toISOString(),
            onboarding_reminder_failure_kind: send.failureKind,
          })
          .eq("id", row.id)
          .eq("onboarding_reminder_claim_id", reminderClaimId)
          .is("onboarding_reminder_sent_at", null);
        const { error: pauseError } = await supabase
          .from("job_candidates")
          .update({
            agent_stage: "paused",
            paused_reason: "온보딩 리마인더 발송 실패 — 재발송 없이 수동 확인 필요",
          })
          .eq("id", row.id)
          .eq("onboarding_reminder_claim_id", reminderClaimId)
          .eq("agent_stage", "onboarding")
          .is("onboarding_reminder_sent_at", null);
        console.error("[onboarding-reminder cron] send fail", row.id, send.error);
        results.push({
          candidate_id: row.id as number,
          stage: "reminder",
          success: false,
          error: [send.error, failureMarkError ? `failure marker: ${failureMarkError.message}` : null, pauseError ? `pause: ${pauseError.message}` : null].filter(Boolean).join(" · "),
        });
        continue;
      }

      const sentAt = new Date().toISOString();
      const { data: finalized, error: finalizeError } = await supabase
        .from("job_candidates")
        .update({ onboarding_reminder_sent_at: sentAt })
        .eq("id", row.id)
        .eq("onboarding_reminder_claim_id", reminderClaimId)
        .is("onboarding_reminder_sent_at", null)
        .select("id")
        .maybeSingle();
      const { error: messageError } = await supabase.from("messages").insert({
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
      if (finalizeError || !finalized || messageError) {
        const errorParts = [
          finalizeError ? `sent marker: ${finalizeError.message}` : !finalized ? "sent marker lost CAS" : null,
          messageError ? `message log: ${messageError.message}` : null,
        ].filter(Boolean).join(" · ");
        // 공급자 성공 뒤 내부 기록이 불완전하면 자동 재발송은 금지한 채 기존 수동 응대 큐에 올린다.
        // 조용히 onboarding에 남기면 영구 정지가 화면 어디에도 보이지 않는다.
        await supabase
          .from("job_candidates")
          .update({
            agent_stage: "paused",
            paused_reason: "온보딩 리마인더 발송 후 기록 불완전 — 수동 확인 필요",
          })
          .eq("id", row.id)
          .eq("onboarding_reminder_claim_id", reminderClaimId)
          .eq("agent_stage", "onboarding");
        console.error("[onboarding-reminder cron] post-send persistence incomplete", row.id, errorParts);
        results.push({ candidate_id: row.id as number, stage: "reminder", success: false, error: `SMS sent; ${errorParts}` });
        continue;
      }
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
