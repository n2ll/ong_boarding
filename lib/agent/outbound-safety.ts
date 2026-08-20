export type AutomatedOutboundSafetyViolation = {
  kind: "confirmation" | "identity_document" | "mandatory_preparation";
  match: string;
};

/** 매니저가 검토 후 직접 보내는 사전 준비 빠른 답변. */
export const PRECONFIRMATION_ONBOARDING_TEMPLATE = `#{이름}님, 아래 내용은 희망하실 경우 미리 준비하실 수 있는 선택 안내입니다. 앱 설치·교육·아이디 회신은 채용이나 근무 배정 확정을 의미하지 않습니다.
1. 배민 커넥트 앱 설치 후 가입(선택)
2. 안전보건교육 영상(2시간) 미리 시청(선택)
3. 준비하신 경우 앱 아이디 회신`;

export const PRECONFIRMATION_ONBOARDING_REMINDER_TEMPLATE = `#{이름}님, 앱 설치·교육·아이디 회신은 선택 사항이며 채용이나 근무 배정 확정을 의미하지 않습니다.
사전 준비를 선택하셨고 완료하셨다면 앱 아이디를 회신해주세요. 아직 준비하지 않으셨다면 나중에 하셔도 괜찮습니다.`;

/** 신분증 이미지를 SMS로 수집하지 않도록 안내하는 빠른 답변. */
export const PRIVACY_SAFE_ID_DOCUMENT_TEMPLATE = `#{이름}님, 개인정보 보호를 위해 신분증 사진은 문자로 보내지 마세요. 필요할 경우 담당 매니저가 승인된 제출 방법을 별도로 안내드리겠습니다.`;

const CONFIRMATION_NUANCE_PATTERNS: RegExp[] = [
  /근무\s*(?:가|이|를)?\s*확정/,
  /확정\s*(?:됐|되었|되셨|완료|입니다|이에요|했어요|했습니다)/,
  /배정\s*(?:이|을|가)?\s*(?:완료|됐|되었|드렸|해\s*드)/,
  /채용\s*(?:됐|되었|되셨|완료|결정)/,
  /선정\s*(?:됐|되었|되셨|완료)/,
  /투입\s*예정/,
  /(?:내일|모레|다음\s*주|이번\s*주)\s*부터\s*(?:출근|근무|나오|나와)/,
  /(?:근무|출근)\s*시작\s*(?:하시면|하세요|합니다)/,
  /출근\s*(?:지시|하세요|해\s*주세요|하시면\s*됩니다)/,
  /합격\s*(?:하셨|입니다|이에요|이십니다)/,
];

const SENTENCE_BREAK = /[\n.!?。！？]+/;

function isNegatedInSentence(sentence: string, matchIndex: number, matchLength: number): boolean {
  const suffix = sentence.slice(matchIndex + matchLength, matchIndex + matchLength + 32);
  return /^.{0,24}(?:아니|아닙|않|없|미정|정해지지|확정되지)/.test(suffix);
}

export function detectConfirmationNuance(text: string): string | null {
  for (const sentence of text.split(SENTENCE_BREAK)) {
    for (const pattern of CONFIRMATION_NUANCE_PATTERNS) {
      const match = pattern.exec(sentence);
      if (match && !isNegatedInSentence(sentence, match.index, match[0].length)) {
        return match[0];
      }
    }
  }
  return null;
}

function detectIdentityDocumentImageRequest(text: string): string | null {
  for (const sentence of text.split(SENTENCE_BREAK)) {
    if (!/(?:신분증|주민등록증|운전면허증|외국인등록증)/.test(sentence)) continue;
    if (!/(?:사진|이미지|사본|스캔|앞면|뒷면|앞뒤|촬영|찍)/.test(sentence)) continue;

    // "문자로 보내지 마세요" 같은 금지 안내 자체는 요청으로 보지 않는다.
    const withoutWarnings = sentence.replace(
      /(?:보내|전송|회신|첨부|제출)\s*지\s*마(?:세요|십시오|시고|라)?/g,
      ""
    );
    const request = /(?:회신|보내\s*(?:주세요|세요|주십시오)|보내주시|공유\s*(?:해\s*)?주세요|전송|첨부|제출|찍어\s*주세요|부탁드립니다)/.exec(withoutWarnings);
    if (request) return request[0];
  }
  return null;
}

