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
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data: data ?? [] });
}
