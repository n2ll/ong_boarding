import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SELECT_COLS =
  "id, name, phone, branch, role, note, active, sort_order, created_at, updated_at";

interface PatchBody {
  name?: string;
  phone?: string;
  branch?: string | null;
  role?: string | null;
  note?: string | null;
  active?: boolean;
  sort_order?: number;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const id = Number(params.id);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
    }
    const body = (await req.json()) as PatchBody;

    const update: Record<string, unknown> = {};

    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json({ error: "이름은 비울 수 없습니다." }, { status: 400 });
      }
      if (name.length > 50) {
        return NextResponse.json({ error: "이름이 너무 깁니다." }, { status: 400 });
      }
      update.name = name;
    }
    if (typeof body.phone === "string") {
      const phone = body.phone.trim();
      if (!phone) {
        return NextResponse.json({ error: "전화번호는 비울 수 없습니다." }, { status: 400 });
      }
      update.phone = phone;
    }
    if ("branch" in body) update.branch = body.branch?.toString().trim() || null;
    if ("role" in body) update.role = body.role?.toString().trim() || null;
    if ("note" in body) update.note = body.note?.toString().trim() || null;
    if (typeof body.active === "boolean") update.active = body.active;
    if (typeof body.sort_order === "number") update.sort_order = body.sort_order;

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "수정할 필드가 없습니다." }, { status: 400 });
    }

    // updated_at 수동 갱신 (DB 트리거 없으므로)
    update.updated_at = new Date().toISOString();

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("site_managers")
      .update(update)
      .eq("id", id)
      .select(SELECT_COLS)
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "이미 등록된 (이름, 전화번호) 조합입니다." },
          { status: 409 }
        );
      }
      console.error("[admin/site-managers/:id] update error", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    console.error("[admin/site-managers/:id] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const id = Number(params.id);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
    }
    const supabase = createServiceClient();

    const { error } = await supabase.from("site_managers").delete().eq("id", id);
    if (error) {
      console.error("[admin/site-managers/:id] delete error", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data: { id } });
  } catch (err) {
    console.error("[admin/site-managers/:id] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
