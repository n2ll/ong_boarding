/**
 * Claude API 사용량 기록 헬퍼.
 *
 * 모든 Claude 호출부(스크리닝/온보딩/탐색 에이전트, 배민 triage, 공고 생성/추출)가
 * 응답에서 받은 `usage` 블록을 이 헬퍼로 전달하면:
 *   1) `ai_usage_daily` 테이블에 (KST 기준 day, model, purpose)로 UPSERT — 비용 집계용
 *   2) (옵션) outbound 메시지 행에 함께 저장할 수 있는 형태로 가공해 반환
 *
 * KST 기준 day:
 *   Vercel 서버는 UTC라 그냥 toISOString().slice(0,10) 쓰면 한국 시각 자정~09:00 호출이
 *   '전날'로 떨어진다. 그래서 +9h 보정 후 YYYY-MM-DD 추출.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type UsagePurpose =
  | "screening"
  | "onboarding"
  | "exploration"
  | "active"
  | "triage"
  | "availability"
  | "job_generate"
  | "job_extract"
  | "recovery_healthcheck"
  | "improve";

/** messages 행에 박을 토큰 정보. usage 누락 시 null 필드 그대로. */
export interface MessageTokenColumns {
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read_tokens: number | null;
}

function kstDay(): string {
  const now = new Date();
  const kstMs = now.getTime() + 9 * 60 * 60 * 1000;
  return new Date(kstMs).toISOString().slice(0, 10);
}

/**
 * ai_usage_daily에 UPSERT.
 * Claude 응답에서 받은 usage가 비어있어도 call_count 1은 올린다 (실패 추적용).
 */
export async function recordUsage(
  supabase: SupabaseClient,
  opts: {
    model: string;
    purpose: UsagePurpose;
    usage: AnthropicUsage | null | undefined;
  }
): Promise<void> {
  const u = opts.usage ?? {};
  try {
    const { error } = await supabase.rpc("upsert_ai_usage_daily", {
      p_day: kstDay(),
      p_model: opts.model,
      p_purpose: opts.purpose,
      p_in: u.input_tokens ?? 0,
      p_out: u.output_tokens ?? 0,
      p_cache: u.cache_read_input_tokens ?? 0,
    });
    if (error) {
      console.error("[usage] upsert_ai_usage_daily error", error);
    }
  } catch (e) {
    console.error("[usage] recordUsage exception", e);
  }
}

/** Claude 응답의 usage를 messages 컬럼 형태로 가공. usage 없으면 모두 null. */
export function toMessageTokens(
  model: string,
  usage: AnthropicUsage | null | undefined
): MessageTokenColumns {
  if (!usage) {
    return { model: null, tokens_in: null, tokens_out: null, cache_read_tokens: null };
  }
  return {
    model,
    tokens_in: usage.input_tokens ?? 0,
    tokens_out: usage.output_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
  };
}
