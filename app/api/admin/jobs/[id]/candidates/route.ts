/**
 * GET  /api/admin/jobs/[id]/candidates  — 공고에 묶인 후보자 + 진행 상태 + 최근 메시지
 * POST /api/admin/jobs/[id]/candidates  — 후보자 추가 (단순 INSERT, 발송은 dispatch에서)
 *
 * 보드/표 화면이 이 응답을 그대로 사용한다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { haversineKm } from "@/lib/kakao-geocode";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const jobId = Number(params.id);
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: rows, error } = await supabase
    .from("job_candidates")
    .select(`
      id, job_id, applicant_id, agent_stage, agent_state, paused_reason,
      sent_at, responded_at, confirmed_at, activated_at, closed_at, closed_reason,
      created_at, updated_at,
      applicants:applicant_id (
        id, name, phone, branch1, branch2, work_hours, location,
        own_vehicle, license_type, vehicle_type, available_date, status,
        source, confirmed_slot, confirmed_branch, availability,
        lat, lng, applied_at,
        last_message_at, unread_count
      )
    `)
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[candidates GET]", error);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  // 후보↔공고 거리(km) — 상차지·마지막 경유지 중 가까운 쪽 기준(파이프라인 거리 정렬과 동일 원칙).
  // 보드 '추천순' 정렬과 카드 메타 줄의 근거로 distance_km을 함께 내려준다.
  const { data: job } = await supabase
    .from("jobs")
    .select("pickup_lat, pickup_lng, dropoff_lat, dropoff_lng")
    .eq("id", jobId)
    .maybeSingle();
  const anchors: { lat: number; lng: number }[] = [];
  if (typeof job?.pickup_lat === "number" && typeof job?.pickup_lng === "number") {
    anchors.push({ lat: job.pickup_lat, lng: job.pickup_lng });
  }
  if (typeof job?.dropoff_lat === "number" && typeof job?.dropoff_lng === "number") {
    anchors.push({ lat: job.dropoff_lat, lng: job.dropoff_lng });
  }

  const candidates = (rows ?? []).map((r) => {
    // supabase 조인은 1:1이어도 배열/객체로 올 수 있어 둘 다 방어(jobs GET과 동일 패턴).
    const rel = (r as { applicants?: { lat?: number | null; lng?: number | null } | { lat?: number | null; lng?: number | null }[] | null }).applicants;
    const a = Array.isArray(rel) ? rel[0] : rel;
    const alat = a?.lat;
    const alng = a?.lng;
    let distance_km: number | null = null;
    if (anchors.length > 0 && typeof alat === "number" && typeof alng === "number") {
      distance_km = Math.min(...anchors.map((p) => haversineKm(alat, alng, p.lat, p.lng)));
    }
    return { ...r, distance_km };
  });

  return NextResponse.json({ candidates });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const jobId = Number(params.id);
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

  return NextResponse.json({ added: data?.length ?? 0, candidates: data ?? [] });
}
