/**
 * POST /api/messages/inbound — SMS Gateway(법인폰) 인입 프록시 (thin ingest).
 *
 * 배경 (2026-07-06): 게이트웨이 앱은 원래 messages 테이블에 anon 키로 직접 INSERT했는데,
 * 2026-06-23 rls-lockdown(PII 보호)이 anon 쓰기를 전면 차단하면서 인입이 전부 유실됐다
 * (앱 '미전송' 큐 적체). 이 라우트가 다시 유일한 공식 진입점이다.
 *
 * 과거 이 라우트는 매칭·triage·에이전트 호출까지 직접 수행했지만, 지금 그 로직은
 * Supabase Database Webhook(/api/webhooks/supabase-new-message)이 단일 담당한다
 * (매칭·AI 응대·가용성 추출·수신거부 처리 포함). 여기서 처리까지 하면 웹훅과 이중
 * 처리(중복 응대)가 되므로, 이 라우트는 **인증 + 멱등 + INSERT만** 한다.
 * INSERT가 곧 웹훅 트리거다.
 *
 * 인증: 헤더 `x-webhook-secret` = env INBOUND_WEBHOOK_SECRET (미설정 시 500 fail-closed)
 * 멱등: external_id(→ solapi_msg_id 컬럼에 보관) 우선, 없으면 (phone, body, received_at) 일치.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface InboundPayload {
  from: string;            // 발신 번호 ("010-1234-5678" 또는 "01012345678")
  text: string;            // SMS 본문
  received_at?: string;    // 가능하면 ISO8601, 없으면 서버 now()
  device_id?: string;      // 전용 폰 식별자
  external_id?: string;    // Gateway가 부여한 고유 ID (멱등성)
}

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

export async function POST(req: NextRequest) {
  // 1) 인증
  const expected = process.env.INBOUND_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[inbound] INBOUND_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }
  const provided = req.headers.get("x-webhook-secret");
  if (provided !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 2) 페이로드 검증
  let payload: InboundPayload;
  try {
    payload = (await req.json()) as InboundPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!payload.from || !payload.text) {
    return NextResponse.json({ error: "from, text 필수" }, { status: 400 });
  }

  const phone = normalizePhone(payload.from);
  const text = payload.text.trim();
  if (!phone || !text) {
    return NextResponse.json({ error: "from, text 필수" }, { status: 400 });
  }
  const receivedAt = payload.received_at || new Date().toISOString();
  const supabase = createServiceClient();

  // 3) 멱등 — 게이트웨이 재시도(큐 재전송)로 같은 문자가 두 번 오면 한 번만 저장
  if (payload.external_id) {
    const { data: dup } = await supabase
      .from("messages")
      .select("id")
      .eq("solapi_msg_id", payload.external_id)
      .eq("direction", "inbound")
      .maybeSingle();
    if (dup) {
      return NextResponse.json({ ok: true, message_id: dup.id, dedup: true });
    }
  } else {
    const { data: dup } = await supabase
      .from("messages")
      .select("id")
      .eq("applicant_phone", phone)
      .eq("direction", "inbound")
      .eq("body", text)
      .eq("created_at", receivedAt)
      .limit(1);
    if (dup && dup.length > 0) {
      return NextResponse.json({ ok: true, message_id: dup[0].id, dedup: true });
    }
  }

  // 4) INSERT — applicant 매칭·분류는 하지 않는다(웹훅 담당).
  //    classification·webhook_processed_at을 비워둬야 웹훅이 이 행을 처리한다.
  const { data: inserted, error: insertErr } = await supabase
    .from("messages")
    .insert({
      applicant_phone: phone,
      direction: "inbound",
      body: text,
      status: "received",
      sent_by: payload.device_id ?? "sms-gateway",
      solapi_msg_id: payload.external_id ?? null,
      message_type: "sms",
      created_at: receivedAt,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    console.error("[inbound] messages insert", insertErr);
    return NextResponse.json({ error: "메시지 저장 실패" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, message_id: inserted.id });
}
