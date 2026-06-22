/**
 * 체크리스트 헬퍼 — 초기화·병합·진행도 계산.
 */

import type {
  AgentState,
  OnboardingChecklist,
  ScreeningChecklist,
  StageName,
} from "./types";

export const SCREENING_KEYS: (keyof ScreeningChecklist)[] = [
  "자차_재확인",
  "프로모션_종료가능성_안내",
  "정산주기_안내",
  "공휴일_업무여부_확인",
  "본인명의_정산_문제없음",
  "업무시간_체계_이해",
  "지원자_질문_해소",
];

export const ONBOARDING_KEYS: (keyof OnboardingChecklist)[] = [
  "앱설치_교육_안내발송됨",
  "배민_아이디_수신",
  "만남장소_안내발송됨",
];

export function emptyScreening(): ScreeningChecklist {
  return SCREENING_KEYS.reduce((acc, k) => {
    acc[k] = false;
    return acc;
  }, {} as ScreeningChecklist);
}

export function emptyOnboarding(): OnboardingChecklist {
  return ONBOARDING_KEYS.reduce((acc, k) => {
    acc[k] = false;
    return acc;
  }, {} as OnboardingChecklist);
}

/**
 * 기존 state에 update를 deep-merge해 새 state를 만든다.
 * - 단순 객체 1단계 깊이까지만 (체크리스트 구조는 평면이라 충분)
 */
export function mergeAgentState(prev: AgentState, update: AgentState): AgentState {
  return {
    screening: { ...(prev.screening ?? {}), ...(update.screening ?? {}) },
    onboarding: { ...(prev.onboarding ?? {}), ...(update.onboarding ?? {}) },
    meta: { ...(prev.meta ?? {}), ...(update.meta ?? {}) },
  };
}

/** 현재 단계 체크리스트의 진행도. UI 배지 (예: "4/8")용 */
export function progress(state: AgentState, stage: StageName): { done: number; total: number } {
  if (stage === "screening") {
    const cl = { ...emptyScreening(), ...(state.screening ?? {}) };
    const done = SCREENING_KEYS.filter((k) => cl[k] === true).length;
    return { done, total: SCREENING_KEYS.length };
  }
  if (stage === "onboarding") {
    const cl = { ...emptyOnboarding(), ...(state.onboarding ?? {}) };
    const done = ONBOARDING_KEYS.filter((k) => cl[k] === true).length;
    return { done, total: ONBOARDING_KEYS.length };
  }
  return { done: 0, total: 0 };
}

/** 모든 항목 체크됐는지 — advance 트리거 판정 */
export function isComplete(state: AgentState, stage: StageName): boolean {
  const p = progress(state, stage);
  return p.total > 0 && p.done === p.total;
}
