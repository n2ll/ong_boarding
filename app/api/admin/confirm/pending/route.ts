/**
 * GET /api/admin/confirm/pending
 *
 * '확정 대기' 큐 — 스크리닝을 끝냈지만(status='스크리닝 완료') 아직 매니저가 '확정인력'으로
 * 전환하지 않은 지원자. 매니저 확정 루프가 곧 제품 SLA이므로 이 큐를 Live 콘솔에 노출한다.
 *
 * 라인 형태 무관(확장성): 배민커넥트 라인은 온보딩 끝에 agent_stage='active'가 되고,
 * 도시락 등 internal 정기 라인은 스크리닝 통과 후 매니저 인계(paused)로 끝난다.
 * baemin_id·특정 stage에 묶지 않고, '스크리닝 완료' + 진행 중(비마감) 공고 링크 하나로 정의한다.
 *
 * 정의: applicants.status='스크리닝 완료'.
 * 각 지원자의 '확정 대상 공고'는 링크된 후보 중 (1) 진행단계(active/onboarding/paused/screening)이면서
 * 마감되지 않은 공고를 우선, 없으면 (2) 마감되지 않은 공고의 최신 링크(관심 클릭 등 null stage 포함).
 * 그 공고에서 만남장소 발송에 필요한 정보(start_date/pickup_address/현장매니저)를 함께 싣는다.
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { isJobEffectivelyClosed, isSystemJobTitle } from "@/lib/jobs";

export const dynamic = "force-dynamic";

interface JobRow {
  id: number;
  title: string | null;
  branch: string | null;
  start_date: string | null;
  pickup_address: string | null;
  site_manager_id: number | null;
  status: string | null;
  closes_at: string | null;
  recruit_mode: string | null;
}

// 진행 단계(확정 대상 후보로 우선). abort/null은 여기서 제외(단, 폴백에서 null도 허용).
const IN_PROGRESS_STAGES = new Set(["active", "onboarding", "paused", "screening"]);

export async function GET() {
  const supabase = createServiceClient();

  const { data: apps, error } = await supabase
    .from("applicants")
    .select("id, name, phone, branch1, confirmed_branch, baemin_id, created_at")
    .eq("status", "스크리닝 완료")
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

  // 모든 후보 + 공고 (stage 필터 없이) — 라인 형태별 종료 stage가 달라 여기서 좁히지 않는다.
  const { data: cands } = await supabase
    .from("job_candidates")
    .select("applicant_id, job_id, agent_stage, created_at, jobs:job_id ( id, title, branch, start_date, pickup_address, site_manager_id, status, closes_at, recruit_mode )")
    .in("applicant_id", ids)
    .order("created_at", { ascending: false });

  // 지원자별 확정 대상 공고 선택: 진행단계+비마감 우선 → 없으면 비마감 최신(null stage 포함).
  // 시스템 더미 공고·마감 공고는 대상에서 제외(마감된 공고로 확정 유도 방지).
  type Cand = { applicant_id: number; job_id: number; agent_stage: string | null; jobs: JobRow | null };
  const byApplicant = new Map<number, { primary: Cand | null; fallback: Cand | null }>();
  for (const c of (cands ?? []) as unknown as Cand[]) {
    const job = c.jobs ?? null;
    if (!job || isSystemJobTitle(job.title) || isJobEffectivelyClosed(job.status, job.closes_at)) continue;
    const slot = byApplicant.get(c.applicant_id) ?? { primary: null, fallback: null };
    if (IN_PROGRESS_STAGES.has(c.agent_stage ?? "")) {
      if (!slot.primary) slot.primary = c;
    } else if (!slot.fallback) {
      slot.fallback = c;
    }
    byApplicant.set(c.applicant_id, slot);
  }
  const jobByApplicant = new Map<number, { job_id: number; job: JobRow | null }>();
  for (const [aid, slot] of byApplicant) {
    const pick = slot.primary ?? slot.fallback;
    if (pick) jobByApplicant.set(aid, { job_id: pick.job_id, job: pick.jobs ?? null });
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

  // 확정 대상 공고 링크가 있는 지원자만 큐에 싣는다 — 비마감 공고에 붙지 않은 '스크리닝 완료'는
  // 확정할 공고가 없으므로 제외(과거 baemin_id 게이트가 하던 '온보딩 완료' 역할을 공고 링크로 대체).
  const pending = applicants
    .filter((a) => jobByApplicant.has(a.id))
    .map((a) => {
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
