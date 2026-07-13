/**
 * 선탑(동승) 완료 이력 기록/정정 — POST·DELETE /api/admin/applicants/[id]/suntop
 *
 * 선탑 완료 = 현장을 미리 경험한 '프리보딩' 자산. pool_events(event_type='suntop_done') 원장에 기록되어
 *  - 상세 패널 배지·이력 표시 (applicants/[id] GET의 suntop 필드)
 *  - 새 공고 안내(announce-targets) S그룹(약속자보다 우선) 산정
 * 의 근거가 된다. meta: { client?, line?, note?, source:'manual' } — 어느 화주사·라인을 경험했는지.
 *
 * DELETE는 ?event_id= 로 특정 기록만 제거(오기록 정정용). 인증은 middleware(Basic Auth)가 담당.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  let body: { client?: string; line?: string; note?: string } = {};
  try {
    body = await req.json();
  } catch {
    // 본문 없이도 기록 허용 — 화주사·라인은 선택 입력
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("pool_events")
    .insert({
      applicant_id: id,
      event_type: "suntop_done",
      meta: {
        source: "manual",
        ...(body.client?.trim() ? { client: body.client.trim() } : {}),
        ...(body.line?.trim() ? { line: body.line.trim() } : {}),
        ...(body.note?.trim() ? { note: body.note.trim() } : {}),
      },
    })
    .select("id, created_at, meta")
    .single();
  if (error) {
    console.error("[suntop POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, event: data });
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
    .eq("event_type", "suntop_done");
  if (error) {
    console.error("[suntop DELETE]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
