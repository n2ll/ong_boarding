/**
 * 전역 AI 응답 일시중지 스위치.
 *
 * DB 플래그(`prompt_examples` 안에 category='system_message', title='agent_kill_switch')
 * 또는 환경변수(AGENT_DISABLED=1) 중 하나라도 활성이면 AI 응답을 일체 건너뛴다.
 *
 * 토글:
 *  - 켜기: scripts/toggle-agent-kill-switch.mjs on
 *  - 끄기: scripts/toggle-agent-kill-switch.mjs off
 *
 * 라우터는 처리 시작 전에 isAgentDisabled()를 호출해 true면 즉시 종료한다.
 * 인입·apply 라우트는 새 후보를 만들 때 stage를 'paused'로 시작해 둔다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

let cache: { value: boolean; at: number } | null = null;
const TTL_MS = 5_000; // 안전상 짧게 — 토글 후 5초 이내 반영

export async function isAgentDisabled(supabase: SupabaseClient): Promise<boolean> {
  if (process.env.AGENT_DISABLED === "1") return true;

  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  try {
    const { data } = await supabase
      .from("prompt_examples")
      .select("body")
      .eq("category", "system_message")
      .eq("title", "agent_kill_switch")
      .maybeSingle();
    const v = (data?.body ?? "").trim() === "1";
    cache = { value: v, at: Date.now() };
    return v;
  } catch (e) {
    console.error("[kill-switch] query failed, treating as disabled=false", e);
    return false;
  }
}

/** 호출자가 토글 직후 강제로 캐시 무효화하고 싶을 때 사용. */
export function invalidateKillSwitchCache(): void {
  cache = null;
}
