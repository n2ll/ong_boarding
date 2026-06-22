/**
 * GET /api/admin/drafts/pending?applicant_id=N
 *
 * 특정 지원자의 최신 미처리 AI 초안(message_drafts: status in pending/need_info) 1건.
 * 기존엔 브라우저(anon)에서 직접 조회했으나, PII RLS 전면 적용을 위해
 * 서버(service_role) 경유로 전환한다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const applicantId = Number(new URL(req.url).searchParams.get("applicant_id"));
  if (!Number.isFinite(applicantId)) {
    return NextResponse.json({ error: "applicant_id가 필요합니다." }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("message_drafts")
    .select("id, draft_text, reasoning, status, missing_info, created_at")
    .eq("applicant_id", applicantId)
    .in("status", ["pending", "need_info"])
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("[admin/drafts/pending]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: data?.[0] ?? null });
}
