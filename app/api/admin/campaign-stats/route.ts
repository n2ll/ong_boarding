/**
 * /api/admin/campaign-stats
 *
 * 재컨택 캠페인(벌크 ping) 반응 현황 집계 — 대시보드 '재컨택 캠페인' 카드 데이터 소스.
 * 인증은 middleware의 /api/admin/* Basic Auth에 위임.
 *
 * GET ?days=14 (기본 14)
 *   코호트 = 기간 내 ping_sent 이벤트가 있는 지원자 집합(인원 기준, 메시지 수 아님).
 *   반응(열람/관심/답장)은 해당 지원자의 '기간 내 첫 ping 이후' 발생분만 인정.
 *   반환: { window_days, sent, sent_messages, failed, viewed, interested,
 *          by_job: [{job_id, title, count, immediate_count}], replied, opted_out, last_sent_at }
 *
 * 쿼리: pool_events 기간 스캔 1회(ping/열람/관심 단일 패스) + messages 2회(캠페인 outbound·코호트 inbound)
 *      + applicants 1회(수신거부·즉시가능) + jobs 제목 1회. 코호트 ≤ 수백 규모 전제.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
// supabase-js 기본 1000행 제한이 집계를 조용히 자르지 않게 명시 상한 (파일럿 규모 대비 여유)
const SCAN_LIMIT = 5000;

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
    console.error("[campaign-stats GET] pool_events", evErr);
    return NextResponse.json({ error: evErr.message }, { status: 500 });
  }

  const pingAtByApplicant = new Map<number, number>(); // 지원자별 기간 내 첫 ping 시각(ms)
  let lastSentAt: string | null = null; // asc 정렬 — 마지막에 본 ping_sent가 최신
  const viewed = new Set<number>();
  const interested = new Set<number>();
  const clicksByJob = new Map<number, Map<number, boolean>>(); // job_id → (applicant_id → click meta immediate)

  for (const ev of events ?? []) {
    const aid = ev.applicant_id as number;
    if (ev.event_type === "ping_sent") {
      if (!pingAtByApplicant.has(aid)) pingAtByApplicant.set(aid, Date.parse(ev.created_at as string));
      lastSentAt = ev.created_at as string;
      continue;
    }
    // 코호트 밖(기간 내 ping 없음) 또는 ping 이전 반응은 캠페인 성과로 세지 않는다.
    const pingAt = pingAtByApplicant.get(aid);
    if (pingAt === undefined || Date.parse(ev.created_at as string) < pingAt) continue;
    if (ev.event_type === "link_view") {
      viewed.add(aid);
    } else if (ev.event_type === "interest_click") {
      interested.add(aid);
      const jobId = typeof ev.job_id === "number" ? ev.job_id : null;
      if (jobId !== null) {
        const meta = ev.meta as { immediate?: unknown } | null;
        const immediate = meta?.immediate === true || meta?.immediate === "true";
        const perJob = clicksByJob.get(jobId) ?? new Map<number, boolean>();
        perJob.set(aid, (perJob.get(aid) ?? false) || immediate);
        clicksByJob.set(jobId, perJob);
      }
    }
  }

  const cohortIds = [...pingAtByApplicant.keys()];
  const sent = cohortIds.length;

  // 발송 자체가 없으면 나머지 조회 생략 (카드도 이 값으로 숨김 판단)
  if (sent === 0) {
    return NextResponse.json({
      window_days: days,
      sent: 0,
      sent_messages: 0,
      failed: 0,
      viewed: 0,
      interested: 0,
      by_job: [],
      replied: 0,
      opted_out: 0,
      last_sent_at: null,
    });
  }

  const jobIds = [...clicksByJob.keys()];

  // 2~5) 캠페인 outbound(참고 수·실패), 코호트 inbound(답장), 코호트 지원자(수신거부·즉시가능), 공고 제목.
  const [outboundRes, inboundRes, applicantsRes, jobsRes] = await Promise.all([
    supabase
      .from("messages")
      .select("status")
      .eq("direction", "outbound")
      .eq("sent_by", "system-bulk")
      .gte("created_at", since)
      .limit(SCAN_LIMIT),
    supabase
      .from("messages")
      .select("applicant_id, created_at")
      .eq("direction", "inbound")
      .in("applicant_id", cohortIds)
      .gte("created_at", since)
      .limit(SCAN_LIMIT),
    supabase.from("applicants").select("id, availability, sms_opt_out_at").in("id", cohortIds),
    jobIds.length > 0
      ? supabase.from("jobs").select("id, title").in("id", jobIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const firstError = outboundRes.error ?? inboundRes.error ?? applicantsRes.error ?? jobsRes.error;
  if (firstError) {
    console.error("[campaign-stats GET]", firstError);
    return NextResponse.json({ error: firstError.message }, { status: 500 });
  }

  const outboundRows = (outboundRes.data ?? []) as { status: string | null }[];
  const sentMessages = outboundRows.length;
  const failed = outboundRows.filter((m) => m.status === "failed").length;

  // 답장 = 코호트 중 첫 ping 이후 inbound 메시지가 있는 인원.
  const replied = new Set<number>();
  for (const m of (inboundRes.data ?? []) as { applicant_id: number | null; created_at: string }[]) {
    if (typeof m.applicant_id !== "number") continue;
    const pingAt = pingAtByApplicant.get(m.applicant_id);
    if (pingAt !== undefined && Date.parse(m.created_at) >= pingAt) replied.add(m.applicant_id);
  }

  const applicantRows = (applicantsRes.data ?? []) as {
    id: number;
    availability: string | null;
    sms_opt_out_at: string | null;
  }[];
  const optedOut = applicantRows.filter((a) => a.sms_opt_out_at && a.sms_opt_out_at >= since).length;
  const immediateAvailability = new Set(
    applicantRows.filter((a) => a.availability === "즉시가능").map((a) => a.id)
  );

  // 공고별 관심 분해 — 인원 distinct, immediate는 클릭 meta 또는 가용성 '즉시가능' (interest-queue와 동일 기준).
  const titleByJobId = new Map<number, string | null>(
    ((jobsRes.data ?? []) as { id: number; title: string | null }[]).map((j) => [j.id, j.title])
  );
  const byJob = jobIds
    .map((jobId) => {
      const perJob = clicksByJob.get(jobId)!;
      let immediateCount = 0;
      for (const [aid, clickImmediate] of perJob) {
        if (clickImmediate || immediateAvailability.has(aid)) immediateCount++;
      }
      return {
        job_id: jobId,
        title: titleByJobId.get(jobId) || `공고 #${jobId}`,
        count: perJob.size,
        immediate_count: immediateCount,
      };
    })
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({
    window_days: days,
    sent,
    sent_messages: sentMessages,
    failed,
    viewed: viewed.size,
    interested: interested.size,
    by_job: byJob,
    replied: replied.size,
    opted_out: optedOut,
    last_sent_at: lastSentAt,
  });
}
