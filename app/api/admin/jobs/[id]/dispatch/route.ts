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
  name: string | null;
  phone: string;
  marketing_consent: boolean | null;
  current_job_id: number | null;
  sms_opt_out_at: string | null;
  access_token: string | null;
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
    .select("id, name, phone, marketing_consent, current_job_id, sms_opt_out_at, access_token")
    .in("id", aids);
  const aMap = new Map<number, Applicant>(
    (applicants ?? []).map((a) => [a.id as number, a as Applicant])
  );

  // 발송 루프
  let sent = 0;
  let skipped = 0;
  const conflicts: number[] = [];        // 다른 active job에 묶여있어 보류한 applicant
  const sentApplicantIds: number[] = [];
  // 제외 사유별 집계 — 매니저가 "왜 빠졌는지" 바로 알 수 있게
  const skipReasons = { no_phone: 0, no_consent: 0, opt_out: 0, conflict: 0, no_token: 0, send_fail: 0 };
  const now = new Date().toISOString();

  // 수신자별 치환 — #{이름}, #{맞춤링크} (bulk-send와 동일 규칙)
  const needsFill = job.body.includes("#{이름}") || job.body.includes("#{맞춤링크}");
  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    "https://ong-boarding-pi.vercel.app";
  const normalizedBase = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;

  for (const c of candidates) {
    const a = aMap.get(c.applicant_id as number);
    if (!a || !a.phone) {
      skipped++;
      skipReasons.no_phone++;
      continue;
    }
    // 마케팅 수신 미동의 → 발송 제외 (광고성 일괄)
    if (a.marketing_consent === false) {
      skipped++;
      skipReasons.no_consent++;
      continue;
    }
    // 수신거부 하드 가드 — '그만' 답장 등으로 기록된 지원자는 영구 제외
    if (a.sms_opt_out_at) {
      skipped++;
      skipReasons.opt_out++;
      continue;
    }
    // 다른 공고 진행 중이면 보류 (정책: 한 사람 = 하나의 '진행 중' 공고)
    if (a.current_job_id && a.current_job_id !== jobId) {
      conflicts.push(a.id);
      skipped++;
      skipReasons.conflict++;
      continue;
    }

    let personalText = job.body;
    if (needsFill) {
      personalText = personalText.replace(/#\{이름\}/g, a.name?.trim() || "고객");
      if (personalText.includes("#{맞춤링크}")) {
        if (!a.access_token) {
          // 링크를 만들 수 없는 수신자에게 깨진 문구를 보내지 않는다.
          skipped++;
          skipReasons.no_token++;
          continue;
        }
        personalText = personalText.replace(/#\{맞춤링크\}/g, `${normalizedBase}/p/${a.access_token}`);
      }
    }

    const result = await sendSms(a.phone, personalText);
    if (!result.success) {
      console.error("[dispatch] SMS fail", a.id, result.error);
      skipped++;
      skipReasons.send_fail++;
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
      body: personalText,
      status: "sent",
      sent_by: "dispatch",
      solapi_msg_id: result.messageId ?? null,
      message_type: "sms",
      job_id: jobId,
    });

    // ping 발송 이벤트 — 응답률·응답속도(신뢰점수) 분모 (bulk-send와 동일 규칙)
    const { error: evErr } = await supabase.from("pool_events").insert({
      applicant_id: a.id,
      job_id: jobId,
      event_type: "ping_sent",
      meta: { source: "dispatch" },
    });
    if (evErr) console.error("[dispatch] pool_events ping_sent failed", evErr);

    sent++;
    sentApplicantIds.push(a.id);
  }

  return NextResponse.json({
    sent,
    skipped,
    skip_reasons: skipReasons,             // 제외 사유별 집계
    conflicts,                             // 매니저가 처리해야 할 충돌 목록
    sent_applicant_ids: sentApplicantIds,
  });
}
