/**
 * POST /api/admin/jobs/[id]/dispatch
 *
 * 공고 본문을 후보자들에게 일괄 SMS 발송한다.
 *
 * 흐름:
 *   1) job_candidates 중 sent_at IS NULL 인 row만 대상 (또는 body로 applicant_ids 명시)
 *   2) 각 후보의 applicant_id로 phone 조회 → SOLAPI sendSms
 *   3) sent_at = now(), agent_stage = 'screening' (응답 시 즉시 agent 발동 가능하게)
 *   4) applicants.current_job_id 갱신 (충돌 시 정책: 기존 진행중이면 매니저 경고)
 *   5) messages 테이블에 outbound 기록 (job_id 포함)
 *
 * 마케팅 수신 미동의자는 자동 제외.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { sendSms } from "@/lib/solapi";

interface Applicant {
  id: number;
  phone: string;
  marketing_consent: boolean | null;
  current_job_id: number | null;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const jobId = Number(params.id);
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let payload: { applicant_ids?: number[]; resend?: boolean } = {};
  try {
    payload = await req.json();
  } catch {
    /* allow empty body — 모든 미발송 후보 발송 */
  }

  const supabase = createServiceClient();

  // 공고 로드
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id, body, status")
    .eq("id", jobId)
    .single();
  if (jobErr || !job) {
    return NextResponse.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  }
  if (job.status !== "active") {
    return NextResponse.json({ error: "활성 공고만 발송 가능합니다." }, { status: 400 });
  }

  // 후보 후보군 조회
  let jcQuery = supabase
    .from("job_candidates")
    .select("id, applicant_id, sent_at")
    .eq("job_id", jobId);
  if (Array.isArray(payload.applicant_ids) && payload.applicant_ids.length > 0) {
    jcQuery = jcQuery.in("applicant_id", payload.applicant_ids);
  }
  if (!payload.resend) {
    jcQuery = jcQuery.is("sent_at", null);
  }
  const { data: candidates, error: cErr } = await jcQuery;
  if (cErr) {
    console.error("[dispatch] candidates query", cErr);
    return NextResponse.json({ error: "후보 조회 실패" }, { status: 500 });
  }
  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ sent: 0, skipped: 0, conflicts: [] });
  }

  // 지원자 정보 일괄 로드
  const aids = candidates.map((c) => c.applicant_id);
  const { data: applicants } = await supabase
    .from("applicants")
    .select("id, phone, marketing_consent, current_job_id")
    .in("id", aids);
  const aMap = new Map<number, Applicant>(
    (applicants ?? []).map((a) => [a.id as number, a as Applicant])
  );

  // 발송 루프
  let sent = 0;
  let skipped = 0;
  const conflicts: number[] = [];        // 다른 active job에 묶여있어 보류한 applicant
  const sentApplicantIds: number[] = [];
  const now = new Date().toISOString();

  for (const c of candidates) {
    const a = aMap.get(c.applicant_id as number);
    if (!a || !a.phone) {
      skipped++;
      continue;
    }
    // 마케팅 수신 미동의 → 발송 제외 (광고성 일괄)
    if (a.marketing_consent === false) {
      skipped++;
      continue;
    }
    // 다른 공고 진행 중이면 보류 (정책: 한 사람 = 하나의 active job)
    if (a.current_job_id && a.current_job_id !== jobId) {
      conflicts.push(a.id);
      skipped++;
      continue;
    }

    const result = await sendSms(a.phone, job.body);
    if (!result.success) {
      console.error("[dispatch] SMS fail", a.id, result.error);
      skipped++;
      continue;
    }

    // job_candidates 갱신 — sent_at + agent_stage='exploration' (탐색 단계로 진입, 지원의사 확인 후 screening)
    await supabase
      .from("job_candidates")
      .update({
        sent_at: now,
        agent_stage: "exploration",
      })
      .eq("id", c.id);

    // applicants.current_job_id 갱신
    await supabase
      .from("applicants")
      .update({ current_job_id: jobId })
      .eq("id", a.id);

    // outbound 메시지 기록
    await supabase.from("messages").insert({
      applicant_id: a.id,
      applicant_phone: a.phone,
      direction: "outbound",
      body: job.body,
      status: "sent",
      sent_by: "dispatch",
      solapi_msg_id: result.messageId ?? null,
      message_type: "sms",
      job_id: jobId,
    });

    sent++;
    sentApplicantIds.push(a.id);
  }

  return NextResponse.json({
    sent,
    skipped,
    conflicts,                             // 매니저가 처리해야 할 충돌 목록
    sent_applicant_ids: sentApplicantIds,
  });
}
