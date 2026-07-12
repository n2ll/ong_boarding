import crypto from "crypto";

const SOLAPI_URL = "https://api.solapi.com/messages/v4/send-many/detail";
const FROM_NUMBER = "01035037252";

/**
 * 실제 SMS 발송을 건너뛸지 판단(개발 오발송 방지).
 * - SMS_DRY_RUN=1 → 항상 건너뜀.  SMS_DRY_RUN=0 → 항상 실제 발송.
 * - 미설정이면 프로덕션만 실제 발송(dev/preview는 자동 dry-run).
 */
function isSmsDryRun(): boolean {
  const flag = process.env.SMS_DRY_RUN;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return process.env.NODE_ENV !== "production";
}

function getAuthHeader() {
  const apiKey = process.env.SOLAPI_API_KEY!;
  const apiSecret = process.env.SOLAPI_API_SECRET!;
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString("hex");
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(date + salt)
    .digest("hex");

  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

export async function sendSms(
  to: string,
  text: string,
  subject?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (isSmsDryRun()) {
    console.warn(`[SMS DRY-RUN] 발송 생략 (SMS_DRY_RUN) to=${to} text="${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`);
    return { success: true, messageId: "dry-run" };
  }
  // subject: LMS 제목. 미지정 시 SOLAPI가 본문 첫 문장을 제목으로 자동 생성해 인사말이
  // 제목·본문에 중복 노출된다 → 캠페인 발송은 명시적 제목을 넣어 중복을 막는다.
  const res = await fetch(SOLAPI_URL, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [{ to, from: FROM_NUMBER, text, ...(subject ? { subject } : {}) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("[SOLAPI error]", body);
    return { success: false, error: body };
  }

  const data = await res.json();

  // SOLAPI는 등록 실패(발신번호 미등록·잔액부족·번호오류 등)에도 HTTP 200을 준다.
  // 실패 건을 검사하지 않으면 실제로 안 나간 문자가 'sent'로 기록된다 — 실캠페인에서 치명적.
  const failedList = Array.isArray(data?.failedMessageList) ? data.failedMessageList : [];
  const registeredFailed = Number(data?.groupInfo?.count?.registeredFailed ?? 0);
  if (failedList.length > 0 || registeredFailed > 0) {
    const first = failedList[0] ?? {};
    const reason = first.statusMessage || first.statusCode || `등록 실패 ${registeredFailed}건`;
    console.error(
      "[SOLAPI registration failed]",
      JSON.stringify(data?.groupInfo?.count ?? {}),
      JSON.stringify(failedList).slice(0, 300)
    );
    return { success: false, error: `발송 등록 실패: ${reason}` };
  }

  // solapi 응답에서 messageId 추출
  const messageId =
    data?.groupInfo?.groupId ||
    data?.messageList?.[Object.keys(data.messageList || {})[0]]?.messageId ||
    undefined;

  return { success: true, messageId };
}

export async function sendAlimtalk(
  to: string,
  templateId: string,
  variables: Record<string, string>,
  fallbackText?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (isSmsDryRun()) {
    console.warn(`[SMS DRY-RUN] 알림톡 발송 생략 (SMS_DRY_RUN) to=${to} template=${templateId}`);
    return { success: true, messageId: "dry-run" };
  }
  const pfId = process.env.SOLAPI_PFID!;

  const res = await fetch(SOLAPI_URL, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        {
          to,
          from: FROM_NUMBER,
          text: fallbackText,
          kakaoOptions: {
            pfId,
            templateId,
            variables,
            disableSms: false,
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("[SOLAPI alimtalk error]", body);
    return { success: false, error: body };
  }

  const data = await res.json();
  const messageId =
    data?.groupInfo?.groupId ||
    data?.messageList?.[Object.keys(data.messageList || {})[0]]?.messageId ||
    undefined;

  return { success: true, messageId };
}

export type TemplateKey =
  | "APPLY_RECEIVED"
  | "CONFIRM"
  | "WAIT"
  | "ATTENDANCE"
  | "GUIDE"
  | "SCREENING_ANNOUNCE"
  | "VENUE_GUIDE"
  // 일반 라인(internal 공고) 전용 — 알림톡 템플릿 미등록 상태라 SMS 폴백으로 발송된다.
  // (비마트용 SCREENING_ANNOUNCE/GUIDE 템플릿을 재사용하면 등록된 비마트 본문이 나가므로 키를 분리)
  | "GENERAL_SCREENING_ANNOUNCE"
  | "GENERAL_SCREENING_HANDOFF";

export async function sendNotification(
  to: string,
  templateKey: TemplateKey,
  variables: Record<string, string>,
  fallbackText: string
): Promise<{
  success: boolean;
  via: "alimtalk" | "sms";
  messageId?: string;
  templateId?: string;
  error?: string;
}> {
  const templateId = process.env[`SOLAPI_TEMPLATE_${templateKey}`];

  if (templateId) {
    const result = await sendAlimtalk(to, templateId, variables, fallbackText);
    return { ...result, via: "alimtalk", templateId };
  }

  const result = await sendSms(to, fallbackText);
  return { ...result, via: "sms" };
}
