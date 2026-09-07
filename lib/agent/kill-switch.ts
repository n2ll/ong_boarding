/**
 * 전역 AI 응답 모드 스위치 (3단).
 *
 * DB 플래그(`prompt_examples` 안에 category='system_message', title='agent_kill_switch') body 값:
 *  - ''/'0'/행 없음 → 'off'   : 대상 없는 전역 자동 재개 금지
 *  - '1'            → 'off'   : 완전 중지 (기존 kill-switch ON과 100% 동일)
 *  - JSON test 세션 → 지정 지원자의 새 인입만 auto, 대상 없는 호출은 off
 *  - 'draft'        → 'draft' : 코파일럿 — AI가 초안(message_drafts)만 만들고 발송·전이는 하지 않음
 *  - 그 외 손상값    → 'off'   : 불명확한 상태에서 자동응답을 임의 재개하지 않음
 *  - DB 조회 실패    → 'off'   : 저장된 중지 의도를 확인할 수 없으면 매니저 수동 응대로 전환
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

export type AgentTestSession = { mode: "test"; applicant_id: number; job_ids: number[]; started_at: string; expires_at: string };
export type AgentInboundScope = { applicantId: number; receivedAt: string; jobIds?: number[] };

export function isValidTestJobIds(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 3
    && value.every((id) => Number.isSafeInteger(id) && id > 0)
    && new Set(value).size === value.length;
}

export function parseAgentTestSession(body: string | null | undefined, now = Date.now()): AgentTestSession | null {
  try {
    const value = JSON.parse(body ?? "") as AgentTestSession;
    if (!value || value.mode !== "test" || !Number.isSafeInteger(value.applicant_id) || value.applicant_id <= 0 || !isValidTestJobIds(value.job_ids)) return null;
    const start = Date.parse(value.started_at), end = Date.parse(value.expires_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 30 * 60_000 || now < start || now >= end) return null;
    return { mode: "test", applicant_id: value.applicant_id, job_ids: value.job_ids, started_at: value.started_at, expires_at: value.expires_at };
  } catch { return null; }
}

function scopedMode(body: string | null | undefined, scope?: AgentInboundScope): AgentMode {
  const session = parseAgentTestSession(body);
  if (session && scope && scope.applicantId === session.applicant_id
    && scope.jobIds?.length && scope.jobIds.every((id) => session.job_ids.includes(id))) {
    const received = Date.parse(scope.receivedAt);
    if (received >= Date.parse(session.started_at) && received < Date.parse(session.expires_at) && received <= Date.now()) return "auto";
  }
  return parseAgentMode(body);
}

// 원문을 캐시한다. 특정 지원자의 auto 판정이 다른 지원자나 cron에 재사용되면 안 된다.
let cache: { body: string | null | undefined; at: number } | null = null;
const TTL_MS = 5_000; // 안전상 짧게 — 토글 후 5초 이내 반영

/** DB body 문자열 → 모드. API 라우트와 판정을 공유한다. */
export function parseAgentMode(body: string | null | undefined): AgentMode {
  const v = (body ?? "").trim();
  if (v === "draft") return "draft";
  return "off";
}

export async function getAgentMode(supabase: SupabaseClient, scope?: AgentInboundScope, fresh = false): Promise<AgentMode> {
  if (process.env.AGENT_DISABLED === "1") return "off";

  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return scopedMode(cache.body, scope);

  try {
    const { data, error } = await supabase
      .from("prompt_examples")
      .select("body")
      .eq("category", "system_message")
      .eq("title", "agent_kill_switch")
      .limit(2);
    if (error) {
      console.error("[kill-switch] query failed, treating as mode=off", error);
      return "off";
    }
    if ((data?.length ?? 0) > 1) {
      console.error("[kill-switch] duplicate control rows detected, treating as mode=off");
      cache = { body: "1", at: Date.now() };
      return "off";
    }
    const body = data?.[0]?.body as string | null | undefined;
    cache = { body, at: Date.now() };
    return scopedMode(body, scope);
  } catch (e) {
    console.error("[kill-switch] query failed, treating as mode=off", e);
    return "off";
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
