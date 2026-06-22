/**
 * 자동 점검 규칙 설정 — GET(현재 설정+정의), PUT(설정 저장).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { AUTOMATION_RULES, loadAutomationConfig, saveAutomationConfig, normalizeConfig } from "@/lib/automation";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServiceClient();
  const config = await loadAutomationConfig(supabase);
  return NextResponse.json({ rules: AUTOMATION_RULES, config });
}

export async function PUT(req: NextRequest) {
  let body: { config?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }
  if (!body?.config) {
    return NextResponse.json({ error: "config가 필요합니다." }, { status: 400 });
  }
  const supabase = createServiceClient();
  const config = normalizeConfig(body.config);
  await saveAutomationConfig(supabase, config);
  return NextResponse.json({ config });
}
