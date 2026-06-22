import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SELECT_COLS =
  "id, name, phone, branch, role, note, active, sort_order, created_at, updated_at";

export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("site_managers")
    .select(SELECT_COLS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[admin/site-managers] query error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data: data || [] });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      name?: string;
      phone?: string;
      branch?: string | null;
      role?: string | null;
      note?: string | null;
      active?: boolean;
      sort_order?: number;
    };

    const name = (body.name || "").trim();
    const phone = (body.phone || "").trim();
    if (!name) {
      return NextResponse.json({ error: "이름을 입력해주세요." }, { status: 400 });
    }
    if (!phone) {
      return NextResponse.json({ error: "전화번호를 입력해주세요." }, { status: 400 });
    }
    if (name.length > 50) {
      return NextResponse.json({ error: "이름이 너무 깁니다 (최대 50자)." }, { status: 400 });
    }

    const supabase = createServiceClient();

    let sort_order = body.sort_order;
    if (typeof sort_order !== "number") {
      const { data: maxRow } = await supabase
        .from("site_managers")
        .select("sort_order")
        .order("sort_order", { ascending: false })
        .limit(1)
        .maybeSingle();
      sort_order = (maxRow?.sort_order ?? 0) + 10;
    }

    const { data, error } = await supabase
      .from("site_managers")
      .insert({
        name,
        phone,
        branch: body.branch?.trim() || null,
        role: body.role?.trim() || "현장",
        note: body.note?.trim() || null,
        active: body.active ?? true,
        sort_order,
      })
      .select(SELECT_COLS)
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "이미 등록된 (이름, 전화번호) 조합입니다." },
          { status: 409 }
        );
      }
      console.error("[admin/site-managers] insert error", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error("[admin/site-managers] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
