/**
 * GET /api/admin/inbox/pending
 *
 * 미분류(classification='pending') 인입 메시지 목록.
 * 매니저가 [✓ 배민 지원자] / [⛔ 기타] 1-click 처리 대상.
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("messages")
    .select("id, applicant_phone, body, created_at, sent_by")
    .eq("classification", "pending")
    .eq("direction", "inbound")
    // 오래된 순 — 최신순이면 오래 기다린 문자가 맨 아래로 밀려 영영 안 보인다.
    // 실측: 7월 6일에 온 "앱 재등록 비번 알려주세요"(이미 일하는 기사)가 39일째 맨 아래에 있었다.
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data: data ?? [] });
}
