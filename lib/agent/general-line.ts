/**
 * 일반 배송 라인(비마트 외 실제 공고) 판별 + 전용 지식 헬퍼.
 *
 * 배경: 기존 스크리닝 지식은 비마트(배민커넥트) 기준이다
 * (프로모션 5천원 · 08:00/16:00 배차 · 배민 앱 가입 온보딩).
 * 비마트 외 실제 공고(도시락 라인 등)는 프로세스가 다르다:
 *   체크: ①차종(공고 요건 대비) ②본인 명의 정산 ③시작 가능일 ④선탑 가능 요일·시간대
 *   통과 시: 배민 앱 가이드 대신 "매니저가 선탑(동승) 일정을 잡아 연락" 마무리 + 매니저 인계(paused).
 *
 * 시스템 공고(__baemin_system__/__danggeun_system__)는 레거시 비마트 흐름을 유지한다.
 * 실제 공고는 모집 채널(recruit_mode)이 아니라 화주사 유형으로 판별하며,
 * 명시적 baemin_bmart만 비마트 흐름을 쓴다.
 */

import { isSystemJobTitle } from "../jobs.ts";
import type { AgentState, JobContext, ScreeningChecklist, StageContext } from "./types";

/** Supabase의 단일 FK 관계가 객체/배열 어느 형태로 와도 client_type을 안전하게 꺼낸다. */
export function joinedClientType(relation: unknown): string | null {
  const value = Array.isArray(relation) ? relation[0] : relation;
  if (!value || typeof value !== "object") return null;
  const clientType = (value as { client_type?: unknown }).client_type;
  return typeof clientType === "string" ? clientType : null;
}

/** 시스템 공고는 레거시, 실제 공고는 명시적 baemin_bmart만 비마트 흐름을 탄다. */
export function isGeneralLineJob(
  job: Pick<JobContext, "title" | "client_type"> | null | undefined
): boolean {
  if (!job) return false;
  if (isSystemJobTitle(job.title)) return false;
  return job.client_type !== "baemin_bmart";
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
  /**
   * 근무 가능 시간대(4슬롯 정규 키) — 대화 중 자연스럽게 확인되면 채운다. **필수 아님**(advance 조건에 넣지 않는다).
   * 실데이터 645명 중 237명은 시간대가 미확인이고(값이 '~' 한 글자이거나 야간·새벽), 파서로는 채울 수 없다.
   * 여기서 채운 값은 applicants.available_slots로 승격돼 노출 규칙 '희망 시간대' 축에 쓰인다.
   */
  가능시간대?: string[];
}

/** 4슬롯 정규 키 — DB CHECK 제약과 같은 집합(자유 문자열이 들어오면 저장이 실패한다). */
const VALID_SLOT_KEYS = ["평일오전", "평일오후", "주말오전", "주말오후"];

/** AI가 준 시간대 값에서 정규 키만 남긴다(공백형 '평일 오전'도 흡수). 빈 배열이면 수집 없음. */
export function normalizeCollectedSlots(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const k = raw.replace(/\s/g, "");
    if (VALID_SLOT_KEYS.includes(k)) out.add(k);
  }
  return [...out];
}

/** meta에서 수집값 읽기 (없으면 빈 객체). */
export function readGeneralCollected(
  meta: AgentState["meta"] | null | undefined
): GeneralScreeningCollected {
  return (meta?.general_screening ?? {}) as GeneralScreeningCollected;
}

/** 참여 의사나 확인 대기 표시는 실제 선탑 가능 시간으로 저장·완료 처리하지 않는다. */
function hasTrainingAvailability(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  const pending = /미정|미확인|대기|확인\s*필요/;
  if (!pending.test(value)) return true;
  // "화요일 오전 가능, 정확한 날짜 미정"처럼 이미 답한 범위는 지우지 않는다.
  return value.split(/[,;，\n()]/).some((part) => !pending.test(part)
    && /평일|주말|[월화수목금토일]요일|오전|오후|\d{1,2}\s*(?:월|일|시)|\d{1,2}\/\d{1,2}/.test(part));
}

/** 이전 수집값에 이번 턴 수집값을 병합 — 빈 문자열로 기존 값을 지우지 않는다. */
export function mergeGeneralCollected(
  prev: GeneralScreeningCollected,
  update: GeneralScreeningCollected | undefined
): GeneralScreeningCollected {
  const next = { ...prev };
  if (!hasTrainingAvailability(next.선탑_가능시간)) delete next.선탑_가능시간;
  if (!update) return next;
  if (update.차종?.trim()) next.차종 = update.차종.trim();
  if (update.시작가능일?.trim()) next.시작가능일 = update.시작가능일.trim();
  if (hasTrainingAvailability(update.선탑_가능시간)) next.선탑_가능시간 = update.선탑_가능시간.trim();
  if (typeof update.법인차_렌트_희망 === "boolean") next.법인차_렌트_희망 = update.법인차_렌트_희망;
  const slots = normalizeCollectedSlots(update.가능시간대);
  if (slots.length) next.가능시간대 = slots;
  return next;
}

