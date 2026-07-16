/**
 * 재채용 블랙리스트 관리 — GET(목록) / POST(등록) / DELETE(해제).
 * "절대 재채용 불가" 명단(recruitment_blacklist). 전화번호(정규화) 키.
 * 콜드 발송·(Phase B) 편입에서 하드 제외된다. 어드민 미들웨어 인증.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { normalizePhone } from "@/lib/ongmanaging";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("recruitment_blacklist")
    .select("id, phone, name, reason, added_by, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[blacklist GET] failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ entries: data ?? [] });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const phone = normalizePhone(String(body?.phone ?? ""));
  if (!/^\d{10,11}$/.test(phone)) {
    return NextResponse.json({ error: "유효한 전화번호가 필요합니다." }, { status: 400 });
  }
  const name = typeof body?.name === "string" ? body.name.trim() || null : null;
  const reason = typeof body?.reason === "string" ? body.reason.trim() || null : null;
  const added_by = typeof body?.added_by === "string" ? body.added_by.trim() || null : null;

  const supabase = createServiceClient();
  // 이미 있으면 사유/이름 갱신(멱등) — phone unique.
  const { data, error } = await supabase
    .from("recruitment_blacklist")
    .upsert({ phone, name, reason, added_by }, { onConflict: "phone" })
    .select()
    .single();
  if (error) {
    console.error("[blacklist POST] failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, entry: data });
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const body = await req.json().catch(() => null);
  const raw = body?.phone ?? url.searchParams.get("phone") ?? "";
  const phone = normalizePhone(String(raw));
  if (!phone) {
    return NextResponse.json({ error: "phone이 필요합니다." }, { status: 400 });
  }
  const supabase = createServiceClient();
  const { error } = await supabase.from("recruitment_blacklist").delete().eq("phone", phone);
  if (error) {
    console.error("[blacklist DELETE] failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
