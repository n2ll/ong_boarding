/**
 * GET /api/pool/[token] — 무로그인 pull 채널: 지원자별 맞춤 공고 목록.
 *
 * 인력풀이 활성 공고를 스스로 확인하는 창구 (PRODUCT_DIRECTION §5.5[3]·§6).
 * 인증은 applicants.access_token(UUID, 유니크 인덱스) 자체가 담당 — 로그인·앱 없음.
 * 열람은 pool_events(link_view)로 기록해 가용성 신선도의 근거로 쓴다.
 *
 * ⚠️ 응답에 다른 지원자·내부 정보가 섞이지 않게 공고 표시 필드만 선별해 내린다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const token = params.token;
  if (!UUID_RE.test(token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: applicant, error } = await supabase
    .from("applicants")
    .select("id, name, lat, lng, availability")
    .eq("access_token", token)
    .maybeSingle();

  if (error) {
    console.error("[pool GET] applicant lookup failed", error);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
  if (!applicant) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // 활성 실공고 (시스템 더미 공고 제외)
  const { data: jobs, error: jobsErr } = await supabase
    .from("jobs")
    .select("id, title, branch, slot, start_date, vehicle_required, pickup_address, pickup_lat, pickup_lng, pay_type, pay_amount, pay_info, capacity, created_at")
    .eq("status", "active")
    .not("title", "like", "\\_\\_%")
    .order("created_at", { ascending: false });

  if (jobsErr) {
    console.error("[pool GET] jobs fetch failed", jobsErr);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  // 이미 관심/지원으로 연결된 공고 표시
  const { data: jcs } = await supabase
    .from("job_candidates")
    .select("job_id")
    .eq("applicant_id", applicant.id);
  const linkedJobIds = new Set((jcs ?? []).map((r) => r.job_id as number));

  // 맞춤 정렬 — 좌표가 있으면 가까운 순, 없으면 최신 등록순 유지
  const hasGeo = typeof applicant.lat === "number" && typeof applicant.lng === "number";
  const list = (jobs ?? [])
    .map((j) => {
      const d =
        hasGeo && typeof j.pickup_lat === "number" && typeof j.pickup_lng === "number"
          ? distKm(applicant.lat as number, applicant.lng as number, j.pickup_lat, j.pickup_lng)
          : null;
      return {
        id: j.id,
        title: j.title,
        branch: j.branch,
        slot: j.slot,
        start_date: j.start_date,
        vehicle_required: j.vehicle_required,
        pickup_address: j.pickup_address,
        pay_type: j.pay_type,
        pay_amount: j.pay_amount,
        pay_info: j.pay_info,
        distance_km: d === null ? null : Math.round(d * 10) / 10,
        interested: linkedJobIds.has(j.id as number),
      };
    })
    .sort((a, b) => {
      if (a.distance_km !== null && b.distance_km !== null) return a.distance_km - b.distance_km;
      if (a.distance_km !== null) return -1;
      if (b.distance_km !== null) return 1;
      return 0; // 둘 다 좌표 없으면 최신순(원 순서) 유지
    });

  // 열람 이벤트 — 신선도 근거 (실패해도 응답은 정상)
  // 새로고침마다 열람 수가 부풀지 않게 같은 지원자의 link_view가 최근 30분 내 있으면 기록 생략 (파일럿 KPI 열람률 보호).
  // 인덱스: pool_events_applicant_created_idx(applicant_id, created_at DESC)가 applicant_id 등치 + created_at 범위를
  // 커버하고 event_type은 잔여 필터로 처리됨 — 지원자당 이벤트 수가 적어 별도 인덱스 불필요.
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: recentView, error: dupErr } = await supabase
    .from("pool_events")
    .select("id")
    .eq("applicant_id", applicant.id)
    .eq("event_type", "link_view")
    .gt("created_at", since)
    .limit(1)
    .maybeSingle();
  if (dupErr) console.error("[pool GET] link_view dedupe check failed", dupErr);
  if (!recentView) {
    const { error: evErr } = await supabase.from("pool_events").insert({
      applicant_id: applicant.id,
      event_type: "link_view",
      meta: { jobs_shown: list.length },
    });
    if (evErr) console.error("[pool GET] link_view insert failed", evErr);
  }

  return NextResponse.json({
    name: applicant.name,
    availability: applicant.availability,
    jobs: list,
  });
}
