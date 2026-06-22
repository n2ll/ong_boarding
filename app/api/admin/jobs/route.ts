/**
 * GET  /api/admin/jobs              — 공고 목록 (필터: status)
 * POST /api/admin/jobs              — 공고 신규 생성
 *
 * 사이드바 + 보드용 카운트도 같이 내려준다 (단일 쿼리 부담을 줄이기 위해 별도 view 없이 집계).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { DANGGEUN_SYSTEM_JOB_TITLE } from "@/lib/agent/danggeun-job";

export async function GET(req: NextRequest) {
  const supabase = createServiceClient();
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status"); // active/closed/paused/all

  let query = supabase
    .from("jobs")
    .select("id, title, body, branch, slot, start_date, vehicle_required, pickup_address, capacity, status, site_manager_id, created_at, updated_at, closed_at")
    .neq("title", DANGGEUN_SYSTEM_JOB_TITLE) // 시스템 더미 공고는 칸반에서 숨김
    .order("created_at", { ascending: false });

  if (statusFilter && statusFilter !== "all") {
    query = query.eq("status", statusFilter);
  }

  const { data: jobs, error } = await query;
  if (error) {
    console.error("[jobs GET]", error);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  // 공고별 후보 카운트(stage 별) 조회 — 한 번의 쿼리로
  const jobIds = (jobs ?? []).map((j) => j.id);
  const stageCounts: Record<number, Record<string, number>> = {};
  if (jobIds.length > 0) {
    const { data: cands } = await supabase
      .from("job_candidates")
      .select("job_id, agent_stage")
      .in("job_id", jobIds);
    for (const c of cands ?? []) {
      const jid = c.job_id as number;
      const stage = (c.agent_stage as string | null) ?? "sent";
      stageCounts[jid] ??= {};
      stageCounts[jid][stage] = (stageCounts[jid][stage] ?? 0) + 1;
    }
  }

  const enriched = (jobs ?? []).map((j) => ({
    ...j,
    counts: stageCounts[j.id] ?? {},
  }));

  return NextResponse.json({ jobs: enriched });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const {
    title,
    body: jobBody,
    branch,
    slot,
    start_date,
    vehicle_required,
    pickup_address,
    pickup_lat,
    pickup_lng,
    capacity,
    site_manager_id,
    created_by,
  } = body as {
    title?: string;
    body?: string;
    branch?: string | null;
    slot?: string | null;
    start_date?: string | null;
    vehicle_required?: boolean;
    pickup_address?: string | null;
    pickup_lat?: number | null;
    pickup_lng?: number | null;
    capacity?: number;
    site_manager_id?: number | null;
    created_by?: string | null;
  };

  if (!title?.trim() || !jobBody?.trim()) {
    return NextResponse.json(
      { error: "title과 body는 필수입니다." },
      { status: 400 }
    );
  }
  if (slot && !["평일오전", "평일오후", "주말오전", "주말오후"].includes(slot)) {
    return NextResponse.json({ error: "slot 값이 잘못되었습니다." }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      title: title.trim(),
      body: jobBody.trim(),
      branch: branch ?? null,
      slot: slot ?? null,
      start_date: start_date ?? null,
      vehicle_required: vehicle_required ?? true,
      pickup_address: pickup_address ?? null,
      pickup_lat: pickup_lat ?? null,
      pickup_lng: pickup_lng ?? null,
      capacity: capacity ?? 1,
      site_manager_id: site_manager_id ?? null,
      created_by: created_by ?? null,
    })
    .select()
    .single();

  if (error || !data) {
    console.error("[jobs POST]", error);
    return NextResponse.json({ error: "공고 생성 실패" }, { status: 500 });
  }

  return NextResponse.json({ job: data });
}
