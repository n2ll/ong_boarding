import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { sendSms } from "@/lib/solapi";

export const dynamic = "force-dynamic";

interface Recipient {
  phone: string;
  applicant_id?: number | null;
}

interface BulkSendBody {
  recipients: Recipient[];
  body: string;
  subject?: string;
  // 발송 목적 태그(선택) — ping_sent meta에 기록해 발송 이력을 추적 (예: 'waitlist' 대기 안내).
  purpose?: string;
  // purpose와 연관된 공고 id(선택) — 예: '공고 관심자 선택'으로 고른 대기 안내 대상의 공고.
  job_id?: number;
}

export async function POST(req: NextRequest) {
  try {
    const data = (await req.json()) as BulkSendBody;
    const text = (data.body || "").trim();
    // LMS 제목 — 미지정 시 SOLAPI가 본문 첫 문장을 제목으로 자동 생성해 인사말이 중복 노출된다.
    const subject = (data.subject || "옹고잉 채용 안내").trim();
    const recipients = Array.isArray(data.recipients) ? data.recipients : [];
    // 발송 목적 태그 — ping_sent meta 기록용(예: waitlist). 임의 문자열 유입 대비 길이 제한.
    const purpose = typeof data.purpose === "string" ? data.purpose.trim().slice(0, 40) : "";
    const purposeJobId =
      typeof data.job_id === "number" && Number.isFinite(data.job_id) ? data.job_id : null;

    if (!text) {
      return NextResponse.json({ error: "메시지 내용이 비어있습니다." }, { status: 400 });
    }
    if (recipients.length === 0) {
      return NextResponse.json({ error: "수신자가 없습니다." }, { status: 400 });
    }
    if (recipients.length > 50) {
      return NextResponse.json(
        { error: "한 번에 최대 50명까지 발송 가능합니다." },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();
    const results: Array<{ phone: string; success: boolean; error?: string }> = [];

    // 수신자별 치환 — #{이름}, #{맞춤링크}(무로그인 pull 페이지 /p/[token]).
    // 기존엔 치환 없이 원문 그대로 발송돼 '#{이름}님' 문자가 나갔다.
    // 지원자 정보는 치환 여부와 무관하게 항상 로드 — 수신거부(sms_opt_out_at) 가드용.
    const needsFill = text.includes("#{이름}") || text.includes("#{맞춤링크}");
    const infoById = new Map<
      number,
      { name: string | null; access_token: string | null; sms_opt_out_at: string | null; status: string | null }
    >();
    {
      const ids = recipients
        .map((r) => r.applicant_id)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (ids.length > 0) {
        const { data: rows } = await supabase
          .from("applicants")
          .select("id, name, access_token, sms_opt_out_at, status")
          .in("id", ids);
        for (const row of rows ?? []) {
          infoById.set(row.id as number, {
            name: (row.name as string | null) ?? null,
            access_token: (row.access_token as string | null) ?? null,
            sms_opt_out_at: (row.sms_opt_out_at as string | null) ?? null,
            status: (row.status as string | null) ?? null,
          });
        }
      }
    }
    // 인력풀 제외자는 캠페인 발송 대상이 아니다 — 방어선(선택 UI가 걸러도 백엔드에서 재차 차단).
    const EXCLUDED_POOL_STATUS = new Set(["부적합", "이탈"]);

    // 중복 발송 가드 — 최근 10분 내 캠페인(system-bulk) 발송된 지원자는 재발송 스킵.
    // LMS 도달 지연에 매니저가 "안 왔다"고 재클릭해 같은 사람에게 두 번 나가는 것을 막는다.
    const DEDUP_WINDOW_MIN = 10;
    const recentlySent = new Set<number>();
    {
      const ids = recipients
        .map((r) => r.applicant_id)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (ids.length > 0) {
        const since = new Date(Date.now() - DEDUP_WINDOW_MIN * 60 * 1000).toISOString();
        const { data: recent } = await supabase
          .from("messages")
          .select("applicant_id")
          .in("applicant_id", ids)
          .eq("direction", "outbound")
          .eq("sent_by", "system-bulk")
          .gt("created_at", since);
        for (const m of recent ?? []) {
          if (typeof m.applicant_id === "number") recentlySent.add(m.applicant_id);
        }
      }
    }
    // 공고 안내 교차 가드(24시간) — 마감 안내(job_closed)와 새 공고 안내(new_job)가 같은 사람에게
    // 몇 분 간격으로 겹쳐 나가는 상황을 실무자의 조작 순서와 무관하게 서버에서 차단한다.
    // 두 안내 모두 맞춤링크(살아있는 페이지)를 담고 있어 한 통이면 최신 상태가 전부 전달된다.
    // (지원자 경험 원칙, 2026-07-14. 10분 가드는 동일 발송 재클릭용 — 이 가드는 목적 교차용.)
    const CROSS_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
    const CROSS_NOTICE_PURPOSES = new Set(["job_closed", "new_job"]);
    const recentNoticed = new Set<number>();
    if (CROSS_NOTICE_PURPOSES.has(purpose)) {
      const ids = recipients
        .map((r) => r.applicant_id)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (ids.length > 0) {
        const since = new Date(Date.now() - CROSS_NOTICE_WINDOW_MS).toISOString();
        const { data: recent } = await supabase
          .from("pool_events")
          .select("applicant_id, meta")
          .in("applicant_id", ids)
          .eq("event_type", "ping_sent")
          .gt("created_at", since);
        for (const ev of recent ?? []) {
          const p = (ev.meta as { purpose?: string } | null)?.purpose;
          if (p && CROSS_NOTICE_PURPOSES.has(p) && typeof ev.applicant_id === "number") {
            recentNoticed.add(ev.applicant_id);
          }
        }
      }
    }

    const baseUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      "https://ong-boarding-pi.vercel.app";
    const normalizedBase = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;

    for (const r of recipients) {
      const phone = (r.phone || "").replace(/\D/g, "");
      if (!/^\d{10,11}$/.test(phone)) {
        results.push({ phone, success: false, error: "잘못된 번호" });
        continue;
      }

      const info = typeof r.applicant_id === "number" ? infoById.get(r.applicant_id) : undefined;

      // 수신거부 하드 가드 — '그만' 답장 등으로 sms_opt_out_at이 기록된 지원자는 영구 제외.
      if (info?.sms_opt_out_at) {
        results.push({ phone, success: false, error: "수신거부(발송 제외)" });
        continue;
      }
      // 인력풀 제외(부적합/이탈) 하드 가드 — 풀에서 뺀 지원자에겐 캠페인이 나가지 않는다.
      if (info?.status && EXCLUDED_POOL_STATUS.has(info.status)) {
        results.push({ phone, success: false, error: `인력풀 제외(${info.status})` });
        continue;
      }
      // 중복 발송 가드 — 최근 10분 내 캠페인 발송된 지원자는 스킵.
      if (typeof r.applicant_id === "number" && recentlySent.has(r.applicant_id)) {
        results.push({ phone, success: false, error: "최근 발송됨(중복 방지)" });
        continue;
      }
      // 공고 안내 교차 가드 — 24시간 내 마감/새 공고 안내를 이미 받은 지원자는 스킵.
      if (typeof r.applicant_id === "number" && recentNoticed.has(r.applicant_id)) {
        results.push({ phone, success: false, error: "24시간 내 공고 안내 수신(중복 방지)" });
        continue;
      }

      let personalText = text;
      if (needsFill) {
        personalText = personalText.replace(/#\{이름\}/g, info?.name?.trim() || "고객");
        if (personalText.includes("#{맞춤링크}")) {
          if (!info?.access_token) {
            // 링크를 만들 수 없는 수신자에게 깨진 문구를 보내지 않는다.
            results.push({ phone, success: false, error: "맞춤링크 생성 불가(토큰 없음)" });
            continue;
          }
          personalText = personalText.replace(/#\{맞춤링크\}/g, `${normalizedBase}/p/${info.access_token}`);
        }
      }

      const sent = await sendSms(phone, personalText, subject);
      results.push({
        phone,
        success: sent.success,
        error: sent.error,
      });

      if (sent.success) {
        await supabase.from("messages").insert({
          applicant_id: r.applicant_id ?? null,
          applicant_phone: phone,
          direction: "outbound",
          body: personalText,
          status: "sent",
          sent_by: "system-bulk",
          solapi_msg_id: sent.messageId || null,
          message_type: "sms",
        });

        // ping 발송 이벤트 — 응답률(ping_reply/ping_sent)·응답속도의 분모. 지원자 연결 발송만.
        // purpose/job_id가 오면 meta에 함께 기록 — 대기 안내(waitlist) 등 발송 이력 추적.
        if (typeof r.applicant_id === "number") {
          const { error: evErr } = await supabase.from("pool_events").insert({
            applicant_id: r.applicant_id,
            event_type: "ping_sent",
            meta: {
              source: "bulk",
              has_link: personalText.includes("/p/"),
              ...(purpose ? { purpose } : {}),
              ...(purposeJobId !== null ? { job_id: purposeJobId } : {}),
            },
          });
          if (evErr) console.error("[bulk-send] pool_events ping_sent failed", evErr);

          // 공고 마감 안내(purpose='job_closed')는 waitlist_notice로도 기록 —
          // 공고 재개 시 '결원 우선 안내' 대상 역조회와 중복 안내 방지의 근거(engage의 충원 완료 안내와 동일 event_type).
          if (purpose === "job_closed" && purposeJobId !== null) {
            const { error: wlErr } = await supabase.from("pool_events").insert({
              applicant_id: r.applicant_id,
              job_id: purposeJobId,
              event_type: "waitlist_notice",
              meta: { trigger: "job_closed" },
            });
            if (wlErr) console.error("[bulk-send] pool_events waitlist_notice failed", wlErr);
          }
        }
      }

      await new Promise((r) => setTimeout(r, 150));
    }

    return NextResponse.json({
      success: true,
      sent: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    });
  } catch (err) {
    console.error("[bulk-send] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
