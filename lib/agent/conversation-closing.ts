import type { ConversationTurn } from "./types";

const ACKNOWLEDGEMENT = /^(?:(?:네|넵|넹|예|옙|응|알겠습니다|알겠어요|감사합니다|감사해요|감사|고맙습니다|고마워요|수고하세요|수고하셨습니다)[\s,.!~^♡♥]*)+$/;

function asksForAnswer(text: string): boolean {
  return /[?？]|(?:나요|까요|가요|습니까|실래요|겠어요|어때요|인지요)|(?:어떤|어떻게|언제|어디|무엇|몇|얼마)|(?:가능|괜찮|동의)[\s\S]{0,8}(?:세요|신지)|(?:알려|말씀|답장|회신|보내|확인|선택|기재|입력|작성|답변)[\s\S]{0,16}(?:주|부탁|바랍니다)|부탁(?:합니다|드립니다)/.test(text);
}

function explicitlyCloses(text: string): boolean {
  if (asksForAnswer(text)) return false;
  return /(?:대화|상담|얘기|이야기)는?\s*(?:이제\s*)?(?:그만|끝|여기까지)|(?:오늘은?|지금은?)\s*여기까지|(?:그만할게요|그만하겠습니다)|(?:제가|나중에|다음에|다시)[\s\S]{0,12}(?:연락|전화|말씀|이야기|얘기)\s*(?:드릴게요|드리겠습니다|할게요|하겠습니다)|^(?:네\s*)?(?:나중에|다음에)(?:요|할게요|하겠습니다)?[\s.!~]*$/.test(text);
}

/**
 * 발송만 억제한다. 같은 문자에 담긴 날짜·거절·동의와 상담 관찰은 기존 stage가 처리한다.
 * '그만' 단독의 기존 수신거부 계약은 router의 opt-out 가드가 먼저 처리한다.
 */
export function shouldSuppressConversationReply(text: string, history: ConversationTurn[]): boolean {
  const clean = text.trim();
  if (explicitlyCloses(clean)) return true;
  if (!ACKNOWLEDGEMENT.test(clean)) return false;

  // 침묵 뒤 이어진 감사도 마지막 실제 안내/종료 의사를 기준으로 판단한다.
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.direction === "outbound") return !asksForAnswer(turn.body);
    if (explicitlyCloses(turn.body)) return true;
    if (!ACKNOWLEDGEMENT.test(turn.body.trim())) return false;
  }
  return false;
}


export const CONVERSATION_CLOSING_GUIDANCE = `## 대화 종료와 짧은 확인 답장
- "오늘은 여기까지", "나중에", "제가 연락드릴게요"처럼 대화를 끝내려는 뜻이면 추가 질문이나 인사 답장을 붙이지 말고 reply_text를 비워라. 종료 자체만으로 지원 철회(abort), 매니저 인계(pause), 문자 수신거부, 동의 변경을 만들지 말고 stay를 유지한다.
- 같은 문자에 보낸 가능 날짜·차종·답변·명시적인 공고 거절은 별도로 처리한다. 종료 의사 때문에 실제 정보를 버리거나, 정보 수집을 근무 확정으로 바꾸지 않는다.
- 마지막 안내 뒤 "네", "감사합니다"만 오면 다시 질문하거나 인사를 반복하지 않는다. 직전 실제 질문에 대한 답·동의·거절은 정상 처리하고, 새 실질 질문이 오면 그 질문에 답한다.
- "그만" 단독 등 문자 수신거부는 별도의 수신거부 정책을 따른다. 대화를 잠시 마치는 말과 구분한다.`;


const PURE_CLOSING = /^(?:(?:네|감사합니다|고맙습니다)[\s,.!~]*)?(?:나중에요?|다음에요?|제가\s*(?:다시\s*)?연락\s*(?:드릴게요|드리겠습니다)|오늘은?\s*여기까지\s*(?:할게요|하겠습니다)?|대화는?\s*그만\s*(?:할게요|하겠습니다))[\s.!~]*$/;

/** 새 정보가 전혀 없는 종료만 생략한다. 앞서 연달아 온 미처리 답변이 있으면 stage에 남긴다. */
export function canSkipConversationProcessing(text: string, history: ConversationTurn[]): boolean {
  if (!shouldSuppressConversationReply(text, history)) return false;
  const isPure = (value: string) => ACKNOWLEDGEMENT.test(value.trim()) || PURE_CLOSING.test(value.trim());
  if (!isPure(text)) return false;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].direction === "outbound") break;
    if (!isPure(history[i].body)) return false;
  }
  return true;
}
