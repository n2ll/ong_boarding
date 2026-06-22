/**
 * 운영자 페르소나 — AI 에이전트 시스템 프롬프트에 덧붙는 톤·역할 지침.
 *
 * 저장소: prompt_examples (category='agent_config', title='persona') 단일 행.
 *   - body에 구조화 JSON({ role, instructions, tone, emoji })을 저장.
 *   - 에이전트(lib/agent.ts buildSystemPrompt)가 loadPersonaGuidance로 읽어 프롬프트에 반영.
 *   - KB 탭(facts/system_message/conversation)에는 노출되지 않는 별도 카테고리.
 *
 * GET  → { data: { role, instructions, tone, emoji } | null }
 * PUT  body: { role, instructions, tone, emoji } → upsert
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { invalidateExamplesCache } from "@/lib/agent/examples";

export const dynamic = "force-dynamic";

// prompt_examples.category에 CHECK 제약이 있어 신규 카테고리를 못 쓴다.
// 허용된 'system_message' 카테고리 + 예약 제목('__persona__')으로 저장하고,
// KB UI에서는 '__' 접두 제목을 숨겨 노출되지 않게 한다.
const CATEGORY = "system_message";
const TITLE = "__persona__";

interface PersonaForm {
  role: string;
  instructions: string;
  tone: string;
  emoji: number;
}

function parsePersona(body: string | null): PersonaForm | null {
  if (!body?.trim()) return null;
  try {
    const o = JSON.parse(body) as Partial<PersonaForm>;
    return {
      role: typeof o.role === "string" ? o.role : "",
      instructions: typeof o.instructions === "string" ? o.instructions : "",
      tone: typeof o.tone === "string" ? o.tone : "",
      emoji: typeof o.emoji === "number" ? o.emoji : 40,
    };
  } catch {
    // 구버전 자유 텍스트 → instructions로 흡수
    return { role: "", instructions: body, tone: "", emoji: 40 };
  }
}

export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("prompt_examples")
    .select("body")
    .eq("category", CATEGORY)
    .eq("title", TITLE)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[admin/agent/persona GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data: parsePersona((data?.body as string | null) ?? null) });
}

export async function PUT(req: NextRequest) {
  let payload: Partial<PersonaForm>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }

  const form: PersonaForm = {
    role: (payload.role ?? "").toString().trim(),
    instructions: (payload.instructions ?? "").toString().trim(),
    tone: (payload.tone ?? "").toString().trim(),
    emoji: typeof payload.emoji === "number" ? Math.max(0, Math.min(100, payload.emoji)) : 40,
  };

  if (!form.role && !form.instructions) {
    return NextResponse.json({ error: "역할 또는 핵심 지시사항 중 하나는 입력해야 합니다." }, { status: 400 });
  }

  const supabase = createServiceClient();
  const body = JSON.stringify(form);

  // upsert by (category, title): 기존 행이 있으면 update, 없으면 insert.
  const { data: existing } = await supabase
    .from("prompt_examples")
    .select("id")
    .eq("category", CATEGORY)
    .eq("title", TITLE)
    .limit(1)
    .maybeSingle();

  let error;
  if (existing?.id) {
    ({ error } = await supabase
      .from("prompt_examples")
      .update({ body, updated_at: new Date().toISOString() })
      .eq("id", existing.id));
  } else {
    ({ error } = await supabase
      .from("prompt_examples")
      .insert({ category: CATEGORY, title: TITLE, body, sort_order: 0 }));
  }

  if (error) {
    console.error("[admin/agent/persona PUT]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  invalidateExamplesCache();
  return NextResponse.json({ data: form });
}
