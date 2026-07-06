/**
 * POST /api/messages/heartbeat — SMS Gateway(법인폰) 하트비트 수신.
 *
 * 게이트웨이 앱이 5분 주기로 기기 상태를 보고한다. 기존엔 device_heartbeat 테이블에
 * anon 키로 직접 upsert했으나 2026-06-23 rls-lockdown으로 차단 → 인입 프록시
 * (/api/messages/inbound)와 동일 인증의 서버 upsert로 전환 (2026-07-06).
 *
 * pending_count가 계속 0보다 크면 게이트웨이 전송 적체를 뜻한다 —
 * "인입이 조용한 게 평화인지 장애인지"를 구분하는 조기 감지 신호.
 * 조회는 기존 GET /api/admin/heartbeat.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface HeartbeatPayload {
  device_id: string;
  last_seen_at?: string;
  pending_count?: number;
  battery_level?: number;
  app_version?: string;
}

export async function POST(req: NextRequest) {
  const expected = process.env.INBOUND_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[heartbeat] INBOUND_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }
  if (req.headers.get("x-webhook-secret") !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: HeartbeatPayload;
  try {
    payload = (await req.json()) as HeartbeatPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!payload.device_id || typeof payload.device_id !== "string") {
    return NextResponse.json({ error: "device_id 필수" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { error } = await supabase.from("device_heartbeat").upsert(
    {
      device_id: payload.device_id,
      last_seen_at: payload.last_seen_at ?? new Date().toISOString(),
      pending_count: typeof payload.pending_count === "number" ? payload.pending_count : 0,
      battery_level: typeof payload.battery_level === "number" ? payload.battery_level : -1,
      app_version: payload.app_version ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "device_id" }
  );

  if (error) {
    console.error("[heartbeat] upsert failed", error);
    return NextResponse.json({ error: "저장 실패" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
