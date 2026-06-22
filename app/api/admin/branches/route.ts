import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("branches")
    .select("id, name, sort_order, active, client_id, slot_capacity, ai_facts, created_at, updated_at")
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("[admin/branches] query error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data: data || [] });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      name?: string;
      sort_order?: number;
      active?: boolean;
      client_id?: number | null;
    };
    const name = (body.name || "").trim();
    if (!name) {
      return NextResponse.json(
        { error: "지점 이름을 입력해주세요." },
        { status: 400 }
      );
    }
    if (name.length > 50) {
      return NextResponse.json(
        { error: "지점 이름이 너무 깁니다 (최대 50자)." },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    let sort_order = body.sort_order;
    if (typeof sort_order !== "number") {
      const { data: maxRow } = await supabase
        .from("branches")
        .select("sort_order")
        .order("sort_order", { ascending: false })
        .limit(1)
        .maybeSingle();
      sort_order = (maxRow?.sort_order ?? 0) + 10;
    }

    const { data, error } = await supabase
      .from("branches")
      .insert({
        name,
        sort_order,
        active: body.active ?? true,
        client_id: typeof body.client_id === "number" ? body.client_id : null,
      })
      .select("id, name, sort_order, active, client_id")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "이미 존재하는 지점 이름입니다." },
          { status: 409 }
        );
      }
      console.error("[admin/branches] insert error", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error("[admin/branches] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
