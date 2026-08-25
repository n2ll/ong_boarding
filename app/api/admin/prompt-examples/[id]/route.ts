import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { invalidateExamplesCache } from "@/lib/agent/examples";
import { isReservedPromptExampleKey } from "@/lib/admin/prompt-example-reserved";

export const dynamic = "force-dynamic";

// PUT /api/admin/prompt-examples/[id]  body: { title?, body?, sort_order? }
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const routeParams = await params;
    const id = parseInt(routeParams.id);
    if (isNaN(id)) {
      return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
    }

    const { title, body, sort_order } = await req.json();
    const supabase = createServiceClient();
    const { data: current, error: currentError } = await supabase
      .from("prompt_examples")
      .select("category, title")
      .eq("id", id)
      .maybeSingle();
    if (currentError) {
      console.error("[prompt-examples PUT lookup]", currentError);
      return NextResponse.json({ error: currentError.message }, { status: 500 });
    }
    if (!current) {
      return NextResponse.json({ error: "항목을 찾을 수 없습니다." }, { status: 404 });
    }
    const nextTitle = typeof title === "string" ? title.trim() : current.title;
    if (
      isReservedPromptExampleKey(current.category, current.title)
      || isReservedPromptExampleKey(current.category, nextTitle)
    ) {
      return NextResponse.json(
        { error: "전역 AI 응답 모드는 에이전트 설정에서만 변경할 수 있습니다." },
        { status: 409 }
      );
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof title === "string") update.title = nextTitle;
    if (typeof body === "string") update.body = body.trim();
    if (typeof sort_order === "number") update.sort_order = sort_order;

    if (Object.keys(update).length === 1) {
      return NextResponse.json({ error: "변경할 필드 없음" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("prompt_examples")
      .update(update)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("[prompt-examples PUT]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    invalidateExamplesCache();
    return NextResponse.json({ data });
  } catch (err) {
    console.error("[prompt-examples PUT exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

// DELETE /api/admin/prompt-examples/[id]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const routeParams = await params;
    const id = parseInt(routeParams.id);
    if (isNaN(id)) {
      return NextResponse.json({ error: "잘못된 id" }, { status: 400 });
    }

    const supabase = createServiceClient();
    const { data: current, error: currentError } = await supabase
      .from("prompt_examples")
      .select("category, title")
      .eq("id", id)
      .maybeSingle();
    if (currentError) {
      console.error("[prompt-examples DELETE lookup]", currentError);
      return NextResponse.json({ error: currentError.message }, { status: 500 });
    }
    if (!current) {
      return NextResponse.json({ error: "항목을 찾을 수 없습니다." }, { status: 404 });
    }
    if (isReservedPromptExampleKey(current.category, current.title)) {
      return NextResponse.json(
        { error: "전역 AI 응답 모드는 에이전트 설정에서만 변경할 수 있습니다." },
        { status: 409 }
      );
    }

    const { error } = await supabase.from("prompt_examples").delete().eq("id", id);

    if (error) {
      console.error("[prompt-examples DELETE]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    invalidateExamplesCache();
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[prompt-examples DELETE exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