const PREPARATION_TOPIC = /(?:앱[^\n.!?]{0,16}(?:설치|가입|아이디[^\n.!?]{0,8}(?:확인|회신))|안전보건교육|교육\s*영상|영상\s*(?:교육|시청)|아이디[^\n.!?]{0,8}(?:확인|회신))/;
const MANDATORY_PREPARATION = /(?:반드시|필수|필요|해\s*주세요|해주세요|(?:보내|공유|제출)\s*(?:해\s*)?주세요|보내세요|부탁드립니다|회신\s*부탁)/;
const OPTIONAL_PREPARATION = /(?:선택\s*(?:사항|안내)?|원하실\s*경우|희망하실\s*경우|미리\s*준비하실\s*수)/;
const NON_CONFIRMATION_DISCLOSURE =
  /(?:(?:채용|근무|업무)[^\n.!?]{0,28}(?:확정|배정)[^\n.!?]{0,20}(?:아니|의미하지)|(?:확정|배정)[^\n.!?]{0,28}(?:의미하지|아니))/;

function detectMandatoryPreparation(text: string): string | null {
  for (const sentence of text.split(SENTENCE_BREAK)) {
    if (!PREPARATION_TOPIC.test(sentence)) continue;
    const mandatory = MANDATORY_PREPARATION.exec(sentence);
    if (!mandatory || OPTIONAL_PREPARATION.test(sentence)) continue;
    const suffix = sentence.slice(mandatory.index + mandatory[0].length, mandatory.index + mandatory[0].length + 16);
    if (!/^.{0,6}(?:하지|아니|아닙|않|없)/.test(suffix)) return mandatory[0];
  }
  return null;
}

/** 확정 전 앱·교육 안내가 선택 사항과 비확정 안내를 모두 담는지 확인한다. */
export function detectPreconfirmationGuideSafetyViolation(
  text: string
): AutomatedOutboundSafetyViolation | null {
  const outboundViolation = detectAutomatedOutboundSafetyViolation(text);
  if (outboundViolation) return outboundViolation;

  if (PREPARATION_TOPIC.test(text) && (!OPTIONAL_PREPARATION.test(text) || !NON_CONFIRMATION_DISCLOSURE.test(text))) {
    return { kind: "mandatory_preparation", match: "사전 준비 선택·비확정 안내 누락" };
  }
  return null;
}

/** 운영 DB 문구가 안전 계약을 어기면 검증된 코드 폴백만 사용한다. 둘 다 위험하면 발송하지 않는다. */
export function resolvePreconfirmationGuideText(
  stored: string | null,
  fallback: string
): string | null {
  const candidate = stored?.trim() || fallback;
  if (!detectPreconfirmationGuideSafetyViolation(candidate)) return candidate;
  return detectPreconfirmationGuideSafetyViolation(fallback) ? null : fallback;
}

export function buildSafePreconfirmationOnboardingGuide(
  stored: string | null,
  fallback: string,
  deadline: string
): string | null {
  const base = resolvePreconfirmationGuideText(stored, fallback);
  if (!base) return null;
  const guide = base.includes(deadline)
    ? base
    : `${base}\n\n사전 준비를 선택하셨다면 ${deadline}까지 앱 아이디를 회신해주세요. 어려우시면 나중에 준비하셔도 됩니다.`;
  return detectPreconfirmationGuideSafetyViolation(guide) ? null : guide;
}

/**
 * AI와 pre-confirmation 시스템 자동 메시지의 최종 발송 직전 백스톱.
 * 매니저가 검토해 직접 보내는 수동 발송에는 적용하지 않는다.
 */
export function detectAutomatedOutboundSafetyViolation(
  text: string
): AutomatedOutboundSafetyViolation | null {
  const identityDocument = detectIdentityDocumentImageRequest(text);
  if (identityDocument) return { kind: "identity_document", match: identityDocument };

  const confirmation = detectConfirmationNuance(text);
  if (confirmation) return { kind: "confirmation", match: confirmation };

  const mandatoryPreparation = detectMandatoryPreparation(text);
  if (mandatoryPreparation) {
    return { kind: "mandatory_preparation", match: mandatoryPreparation };
  }

  return null;
}

/**
 * 편집 가능한 자동 발송 문구는 치환까지 끝난 최종 문자열을 검사한다.
 * DB 문구가 위험하면 검증된 코드 폴백을 쓰고, 폴백도 위험하면 발송하지 않는다.
 */
export function resolveAutomatedOutboundText(
  stored: string | null,
  fallback: string,
): string | null {
  const candidate = stored?.trim() || fallback.trim();
  if (candidate && !detectAutomatedOutboundSafetyViolation(candidate)) return candidate;

  const safeFallback = fallback.trim();
  return safeFallback && !detectAutomatedOutboundSafetyViolation(safeFallback)
    ? safeFallback
    : null;
}

/** 매니저 수동 확정 안내는 허용하되, 신분증 이미지는 문자로 수집하지 않는다. */
export function detectManualOutboundSafetyViolation(
  text: string
): AutomatedOutboundSafetyViolation | null {
  const identityDocument = detectIdentityDocumentImageRequest(text);
  return identityDocument
    ? { kind: "identity_document", match: identityDocument }
    : null;
}
