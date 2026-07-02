/**
 * GET /api/admin/confirm/pending
 *
 * '확정 대기' 큐 — 온보딩을 끝냈지만(배민 아이디 수집 완료) 아직 매니저가 '확정인력'으로
 * 전환하지 않은 지원자. 매니저 확정 루프가 곧 제품 SLA이므로 이 큐를 Live 콘솔에 노출한다.
 *
 * 정의: applicants.status='스크리닝 완료' AND baemin_id 있음.
 * 각 지원자의 활성 후보(agent_stage='active') 공고에서 만남장소 발송에 필요한 정보
 * (start_date/pickup_address/현장매니저)를 함께 실어 보낸다.
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface JobRow {
  id: number;
  title: string | null;
  branch: string | null;
  start_date: string | null;
  pickup_address: string | null;
  site_manager_id: number | null;
}

export async function GET() {
  const supabase = createServiceClient();

  const { data: apps, error } = await supabase
    .from("applicants")
    .select("id, name, phone, branch1, confirmed_branch, baemin_id, created_at")
    .eq("status", "스크리닝 완료")
    .not("baemin_id", "is", null)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[confirm/pending]", error);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
  const applicants = (apps ?? []) as {
    id: number; name: string | null; phone: string | null;
    branch1: string | null; confirmed_branch: string | null; baemin_id: string | null;
  }[];
  if (applicants.length === 0) return NextResponse.json({ pending: [], total: 0 });

  const ids = applicants.map((a) => a.id);

  // 활성 후보 + 공고 (만남장소 발송 정보 소스). 한 지원자가 여러 활성 후보면 가장 최근 것.
  const { data: cands } = await supabase
    .from("job_candidates")
    .select("applicant_id, job_id, created_at, jobs:job_id ( id, title, branch, start_date, pickup_address, site_manager_id )")
    .in("applicant_id", ids)
    .eq("agent_stage", "active")
    .order("created_at", { ascending: false });

  const jobByApplicant = new Map<number, { job_id: number; job: JobRow | null }>();
  for (const c of (cands ?? []) as unknown as { applicant_id: number; job_id: number; jobs: JobRow | null }[]) {
    if (!jobByApplicant.has(c.applicant_id)) {
      jobByApplicant.set(c.applicant_id, { job_id: c.job_id, job: c.jobs ?? null });
    }
  }

  // 현장매니저 배치 조회
  const smIds = Array.from(
    new Set(
      Array.from(jobByApplicant.values())
        .map((v) => v.job?.site_manager_id)
        .filter((v): v is number => typeof v === "number")
    )
  );
  const smById = new Map<number, { name: string | null; phone: string | null }>();
  if (smIds.length > 0) {
    const { data: sms } = await supabase.from("site_managers").select("id, name, phone").in("id", smIds);
    for (const s of sms ?? []) {
      smById.set(s.id as number, { name: (s.name as string) ?? null, phone: (s.phone as string) ?? null });
    }
  }

  const pending = applicants.map((a) => {
    const jc = jobByApplicant.get(a.id) ?? null;
    const job = jc?.job ?? null;
    const sm = job?.site_manager_id != null ? smById.get(job.site_manager_id) ?? null : null;
    const jobTitle =
      job && typeof job.title === "string"
        ? job.title.startsWith("__") ? "공고 미지정" : job.title
        : null;
    return {
      applicant_id: a.id,
      name: a.name ?? `지원자 #${a.id}`,
      phone: a.phone ?? null,
      branch: a.confirmed_branch ?? a.branch1 ?? job?.branch ?? null,
      baemin_id: a.baemin_id ?? null,
      job_id: jc?.job_id ?? null,
      job_title: jobTitle,
      start_date: job?.start_date ?? null,
      pickup_address: job?.pickup_address ?? null,
      site_manager_name: sm?.name ?? null,
      site_manager_phone: sm?.phone ?? null,
      can_send_venue: !!(job?.pickup_address && sm?.name),
    };
  });

  return NextResponse.json({ pending, total: pending.length });
}
