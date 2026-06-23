/**
 * GET /api/admin/applicants/[id]/active-jobs
 *
 * 한 지원자가 동시에 진행 중인 '활성 후보(job_candidate)' 목록.
 * 멀티-잡 지원자를 실시간 응대에서 공고별로 분리해 보여주기 위한 셀렉터 데이터.
 *  - agent_stage가 null/abort가 아닌 후보만
 *  - 시스템 더미 공고(__ 접두) 제외
 *  - created_at 오름차순(먼저 시작한 공고가 앞)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const applicantId = Number(params.id);
  if (!Number.isFinite(applicantId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("job_candidates")
    .select("job_id, agent_stage, created_at, jobs:job_id ( id, title, branch )")
    .eq("applicant_id", applicantId)
    .not("agent_stage", "is", null)
    .neq("agent_stage", "abort")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[active-jobs]", error);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  const jobs = (data ?? [])
    .map((c) => {
      const j = (c.jobs ?? null) as unknown as { id: number; title: string; branch: string | null } | null;
      if (!j || typeof j.title !== "string" || j.title.startsWith("__")) return null;
      return {
        job_id: j.id,
        title: j.title,
        branch: j.branch ?? null,
        agent_stage: (c.agent_stage as string | null) ?? null,
      };
    })
    .filter((x): x is { job_id: number; title: string; branch: string | null; agent_stage: string | null } => x !== null);

  return NextResponse.json({ jobs });
}
