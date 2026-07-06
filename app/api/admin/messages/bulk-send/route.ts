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
}

export async function POST(req: NextRequest) {
  try {
    const data = (await req.json()) as BulkSendBody;
    const text = (data.body || "").trim();
    const recipients = Array.isArray(data.recipients) ? data.recipients : [];

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
      { name: string | null; access_token: string | null; sms_opt_out_at: string | null }
    >();
    {
      const ids = recipients
        .map((r) => r.applicant_id)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (ids.length > 0) {
        const { data: rows } = await supabase
          .from("applicants")
          .select("id, name, access_token, sms_opt_out_at")
          .in("id", ids);
        for (const row of rows ?? []) {
          infoById.set(row.id as number, {
            name: (row.name as string | null) ?? null,
            access_token: (row.access_token as string | null) ?? null,
            sms_opt_out_at: (row.sms_opt_out_at as string | null) ?? null,
          });
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

      const sent = await sendSms(phone, personalText);
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
        if (typeof r.applicant_id === "number") {
          const { error: evErr } = await supabase.from("pool_events").insert({
            applicant_id: r.applicant_id,
            event_type: "ping_sent",
            meta: { source: "bulk", has_link: personalText.includes("/p/") },
          });
          if (evErr) console.error("[bulk-send] pool_events ping_sent failed", evErr);
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
