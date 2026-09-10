import { classifyHandoff, getCategory, type HandoffCategory } from "../agent/handoff-category.ts";

export interface HandoffDispositionInput {
  paused_reason?: string | null;
  job_title?: string | null;
  agent_state?: unknown;
}

export interface HandoffDisposition {
  state: "action_required" | "intentional_pause" | "resolved";
  category: HandoffCategory;
  suggestedAction: string;
  holdLabel: string | null;
  holdReason: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const REVIEW_END_REASONS = new Set([
  "관리자 자동 응대 검수 종료",
  "본인 한정 자동 응대 검수 종료",
]);

/** 조회 전용 분류. 불명확한 중지나 오래된 완료 표식은 현재 처리할 일을 숨기지 않는다. */
export function getHandoffDisposition(input: HandoffDispositionInput): HandoffDisposition {
  const meta = record(record(input.agent_state).meta);
  const pause = record(meta.pause);
  const resolved = record(meta.handoff_resolved);
  const reason = input.paused_reason?.trim() ?? "";
  const title = input.job_title?.trim() ?? "";
  const manualStop = reason === "매니저 수동 일시정지";
  const directReplyStop = reason === "매니저 직접 응답 — 자동 전환";
  const crossJobValidation = /(?:복수|교차|공고별).*검증\s*실패/.test(reason);
  // 수동 중지 경로는 과거 meta.pause를 보존하므로 현재 시스템 사유가 더 정확하다.
  const category = manualStop
    ? getCategory("manual")
    : directReplyStop ? getCategory("auto")
    : typeof pause.category === "string" && pause.category
      ? getCategory(pause.category)
      : crossJobValidation ? getCategory("cross_job") : classifyHandoff(reason);
  const fallbackAction = category.id === "manual" || category.id === "auto"
    ? "대화에서 추가 문의를 확인하고 답변 또는 처리 완료"
    : category.id === "cross_job" && /검증\s*실패/.test(reason)
      ? "수신 원문과 공고별 조건·근거를 대조하고 공고별 답변을 확인해 직접 안내"
      : category.action;
  const suggestedAction = !manualStop && !directReplyStop && typeof pause.suggested_action === "string" && pause.suggested_action.trim()
    ? pause.suggested_action.trim()
    : fallbackAction;
  const result: HandoffDisposition = {
    state: "action_required", category, suggestedAction, holdLabel: null, holdReason: null,
  };

  const pausedAt = typeof meta.paused_at === "string" ? Date.parse(meta.paused_at) : NaN;
  const resolvedAt = typeof resolved.at === "string" ? Date.parse(resolved.at) : NaN;
  // 기존 처리 완료 API는 legacy 후보의 paused_at을 채우지 않는다. 중지 시각이 없으면
  // 유효한 완료 시각만으로 인정하되, 명시적 오류 시각이나 이후 재인계는 숨기지 않는다.
  // 완료 객체 자체에 at이 없으면 완료 여부를 입증할 수 없어 처리 필요로 남긴다.
  if (Number.isFinite(resolvedAt) && (meta.paused_at == null || (Number.isFinite(pausedAt) && resolvedAt >= pausedAt))) {
    return { ...result, state: "resolved" };
  }
  if (manualStop) {
    return { ...result, state: "intentional_pause", holdLabel: "수동 중지", holdReason: "매니저가 자동 응대를 직접 중지한 상태입니다." };
  }
  if (REVIEW_END_REASONS.has(reason)) {
    return { ...result, state: "intentional_pause", holdLabel: "검수 종료", holdReason: "자동 응대 검수를 마치고 중지한 대화입니다." };
  }
  // 일반 공고의 '테스트' 단어나 지원자 이름을 검수 근거로 삼지 않는다.
  if (/^\[검수(?:\s+\d+)?\]/.test(title) || /^\[운영 검증\].*E2E\s+테스트/.test(title)) {
    return { ...result, state: "intentional_pause", holdLabel: "검수 공고", holdReason: "공고 제목에 검수용 표시가 있는 대화입니다." };
  }
  return result;
}
