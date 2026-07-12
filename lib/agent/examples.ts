/**
 * 퓨샷 예시 + 사실 정보 로더 — Supabase에서 동적 로드.
 *
 * - prompt_examples.category='conversation' : 일반 대화 톤 (모든 stage) — 백엔드 전용, UI 비노출
 * - prompt_examples.category='facts'        : 공통 운영 정보 (전 지점 공통 — 정산·프로모션·업무시간 등)
 * - prompt_examples.category='knowledge'    : 일반 배송 라인 FAQ — internal 실공고 프롬프트에만 주입
 *                                             (비마트 흐름과 정산 주기 등이 달라 facts와 분리)
 * - branches.ai_facts                       : 지점별 AI 참고 정보 (자유 텍스트, 지점관리 탭에서 편집)
 *
 * 매니저가 admin UI에서 편집하면 다음 캐시 만료(60초) 이후 자동 반영.
 */

import { createServiceClient } from "@/lib/supabase";

interface CachedCategory {
  text: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CachedCategory>();

async function fetchCategory(category: "conversation" | "facts" | "knowledge"): Promise<string> {
  const cached = cache.get(category);
  if (cached && cached.expiresAt > Date.now()) return cached.text;

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("prompt_examples")
      .select("title, body, sort_order")
      .eq("category", category)
      .order("sort_order", { ascending: true });

    if (error) {
      console.error(`[agent/examples] supabase error for ${category}`, error);
      return cached?.text ?? "";
    }

    const text = (data ?? [])
      .map((row) => `[${row.title}]\n${row.body}`)
      .join("\n\n");

    cache.set(category, { text, expiresAt: Date.now() + CACHE_TTL_MS });
    return text;
  } catch (e) {
    console.error(`[agent/examples] exception for ${category}`, e);
    return cached?.text ?? "";
  }
}

export async function loadConversationExamples(): Promise<string> {
  return fetchCategory("conversation");
}

// 운영자 페르소나 — prompt_examples(category='agent_config', title='persona') 1행.
// body에는 구조화 JSON({role, instructions, tone, emoji})을 저장하고, 여기서 가독 텍스트로 조립한다.
let personaCache: CachedCategory | null = null;

function composePersona(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const o = JSON.parse(trimmed) as { role?: string; instructions?: string; tone?: string; emoji?: number };
    const lines: string[] = [];
    if (o.role?.trim()) lines.push(`역할: ${o.role.trim()}`);
    if (o.instructions?.trim()) lines.push(`핵심 지시사항:\n${o.instructions.trim()}`);
    if (o.tone?.trim()) lines.push(`어조: ${o.tone.trim()}`);
    if (typeof o.emoji === "number") {
      const level = o.emoji <= 20 ? "거의 사용 안 함" : o.emoji >= 70 ? "자주 사용" : "적당히 사용";
      lines.push(`이모지 사용 빈도: ${level}`);
    }
    return lines.join("\n\n");
  } catch {
    // 구버전/자유 텍스트 호환 — 그대로 가이드로 사용
    return trimmed;
  }
}

export async function loadPersonaGuidance(): Promise<string> {
  if (personaCache && personaCache.expiresAt > Date.now()) return personaCache.text;
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("prompt_examples")
      .select("body")
      .eq("category", "system_message")
      .eq("title", "__persona__")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[agent/examples] persona fetch error", error);
      return personaCache?.text ?? "";
    }
    const text = composePersona((data?.body as string | null) ?? "");
    personaCache = { text, expiresAt: Date.now() + CACHE_TTL_MS };
    return text;
  } catch (e) {
    console.error("[agent/examples] persona exception", e);
    return personaCache?.text ?? "";
  }
}

export async function loadFacts(): Promise<string> {
  return fetchCategory("facts");
}

/** 일반 배송 라인 FAQ(category='knowledge') — internal 실공고 프롬프트에서만 사용. */
export async function loadLineKnowledge(): Promise<string> {
  return fetchCategory("knowledge");
}

interface CachedBranchFacts {
  text: string;
  expiresAt: number;
}
const branchFactsCache = new Map<string, CachedBranchFacts>();

/**
 * 특정 지점의 ai_facts(branches 테이블) 로드. 캐시 60초.
 * branchName이 null/공백이면 빈 문자열 반환.
 */
