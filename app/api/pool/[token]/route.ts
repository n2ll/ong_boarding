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
  // recruit_mode 게이팅: pull(/p/[token])은 인재풀 전용 채널이므로 internal·both만 노출한다.
  // external(공개 모집)은 게시 링크로만 유통 — 인재풀 전체에 새어나가면 안 된다(Jobs.tsx '게시 링크' 규칙과 대칭).
  // recruit_mode는 DB NOT NULL DEFAULT 'external' — null은 발생하지 않지만, 안전 방향(비공개)으로 in-필터가 null을 자동 제외한다.
  const { data: jobs, error: jobsErr } = await supabase
    .from("jobs")
    .select("id, title, body, branch, slot, start_date, vehicle_required, pickup_address, pickup_lat, pickup_lng, pay_type, pay_amount, pay_info, capacity, created_at, work_period, closes_at")
    .eq("status", "active")
    .in("recruit_mode", ["internal", "both"])
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

  // '다음 급구 알림' 요청 이력 — 마감 카드 버튼 상태 재수화용 (새로고침 시 중복 접수 방지)
  const { data: notifies } = await supabase
    .from("pool_events")
    .select("job_id")
    .eq("applicant_id", applicant.id)
    .eq("event_type", "notify_request");
  const notifiedJobIds = new Set((notifies ?? []).map((r) => r.job_id as number));

  // 맞춤 정렬 — 좌표가 있으면 가까운 순, 없으면 최신 등록순 유지
  const hasGeo = typeof applicant.lat === "number" && typeof applicant.lng === "number";
  const nowMs = Date.now();
  // 마감 경과 공고는 3일간 '마감됨' 카드로 노출 — "다음 급구 때 먼저 알림" 수집(두 번째 수확).
  // 3일 지나면 완전히 제거. 마감 카드가 실제로 사라지는 걸 보여줘야 긴박감 문구가 거짓이 아니게 된다.
  const EXPIRED_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
  const expiredAt = (j: { closes_at: string | null }) =>
    j.closes_at ? new Date(j.closes_at).getTime() : null;
  const list = (jobs ?? [])
    .filter((j) => {
      const e = expiredAt(j as { closes_at: string | null });
      return e === null || e > nowMs - EXPIRED_GRACE_MS;
    })
    .map((j) => {
      const d =
        hasGeo && typeof j.pickup_lat === "number" && typeof j.pickup_lng === "number"
          ? distKm(applicant.lat as number, applicant.lng as number, j.pickup_lat, j.pickup_lng)
          : null;
      return {
        id: j.id,
        title: j.title,
        // 공고 본문 — 지원자가 '관심 있음' 판단에 필요한 상세(업무 형태·일정 등).
        // 민감정보(업체명·상세주소·연락처)는 본문 작성 단계에서 제외하는 게 원칙.
        body: j.body,
        branch: j.branch,
        slot: j.slot,
        start_date: j.start_date,
        vehicle_required: j.vehicle_required,
        pickup_address: j.pickup_address,
        pay_type: j.pay_type,
        pay_amount: j.pay_amount,
        pay_info: j.pay_info,
        work_period: j.work_period,
        closes_at: j.closes_at,
        expired: (() => {
          const e = expiredAt(j as { closes_at: string | null });
          return e !== null && e <= nowMs;
        })(),
        distance_km: d === null ? null : Math.round(d * 10) / 10,
        interested: linkedJobIds.has(j.id as number),
        notified: notifiedJobIds.has(j.id as number),
      };
    })
    .sort((a, b) => {
      if (a.expired !== b.expired) return a.expired ? 1 : -1; // 진행 중 공고 먼저
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
