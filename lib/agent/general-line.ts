/**
 * 일반 배송 라인(도시락 등 recruit_mode='internal' 실공고) 판별 + 전용 지식 헬퍼.
 *
 * 배경: 기존 스크리닝 지식은 비마트(배민커넥트) 기준이다
 * (프로모션 5천원 · 08:00/16:00 배차 · 배민 앱 가입 온보딩).
 * internal 실공고(도시락 라인 등)는 프로세스가 다르다:
 *   체크: ①차종(공고 요건 대비) ②본인 명의 정산 ③시작 가능일 ④선탑 가능 요일·시간대
 *   통과 시: 배민 앱 가이드 대신 "매니저가 선탑(동승) 일정을 잡아 연락" 마무리 + 매니저 인계(paused).
 *
 * 시스템 공고(__baemin_system__/__danggeun_system__)와 external/both 공고는
 * 기존 비마트 흐름을 100% 유지한다 — 판별은 이 모듈의 isGeneralLineJob 하나로 단일화.
 */

import { isSystemJobTitle } from "../jobs";
import type { AgentState, JobContext, ScreeningChecklist } from "./types";

/** recruit_mode='internal' 실공고(시스템 더미 공고 제외)만 일반 라인 흐름을 탄다. */
export function isGeneralLineJob(
  job: Pick<JobContext, "title" | "recruit_mode"> | null | undefined
): boolean {
  if (!job) return false;
  if (isSystemJobTitle(job.title)) return false;
  return job.recruit_mode === "internal";
}

/**
 * 일반 라인에서 '해당 없음'으로 자동 true 처리하는 비마트 전용 안내 항목.
 * 체크리스트 스키마(7키)는 그대로 두고 프롬프트 레벨에서 항목을 재정의하는 설계 —
 * agent_state·UI 진행도(X/7)·set-stage·cron 로직에 파장이 없다.
 */
export const GENERAL_SCREENING_AUTO_TRUE: Partial<ScreeningChecklist> = {
  프로모션_종료가능성_안내: true,
  정산주기_안내: true,
  업무시간_체계_이해: true,
  공휴일_업무여부_확인: true,
};

/** 일반 라인 스크리닝 수집값 — agent_state.meta.general_screening에 저장. */
export interface GeneralScreeningCollected {
  차종?: string;
  시작가능일?: string;
  선탑_가능시간?: string;
  법인차_렌트_희망?: boolean;
}

/** meta에서 수집값 읽기 (없으면 빈 객체). */
export function readGeneralCollected(
  meta: AgentState["meta"] | null | undefined
): GeneralScreeningCollected {
  return (meta?.general_screening ?? {}) as GeneralScreeningCollected;
}

/** 이전 수집값에 이번 턴 수집값을 병합 — 빈 문자열로 기존 값을 지우지 않는다. */
export function mergeGeneralCollected(
  prev: GeneralScreeningCollected,
  update: GeneralScreeningCollected | undefined
): GeneralScreeningCollected {
  const next = { ...prev };
  if (!update) return next;
  if (update.차종?.trim()) next.차종 = update.차종.trim();
  if (update.시작가능일?.trim()) next.시작가능일 = update.시작가능일.trim();
  if (update.선탑_가능시간?.trim()) next.선탑_가능시간 = update.선탑_가능시간.trim();
  if (typeof update.법인차_렌트_희망 === "boolean") next.법인차_렌트_희망 = update.법인차_렌트_희망;
  return next;
}

/** 수집 항목(③시작 가능일 ④선탑 가능 시간대)이 채워졌는지 — advance 코드 가드. */
export function isGeneralCollectedComplete(c: GeneralScreeningCollected): boolean {
  return !!(c.시작가능일?.trim() && c.선탑_가능시간?.trim());
}

/** Slack 인계용 수집 요약 (본인명의는 체크리스트 통과가 전제라 '확인됨'으로 표기). */
export function buildGeneralCollectedSummary(c: GeneralScreeningCollected): string {
  return [
    `· 차종: ${c.차종?.trim() || "-"}`,
    "· 본인 명의 정산: 확인됨",
    `· 시작 가능일: ${c.시작가능일?.trim() || "-"}`,
    `· 선탑 가능 요일·시간대: ${c.선탑_가능시간?.trim() || "-"}`,
    `· 법인차 렌트 희망: ${c.법인차_렌트_희망 ? "예" : "아니오"}`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────
// 자동 발송 본문 폴백 (운영 문구는 prompt_examples system_message가 우선)
// ─────────────────────────────────────────────────────────────

/** exploration → screening 진입 시 첫 확인질문 묶음 (비마트 안내 묶음 대체). */
export function buildGeneralScreeningAnnouncement(name: string | null): string {
  const n = name ?? "지원자";
  return [
    `${n}님, 관심 감사합니다! 빠른 진행을 위해 몇 가지만 여쭤볼게요.`,
    "- 지금 운행하시는 차량(차종)이 어떻게 되세요?",
    "- 본인 명의로 정산 받으시는 데 문제는 없으실까요?",
    "편하게 답장 주세요 😊",
  ].join("\n");
}

/** 스크리닝 통과 시 인계 마무리 — 배민 앱 가이드 대체. 확정 뉘앙스 없음(연락 예고까지만). */
export function buildGeneralHandoffText(name: string | null): string {
  const n = name ?? "지원자";
  return `${n}님, 확인 감사합니다! 담당 매니저가 선탑(동승) 일정을 잡아 연락드릴게요 😊`;
}

/** prompt_examples category='knowledge' rows를 프롬프트 섹션으로 조립. 비어 있으면 빈 문자열. */
export function buildLineKnowledgeBlock(knowledge: string): string {
  const body = knowledge.trim();
  if (!body) return "";
  return [
    "",
    "## 일반 배송 라인 공통 FAQ — 공식 답변",
    "지원자가 아래 주제(정산·유류비·과태료·선탑·보험·법인차 렌트 등)를 물으면 이 내용 범위 안에서 직접 답해라 (pause 불필요).",
    "여기와 [현재 공고]에 없는 세부 수치·예외는 절대 추측하지 말고 매니저에게 인계(pause)해라.",
    "",
    body,
  ].join("\n");
}
