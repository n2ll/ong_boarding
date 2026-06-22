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

    for (const r of recipients) {
      const phone = (r.phone || "").replace(/\D/g, "");
      if (!/^\d{10,11}$/.test(phone)) {
        results.push({ phone, success: false, error: "잘못된 번호" });
        continue;
      }

      const sent = await sendSms(phone, text);
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
          body: text,
          status: "sent",
          sent_by: "system-bulk",
          solapi_msg_id: sent.messageId || null,
          message_type: "sms",
        });
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
