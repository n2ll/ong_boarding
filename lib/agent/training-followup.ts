import { shouldSuppressConversationReply } from "./conversation-closing.ts";
import type { ConsultationObservation } from "./consultation-types";
import type { StageContext } from "./types";

const TRAINING = /선탑|동승|교육(?!비)/;
const QUESTION = /[?？]|(?:궁금|얼마|언제|몇\s*시|몇\s*시간)|(?:나요|까요|인가요|는지요)[.!\s]*$/;
const DECLINED = /(?:안\s*(?:할|하|해)|하지\s*않|못\s*(?:할|하|해)|어렵|보류|나중에)/;
const DAY = /평일|주말|[월화수목금토일]요일|오늘|내일|모레|다음\s*주|이번\s*주|\d{1,2}\s*일|\d{1,2}[/.]\d{1,2}/;
const TIME = /오전|오후|아침|저녁|점심|새벽|종일|아무\s*때|언제든|\d{1,2}\s*시(?!간)|\d{1,2}:\d{2}/;

/** 원문만 읽는다. 의사 표시/미정 메모를 가능 날짜·시간으로 만들지 않는다. */
export function trainingReplyEvidence(text: string, answeringTraining = false) {
  const active = TRAINING.test(text) || answeringTraining;
  const declined = active && DECLINED.test(text);
  const statement = active && !QUESTION.test(text) && !declined;
  const hasDate = statement && DAY.test(text);
  const hasTime = statement && TIME.test(text);
  const interested = statement && (hasDate || hasTime || /(?:하고|받고|참여하고|해보고)\s*싶|참여(?:를)?\s*(?:희망|원)|선탑(?:을|은)?\s*(?:희망|원|하겠|할게)|동승(?:을|은)?\s*(?:희망|원|하겠|할게)/.test(text));
  return { interested, declined, hasDate, hasTime };
}

export const TRAINING_FOLLOWUP_GUIDANCE = `
- 선탑 후속 질문에 본인이 명시한 참여 희망은 interest, 가능한 날짜·시간은 availability로 원문을 기록한다. 단순 "네"와 교육비·시간 질문은 참여 의사로 기록하지 마라. 가능 시간을 받았다는 이유만으로 pause하거나 선탑 일정을 잡았다고 말하지 마라. 서버가 등록된 선탑 안내와 아직 답하지 않은 후속 질문을 붙인다.`;

/** 검증된 상담 관찰 뒤에만 한 가지 다음 질문을 붙인다. 일정·전이·기록은 변경하지 않는다. */
export function buildTrainingFollowup(ctx: StageContext, verified: ConsultationObservation[], inboundText: string): string | null {
  if (!verified.length || shouldSuppressConversationReply(inboundText, ctx.history)) return null;
  if (QUESTION.test(inboundText) || /^(?:네|예|넵|알겠습니다|감사합니다)[\s,.!]*$/.test(inboundText.trim())) return null;
  const ids = [...new Set(verified.map((item) => item.job_id))];
  const jobs = ids.map((id) => ctx.consultation?.jobs.find((job) => job.job_id === id));
  if (jobs.some((job) => !job || job.expired || job.stage === "paused" || job.stage === "abort")) return null;
  const registered = jobs.map((job) => job!.ai_facts?.match(/^선탑·교육:[ \t]*([^\r\n]+)$/m)?.[1]?.trim());
  if (registered.some((value) => !value)) return null;
  const titles = jobs.map((job) => job!.title);
  const label = titles.map((title) => `‘${title}’`).join(", ");
  const current = trainingReplyEvidence(inboundText);
  if (current.declined) return null;

  let trainingContext = false;
  let interested = false;
  let declined = false;
  let hasDate = false;
  let hasTime = false;
  if (ids.length === 1 && ids[0] === ctx.job?.id) {
    const saved = (ctx.state.meta?.general_screening as { 선탑_가능시간?: unknown } | undefined)?.선탑_가능시간;
    if (typeof saved === "string") {
      const evidence = trainingReplyEvidence(saved, true);
      interested = evidence.interested; hasDate = evidence.hasDate; hasTime = evidence.hasTime;
    }
  }
  const previousQuestions: string[] = [];
  for (const turn of ctx.history) {
    if (turn.direction === "outbound") {
      const namesAnotherJob = ctx.consultation?.jobs.some((job) => !ids.includes(job.job_id) && turn.body.includes(job.title));
      if (TRAINING.test(turn.body) && (titles.some((title) => turn.body.includes(title)) || (ids.length === 1 && ids[0] === ctx.job?.id && !namesAnotherJob))) {
        trainingContext = /희망하시나요|가능[^?\n]*(?:알려|말씀|회신)|(?:날짜|시간대)[^?\n]*[?？]/.test(turn.body);
        previousQuestions.push(turn.body);
      } else if (/[?？]/.test(turn.body)) trainingContext = false;
      continue;
    }
    if (!trainingContext) continue;
    const evidence = trainingReplyEvidence(turn.body, true);
    interested ||= evidence.interested;
    if (evidence.declined) declined = true;
    hasDate ||= evidence.hasDate;
    hasTime ||= evidence.hasTime;
  }
  const latest = trainingReplyEvidence(inboundText, trainingContext);
  if (latest.declined || (declined && !current.interested)) return null;
  const alreadyComplete = hasDate && hasTime;
  interested ||= latest.interested;
  hasDate ||= latest.hasDate;
  hasTime ||= latest.hasTime;

  if (new Set(registered).size > 1) {
    const question = `${label}의 선탑 조건이 달라요. 어느 공고의 선탑부터 알아보시겠어요?`;
    return previousQuestions.some((text) => text.includes(question)) ? null : question;
  }
  if (hasDate && hasTime) {
    if (alreadyComplete) return null;
    return `${label}\n말씀하신 선탑 가능 시간은 매니저가 확인하고 문자나 전화로 일정을 조율할 예정입니다. 실제 교육 일시·첫 상차지·연결 프로는 매니저가 안내하며, 근무 배정은 별도로 확인합니다.`;
  }
  const question = !interested ? "선탑 참여를 희망하시나요?"
    : hasDate ? "선탑 가능한 시간대를 알려주시겠어요?"
    : hasTime ? "선탑 가능한 날짜를 알려주시겠어요?"
    : "선탑 가능한 날짜와 시간대를 알려주시겠어요?";
  if (previousQuestions.some((text) => text.includes(question))) return null;
  const facts = previousQuestions.some((text) => text.includes(registered[0]!)) ? "" : `${registered[0]}\n`;
  return `${label}\n${facts}${question}`;
}
