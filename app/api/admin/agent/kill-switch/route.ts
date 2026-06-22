/**
 * GET  /api/admin/agent/kill-switch  → { disabled: boolean, updated_at: string | null }
 * POST /api/admin/agent/kill-switch  body: { disabled: boolean } → 전역 AI 응답 on/off
 *
 * 전역 AI 응답 일시중지 스위치를 prompt_examples
 * (category='system_message', title='agent_kill_switch') 플래그로 토글한다.
 * body='1'이면 전역 중단, 그 외면 작동.
 * router.runAgentForCandidate가 처리 시작 전 isAgentDisabled()로 이 값을 확인한다.
 *
 * 주의: 환경변수 AGENT_DISABLED=1이 별도로 걸려 있으면 이 토글과 무관하게 항상 중단된다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { invalidateKillSwitchCache } from "@/lib/agent/kill-switch";

export const dynamic = "force-dynamic";

const CATEGORY = "system_message";
const TITLE = "agent_kill_switch";

export async function GET() {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("prompt_examples")
      .select("body, updated_at")
      .eq("category", CATEGORY)
      .eq("title", TITLE)
      .maybeSingle();

    if (error) {
      console.error("[kill-switch GET]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      disabled: (data?.body ?? "").trim() === "1",
      updated_at: (data as { updated_at?: string } | null)?.updated_at ?? null,
      env_forced: process.env.AGENT_DISABLED === "1",
    });
  } catch (err) {
    console.error("[kill-switch GET exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { disabled } = await req.json();
    if (typeof disabled !== "boolean") {
      return NextResponse.json(
        { error: "disabled(boolean)는 필수입니다." },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();
    const body = disabled ? "1" : "0";

    // 기존 플래그 행이 있으면 업데이트, 없으면 생성.
    const { data: existing } = await supabase
      .from("prompt_examples")
      .select("id")
      .eq("category", CATEGORY)
      .eq("title", TITLE)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from("prompt_examples")
        .update({ body })
        .eq("id", existing.id);
      if (error) {
        console.error("[kill-switch POST update]", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    } else {
      const { error } = await supabase
        .from("prompt_examples")
        .insert({ category: CATEGORY, title: TITLE, body, sort_order: 0 });
      if (error) {
        console.error("[kill-switch POST insert]", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    // 이 인스턴스의 캐시만 즉시 무효화(best-effort). 다른 인스턴스도 TTL 5초 내 반영됨.
    invalidateKillSwitchCache();
    return NextResponse.json({ disabled });
  } catch (err) {
    console.error("[kill-switch POST exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
