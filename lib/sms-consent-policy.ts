export type SmsCategory = "operational" | "promotional" | "unknown";
export type SmsSendBlockReason =
  | "opt_out"
  | "consent_required"
  | "recipient_unverified"
  | "unknown_category";

const PROMOTIONAL_BULK_PURPOSES = new Set(["new_job", "campaign"]);

export const CURRENT_JOB_WAITLIST_SMS_BODY = `#{이름}님, 관심 감사합니다. 현재 순차적으로 안내드리고 있어요. 자리가 정리되는 대로 먼저 연락드릴게요! (안내 중단: '그만' 회신)`;

export const CURRENT_JOB_CLOSED_SMS_TEMPLATE = `#{이름}님, '#{공고명}'에 관심 가져주시고 함께해 주셔서 진심으로 감사합니다.
안내드리는 사이에 이번 자리가 먼저 채워져 마감됐어요. 기다리시게 해서 정말 죄송합니다.
이번 지원 건에 궁금한 점이 있으시면 이 번호로 답장해주세요.`;

export const CURRENT_JOB_CLOSED_SUNTOP_LINE = `
그동안 선탑(동승)으로 현장을 미리 경험해두실 수도 있어요. 비슷한 라인 투입 때 우선순위가 생깁니다. 원하시면 이 번호로 '선탑'이라고 답장 주세요.`;

