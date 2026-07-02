/**
 * POST /api/admin/confirm/send
 *
 * '확정 대기' 큐에서 매니저가 수동 트리거하는 발송.
 *  - kind='venue'     : 만남장소 안내 (buildVenueGuideText). 시작일은 매니저 입력값 우선(확정 뉘앙스 금지 —
 *                       에이전트가 시작일을 미리 정하지 않으므로 매니저가 확정 시점에 정한다).
 *  - kind='first_day' : 첫날 근무 규칙 (buildFirstDayRules).
 *
 * 본문은 서버에서 빌드하고(현장매니저·픽업주소 조회 포함), SOLAPI 발송 후 messages에 기록한다.
 * 시스템 라벨(system-venue-guide/system-first-day)로 기록해 매니저 수동 응대 auto-pause와 구분한다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { sendSms } from "@/lib/solapi";
import { buildVenueGuideText, buildFirstDayRules } from "@/lib/agent/transitions";

export const dynamic = "force-dynamic";

// SMS 비용 대략치(SOLAPI 기준): 90바이트 이하 SMS(단문) ~20원, 초과 LMS(장문) ~33원.
// 한글 등 비ASCII는 2바이트로 계산.
function estimateSms(text: string): { bytes: number; sms_type: "SMS" | "LMS"; cost_krw: number } {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) bytes += text.charCodeAt(i) > 0x7f ? 2 : 1;
  const sms_type = bytes <= 90 ? "SMS" : "LMS";
  return { bytes, sms_type, cost_krw: sms_type === "SMS" ? 20 : 33 };
}

export async function POST(req: NextRequest) {
  try {
    const { applicant_id, kind, job_id, start_date, preview } = await req.json();
    if (!applicant_id || (kind !== "venue" && kind !== "first_day")) {
      return NextResponse.json(
        { error: "applicant_id와 kind(venue|first_day)는 필수입니다." },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    const { data: applicant } = await supabase
      .from("applicants")
      .select("id, name, phone")
      .eq("id", applicant_id)
      .maybeSingle();
    if (!applicant) return NextResponse.json({ error: "지원자를 찾을 수 없습니다." }, { status: 404 });
    const name = (applicant.name as string) ?? null;
    const phone = (applicant.phone as string) ?? "";
    if (!phone) return NextResponse.json({ error: "지원자 전화번호가 없습니다." }, { status: 400 });

    let text: string;
    let sentBy: string;

    if (kind === "first_day") {
      text = buildFirstDayRules(name);
      sentBy = "system-first-day";
    } else {
      if (!job_id) {
        return NextResponse.json({ error: "만남장소 발송에는 공고(job_id)가 필요합니다." }, { status: 400 });
      }
      const { data: job } = await supabase
        .from("jobs")
        .select("id, start_date, pickup_address, site_manager_id")
        .eq("id", job_id)
        .maybeSingle();
      if (!job) return NextResponse.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });

      const startDate = (start_date as string) || (job.start_date as string) || "";
      if (!startDate) return NextResponse.json({ error: "시작일이 필요합니다." }, { status: 400 });
      const pickup = (job.pickup_address as string) || "";
      if (!pickup) return NextResponse.json({ error: "공고에 픽업 주소가 없습니다." }, { status: 400 });

      let smName = "";
      let smPhone = "";
      if (job.site_manager_id != null) {
        const { data: sm } = await supabase
          .from("site_managers")
          .select("name, phone")
          .eq("id", job.site_manager_id)
          .maybeSingle();
        smName = (sm?.name as string) || "";
        smPhone = (sm?.phone as string) || "";
      }
      if (!smName) {
        return NextResponse.json({ error: "공고에 현장매니저가 지정되지 않았습니다." }, { status: 400 });
      }

      text = buildVenueGuideText({
        name,
        start_date: startDate,
        pickup_address: pickup,
        site_manager_name: smName,
        site_manager_phone: smPhone,
      });
      sentBy = "system-venue-guide";
    }

    // 미리보기 — 실제 발송 없이 내용·예상 비용만 반환(실무자 확인용 허들).
    if (preview) {
      return NextResponse.json({ preview: true, text, ...estimateSms(text) });
    }

    const result = await sendSms(phone, text);
    if (!result.success) {
      return NextResponse.json({ error: "문자 발송 실패: " + (result.error ?? "unknown") }, { status: 500 });
    }

    await supabase.from("messages").insert({
      applicant_id,
      applicant_phone: phone,
      direction: "outbound",
      body: text,
      status: "sent",
      sent_by: sentBy,
      solapi_msg_id: result.messageId ?? null,
      message_type: "sms",
      job_id: job_id ?? null,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[confirm/send]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
