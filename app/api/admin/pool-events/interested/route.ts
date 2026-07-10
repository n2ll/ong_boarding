/**
 * GET /api/admin/pool-events/interested?job_id=N
 *
 * 특정 공고에 '관심 있음'(interest_click)을 남긴 지원자 id 목록(중복 제거).
 * 파이프라인 '공고 관심자 선택'(사후관리 — 대기 안내 발송 대상 원클릭 선별)용.
 * interest-queue와 달리 처리 여부(contacted_at 등)와 무관하게 관심 이력 전체를 준다.
 * 확정인력 제외 등 대상 정제는 클라이언트(파이프라인)가 담당.
 * 인증은 middleware의 /api/admin/* Basic Auth에 위임.
 *
 * 응답: { applicantIds: number[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const jobId = Number(req.nextUrl.searchParams.get("job_id"));
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "job_id must be a number" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("pool_events")
    .select("applicant_id")
    .eq("event_type", "interest_click")
    .eq("job_id", jobId);

  if (error) {
    console.error("[pool-events/interested]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const applicantIds = [...new Set((data ?? []).map((r) => r.applicant_id as number))];
  return NextResponse.json({ applicantIds });
}
