/**
 * POST /api/admin/confirm/send
 *
 * '확정 대기' 큐 / 확정 창에서 매니저가 트리거하는 발송.
 *  - kind='venue'     : 만남장소 안내 (buildVenueGuideText). 시작일·집합시각은 매니저 입력값 우선.
 *  - kind='first_day' : 첫날 근무 규칙 (buildFirstDayRules — 라인 형태별 분기).
 *  - kind='app_guide' : 확정 시 옹고잉 앱 설치·가이드 안내 (system_message 'ongoing_app_guide' 우선).
 *
 * 라인 형태(확장성): 공고 recruit_mode로 판별(isGeneralLineJob). internal 정기배송 라인은 배민 배차
 * 모델 문구를 쓰지 않고 정기배송용 기본 문안으로 분기한다. 특정 라인 하드코딩 없음.
 * 편집(Q1=편집 가능 템플릿): 기본 문안은 system_message(두뇌 탭)로 덮어쓸 수 있고, 클라이언트가
 * 발송 직전 미리보기에서 수정한 본문(text)을 보내면 그 본문 그대로 발송한다.
 *
 * 본문은 서버에서 빌드(현장매니저·픽업주소 조회 포함)하되, text override가 오면 그대로 발송.
 * 시스템 라벨(system-venue-guide/system-first-day/system-app-guide)로 기록해 매니저 수동 auto-pause와 구분.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { sendSms } from "@/lib/solapi";
import { buildVenueGuideText, buildFirstDayRules, buildOngoingAppGuide } from "@/lib/agent/transitions";
import { getSystemMessage, fillTemplate } from "@/lib/agent/system-messages";
import { isGeneralLineJob } from "@/lib/agent/general-line";

export const dynamic = "force-dynamic";

const KINDS = new Set(["venue", "first_day", "app_guide"]);
const SENT_BY: Record<string, string> = {
  venue: "system-venue-guide",
  first_day: "system-first-day",
  app_guide: "system-app-guide",
};

// SMS 비용 대략치(SOLAPI 기준): 90바이트 이하 SMS(단문) ~20원, 초과 LMS(장문) ~33원. 한글=2바이트.
function estimateSms(text: string): { bytes: number; sms_type: "SMS" | "LMS"; cost_krw: number } {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) bytes += text.charCodeAt(i) > 0x7f ? 2 : 1;
  const sms_type = bytes <= 90 ? "SMS" : "LMS";
  return { bytes, sms_type, cost_krw: sms_type === "SMS" ? 20 : 33 };
}

export async function POST(req: NextRequest) {
  try {
    const { applicant_id, kind, job_id, start_date, meeting_time, text: textOverride, preview } = await req.json();
    if (!applicant_id || !KINDS.has(kind)) {
      return NextResponse.json(
        { error: "applicant_id와 kind(venue|first_day|app_guide)는 필수입니다." },
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

    // 공고(라인 형태 판별용) — job_id가 오면 로드. venue는 필수, 나머지는 라인 분기에만 사용.
    type JobInfo = { id: number; title: string; recruit_mode: string | null; start_date: string | null; pickup_address: string | null; site_manager_id: number | null };
    let job: JobInfo | null = null;
    if (job_id) {
      const { data: j } = await supabase
        .from("jobs")
        .select("id, title, recruit_mode, start_date, pickup_address, site_manager_id")
        .eq("id", job_id)
        .maybeSingle();
      job = (j as JobInfo | null) ?? null;
    }
    const general = isGeneralLineJob(job ? { title: job.title, recruit_mode: job.recruit_mode } : null);

    let text: string;

    // 편집된 본문(text override)이 오면 그대로 발송 — 발송 직전 미리보기에서 매니저가 수정한 경우.
    const overriding = typeof textOverride === "string" && textOverride.trim().length > 0;

    if (kind === "first_day") {
      if (overriding) {
        text = textOverride.trim();
      } else {
        const key = general ? "first_day_rules_general" : "first_day_rules";
        const tmpl = (await getSystemMessage(supabase, key))?.trim();
        text = tmpl ? fillTemplate(tmpl, { 이름: name ?? "지원자" }) : buildFirstDayRules(name, { general });
      }
    } else if (kind === "app_guide") {
      if (overriding) {
        text = textOverride.trim();
      } else {
        const tmpl = (await getSystemMessage(supabase, "ongoing_app_guide"))?.trim();
        text = tmpl ? fillTemplate(tmpl, { 이름: name ?? "선생님" }) : buildOngoingAppGuide(name);
      }
      // 자리표시 문구 하드 차단 — 운영 문구 미설정 상태로 지원자에게 발송되는 사고 방지(체크박스·버튼 공통).
      if (!overriding && text.includes("여기에 넣어주세요")) {
        return NextResponse.json(
          { error: "옹고잉 앱 안내 문구가 아직 설정되지 않았어요. 에이전트 두뇌 탭 'ongoing_app_guide'에 실제 안내를 입력한 뒤 발송하세요." },
          { status: 400 }
        );
      }
    } else {
      // venue — 구조화 정보(시작일·픽업·현장매니저)가 필요. text override면 그대로, 아니면 서버 빌드.
      if (!job_id || !job) {
        return NextResponse.json({ error: "만남장소 발송에는 공고(job_id)가 필요합니다." }, { status: 400 });
      }
      if (overriding) {
        text = textOverride.trim();
      } else {
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
        // 현장매니저는 비마트 라인에서만 필수. internal 정기배송 라인은 담당자 줄을 생략하고 발송 가능
        // (도시락 등은 현장매니저를 별도로 두지 않는 경우가 많다 — 발송이 막히지 않게).
        if (!smName && !general) {
          return NextResponse.json({ error: "공고에 현장매니저가 지정되지 않았습니다." }, { status: 400 });
        }

        text = buildVenueGuideText({
          name,
          start_date: startDate,
          pickup_address: pickup,
          site_manager_name: smName || null,
          site_manager_phone: smPhone || null,
          meeting_time: (meeting_time as string) || null,
        });
      }
    }

    const sentBy = SENT_BY[kind];

    // 미리보기 — 실제 발송 없이 내용·예상 비용만 반환(실무자 확인·수정용 허들).
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