export function currentJobClosedSmsBody(jobTitle: string, generalLine: boolean): string {
  return (CURRENT_JOB_CLOSED_SMS_TEMPLATE + (generalLine ? CURRENT_JOB_CLOSED_SUNTOP_LINE : ""))
    .replace(/#\{공고명\}/g, jobTitle.replace(/^_+/, ""));
}

/** 새 공고 자체의 안내 또는 다음 일자리를 연락하겠다는 약속. 동의 질문만 하는 문구는 제외한다. */
export function hasFutureJobPromotion(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (normalized.includes("#{맞춤링크}")) return true;
  if (/(?:https?:\/\/\S+)?\/p\/[0-9a-z-]{16,}(?=$|[/?#\s])/i.test(normalized)) return true;

  const opportunity = /(?:(?:새(?:로운)?|다른|비슷한|다음)[^.!?\n]{0,18}(?:일자리|공고|업무|자리|기회|라인|배송\s*건)|티오)/;
  const announcedNow = /(?:(?:새(?:로운)?|다른|비슷한|다음)[^.!?\n]{0,18}(?:일자리|공고|업무|자리|기회|라인|배송\s*건))[^.!?\n]{0,24}(?:생겼(?:어요|습니다|네요|다)|나왔(?:어요|습니다|네요|다)|올라왔(?:어요|습니다|네요|다)|모집\s*(?:중|합니다|해요)|조건\s*확인|지원(?:해|하))/;
  if (announcedNow.test(normalized)) return true;

  const futureCondition = /(?:(?:(?:새(?:로운)?|다른|비슷한|다음)[^.!?\n]{0,18}(?:일자리|공고|업무|자리|기회|라인|배송\s*건)|티오|자리|일감|배송\s*건)[^.!?\n]{0,32}(?:생기|나오|올라오|추가되|발생하|열리))/;
  const promise = /(?:(?:가장\s*먼저|우선|1순위)[^.!?\n]{0,18}(?:안내|연락)|(?:안내|연락|알려)[^.!?\n]{0,12}(?:드릴게|드리겠|드릴\s*예정|하겠|해드리겠|드리고\s*있)|문자(?:를)?\s*(?:보내드릴게|보내\s*드릴게|드릴게|보내겠|드리겠|보낼\s*예정))/;
  if (opportunity.test(normalized) && promise.test(normalized)) return true;
  const directPromotion = /(?:안내(?:드립니다|드려요|드릴게요|해드릴게요)|지원(?:해보세요|해주세요|하실\s*수\s*있어요)|(?:공고\s*)?(?:보실래요|확인해보세요)|관심\s*있으세요)/;
  if (
    opportunity.test(normalized)
    && directPromotion.test(normalized)
    && !asksForMarketingConsent(normalized)
  ) return true;
  return futureCondition.test(normalized) && promise.test(normalized);
}

function asksForMarketingConsent(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  const opportunity = /(?:새(?:로운)?|다른|비슷한|다음)[^.!?\n]{0,20}(?:일자리|공고|업무|자리|기회|배송\s*건)/;
  const request = /(?:문자[^.!?\n]{0,18}(?:받|수신|동의)|(?:안내|연락)[^.!?\n]{0,18}(?:받|드려도|괜찮|원하)|동의(?:하시|해주|하실))/;
  return opportunity.test(normalized) && request.test(normalized);
}

/**
 * AI가 제안한 동의 분류를 그대로 저장하지 않고, 인바운드 원문과 직전 질문으로 검증한다.
 * 짧은 "네/아니요"는 직전 발신이 신규 일자리 문자 동의 질문일 때만 유효하다.
 */
export function explicitMarketingConsentResponse(input: {
  active: boolean;
  inboundText: string;
  priorOutboundText?: string | null;
}): boolean | undefined {
  if (!input.active) return undefined;
  const inbound = input.inboundText.replace(/\s+/g, " ").trim();
  if (!inbound) return undefined;

  const explicitTopic = /(?:새(?:로운)?|다른|비슷한|다음)[^.!?\n]{0,20}(?:일자리|공고|업무|자리|기회|배송\s*건)[^.!?\n]{0,24}(?:문자|안내|연락|수신)/.test(inbound)
    || /(?:새\s*일자리|일자리\s*안내)\s*문자/.test(inbound);
  const negative = /(?:받지\s*않|안\s*받|원하지\s*않|거절|동의하지\s*않|보내지\s*마)/.test(inbound);
  const positive = /(?:받(?:을게|겠습니다|아볼게|고\s*싶)|동의(?:합니다|할게|해요)|연락\s*(?:주세요|받을게)|안내\s*(?:해주세요|받을게))/.test(inbound);
  if (explicitTopic && negative) return false;
  if (explicitTopic && positive) return true;

  if (!asksForMarketingConsent(input.priorOutboundText ?? "")) return undefined;
  const compact = inbound.toLowerCase().replace(/[\s,.!?~^♡♥]+/g, "");
  if (/(?:안받|받지않|원하지않|싫어|거절|동의하지않)/.test(compact)) return false;
  if (/^(?:아니요|아니오|괜찮습니다)$/.test(compact)) return false;
  if (/^(?:네+|넵+|예+|좋아요|좋습니다|괜찮아요|동의합니다|부탁드립니다)$/.test(compact)) return true;
  if (/^(?:네)?(?:문자|안내|연락)?(?:를)?(?:받을게요|받겠습니다|주세요)$/.test(compact)) return true;
  return undefined;
}

/** 명시적 연락 중단 표현은 AI 분류보다 먼저 모든 인바운드에서 하드 가드한다. */
export function isExplicitSmsOptOutText(text: string): boolean {
  const compact = text.toLowerCase().replace(/\s+/g, "").replace(/[.!?~^♡♥]+$/g, "");
  if (!compact) return false;
  if (/^(?:그만|수신거부|차단(?:할게요|합니다|해주세요)?)$/.test(compact)) return true;
  if (/(?:문자|연락|안내|메시지).{0,12}(?:그만|중단|보내지마|하지마|안받|받지않|원하지않|거부)/.test(compact)) return true;
  return /(?:그만|중단).{0,12}(?:문자|연락|안내|메시지|보내)/.test(compact);
}

/** 지연된 웹훅·복구 작업이 그 뒤의 명시적 재동의를 과거 수신거부로 덮지 않게 한다. */
export function shouldApplyExplicitSmsOptOut(input: {
  inboundAt?: string | null;
  marketingConsentAt?: string | null;
}): boolean {
  if (!input.inboundAt || !input.marketingConsentAt) return true;
  const inboundMs = Date.parse(input.inboundAt);
  const consentMs = Date.parse(input.marketingConsentAt);
  if (!Number.isFinite(inboundMs) || !Number.isFinite(consentMs)) return true;
  return consentMs <= inboundMs;
}

export function classifyBulkSmsCategory(input: {
  purpose?: string | null;
  body: string;
  hasVerifiedCurrentJobContext?: boolean;
  hasApprovedCurrentJobBody?: boolean;
}): SmsCategory {
  const purpose = input.purpose?.trim() ?? "";
  const hasVerifiedCurrentJobContext = input.hasVerifiedCurrentJobContext === true;
  const containsFutureJobPromotion = hasFutureJobPromotion(input.body);

  if (PROMOTIONAL_BULK_PURPOSES.has(purpose)) return "promotional";
  // 현재 지원 건의 순수 마감 사실만 운영 안내다. 다른 공고 링크·향후 안내 약속이 섞이면
  // 호출자가 job_closed로 태깅해도 홍보로 승격해 명시 동의를 요구한다.
  if (purpose === "job_closed") {
    return hasVerifiedCurrentJobContext
      && input.hasApprovedCurrentJobBody === true
      && !containsFutureJobPromotion
      ? "operational"
      : "promotional";
  }
  // 대기 안내는 현재 공고와 수신자의 관계가 서버에서 확인되고 승인 문구를 그대로 쓸 때만
  // 운영 안내다. 목적 태그만 waitlist로 위장한 자유 문구는 홍보로 fail closed 한다.
  if (purpose === "waitlist") {
    return hasVerifiedCurrentJobContext && input.body.trim() === CURRENT_JOB_WAITLIST_SMS_BODY
      ? "operational"
      : "promotional";
  }
  if (purpose) return "unknown";

  if (input.body.includes("#{맞춤링크}")) return "promotional";

  // 목적이 없는 자유 문구는 운영/홍보를 서버가 구분할 수 없다. 호출자가 명시하도록 차단한다.
  return "unknown";
}

export function classifyDispatchSmsCategory(input: {
  agentState: unknown;
  hasInterestClick: boolean;
}): Exclude<SmsCategory, "unknown"> {
  if (input.hasInterestClick) return "operational";
  if (!input.agentState || typeof input.agentState !== "object" || Array.isArray(input.agentState)) {
    return "promotional";
  }
  const meta = (input.agentState as Record<string, unknown>).meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return "promotional";
  return (meta as Record<string, unknown>).entry === "web_apply"
    ? "operational"
    : "promotional";
}

export function classifyManualSmsCategory(input: {
  purpose?: string | null;
  hasVerifiedCurrentJobContext: boolean;
  body: string;
}): Exclude<SmsCategory, "unknown"> {
  if (hasFutureJobPromotion(input.body)) return "promotional";
  return input.purpose?.trim() === "current_application"
    && input.hasVerifiedCurrentJobContext
    ? "operational"
    : "promotional";
}

export function smsSendBlockReason(input: {
  category: string;
  marketingConsent?: boolean | null;
  smsOptOutAt?: string | null;
}): SmsSendBlockReason | null {
  if (input.smsOptOutAt) return "opt_out";
  if (input.category === "operational") return null;
  if (input.category === "promotional") {
    return input.marketingConsent === true ? null : "consent_required";
  }
  return "unknown_category";
}

export function smsRecipientBlockReason(input: {
  category: string;
  recipientPhone: string;
  applicant?: {
    phone: string | null;
    marketingConsent: boolean | null;
    smsOptOutAt: string | null;
  };
}): SmsSendBlockReason | null {
  const recipientPhone = input.recipientPhone.replace(/\D/g, "");
  const applicantPhone = (input.applicant?.phone ?? "").replace(/\D/g, "");
  const matchingApplicant = Boolean(input.applicant && recipientPhone === applicantPhone);

  if (!matchingApplicant) return "recipient_unverified";

  return smsSendBlockReason({
    category: input.category,
    marketingConsent: input.applicant?.marketingConsent,
    smsOptOutAt: input.applicant?.smsOptOutAt,
  });
}

export function marketingConsentPatchFromExplicitResponse(input: {
  active: boolean;
  response: boolean | undefined;
  now: string;
}): Record<string, unknown> | null {
  if (!input.active || typeof input.response !== "boolean") return null;
  if (input.response) {
    return {
      marketing_consent: true,
      marketing_consent_at: input.now,
      // 본인이 공개 링크나 답장으로 다시 명시적으로 신청한 최신 의사가 이전 수신거부보다 우선한다.
      sms_opt_out_at: null,
    };
  }
  return {
    marketing_consent: false,
    marketing_consent_at: null,
  };
}

export function marketingConsentStatusLabel(
  value: boolean | null | undefined,
  smsOptOutAt?: string | null,
): "동의" | "거절" | "미확인" | "수신거부" {
  if (smsOptOutAt) return "수신거부";
  if (value === true) return "동의";
  if (value === false) return "거절";
  return "미확인";
}
