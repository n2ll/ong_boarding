/**
 * 데이터 정합성 점검·재백필 (5-a, 안전·무중단).
 *
 * - GET  : 현재 정합성 리포트(컬럼 변경 없음).
 * - POST : jobs.branch_id/client_id 누락분을 유일하게 확인되는 관계로만 재백필.
 *
 * 파괴적 작업(레거시 컬럼 삭제)은 하지 않는다.
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeDataIntegrityBackfillPlan } from "@/lib/admin/data-integrity-backfill";

export const dynamic = "force-dynamic";

interface JobRow {
  id: number;
  branch: string | null;
  branch_id: number | null;
  client_id: number | null;
}
interface BranchRow {
  id: number;
  name: string;
  client_id: number | null;
}

interface Report {
  jobs_total: number;
  jobs_linked: number; // branch_id 있음
  jobs_backfillable: number; // branch_id 없지만 branch 이름이 지점과 매칭됨 → 자동 연결 가능
  jobs_client_backfillable: number; // branch_id가 가리키는 지점의 화주사가 명확함 → 자동 연결 가능
  jobs_unmatched: number; // branch 문자열이 어떤 지점과도 매칭 안 됨(수동 확인 필요)
  jobs_missing_client: number; // branch_id 있는데 client_id 없음
  branches_total: number;
  branches_missing_client: number;
}

async function loadRows(supabase: SupabaseClient) {
  const [jobsRes, branchesRes] = await Promise.all([
    supabase.from("jobs").select("id, branch, branch_id, client_id"),
    supabase.from("branches").select("id, name, client_id"),
  ]);
  const jobs = (jobsRes.data ?? []) as JobRow[];
  const branches = (branchesRes.data ?? []) as BranchRow[];
  return { jobs, branches };
}

function computeReport(jobs: JobRow[], branches: BranchRow[]): Report {
  const plan = safeDataIntegrityBackfillPlan(jobs, branches);
  const backfillableIds = new Set(plan.jobBranches.map((item) => item.jobId));

  let unmatched = 0;
  let missingClient = 0;
  for (const j of jobs) {
    if (j.branch_id == null) {
      const name = (j.branch ?? "").trim();
      if (name && !backfillableIds.has(j.id)) unmatched++;
    } else if (j.client_id == null) {
      missingClient++;
    }
  }

  return {
    jobs_total: jobs.length,
    jobs_linked: jobs.filter((j) => j.branch_id != null).length,
    jobs_backfillable: plan.jobBranches.length,
    jobs_client_backfillable: plan.jobClients.length,
    jobs_unmatched: unmatched,
    jobs_missing_client: missingClient,
    branches_total: branches.length,
    branches_missing_client: branches.filter((b) => b.client_id == null).length,
  };
}

export async function GET() {
  const supabase = createServiceClient();
  const { jobs, branches } = await loadRows(supabase);
  return NextResponse.json({ report: computeReport(jobs, branches) });
}

export async function POST() {
  const supabase = createServiceClient();
  const { jobs, branches } = await loadRows(supabase);
  const plan = safeDataIntegrityBackfillPlan(jobs, branches);

  let jobsBranchFixed = 0;
  let jobsClientFixed = 0;

  // 지점 소유 화주사는 이름만으로 추론하지 않는다. 유일한 지점 이름과 이미 확정된 지점 소유만 사용한다.
  for (const item of plan.jobBranches) {
    const { data, error } = await supabase
      .from("jobs")
      .update({ branch_id: item.branchId, client_id: item.clientId })
      .eq("id", item.jobId)
      .is("branch_id", null)
      .select("id")
      .maybeSingle();
    if (!error && data) jobsBranchFixed++;
  }
  for (const item of plan.jobClients) {
    const { data, error } = await supabase
      .from("jobs")
      .update({ client_id: item.clientId })
      .eq("id", item.jobId)
      .is("client_id", null)
      .select("id")
      .maybeSingle();
    if (!error && data) jobsClientFixed++;
  }

  // 갱신 후 리포트 재계산
  const { jobs: jobs2, branches: branches2 } = await loadRows(supabase);
  return NextResponse.json({
    fixed: { jobs_branch: jobsBranchFixed, jobs_client: jobsClientFixed, branches_client: 0 },
    report: computeReport(jobs2, branches2),
  });
}
