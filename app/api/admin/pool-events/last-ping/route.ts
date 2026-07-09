/**
 * POST /api/admin/pool-events/last-ping
 *
 * 지원자별 마지막 재컨택(ping_sent) 시각을 배치 조회 — 파이프라인 리스트의
 * '재컨택 N일 전' 배지 + '최근 N일 재컨택 제외' 필터의 근거 데이터.
 * 인증은 middleware의 /api/admin/* Basic Auth에 위임.
 *
 * body: { applicantIds: number[] } (최대 500 — active-check와 동일 상한)
 * 응답: { lastPingById: Record<number, string> }  // ISO 시각, ping 이력 있는 인원만.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const MAX_IDS = 500;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const applicantIds: unknown = body?.applicantIds;

  if (
    !Array.isArray(applicantIds) ||
    applicantIds.length === 0 ||
    !applicantIds.every((v) => Number.isFinite(Number(v)))
  ) {
    return NextResponse.json(
      { error: "applicantIds must be a non-empty number array" },
      { status: 400 }
    );
  }
  if (applicantIds.length > MAX_IDS) {
    return NextResponse.json({ error: `too many applicantIds (max ${MAX_IDS})` }, { status: 400 });
  }

  const numIds = applicantIds.map((v) => Number(v));
  const supabase = createServiceClient();

  // created_at desc 정렬이므로 각 지원자의 첫 등장이 마지막 ping. (pool_events_applicant_created_idx 활용)
  const { data: events, error } = await supabase
    .from("pool_events")
    .select("applicant_id, created_at")
    .eq("event_type", "ping_sent")
    .in("applicant_id", numIds)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[pool-events/last-ping]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const lastPingById: Record<number, string> = {};
  for (const ev of events ?? []) {
    const id = ev.applicant_id as number;
    if (id in lastPingById) continue;
    lastPingById[id] = ev.created_at as string;
  }

  return NextResponse.json({ lastPingById });
}
