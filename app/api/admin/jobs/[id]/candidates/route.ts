/**
 * GET  /api/admin/jobs/[id]/candidates  — 공고에 묶인 후보자 + 진행 상태 + 최근 메시지
 * POST /api/admin/jobs/[id]/candidates  — 후보자 추가 (단순 INSERT, 발송은 dispatch에서)
 *
 * 보드/표 화면이 이 응답을 그대로 사용한다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { distanceToJobKm, EXPOSURE_JOB_GEO_COLUMNS, type GeoJob } from "@/lib/geo";
import { ensureExposureIncludeForLinked } from "@/lib/exposure";
import { fetchAllPostgrestRows } from "@/lib/admin/postgrest-pagination";

export const dynamic = "force-dynamic";

type CandidateBoardRow = Record<string, unknown> & {
  applicants?:
    | { lat?: number | null; lng?: number | null }
    | { lat?: number | null; lng?: number | null }[]
    | null;
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeParams = await params;
  const jobId = Number(routeParams.id);
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();
  let rows: CandidateBoardRow[];
  let job: GeoJob | null;
  const [candidateResult, jobResult] = await Promise.allSettled([
    fetchAllPostgrestRows(async (from, to) => {
      const result = await supabase
        .from("job_candidates")
        .select(`
          id, job_id, applicant_id, agent_stage, agent_state, paused_reason,
          sent_at, responded_at, screening_passed_at, activated_at, closed_at, closed_reason,
          created_at, updated_at,
          applicants:applicant_id (
            id, name, phone, branch1, branch2, work_hours, location,
            own_vehicle, license_type, vehicle_type, available_date, status,
            source, confirmed_slot, confirmed_branch, availability,
            lat, lng, applied_at,
            last_message_at
          )
        `)
        .eq("job_id", jobId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
      return {
        data: result.data as unknown as CandidateBoardRow[] | null,
        error: result.error,
      };
    }, "공고 후보"),
    supabase
      .from("jobs")
      .select(EXPOSURE_JOB_GEO_COLUMNS)
      .eq("id", jobId)
      .maybeSingle(),
  ]);

  if (candidateResult.status === "rejected") {
    console.error("[candidates GET]", candidateResult.reason);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
  rows = candidateResult.value;

  if (jobResult.status === "rejected") {
    console.error("[candidates GET] optional job geo", jobResult.reason);
    job = null;
  } else if (jobResult.value.error) {
    console.error("[candidates GET] optional job geo", jobResult.value.error);
    job = null;
  } else {
    job = (jobResult.value.data as unknown as GeoJob | null) ?? null;
  }

  // 후보↔공고 거리(km) — 상차지·마지막 경유지 중 가까운 쪽 기준(파이프라인 거리 정렬과 동일 원칙).
  // 보드 '추천순' 정렬과 카드 메타 줄의 근거로 distance_km을 함께 내려준다.

  const candidates = rows.map((r) => {
    // supabase 조인은 1:1이어도 배열/객체로 올 수 있어 둘 다 방어(jobs GET과 동일 패턴).
    const rel = r.applicants;
    const a = Array.isArray(rel) ? rel[0] : rel;
    const alat = a?.lat;
    const alng = a?.lng;
    // 거리는 lib/geo 단일 공식 — 기준점은 공고가 정한다(distance_basis). 화면마다 다른 숫자를 만들지 않는다.
    const distance_km = distanceToJobKm(
      { lat: typeof alat === "number" ? alat : null, lng: typeof alng === "number" ? alng : null },
      job
    );
    return { ...r, distance_km };
  });

  return NextResponse.json({ candidates });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeParams = await params;
  const jobId = Number(routeParams.id);
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const applicantIds = body.applicant_ids;
  if (!Array.isArray(applicantIds) || applicantIds.length === 0) {
    return NextResponse.json({ error: "applicant_ids 배열 필수" }, { status: 400 });
  }
  const ids = applicantIds.filter((x) => Number.isFinite(x)) as number[];
  if (ids.length === 0) {
    return NextResponse.json({ error: "유효한 applicant_id 없음" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const rows = ids.map((aid) => ({ job_id: jobId, applicant_id: aid }));
  const { data, error } = await supabase
    .from("job_candidates")
    .upsert(rows, { onConflict: "job_id,applicant_id", ignoreDuplicates: true })
    .select();

  if (error) {
    console.error("[candidates POST]", error);
    return NextResponse.json({ error: "후보 추가 실패" }, { status: 500 });
  }

  // 지정 노출 공고면 방금 붙인 후보를 노출 명단에 남긴다 — 좁히는 시점의 보호는 그 순간의 명단만
  // 지키므로, 전환 뒤 추가한 후보는 '지원자는 못 보는데 AI는 말하는' 상태가 된다.
  let exposureIncluded = 0;
  try {
    exposureIncluded = await ensureExposureIncludeForLinked(supabase, jobId, ids);
  } catch (e) {
    console.error("[candidates POST] exposure include failed", e);
    return NextResponse.json(
      {
        // 이 공고가 '지정 노출'일 때만 도달하는 경로다(전체 노출이면 훅이 0을 반환하고 끝).
        error:
          "후보는 추가했지만 노출 명단에 남기지 못했어요 — 이 공고는 지정 노출이라, 인재풀에서 '이 명단에게만 노출'로 이분들을 명단에 추가해야 본인 링크에 공고가 보입니다.",
        added: data?.length ?? 0,
        partial: true,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ added: data?.length ?? 0, candidates: data ?? [], exposure_included: exposureIncluded });
}
