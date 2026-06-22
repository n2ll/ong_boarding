import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface PatchBody {
  name?: string;
  sort_order?: number;
  active?: boolean;
  slot_capacity?: Record<string, number>;
  ai_facts?: string | null;
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

    const update: PatchBody = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json(
          { error: "지점 이름은 비울 수 없습니다." },
          { status: 400 }
        );
      }
      if (name.length > 50) {
        return NextResponse.json(
          { error: "지점 이름이 너무 깁니다." },
          { status: 400 }
        );
      }
      update.name = name;
    }
    if (typeof body.sort_order === "number") update.sort_order = body.sort_order;
    if (typeof body.active === "boolean") update.active = body.active;
    if ("ai_facts" in body) {
      // null 또는 string. 빈 문자열은 null로 정규화 (저장 일관성).
      const v = body.ai_facts;
      update.ai_facts = (typeof v === "string" && v.trim()) ? v : null;
    }
    if (body.slot_capacity && typeof body.slot_capacity === "object") {
      // 안전: 숫자만 통과시키고 0 이상으로 클램프
      const sanitized: Record<string, number> = {};
      for (const [k, v] of Object.entries(body.slot_capacity)) {
        const n = Number(v);
        if (Number.isFinite(n)) sanitized[k] = Math.max(0, Math.floor(n));
      }
      update.slot_capacity = sanitized;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { error: "수정할 필드가 없습니다." },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("branches")
      .update(update)
      .eq("id", id)
      .select("id, name, sort_order, active, slot_capacity, ai_facts")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "이미 존재하는 지점 이름입니다." },
          { status: 409 }
        );
      }
      console.error("[admin/branches/:id] update error", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    console.error("[admin/branches/:id] exception", err);
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

    const { data: branch, error: bErr } = await supabase
      .from("branches")
      .select("id, name")
      .eq("id", id)
      .single();
    if (bErr || !branch) {
      return NextResponse.json(
        { error: "지점을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // 지원자가 참조 중이면 하드 삭제 금지 — soft delete(active=false)만 허용
    const { count, error: cErr } = await supabase
      .from("applicants")
      .select("id", { count: "exact", head: true })
      .or(
        `branch.eq.${branch.name},branch1.eq.${branch.name},branch2.eq.${branch.name},confirmed_branch.eq.${branch.name},current_branch.eq.${branch.name}`
      );
    if (cErr) {
      console.error("[admin/branches/:id] count error", cErr);
      return NextResponse.json({ error: cErr.message }, { status: 500 });
    }

    if ((count ?? 0) > 0) {
      const { data, error } = await supabase
        .from("branches")
        .update({ active: false })
        .eq("id", id)
        .select("id, name, sort_order, active, slot_capacity")
        .single();
      if (error) {
        console.error("[admin/branches/:id] soft-delete error", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      return NextResponse.json({
        data,
        soft: true,
        message: `해당 지점에 지원자(${count}명)가 있어 비활성화 처리했습니다.`,
      });
    }

    const { error } = await supabase.from("branches").delete().eq("id", id);
    if (error) {
      console.error("[admin/branches/:id] delete error", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data: { id }, soft: false });
  } catch (err) {
    console.error("[admin/branches/:id] exception", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
