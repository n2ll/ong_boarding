/**
 * POST /api/admin/pool-events/summary
 *
 * 지원자별 pool_events 반응 요약 배치 조회 — 파이프라인 리스트의
 * 반응 배지(열람/관심/답장) + '재컨택 N일 전' 배지 + '반응 있음' 필터/'반응 최신순' 정렬의 근거.
 * last-ping 조회(ping_sent만)를 포괄해 대체한다. 인증은 middleware의 /api/admin/* Basic Auth에 위임.
 *
 * body: { applicantIds: number[] } (최대 500 — active-check/last-ping과 동일 상한)
 * 응답: { summaryById: Record<number, {
 *   last_ping_at: string | null;       // 마지막 재컨택 발송(ping_sent)
 *   last_link_view_at: string | null;  // 마지막 맞춤링크 열람(link_view)
 *   last_interest: { job_id: number | null; at: string; immediate: boolean } | null; // 마지막 관심 클릭(interest_click)
 *   last_reply_at: string | null;      // 마지막 ping 답장(ping_reply)
 * }> } // 관련 이벤트가 1건이라도 있는 지원자만 포함.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const MAX_IDS = 500;
const EVENT_TYPES = ["ping_sent", "link_view", "interest_click", "ping_reply"];

interface SummaryEntry {
  last_ping_at: string | null;
  last_link_view_at: string | null;
  last_interest: { job_id: number | null; at: string; immediate: boolean } | null;
  last_reply_at: string | null;
}

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

  // 관련 event_type IN + applicant_id IN 1회 스캔 → JS 집계 (last-ping과 동일 패턴).
  // created_at desc 정렬이므로 각 (지원자, 유형)의 첫 등장이 마지막 이벤트.
  const { data: events, error } = await supabase
    .from("pool_events")
    .select("applicant_id, job_id, event_type, meta, created_at")
    .in("event_type", EVENT_TYPES)
    .in("applicant_id", numIds)
    .order("created_at", { ascending: false })
    // supabase 기본 1000행 절단 방지 — 500명×여러 이벤트에서 유형별 최신값이 잘리지 않게.
    .limit(5000);

  if (error) {
    console.error("[pool-events/summary]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const summaryById: Record<number, SummaryEntry> = {};
  for (const ev of events ?? []) {
    const id = ev.applicant_id as number;
    const entry = (summaryById[id] ??= {
      last_ping_at: null,
      last_link_view_at: null,
      last_interest: null,
      last_reply_at: null,
    });
    const at = ev.created_at as string;
    switch (ev.event_type as string) {
      case "ping_sent":
        if (!entry.last_ping_at) entry.last_ping_at = at;
        break;
      case "link_view":
        if (!entry.last_link_view_at) entry.last_link_view_at = at;
        break;
      case "ping_reply":
        if (!entry.last_reply_at) entry.last_reply_at = at;
        break;
      case "interest_click":
        if (!entry.last_interest) {
          // immediate 판정은 interest-queue와 동일 — meta.immediate가 true 또는 "true".
          const meta = ev.meta as { immediate?: unknown } | null;
          entry.last_interest = {
            job_id: typeof ev.job_id === "number" ? ev.job_id : null,
            at,
            immediate: meta?.immediate === true || meta?.immediate === "true",
          };
        }
        break;
    }
  }

  return NextResponse.json({ summaryById });
}
