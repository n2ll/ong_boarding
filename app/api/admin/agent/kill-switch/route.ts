/**
 * GET  /api/admin/agent/kill-switch
 *   → { mode: 'auto'|'draft'|'off', disabled: boolean, updated_at, env_forced }
 * POST /api/admin/agent/kill-switch
 *   body: { mode: 'auto'|'draft'|'off' } — 전역 AI 응답 3단 전환
 *   (하위호환: 구형 { disabled: boolean }도 수용 — true→off, false→auto)
 *
 * 전역 AI 응답 모드를 prompt_examples(category='system_message', title='agent_kill_switch')
 * body 값으로 저장한다. '1'=off(완전 중지, 기존과 동일), 'draft'=코파일럿(초안만), 그 외=auto.
 * router.runAgentForCandidate가 처리 시작 전 getAgentMode()로 이 값을 확인한다.
 *
 * 주의: 환경변수 AGENT_DISABLED=1이 별도로 걸려 있으면 이 토글과 무관하게 항상 중단된다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { invalidateKillSwitchCache, parseAgentMode, type AgentMode } from "@/lib/agent/kill-switch";

export const dynamic = "force-dynamic";

const CATEGORY = "system_message";
const TITLE = "agent_kill_switch";

const MODE_TO_BODY: Record<AgentMode, string> = { auto: "0", draft: "draft", off: "1" };

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

    const mode = parseAgentMode(data?.body as string | null | undefined);
    return NextResponse.json({
      mode,
      // 하위호환 — 기존 소비자(disabled boolean)는 '완전 중지'일 때만 true.
      disabled: mode === "off",
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
    const payload = (await req.json()) as { mode?: unknown; disabled?: unknown };

    let mode: AgentMode;
    if (payload.mode !== undefined) {
      if (payload.mode !== "auto" && payload.mode !== "draft" && payload.mode !== "off") {
        return NextResponse.json(
          { error: "mode는 'auto' | 'draft' | 'off' 중 하나여야 합니다." },
          { status: 400 }
        );
      }
      mode = payload.mode;
    } else if (typeof payload.disabled === "boolean") {
      // 구형 on/off 불리언 요청 하위호환
      mode = payload.disabled ? "off" : "auto";
    } else {
      return NextResponse.json(
        { error: "mode('auto'|'draft'|'off') 또는 disabled(boolean)가 필요합니다." },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();
    const body = MODE_TO_BODY[mode];

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
    return NextResponse.json({ mode, disabled: mode === "off" });
  } catch (err) {
    console.error("[kill-switch POST exception]", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}
