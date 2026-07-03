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
import { loadAutomationConfig, evaluateAutomation } from "@/lib/automation";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // 인증 — Bearer CRON_SECRET만 허용(미설정 시 fail-closed)
  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  try {
    const supabase = createServiceClient();
    const config = await loadAutomationConfig(supabase);
    const result = await evaluateAutomation(supabase, config, { notify: true });

    return NextResponse.json({
      ran_at: result.ran_at,
      evaluated: result.results.length,
      triggered: result.triggered_count,
      notified: result.notified,
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