/**
 * 수집 항목(③시작 가능일 ④선탑 가능 시간대)이 채워졌는지 — advance 코드 가드.
 * ⚠️ `가능시간대`(근무 가능 시간대)는 **여기 넣지 않는다** — 못 받아도 진행에 지장이 없어야 한다(사장님 결정).
 */
export function isGeneralCollectedComplete(c: GeneralScreeningCollected): boolean {
  return !!c.시작가능일?.trim() && hasTrainingAvailability(c.선탑_가능시간);
}

/** Slack 인계용 수집 요약 (본인명의는 체크리스트 통과가 전제라 '확인됨'으로 표기). */
export function buildGeneralCollectedSummary(c: GeneralScreeningCollected): string {
  return [
    `· 차종: ${c.차종?.trim() || "-"}`,
    "· 본인 명의 정산: 확인됨",
    `· 시작 가능일: ${c.시작가능일?.trim() || "-"}`,
    `· 선탑 가능 요일·시간대: ${c.선탑_가능시간?.trim() || "-"}`,
    `· 근무 가능 시간대: ${c.가능시간대?.length ? c.가능시간대.join(", ") : "-"}`,
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

/** 스크리닝 통과 시 인계 마무리 — 배민 앱 가이드 대체. 보수적 톤:
 *  일정을 "잡아드린다" 약속 금지(매니저 확인 후 연락 예고까지만) + 선탑≠투입 확정 명시. */
export function buildGeneralHandoffText(name: string | null): string {
  const n = name ?? "지원자";
  return `${n}님, 확인 감사합니다!\n말씀 주신 내용은 담당 매니저에게 전달해 둘게요.\n매니저가 확인 후 연락드릴 예정이에요 😊\n\n참고로 선탑(동승)은 현장을 미리 보는 단계라, 진행하시더라도 바로 투입 확정은 아니에요.`;
}

type CalendarDay = { month: number | null; day: number };

/** 날짜만 읽는다. 주차를 날짜로 환산하거나 시간 범위를 날짜로 해석하지 않는다. */
function calendarDays(text: string): CalendarDay[] {
  const normalized = text
    .replace(/\b\d{4}[-/.](\d{1,2})[-/.](\d{1,2})\b/g, "$1/$2")
    .replace(/(\d{1,2})\s*월\s*(\d{1,2})/g, "$1/$2");
  const dates: CalendarDay[] = [];
  const pattern = /(\d{1,2})\/(\d{1,2})\s*일?\s*[~∼–-]\s*(?:(\d{1,2})\/)?(\d{1,2})\s*일?|(\d{1,2})\s*일?\s*[~∼–-]\s*(\d{1,2})\s*일|(\d{1,2})\/(\d{1,2})\s*일?|(\d{1,2})\s*일/g;
  for (const match of normalized.matchAll(pattern)) {
    if (match[1]) dates.push({ month: Number(match[1]), day: Number(match[2]) }, { month: Number(match[3] ?? match[1]), day: Number(match[4]) });
    else if (match[5]) dates.push({ month: null, day: Number(match[5]) }, { month: null, day: Number(match[6]) });
    else dates.push({ month: match[7] ? Number(match[7]) : null, day: Number(match[8] ?? match[9]) });
  }
  return dates;
}

/** 일반 라인의 선탑 가능일 질문에 백업 날짜·주차 환산 날짜가 섞이면 열린 질문으로 돌린다. */
export function guardGeneralTrainingDateQuestion(reply: string, ctx: StageContext, inboundText: string): string {
  if (!isGeneralLineJob(ctx.job)) return reply;
  const training = /선탑|동승|교육/;
  const priorOutbound = [...ctx.history].reverse().find((turn) => turn.direction === "outbound")?.body ?? "";
  if (!training.test(`${reply}\n${inboundText}\n${priorOutbound}`)) return reply;

  // 배송 시작일이나 과거 AI가 먼저 제안한 날짜는 선탑 날짜의 근거가 아니다.
  const trainingFacts = ctx.job?.ai_facts?.match(/^선탑·교육:[ \t]*([^\r\n]+)$/m)?.[1] ?? "";
  const duration = trainingFacts.match(/(?:약\s*)?\d+(?:\.\d+)?\s*시간(?:\s*(?:전후|정도))?/)?.[0];
  const evidence = [
    ...trainingFacts.split(/[.!?。！？]+/).filter((part) => !/백업|근무|정산|교육비|지급|환산|추측/.test(part)),
    readGeneralCollected(ctx.state.meta).선탑_가능시간 ?? "",
  ];
  if ((training.test(inboundText) || training.test(priorOutbound)) && !/백업|근무/.test(inboundText)) evidence.push(inboundText);
  const supported = evidence.flatMap(calendarDays);
  const corrected = reply.split(/((?<=[.!?。！？])\s+|\n+)/).map((sentence) => {
    if (!training.test(sentence) && /백업|근무|배송/.test(sentence)) return sentence;
    if (!/(?:가능|괜찮).*(?:[?？]|알려|말씀|회신|부탁)|(?:날짜|일정).*(?:알려|말씀|회신|부탁)/.test(sentence)) return sentence;
    const unsupported = calendarDays(sentence).some((date) => !supported.some((known) =>
      known.day === date.day && (date.month === null || date.month === known.month),
    ));
    if (!unsupported) return sentence;
    const durationText = duration && sentence.match(/\d+(?:\.\d+)?\s*시간/g)?.some((value) =>
      value.replace(/\s/g, "") === duration.replace(/약|전후|정도|\s/g, ""),
    )
      ? `예상 소요시간은 ${duration}입니다. ` : "";
    return `${durationText}선탑 가능한 날짜와 시간대를 알려주시겠어요?`;
  });
  return corrected.join("");
}

const TRAINING_GUIDE = `
## 선탑·동승교육 안내 순서
- 선탑 대상은 공고별 기준을 따른다. 일정 조율은 매니저가 투입을 확정했거나 선탑 참여 의사가 명확한 지원자 중심이며, 단순 관심·짧은 "네"·교육비 질문만으로 강한 선탑 의사를 인정하지 마라.
- 먼저 공고에 적힌 교육 목적(앱 사용과 배송 업무 파악 등)을 짧게 설명하고 참여 의사를 확인하라. 목적 설명 없이 날짜·시간부터 요구하지 마라. 지원자가 먼저 소요시간·교육비를 질문하면 그 질문에 먼저 답하라.
- 참여를 명확히 희망하면 공고에 등록된 예상 소요시간을 안내하고 "선탑 가능한 날짜와 시간대를 알려주시겠어요?"처럼 본인이 말하도록 열린 질문을 하라. 특정 날짜·시간을 제안해 동의를 유도하지 마라. 대화나 수집값에 이미 있는 날짜·시간대는 다시 묻지 말고 빠진 정보만 확인하라.
- 소요시간이 미등록이면 확인 후 안내한다고 말하고 시간을 추측하지 마라. 배송 근무시간을 교육시간으로 대신 쓰거나 동승교육 기간을 하루로 단정하지 마라. 조건을 확인해야 답할 수 있다는 지원자에게 계속 가능 시간을 요구하지 마라.
- 공고에 유사한 다른 라인에서 교육할 수 있다고 명시돼 있으면 그 점도 안내하라. 실제 백업할 라인·같은 배송지에서 교육한다고 약속하지 마라. 통상 시작 시간이나 공고 운행시간으로 구체적인 교육 시작 시각을 정하지 마라.
- 교육 당일에는 실제 교육 라인의 첫 상차지에서 연결된 옹고잉 프로와 만난다. 매니저가 정확한 일시·장소·프로 연결을 안내하기 전에는 현재 공고 주소를 확정 접선지로 안내하거나 교육 참석·예약을 약속하지 마라.
- 교육비·합산 지급·정산일은 해당 공고에 적힌 값으로 답하라. 교육만 받고 백업하지 않은 경우의 지급 조건이 없으면 임의로 지급·미지급을 약속하지 마라.
- 선탑 후 백업 진행 여부는 지원자가 선택한다. 거절·보류에는 설득하거나 같은 질문을 반복하지 마라. 단순 참여 긍정은 시간대 확인이나 선탑 참석 완료가 아니다. 선탑과 근무 배정은 매니저가 최종 조율한다.
`;

/** 공통 FAQ와 선탑 안내 순서. FAQ가 비어도 추측 방지 규칙은 유지한다. */
export function buildLineKnowledgeBlock(knowledge: string): string {
  const body = knowledge.trim();
  return [
    "",
    "## 일반 배송 라인 공통 FAQ — 공식 답변",
    "지원자가 아래 주제(정산·유류비·과태료·선탑·보험·법인차 렌트 등)를 물으면 이 내용 범위 안에서 직접 답해라 (pause 불필요).",
    "여기와 [현재 공고]에 없는 세부 수치·예외는 절대 추측하지 말고 매니저에게 인계(pause)해라.",
    "",
    body,
    TRAINING_GUIDE,
  ].join("\n");
}
