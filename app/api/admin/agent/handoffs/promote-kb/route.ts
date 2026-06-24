/**
 * 인계 → 지식 자산화 (③-2, 승인형 KB).
 *
 * 매니저가 인계 큐에서 답한 '공고에 안 담기는 일반 지식'(예: 배민 커넥트 가입 순서,
 * 정산 주기 등)을 옹봇 지식에 추가한다. 등록 = 매니저가 검토·승인한 것만 반영(자동 학습 아님).
 *
 *  POST { target: "common" | "branch", title, body, branch_name? }
 *    - common : prompt_examples(category='facts')에 1행 INSERT → 전 지점 공통
 *    - branch : branches.ai_facts 텍스트에 append → 해당 지점 전용
 *
 * ⚠️ '정보 제공'을 위한 사실 적재일 뿐, 근무 확정/배정과는 무관하다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { invalidateExamplesCache } from "@/lib/agent/examples";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { target?: string; title?: string; body?: string; branch_name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const target = body.target ?? "";
  const title = (body.title ?? "").trim();
  const text = (body.body ?? "").trim();
  const branchName = (body.branch_name ?? "").trim();

  if (!title || !text) {
    return NextResponse.json({ error: "제목·내용은 필수입니다." }, { status: 400 });
  }

  const supabase = createServiceClient();

  if (target === "common") {
    // 해당 카테고리 마지막 sort_order + 10
    const { data: last } = await supabase
      .from("prompt_examples")
      .select("sort_order")
      .eq("category", "facts")
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const finalSort = (last?.sort_order ?? 0) + 10;

    const { error } = await supabase
      .from("prompt_examples")
      .insert({ category: "facts", title, body: text, sort_order: finalSort });
    if (error) {
      console.error("[handoffs/promote-kb common]", error);
      return NextResponse.json({ error: "공통 지식 등록 실패" }, { status: 500 });
    }
    invalidateExamplesCache();
    return NextResponse.json({ ok: true, target: "common" });
  }

  if (target === "branch") {
    if (!branchName) {
      return NextResponse.json({ error: "지점 지식은 지점명이 필요해요." }, { status: 400 });
    }
    const { data: branch, error: bErr } = await supabase
      .from("branches")
      .select("id, ai_facts")
      .eq("name", branchName)
      .maybeSingle();
    if (bErr || !branch) {
      return NextResponse.json({ error: "지점을 찾지 못했어요." }, { status: 404 });
    }
    const prev = (branch.ai_facts as string | null)?.trim() ?? "";
    const block = `[${title}]\n${text}`;
    const next = prev ? `${prev}\n\n${block}` : block;

    const { error } = await supabase.from("branches").update({ ai_facts: next }).eq("id", branch.id);
    if (error) {
      console.error("[handoffs/promote-kb branch]", error);
      return NextResponse.json({ error: "지점 지식 등록 실패" }, { status: 500 });
    }
    invalidateExamplesCache();
    return NextResponse.json({ ok: true, target: "branch", branch: branchName });
  }

  return NextResponse.json({ error: "target(common|branch) 필수" }, { status: 400 });
}
