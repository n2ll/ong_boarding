/**
 * GET /api/admin/drafts/pending?applicant_id=N
 *
 * 특정 지원자의 최신 미처리 AI 초안(message_drafts: status in pending/need_info) 1건.
 * 기존엔 브라우저(anon)에서 직접 조회했으나, PII RLS 전면 적용을 위해
 * 서버(service_role) 경유로 전환한다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { selectPendingDraftForJob } from "@/lib/admin/pending-draft-scope";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const applicantId = Number(url.searchParams.get("applicant_id"));
  if (!Number.isFinite(applicantId)) {
    return NextResponse.json({ error: "applicant_id가 필요합니다." }, { status: 400 });
  }
  const jobIdParam = url.searchParams.get("job_id");
  const jobId = jobIdParam === null ? null : Number(jobIdParam);
  if (jobIdParam !== null && (!Number.isSafeInteger(jobId) || (jobId ?? 0) <= 0)) {
    return NextResponse.json({ error: "유효하지 않은 job_id입니다." }, { status: 400 });
  }
  const draftScopeParam = url.searchParams.get("draft_scope");
  if (draftScopeParam !== null && draftScopeParam !== "unscoped") {
    return NextResponse.json({ error: "유효하지 않은 draft_scope입니다." }, { status: 400 });
  }
  if (jobId !== null && draftScopeParam === "unscoped") {
    return NextResponse.json({ error: "job_id와 draft_scope는 함께 지정할 수 없습니다." }, { status: 400 });
  }

  const supabase = createServiceClient();
  let pendingDraftQuery = supabase
    .from("message_drafts")
    .select("id, draft_text, reasoning, status, missing_info, job_id, created_at")
    .eq("applicant_id", applicantId)
    .in("status", ["pending", "need_info"])
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  if (jobId !== null) pendingDraftQuery = pendingDraftQuery.eq("job_id", jobId);
  else if (draftScopeParam === "unscoped") pendingDraftQuery = pendingDraftQuery.is("job_id", null);
  const { data, error } = await pendingDraftQuery.limit(1);

  if (error) {
    console.error("[admin/drafts/pending]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: selectPendingDraftForJob(data ?? [], jobId) });
}
