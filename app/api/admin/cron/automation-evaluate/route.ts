/**
 * GET /api/admin/cron/automation-evaluate
 *
 * 자동 점검 규칙 엔진 정기 실행 (매시 30분, vercel.json crons).
 * 저장된 규칙 설정을 로드해 라이브 데이터로 평가하고,
 * 트리거된 규칙이 있으면 Slack으로 1회 통합 발송한다.
 *
 * 수동 실행(관리자 '지금 점검' 버튼)은 POST /api/admin/automation/evaluate — 동일 로직 공유.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { requireCronAuth } from "@/lib/cron-auth";
import {
  loadAutomationConfig,
  evaluateAutomation,
  loadLastNotifiedAt,
  saveLastNotifiedAt,
} from "@/lib/automation";

export const dynamic = "force-dynamic";

// 재알림 쿨다운 — cron은 매시 돌지만 같은 적체 상황을 반복 알리지 않는다(하루 1회 요약 수준).
// 수동 '지금 점검' 버튼(POST /api/admin/automation/evaluate)은 쿨다운 없이 항상 발송.
const NOTIFY_COOLDOWN_HOURS = 24;

// 가용성 휴면 전이 기준 — 마지막 재확인 후 60일 (2026-07-04 실무자 인터뷰 확정, PRODUCT_DIRECTION §6.2).
// 휴면 = 삭제가 아니라 기본 발송 타깃 제외. 선별 재컨택·재확인으로 복구 가능.
const DORMANT_AFTER_DAYS = 60;

/**
 * 가용성 신선도 decay — 즉시가능/이번주가능인데 60일 넘게 재확인이 없으면 휴면 전이.
 * 전이 건은 pool_events(dormant_transition)로 이력을 남긴다.
 */
async function transitionDormant(
  supabase: ReturnType<typeof createServiceClient>
): Promise<number> {
  const cutoff = new Date(Date.now() - DORMANT_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: stale, error: selErr } = await supabase
    .from("applicants")
    .select("id, availability")
    .in("availability", ["즉시가능", "이번주가능"])
    .lt("availability_updated_at", cutoff);
  if (selErr) {
    console.error("[automation-evaluate cron] dormant select failed", selErr);
    return 0;
  }
  if (!stale || stale.length === 0) return 0;

  const now = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("applicants")
    .update({ availability: "휴면", availability_updated_at: now })
    .in("id", stale.map((r) => r.id));
  if (updErr) {
    console.error("[automation-evaluate cron] dormant update failed", updErr);
    return 0;
  }

  const { error: evErr } = await supabase.from("pool_events").insert(
    stale.map((r) => ({
      applicant_id: r.id,
      event_type: "dormant_transition",
      meta: { from: r.availability, after_days: DORMANT_AFTER_DAYS },
    }))
  );
  if (evErr) console.error("[automation-evaluate cron] dormant pool_events failed", evErr);

  return stale.length;
}

export async function GET(req: NextRequest) {
  // 인증 — Bearer CRON_SECRET만 허용(미설정 시 fail-closed)
  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  try {
    const supabase = createServiceClient();

    // 규칙 평가 전에 가용성 신선도 decay 먼저 — 평가·알림이 최신 상태를 보게.
    const dormantTransitions = await transitionDormant(supabase);

    const config = await loadAutomationConfig(supabase);

    const lastNotifiedAt = await loadLastNotifiedAt(supabase);
    const cooldownActive =
      lastNotifiedAt !== null &&
      Date.now() - new Date(lastNotifiedAt).getTime() < NOTIFY_COOLDOWN_HOURS * 60 * 60 * 1000;

    const result = await evaluateAutomation(supabase, config, { notify: !cooldownActive });
    if (result.notified) {
      await saveLastNotifiedAt(supabase, result.ran_at);
    }

    return NextResponse.json({
      ran_at: result.ran_at,
      evaluated: result.results.length,
      triggered: result.triggered_count,
      notified: result.notified,
      notify_suppressed_by_cooldown: cooldownActive && result.triggered_count > 0,
      dormant_transitions: dormantTransitions,
      results: result.results.map((r) => ({ id: r.id, triggered: r.triggered, detail: r.detail })),
    });
  } catch (e) {
    console.error("[automation-evaluate cron] error", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "automation evaluate failed" },
      { status: 500 }
    );
  }
}
