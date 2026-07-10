/**
 * 전역 AI 응답 모드 스위치 (3단).
 *
 * DB 플래그(`prompt_examples` 안에 category='system_message', title='agent_kill_switch') body 값:
 *  - ''/'0'/행 없음 → 'auto'  : AI 자동 응대 (기존 동작)
 *  - '1'            → 'off'   : 완전 중지 (기존 kill-switch ON과 100% 동일)
 *  - 'draft'        → 'draft' : 코파일럿 — AI가 초안(message_drafts)만 만들고 발송·전이는 하지 않음
 *
 * 환경변수 AGENT_DISABLED=1 이면 DB 값과 무관하게 항상 'off'.
 *
 * 토글:
 *  - 어드민 UI: 에이전트 두뇌 > 고급 설정 > 'AI 전역 응답' 3단 선택
 *  - API: GET/POST /api/admin/agent/kill-switch  ({ mode } — 구형 { disabled: boolean }도 수용)
 *
 * 라우터는 처리 시작 전에 getAgentMode()를 호출해 off면 즉시 종료, draft면 초안만 생성한다.
 * 인입·apply 라우트는 새 후보를 만들 때 stage를 'paused'로 시작해 둔다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type AgentMode = "auto" | "draft" | "off";

/** 코파일럿 초안 식별 마커 — message_drafts.reasoning 맨 앞에 붙인다.
 *  (message_drafts에 meta 컬럼이 없어 reasoning prefix로 구분.
 *   ConversationThread 초안 카드·messages/send의 승인 처리에서 이 마커로 판정) */
export const COPILOT_DRAFT_MARKER = "[코파일럿]";

let cache: { value: AgentMode; at: number } | null = null;
const TTL_MS = 5_000; // 안전상 짧게 — 토글 후 5초 이내 반영

/** DB body 문자열 → 모드. API 라우트와 판정을 공유한다. */
export function parseAgentMode(body: string | null | undefined): AgentMode {
  const v = (body ?? "").trim();
  if (v === "1") return "off";
  if (v === "draft") return "draft";
  return "auto";
}

export async function getAgentMode(supabase: SupabaseClient): Promise<AgentMode> {
  if (process.env.AGENT_DISABLED === "1") return "off";

  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  try {
    const { data } = await supabase
      .from("prompt_examples")
      .select("body")
      .eq("category", "system_message")
      .eq("title", "agent_kill_switch")
      .maybeSingle();
    const v = parseAgentMode(data?.body as string | null | undefined);
    cache = { value: v, at: Date.now() };
    return v;
  } catch (e) {
    // 조회 실패 시 기존 fail-open 유지(auto) — 인입 파이프라인을 죽이지 않는다.
    console.error("[kill-switch] query failed, treating as mode=auto", e);
    return "auto";
  }
}

/** 완전 중지(off)일 때만 true — 기존 호출부(알림 등)의 의미 유지. */
export async function isAgentDisabled(supabase: SupabaseClient): Promise<boolean> {
  return (await getAgentMode(supabase)) === "off";
}

/** 호출자가 토글 직후 강제로 캐시 무효화하고 싶을 때 사용. */
export function invalidateKillSwitchCache(): void {
  cache = null;
}
