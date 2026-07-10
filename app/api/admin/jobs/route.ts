/**
 * GET  /api/admin/jobs              — 공고 목록 (필터: status)
 * POST /api/admin/jobs              — 공고 신규 생성
 *
 * 사이드바 + 보드용 카운트도 같이 내려준다 (단일 쿼리 부담을 줄이기 위해 별도 view 없이 집계).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { DANGGEUN_SYSTEM_JOB_TITLE } from "@/lib/agent/danggeun-job";
import { isSystemJobTitle } from "@/lib/jobs";
import { geocodeAddressWithFallback } from "@/lib/kakao-geocode";

const RECRUIT_MODES = new Set(["external", "internal", "both"]);

export async function GET(req: NextRequest) {
  const supabase = createServiceClient();
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status"); // active/closed/paused/all
  const clientFilter = url.searchParams.get("client_id");
  const branchFilter = url.searchParams.get("branch_id");

  let query = supabase
    .from("jobs")
    .select("id, title, body, branch, branch_id, client_id, slot, start_date, vehicle_required, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, pay_info, policy_notes, pay_type, pay_amount, ai_facts, capacity, status, recruit_mode, site_manager_id, created_at, updated_at, closed_at, work_period, closes_at")
    .neq("title", DANGGEUN_SYSTEM_JOB_TITLE) // 시스템 더미 공고는 칸반에서 숨김
    .order("created_at", { ascending: false });

  if (statusFilter && statusFilter !== "all") {
    query = query.eq("status", statusFilter);
  }
  if (clientFilter && /^\d+$/.test(clientFilter)) {
    query = query.eq("client_id", Number(clientFilter));
  }
  if (branchFilter && /^\d+$/.test(branchFilter)) {
    query = query.eq("branch_id", Number(branchFilter));
  }

  const { data: jobs, error } = await query;
  if (error) {
    console.error("[jobs GET]", error);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  // 공고별 후보 카운트(stage 별) 조회 — 한 번의 쿼리로.
  // 충원율은 매니저 명시 확정(applicants.status='확정인력')만 센다 — agent_stage='active'는 자동 전이라
  // '확정'이 아니다(확정은 매니저 판단, transitions.ts 참조). confirmed_count로 별도 집계해 게이지와
  // 보드의 '확정 슬롯 분포'가 같은 소스를 쓰게 한다.
  const jobIds = (jobs ?? []).map((j) => j.id);
  const stageCounts: Record<number, Record<string, number>> = {};
  const confirmedCounts: Record<number, number> = {};
  const unreadTotals: Record<number, number> = {};
  if (jobIds.length > 0) {
    const { data: cands } = await supabase
      .from("job_candidates")
      .select("job_id, agent_stage, applicants:applicant_id ( status, unread_count )")
      .in("job_id", jobIds);
    for (const c of cands ?? []) {
      const jid = c.job_id as number;
      const stage = (c.agent_stage as string | null) ?? "sent";
      stageCounts[jid] ??= {};
      stageCounts[jid][stage] = (stageCounts[jid][stage] ?? 0) + 1;
      // supabase 조인은 1:1이어도 배열/객체로 올 수 있어 둘 다 방어.
      const rel = (c as { applicants?: { status?: string | null; unread_count?: number | null } | { status?: string | null; unread_count?: number | null }[] | null }).applicants;
      const a = Array.isArray(rel) ? rel[0] : rel;
      if (a?.status === "확정인력") confirmedCounts[jid] = (confirmedCounts[jid] ?? 0) + 1;
      // 후보 미읽음 답장 합산 — 목록 행 '답장 N' 칩(수동 응대 필요 신호)의 근거.
      if (typeof a?.unread_count === "number" && a.unread_count > 0) {
        unreadTotals[jid] = (unreadTotals[jid] ?? 0) + a.unread_count;
      }
    }
  }

  // 공고별 관심 표시(interest_click) 인원수 — pull 채널 반응 현황. 같은 지원자의 중복 클릭은 1명으로 센다.
  const interestCounts: Record<number, number> = {};
  if (jobIds.length > 0) {
    const { data: clicks } = await supabase
      .from("pool_events")
      .select("applicant_id, job_id")
      .eq("event_type", "interest_click")
      .in("job_id", jobIds)
      // supabase 기본 1000행 절단 방지(pool-events/summary와 동일 상한).
      .limit(5000);
    const seen = new Set<string>();
    for (const ev of clicks ?? []) {
      const jid = ev.job_id as number | null;
      const aid = ev.applicant_id as number | null;
      if (typeof jid !== "number" || typeof aid !== "number") continue;
      const key = `${jid}:${aid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      interestCounts[jid] = (interestCounts[jid] ?? 0) + 1;
    }
  }

  const enriched = (jobs ?? []).map((j) => ({
    ...j,
    counts: stageCounts[j.id] ?? {},
    confirmed_count: confirmedCounts[j.id] ?? 0,
    interest_count: interestCounts[j.id] ?? 0,
    unread_total: unreadTotals[j.id] ?? 0,
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
    branch_id,
    client_id,
    slot,
    start_date,
    vehicle_required,
    pickup_address,
    pickup_lat,
    pickup_lng,
    dropoff_address,
    dropoff_lat,
    dropoff_lng,
    pay_info,
    policy_notes,
    pay_type,
    pay_amount,
    ai_facts,
    capacity,
    recruit_mode,
    site_manager_id,
    created_by,
    work_period,
    closes_at,
    sos_request_id,
  } = body as {
    title?: string;
    body?: string;
    branch?: string | null;
    branch_id?: number | null;
    client_id?: number | null;
    slot?: string | null;
    start_date?: string | null;
    vehicle_required?: boolean;
    pickup_address?: string | null;
    pickup_lat?: number | null;
    pickup_lng?: number | null;
    dropoff_address?: string | null;
    dropoff_lat?: number | null;
    dropoff_lng?: number | null;
    pay_info?: string | null;
    policy_notes?: string | null;
    pay_type?: string | null;
    pay_amount?: number | null;
    ai_facts?: string | null;
    capacity?: number;
    recruit_mode?: string;
    site_manager_id?: number | null;
    created_by?: string | null;
    work_period?: string | null;
    closes_at?: string | null;
    sos_request_id?: number | null;
  };

  if (!title?.trim() || !jobBody?.trim()) {
    return NextResponse.json(
      { error: "title과 body는 필수입니다." },
      { status: 400 }
    );
  }
  // `__` 프리픽스는 시스템 더미 공고 예약어 — 사용자 공고가 이걸로 시작하면 목록·pull에서 숨겨져 사라진 것처럼 보인다.
  if (isSystemJobTitle(title.trim())) {
    return NextResponse.json(
      { error: "공고 제목은 '__'로 시작할 수 없습니다(시스템 예약 프리픽스)." },
      { status: 400 }
    );
  }
  if (slot && !["평일오전", "평일오후", "주말오전", "주말오후"].includes(slot)) {
    return NextResponse.json({ error: "slot 값이 잘못되었습니다." }, { status: 400 });
  }
  if (recruit_mode && !RECRUIT_MODES.has(recruit_mode)) {
    return NextResponse.json({ error: "recruit_mode 값이 잘못되었습니다." }, { status: 400 });
  }
  if (pay_type && !["건당", "일당", "주급", "월급", "혼합", "협의"].includes(pay_type)) {
    return NextResponse.json({ error: "pay_type 값이 잘못되었습니다." }, { status: 400 });
  }
  if (work_period && !["하루", "단기", "정기"].includes(work_period)) {
    return NextResponse.json({ error: "work_period 값이 잘못되었습니다." }, { status: 400 });
  }

  const supabase = createServiceClient();

  // branch_id가 오면 지점 이름·소속 화주사를 함께 채워 계층을 일관되게 유지한다.
  // 지점 없이 화주사(client_id)만 온 경우엔 그 값을 그대로 저장해 화주사 필터에서 유실되지 않게 한다.
  let resolvedBranchName: string | null = branch ?? null;
  let resolvedClientId: number | null = typeof client_id === "number" ? client_id : null;
  if (typeof branch_id === "number") {
    const { data: b } = await supabase
      .from("branches")
      .select("name, client_id")
      .eq("id", branch_id)
      .maybeSingle();
    if (b) {
      resolvedBranchName = (b.name as string) ?? resolvedBranchName;
      resolvedClientId = (b.client_id as number | null) ?? null;
    }
  }

  // 상차지 주소가 있고 좌표가 안 넘어왔으면 지오코딩 — 파이프라인 거리 정렬의 근거.
  let resolvedPickupLat = typeof pickup_lat === "number" ? pickup_lat : null;
  let resolvedPickupLng = typeof pickup_lng === "number" ? pickup_lng : null;
  if (pickup_address && resolvedPickupLat === null && resolvedPickupLng === null) {
    const { geo } = await geocodeAddressWithFallback(String(pickup_address));
    if (geo) {
      resolvedPickupLat = geo.lat;
      resolvedPickupLng = geo.lng;
    }
  }

  // 마지막 경유지(배송 종료 지점) 주소가 있고 좌표가 안 넘어왔으면 지오코딩 — 거리 정렬은 상차지·마지막경유지 중 가까운 쪽 기준.
  let resolvedDropoffLat = typeof dropoff_lat === "number" ? dropoff_lat : null;
  let resolvedDropoffLng = typeof dropoff_lng === "number" ? dropoff_lng : null;
  if (dropoff_address && resolvedDropoffLat === null && resolvedDropoffLng === null) {
    const { geo } = await geocodeAddressWithFallback(String(dropoff_address));
    if (geo) {
      resolvedDropoffLat = geo.lat;
      resolvedDropoffLng = geo.lng;
    }
  }

  const { data, error } = await supabase
    .from("jobs")
    .insert({
      title: title.trim(),
      body: jobBody.trim(),
      branch: resolvedBranchName,
      branch_id: typeof branch_id === "number" ? branch_id : null,
      client_id: resolvedClientId,
      slot: slot ?? null,
      start_date: start_date ?? null,
      vehicle_required: vehicle_required ?? true,
      pickup_address: pickup_address ?? null,
      pickup_lat: resolvedPickupLat,
      pickup_lng: resolvedPickupLng,
      dropoff_address: dropoff_address ?? null,
      dropoff_lat: resolvedDropoffLat,
      dropoff_lng: resolvedDropoffLng,
      pay_info: pay_info ?? null,
      policy_notes: policy_notes ?? null,
      pay_type: pay_type ?? null,
      pay_amount: typeof pay_amount === "number" ? pay_amount : null,
      ai_facts: ai_facts ?? null,
      capacity: capacity ?? 1,
      recruit_mode: recruit_mode ?? "external",
      site_manager_id: site_manager_id ?? null,
      created_by: created_by ?? null,
      work_period: work_period || null,
      closes_at: closes_at ?? null,
      // 긴급 건(SOS)에서 파생된 공고면 그 id를 보관 — 파생 관계 영속(자동 해결 연동은 범위 밖).
      sos_request_id: typeof sos_request_id === "number" ? sos_request_id : null,
    })
    .select()
    .single();

  if (error || !data) {
    console.error("[jobs POST]", error);
    return NextResponse.json({ error: "공고 생성 실패" }, { status: 500 });
  }

  return NextResponse.json({ job: data });
}
