/**
 * 자동 점검 실행 — 현재 저장된 규칙을 라이브 데이터로 평가.
 *
 * POST body(선택): { notify?: boolean }  (기본 true — 트리거 시 Slack 발송)
 * 수동 '지금 점검' 버튼 또는 추후 cron에서 호출.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { loadAutomationConfig, evaluateAutomation } from "@/lib/automation";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let notify = true;
  try {
    const body = await req.json();
    if (typeof body?.notify === "boolean") notify = body.notify;
  } catch {
    /* body 없으면 기본값 사용 */
  }

  const supabase = createServiceClient();
  const config = await loadAutomationConfig(supabase);
  const result = await evaluateAutomation(supabase, config, { notify });
  return NextResponse.json(result);
}
