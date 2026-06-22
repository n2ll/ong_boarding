/**
 * PATCH  /api/admin/clients/[id]  — 화주사 수정
 * DELETE /api/admin/clients/[id]  — 화주사 삭제 (소속 지점 있으면 비활성 처리)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const CLIENT_TYPES = ["baemin_bmart", "danggeun", "general"] as const;

interface PatchBody {
  name?: string;
  client_type?: string;
  uses_slots?: boolean;
  contact_name?: string | null;
  contact_phone?: string | null;
  memo?: string | null;
  active?: boolean;
  sort_order?: number;
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = Number(params.id);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
    }
    const body = (await req.json()) as PatchBody;
    const update: Record<string, unknown> = {};

    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "화주사 이름은 비울 수 없습니다." }, { status: 400 });
      if (name.length > 80) return NextResponse.json({ error: "화주사 이름이 너무 깁니다." }, { status: 400 });
      update.name = name;
    }
    if (body.client_type && (CLIENT_TYPES as readonly string[]).includes(body.client_type)) {
      update.client_type = body.client_type;
    }
    if (typeof body.uses_slots === "boolean") update.uses_slots = body.uses_slots;
    if ("contact_name" in body) update.contact_name = body.contact_name?.toString().trim() || null;
    if ("contact_phone" in body) update.contact_phone = body.contact_phone?.toString().trim() || null;
    if ("memo" in body) update.memo = body.memo?.toString().trim() || null;
    if (typeof body.active === "boolean") update.active = body.active;
    if (typeof body.sort_order === "number") update.sort_order = body.sort_order;

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "수정할 필드가 없습니다." }, { status: 400 });
    }
    update.updated_at = new Date().toISOString();

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("clients")
      .update(update)
      .eq("id", id)
      .select("id, name, client_type, uses_slots, contact_name, contact_phone, memo, active, sort_order")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "이미 존재하는 화주사 이름입니다." }, { status: 409 });
      }
      console.error("[admin/clients/:id PATCH]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    console.error("[admin/clients/:id PATCH exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = Number(params.id);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
    }
    const supabase = createServiceClient();

    const { count } = await supabase
      .from("branches")
      .select("id", { count: "exact", head: true })
      .eq("client_id", id);

    if ((count ?? 0) > 0) {
      const { data, error } = await supabase
        .from("clients")
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select("id, name, active")
        .single();
      if (error) {
        console.error("[admin/clients/:id soft-delete]", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      return NextResponse.json({
        data,
        soft: true,
        message: `소속 지점(${count}개)이 있어 비활성화 처리했습니다.`,
      });
    }

    const { error } = await supabase.from("clients").delete().eq("id", id);
    if (error) {
      console.error("[admin/clients/:id DELETE]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data: { id }, soft: false });
  } catch (err) {
    console.error("[admin/clients/:id DELETE exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
