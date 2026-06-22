import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { invalidateExamplesCache } from "@/lib/agent/examples";
import { PROMPT_EXAMPLES_SEED } from "@/lib/agent/prompt-examples-seed";

export const dynamic = "force-dynamic";

// 'screening' 카테고리는 deprecated (시스템 자동 발송 문구로 일원화됨).
// DB에 남은 레거시 행은 무해 — 더 이상 UI/백엔드에서 읽지 않는다.
const CATEGORIES = ["conversation", "facts", "system_message"] as const;
type Category = (typeof CATEGORIES)[number];

function isValidCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

// GET /api/admin/prompt-examples?category=conversation
export async function GET(req: NextRequest) {
  try {
    const category = new URL(req.url).searchParams.get("category");
    const supabase = createServiceClient();

    let q = supabase
      .from("prompt_examples")
      .select("*")
      .order("category", { ascending: true })
      .order("sort_order", { ascending: true });

    if (category) {
      if (!isValidCategory(category)) {
        return NextResponse.json({ error: "잘못된 category" }, { status: 400 });
      }
      q = q.eq("category", category);
    }

    const { data, error } = await q;
    if (error) {
      console.error("[prompt-examples GET]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data: data ?? [] });
  } catch (err) {
    console.error("[prompt-examples GET exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

// POST /api/admin/prompt-examples  body: { category, title, body, sort_order? }
export async function POST(req: NextRequest) {
  try {
    const { category, title, body, sort_order } = await req.json();

    if (!isValidCategory(category)) {
      return NextResponse.json({ error: "category 필수" }, { status: 400 });
    }
    if (!title?.trim() || !body?.trim()) {
      return NextResponse.json(
        { error: "title, body는 필수입니다." },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();

    // sort_order 미지정 시 해당 카테고리의 마지막 + 10
    let finalSort = typeof sort_order === "number" ? sort_order : 0;
    if (typeof sort_order !== "number") {
      const { data: last } = await supabase
        .from("prompt_examples")
        .select("sort_order")
        .eq("category", category)
        .order("sort_order", { ascending: false })
        .limit(1)
        .maybeSingle();
      finalSort = (last?.sort_order ?? 0) + 10;
    }

    const { data, error } = await supabase
      .from("prompt_examples")
      .insert({
        category,
        title: title.trim(),
        body: body.trim(),
        sort_order: finalSort,
      })
      .select()
      .single();

    if (error) {
      console.error("[prompt-examples POST]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    invalidateExamplesCache();
    return NextResponse.json({ data });
  } catch (err) {
    console.error("[prompt-examples POST exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

// PUT /api/admin/prompt-examples  body: { action: "seed" } — 기본 예시 일괄 INSERT (1회용)
export async function PUT(req: NextRequest) {
  try {
    const { action } = await req.json();
    if (action !== "seed") {
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }

    const supabase = createServiceClient();

    // 멱등 시드 — 이미 존재하는 (category, title) 조합은 건드리지 않고 빠진 것만 INSERT.
    // 매니저가 일부 편집·삭제한 뒤 다시 눌러도 기존 데이터 보존 + 새 기본값(예: system_message)만 보충.
    const { data: existing } = await supabase
      .from("prompt_examples")
      .select("category, title");
    const existingKeys = new Set(
      (existing ?? []).map((r) => `${r.category}::${r.title}`)
    );

    const toInsert = PROMPT_EXAMPLES_SEED.filter(
      (s) => !existingKeys.has(`${s.category}::${s.title}`)
    );

    if (toInsert.length === 0) {
      return NextResponse.json({ success: true, inserted: 0, message: "이미 모든 기본값이 있습니다." });
    }

    const { error } = await supabase.from("prompt_examples").insert(toInsert);
    if (error) {
      console.error("[prompt-examples seed]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    invalidateExamplesCache();
    return NextResponse.json({ success: true, inserted: toInsert.length });
  } catch (err) {
    console.error("[prompt-examples PUT exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
