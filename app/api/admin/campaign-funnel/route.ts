/**
 * /api/admin/campaign-funnel
 *
 * 재컨택 캠페인 퍼널 '명단' — 파이프라인 탭 캠페인 퍼널 보드의 데이터 소스.
 * campaign-stats가 숫자 요약이라면, 여기는 코호트 멤버 개개인의 최고 단계를 내려
 * 각 단계에서 바로 개별 액션(상세 열기)으로 이을 수 있게 한다.
 * 인증은 middleware의 /api/admin/* Basic Auth에 위임.
 *
 * GET ?days=14 (기본 14, 상한 90)
 *   코호트 = 기간 내 ping_sent 이벤트가 있는 지원자 (campaign-stats와 동일 게이트:
 *   반응(열람/관심/답장)은 해당 지원자의 '기간 내 첫 ping 이후' 발생분만 인정).
 *   각 멤버의 최고 단계: replied(첫 ping 이후 inbound) > interested(interest_click)
 *   > viewed(link_view) > sent. last_event_at은 그 단계 이벤트의 최신 시각.
 *   수신거부(sms_opt_out_at이 기간 내)는 별도 플래그(opted_out).
 *
 * 반환: { window_days, members: [{ applicant_id, name, sigungu, availability,
 *        stage, opted_out, last_event_at, interest_job_id, interest_job_title,
 *        immediate, unread_count }] } — last_event_at 최신순.
 *
 * 쿼리: pool_events 기간 스캔 1회 + messages(코호트 inbound) 1회
 *      + applicants 1회 + jobs 제목 1회 (campaign-stats 패턴, N+1 없음).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
// supabase-js 기본 1000행 제한이 집계를 조용히 자르지 않게 명시 상한 (파일럿 규모 대비 여유)
const SCAN_LIMIT = 5000;

type FunnelStage = "sent" | "viewed" | "interested" | "replied";

interface FunnelMember {
  applicant_id: number;
  name: string | null;
  sigungu: string | null;
  availability: string | null;
  stage: FunnelStage;
  opted_out: boolean;
  last_event_at: string | null;
  interest_job_id: number | null;
  interest_job_title: string | null;
  immediate: boolean;
  unread_count: number;
}

export async function GET(req: NextRequest) {
  const daysParam = Number(req.nextUrl.searchParams.get("days"));
  const days =
    Number.isFinite(daysParam) && daysParam > 0 ? Math.min(Math.floor(daysParam), MAX_DAYS) : DEFAULT_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const supabase = createServiceClient();

  // 1) pool_events 기간 스캔 1회 — created_at asc라 '첫 ping 이후 반응' 게이트를 단일 패스로 판정.
  const { data: events, error: evErr } = await supabase
    .from("pool_events")
    .select("applicant_id, job_id, event_type, created_at, meta")
    .in("event_type", ["ping_sent", "link_view", "interest_click"])
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(SCAN_LIMIT);
  if (evErr) {
    console.error("[campaign-funnel GET] pool_events", evErr);
    return NextResponse.json({ error: evErr.message }, { status: 500 });
  }

  const firstPingAt = new Map<number, number>(); // 지원자별 기간 내 첫 ping 시각(ms) — 반응 인정 게이트
  const lastPingAt = new Map<number, string>(); // 지원자별 마지막 ping 시각 — sent 단계의 last_event_at
  const lastViewAt = new Map<number, string>(); // 첫 ping 이후 마지막 열람
  const lastInterest = new Map<number, { at: string; job_id: number | null; immediate: boolean }>();

  for (const ev of events ?? []) {
    const aid = ev.applicant_id as number;
    const at = ev.created_at as string;
    if (ev.event_type === "ping_sent") {
      if (!firstPingAt.has(aid)) firstPingAt.set(aid, Date.parse(at));
      lastPingAt.set(aid, at); // asc 정렬 — 마지막에 본 값이 최신
      continue;
    }
    // 코호트 밖(기간 내 ping 없음) 또는 ping 이전 반응은 캠페인 성과로 세지 않는다.
    const pingAt = firstPingAt.get(aid);
    if (pingAt === undefined || Date.parse(at) < pingAt) continue;
    if (ev.event_type === "link_view") {
      lastViewAt.set(aid, at);
    } else if (ev.event_type === "interest_click") {
      const meta = ev.meta as { immediate?: unknown } | null;
      lastInterest.set(aid, {
        at,
        job_id: typeof ev.job_id === "number" ? ev.job_id : null,
        // immediate 판정은 interest-queue/campaign-stats와 동일 — meta.immediate가 true 또는 "true"
        immediate: meta?.immediate === true || meta?.immediate === "true",
      });
    }
  }

  const cohortIds = [...firstPingAt.keys()];
  if (cohortIds.length === 0) {
    return NextResponse.json({ window_days: days, members: [] });
  }

  const interestJobIds = [...new Set([...lastInterest.values()].map((v) => v.job_id).filter((v): v is number => v !== null))];

  // 2~4) 코호트 inbound(답장), 코호트 지원자(이름·지역·가용성·수신거부·미읽음), 공고 제목 — 배치 병렬 조회.
  const [inboundRes, applicantsRes, jobsRes] = await Promise.all([
    supabase
      .from("messages")
      .select("applicant_id, created_at")
      .eq("direction", "inbound")
      .in("applicant_id", cohortIds)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(SCAN_LIMIT),
    supabase
      .from("applicants")
      .select("id, name, sigungu, availability, sms_opt_out_at, unread_count")
      .in("id", cohortIds),
    interestJobIds.length > 0
      ? supabase.from("jobs").select("id, title").in("id", interestJobIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const firstError = inboundRes.error ?? applicantsRes.error ?? jobsRes.error;
  if (firstError) {
    console.error("[campaign-funnel GET]", firstError);
    return NextResponse.json({ error: firstError.message }, { status: 500 });
  }

  // 답장 = 코호트 중 첫 ping 이후 inbound 메시지 — asc 스캔이라 마지막에 본 값이 최신 답장 시각.
  const lastReplyAt = new Map<number, string>();
  for (const m of (inboundRes.data ?? []) as { applicant_id: number | null; created_at: string }[]) {
    if (typeof m.applicant_id !== "number") continue;
    const pingAt = firstPingAt.get(m.applicant_id);
    if (pingAt !== undefined && Date.parse(m.created_at) >= pingAt) lastReplyAt.set(m.applicant_id, m.created_at);
  }

  const titleByJobId = new Map<number, string | null>(
    ((jobsRes.data ?? []) as { id: number; title: string | null }[]).map((j) => [j.id, j.title])
  );

  const applicantRows = (applicantsRes.data ?? []) as {
    id: number;
    name: string | null;
    sigungu: string | null;
    availability: string | null;
    sms_opt_out_at: string | null;
    unread_count: number | null;
  }[];
  const applicantById = new Map(applicantRows.map((a) => [a.id, a]));

  const members: FunnelMember[] = cohortIds.map((aid) => {
    const a = applicantById.get(aid);
    const reply = lastReplyAt.get(aid);
    const interest = lastInterest.get(aid) ?? null;
    const view = lastViewAt.get(aid);
    // 최고 단계 판정: replied > interested > viewed > sent. last_event_at은 그 단계 이벤트의 최신.
    let stage: FunnelStage = "sent";
    let lastEventAt: string | null = lastPingAt.get(aid) ?? null;
    if (reply) {
      stage = "replied";
      lastEventAt = reply;
    } else if (interest) {
      stage = "interested";
      lastEventAt = interest.at;
    } else if (view) {
      stage = "viewed";
      lastEventAt = view;
    }
    const interestJobId = interest?.job_id ?? null;
    return {
      applicant_id: aid,
      name: a?.name ?? null,
      sigungu: a?.sigungu ?? null,
      availability: a?.availability ?? null,
      stage,
      opted_out: !!(a?.sms_opt_out_at && a.sms_opt_out_at >= since),
      last_event_at: lastEventAt,
      interest_job_id: interestJobId,
      interest_job_title:
        interestJobId !== null ? titleByJobId.get(interestJobId) || `공고 #${interestJobId}` : null,
      // immediate 기준은 campaign-stats by_job과 동일 — 관심 클릭 meta 또는 가용성 '즉시가능'
      immediate: interest !== null && (interest.immediate || a?.availability === "즉시가능"),
      unread_count: a?.unread_count ?? 0,
    };
  });

  // 최신 반응이 위로 — 각 컬럼에서 '방금 움직인 사람'부터 처리하는 동선.
  members.sort((a, b) => {
    const av = a.last_event_at ? Date.parse(a.last_event_at) : 0;
    const bv = b.last_event_at ? Date.parse(b.last_event_at) : 0;
    return bv - av;
  });

  return NextResponse.json({ window_days: days, members });
}
