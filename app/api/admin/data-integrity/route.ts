/**
 * 데이터 정합성 점검·재백필 (5-a, 안전·무중단).
 *
 * - GET  : 현재 정합성 리포트(컬럼 변경 없음).
 * - POST : jobs.branch_id/client_id, branches.client_id 누락분을 이름 매칭으로 재백필.
 *
 * 파괴적 작업(레거시 컬럼 삭제)은 하지 않는다.
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  const byName = new Map<string, BranchRow>();
  for (const b of branches) byName.set(b.name.trim(), b);

  let backfillable = 0;
  let unmatched = 0;
  let missingClient = 0;
  for (const j of jobs) {
    if (j.branch_id == null) {
      const name = (j.branch ?? "").trim();
      if (name && byName.has(name)) backfillable++;
      else if (name) unmatched++;
    } else if (j.client_id == null) {
      missingClient++;
    }
  }

  return {
    jobs_total: jobs.length,
    jobs_linked: jobs.filter((j) => j.branch_id != null).length,
    jobs_backfillable: backfillable,
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

  const byName = new Map<string, BranchRow>();
  for (const b of branches) byName.set(b.name.trim(), b);
  const byId = new Map<number, BranchRow>();
  for (const b of branches) byId.set(b.id, b);

  // 기본 화주사(가장 먼저 생성된 client) — branches.client_id 누락분 귀속용
  const { data: firstClient } = await supabase
    .from("clients")
    .select("id")
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  const defaultClientId = (firstClient?.id as number | undefined) ?? null;

  let jobsBranchFixed = 0;
  let jobsClientFixed = 0;
  let branchesClientFixed = 0;

  // 1) branches.client_id 누락 → 기본 화주사로 귀속
  if (defaultClientId != null) {
    for (const b of branches) {
      if (b.client_id == null) {
        const { error } = await supabase.from("branches").update({ client_id: defaultClientId }).eq("id", b.id);
        if (!error) {
          b.client_id = defaultClientId; // 후속 job client 백필에 반영
          branchesClientFixed++;
        }
      }
    }
  }

  // 2) jobs.branch_id 누락 → 이름 매칭으로 연결, 동시에 client_id도 채움
  for (const j of jobs) {
    if (j.branch_id == null) {
      const name = (j.branch ?? "").trim();
      const match = name ? byName.get(name) : undefined;
      if (match) {
        const { error } = await supabase
          .from("jobs")
          .update({ branch_id: match.id, client_id: match.client_id })
          .eq("id", j.id);
        if (!error) jobsBranchFixed++;
      }
    } else if (j.client_id == null) {
      // 3) branch_id는 있는데 client_id 누락 → 지점의 화주사로 채움
      const b = byId.get(j.branch_id);
      if (b?.client_id != null) {
        const { error } = await supabase.from("jobs").update({ client_id: b.client_id }).eq("id", j.id);
        if (!error) jobsClientFixed++;
      }
    }
  }

  // 갱신 후 리포트 재계산
  const { jobs: jobs2, branches: branches2 } = await loadRows(supabase);
  return NextResponse.json({
    fixed: { jobs_branch: jobsBranchFixed, jobs_client: jobsClientFixed, branches_client: branchesClientFixed },
    report: computeReport(jobs2, branches2),
  });
}