async function loadBranchAiFacts(branchName: string | null | undefined): Promise<string> {
  const key = (branchName ?? "").trim();
  if (!key) return "";
  const cached = branchFactsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.text;
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("branches")
      .select("ai_facts")
      .eq("name", key)
      .maybeSingle();
    if (error) {
      console.error(`[agent/examples] branches.ai_facts fetch '${key}' error`, error);
      return cached?.text ?? "";
    }
    const text = (data?.ai_facts as string | null)?.trim() ?? "";
    branchFactsCache.set(key, { text, expiresAt: Date.now() + CACHE_TTL_MS });
    return text;
  } catch (e) {
    console.error(`[agent/examples] branches.ai_facts exception '${key}'`, e);
    return cached?.text ?? "";
  }
}

/**
 * 시스템 프롬프트 끝에 붙일 톤 가이드 블록.
 *
 * 운영자 페르소나(두뇌 탭 지시사항)도 '운영자 추가 지침' 섹션으로 포함한다
 * — 스크리닝/탐색/온보딩 stage 프롬프트에 반영되는 유일한 경로.
 *
 * @param branchName 지원자의 1지망 지점명 — 그 지점의 ai_facts를 별도 섹션으로 추가.
 *                   비어 있으면 공통 facts만 포함.
 * @param opts.includeCommonFacts false면 공통 운영 정보(facts) 섹션 생략 —
 *                   비마트 기준 정산·프로모션 정보라 일반 라인(internal 공고) 프롬프트를 오염시키기 때문.
 */
export async function buildToneGuide(
  branchName?: string | null,
  opts?: { includeCommonFacts?: boolean }
): Promise<string> {
  const includeCommonFacts = opts?.includeCommonFacts ?? true;
  const [conv, commonFacts, branchFacts, persona] = await Promise.all([
    loadConversationExamples(),
    includeCommonFacts ? loadFacts() : Promise.resolve(""),
    loadBranchAiFacts(branchName),
    loadPersonaGuidance(),
  ]);
  const lines = [
    "## 매니저 실제 대화 톤 — 반드시 모방",
    "아래는 매니저 홍석범이 실제로 지원자에게 보낸 메시지 모음이다.",
    "이 톤·길이·이모지·맞춤법(가벼운 오타 포함)·말투를 그대로 따라라.",
    "- 짧고 친근하게. 한 메시지에 1~2문장이 기본.",
    '- "네 선생님!", "감사합니다", "ㅎㅎ", "ㅠ", "^^" 같은 매니저 어투를 자연스럽게 섞어라.',
    "- 격식 차린 AI 말투 금지 (예: \"안녕하세요, 저는 ~입니다. 몇 가지 확인해 드릴게요!\" 같은 정형문 X).",
    "- 이모지는 매니저 예시처럼 가끔만. ☺️/😊 같은 풍부한 이모지 남발 금지.",
    "",
    "[예시 — 매니저 실제 메시지]",
    conv,
  ];

  if (commonFacts) {
    lines.push(
      "",
      "## 공통 운영 정보 (전 지점 공통)",
      "지원자가 질문하면 아래 정보 범위 안에서만 답해라.",
      "여기에 없는 사실(시급·시간대·인근 지하철역·시작일 등)은 추측하지 말고 매니저에게 인계해라.",
      "",
      commonFacts
    );
  }

  if (branchFacts && branchName) {
    lines.push(
      "",
      `## 📍 ${branchName} 지점 정보 (이 지원자 전용)`,
      "위 공통 정보와 다른 내용이 아래에 있으면 **이 지점 정보가 우선**이다.",
      "다른 지점의 사실은 절대 인용하거나 추측하지 마라.",
      "",
      branchFacts
    );
  }

  // 운영자 페르소나 — lib/agent.ts buildSystemPrompt와 동일한 섹션 형식. 비어 있으면 생략.
  if (persona) {
    lines.push(
      "",
      "## 운영자 추가 지침 (관리자 설정 — 안전 규칙은 유지하되 아래 톤·세부 지침을 우선 반영)",
      persona
    );
  }

  return lines.join("\n");
}

// 캐시 강제 무효화 (편집 직후 즉시 반영하고 싶을 때 사용)
export function invalidateExamplesCache(): void {
  cache.clear();
  branchFactsCache.clear();
  personaCache = null;
}
