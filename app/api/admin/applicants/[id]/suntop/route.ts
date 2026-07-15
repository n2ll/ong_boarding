/**
 * 선탑(동승) 이력 기록/정정 — POST·DELETE /api/admin/applicants/[id]/suntop
 *
 * 선탑 = 현장을 미리 경험한 '프리보딩' 자산. 2단계 원장으로 남긴다:
 *   stage='scheduled' → pool_events(event_type='suntop_scheduled', meta.scheduled_at) — 선탑 예정
 *   stage='done'      → pool_events(event_type='suntop_done')                          — 선탑 완료
 * 이 원장은 (1) 상세 패널 배지·타임라인 (2) 새 공고 안내 S그룹(최우선) (3) 선탑→투입 전환율 지표
 * (/api/admin/suntop-stats)의 근거가 된다. meta: { client?, line?, note?, scheduled_at?, source:'manual' }.
 *
 * DELETE는 ?event_id= 로 특정 기록만 제거(오기록 정정). 인증은 middleware(Basic Auth).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  let body: { stage?: string; client?: string; line?: string; note?: string; scheduled_at?: string } = {};
  try {
    body = await req.json();
  } catch {
    // 본문 없이도 완료 기록 허용 (하위호환)
  }

  const stage = body.stage === "scheduled" ? "scheduled" : "done";
  const eventType = stage === "scheduled" ? "suntop_scheduled" : "suntop_done";

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("pool_events")
    .insert({
      applicant_id: id,
      event_type: eventType,
      meta: {
        source: "manual",
        ...(body.client?.trim() ? { client: body.client.trim() } : {}),
        ...(body.line?.trim() ? { line: body.line.trim() } : {}),
        ...(body.note?.trim() ? { note: body.note.trim() } : {}),
        ...(stage === "scheduled" && body.scheduled_at?.trim() ? { scheduled_at: body.scheduled_at.trim() } : {}),
      },
    })
    .select("id, created_at, meta")
    .single();
  if (error) {
    console.error("[suntop POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, stage, event: data });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  const eventId = Number(req.nextUrl.searchParams.get("event_id"));
  if (!Number.isFinite(id) || !Number.isFinite(eventId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("pool_events")
    .delete()
    .eq("id", eventId)
    .eq("applicant_id", id)
    .in("event_type", ["suntop_scheduled", "suntop_done"]);
  if (error) {
    console.error("[suntop DELETE]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
