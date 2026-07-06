/**
 * POST /api/pool/[token]/interest — pull 페이지 '관심 있음' 클릭.
 *
 * 하는 일 (확정 뉘앙스 금지 — 관심 표시는 '가능 의사 수집'일 뿐, 배정·확정은 매니저):
 *   1. job_candidates upsert — 매니저 파이프라인/공고 보드에 후보로 노출 (발송은 dispatch에서)
 *   2. availability 갱신 — '즉시가능'이 아니면 '이번주가능'으로 (강한 신호를 약한 신호로 강등하지 않음)
 *   3. pool_events(interest_click / availability_set) 기록 — 신선도·신뢰 점수 근거
 *   4. Slack 알림 — 매니저가 컨택 여부를 결정
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { sendSlackText } from "@/lib/slack";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const token = params.token;
  if (!UUID_RE.test(token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const jobId = Number(body?.job_id);
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "job_id 필수" }, { status: 400 });
  }
  // '바로(내일부터) 시작 가능' 후속 버튼 — 관심 표시보다 강한 가용성 신호.
  // 여전히 '가능 의사 수집'일 뿐 확정 아님 (확정 뉘앙스 금지).
  const immediate = body?.immediate === true;

  const supabase = createServiceClient();

  const { data: applicant } = await supabase
    .from("applicants")
    .select("id, name, availability")
    .eq("access_token", token)
    .maybeSingle();
  if (!applicant) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: job } = await supabase
    .from("jobs")
    .select("id, title, status, closes_at")
    .eq("id", jobId)
    .maybeSingle();
  const closed =
    !job ||
    job.status !== "active" ||
    String(job.title).startsWith("__") ||
    (job.closes_at && new Date(job.closes_at as string).getTime() <= Date.now());
  if (closed) {
    return NextResponse.json({ error: "모집이 마감된 공고예요" }, { status: 400 });
  }

  // 1) 후보 연결 (이미 있으면 무시 — 중복 클릭 안전)
  const { error: jcErr } = await supabase
    .from("job_candidates")
    .upsert([{ job_id: jobId, applicant_id: applicant.id }], {
      onConflict: "job_id,applicant_id",
      ignoreDuplicates: true,
    });
  if (jcErr) {
    console.error("[pool interest] jc upsert failed", jcErr);
    return NextResponse.json({ error: "처리 실패" }, { status: 500 });
  }

  // 2) 가용성 갱신 — 관심 클릭은 '이번 주 일할 의사', '바로 가능' 버튼은 '즉시 투입 가능' 프록시
  const prevAvailability = applicant.availability as string | null;
  const nextAvailability = immediate
    ? "즉시가능"
    : prevAvailability === "즉시가능"
      ? "즉시가능"
      : "이번주가능";
  const { error: avErr } = await supabase
    .from("applicants")
    .update({ availability: nextAvailability, availability_updated_at: new Date().toISOString() })
    .eq("id", applicant.id);
  if (avErr) console.error("[pool interest] availability update failed", avErr);

  // 3) 이벤트 기록 (non-fatal)
  const events: { applicant_id: number; job_id?: number; event_type: string; meta?: unknown }[] = [
    {
      applicant_id: applicant.id as number,
      job_id: jobId,
      event_type: "interest_click",
      meta: immediate ? { immediate: true } : undefined,
    },
  ];
  if (prevAvailability !== nextAvailability) {
    events.push({
      applicant_id: applicant.id as number,
      event_type: "availability_set",
      meta: { from: prevAvailability, to: nextAvailability, source: "pull", immediate },
    });
  }
  const { error: evErr } = await supabase.from("pool_events").insert(events);
  if (evErr) console.error("[pool interest] pool_events insert failed", evErr);

  // 4) 매니저 알림 (non-fatal)
  await sendSlackText(
    immediate
      ? `⚡ *바로 시작 가능* — ${applicant.name ?? "이름 미상"}님이 '${job.title}' 공고에 "바로 시작 가능"이라고 답했어요.\n우선 컨택 후보입니다 — 파이프라인에서 확인해주세요.`
      : `💡 *맞춤 공고 관심 표시* — ${applicant.name ?? "이름 미상"}님이 '${job.title}' 공고에 관심을 표시했어요.\n파이프라인/공고 보드에서 확인 후 컨택해주세요.`
  ).catch(() => false);

  return NextResponse.json({ success: true });
}
