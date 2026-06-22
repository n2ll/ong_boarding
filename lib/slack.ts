/**
 * Slack 알림 — 현재 전체 OFF (운영 판단)
 *
 * 복구하려면 SLACK_NOTIFICATIONS_ENABLED=1 환경변수 설정 후 재배포.
 * 호출부는 그대로 두어도 됨 (각 함수가 진입 시점에 self-disable).
 */

const SLACK_ENABLED = process.env.SLACK_NOTIFICATIONS_ENABLED === "1";

/**
 * 범용 Slack 텍스트 발송. webhook 미설정 시 false 반환(전송 안 됨).
 * 자동 점검 규칙 등에서 사용.
 */
export async function sendSlackText(text: string): Promise<boolean> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return false;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch (e) {
    console.error("[slack text]", e);
    return false;
  }
}

/**
 * 지원자 확정(screening → onboarding 전이) 시 슬랙 알림.
 * 라인명(공고 제목) + 지원자 이름 + 전화번호 + 매니저 정보.
 */
// 온보딩 준비 완료 — 배민 아이디 수신 시점.
// 이름 / 근무지점 / 근무시간대 + 수집된 아이디.
export async function sendSlackOnboardingReady(data: {
  applicant_name: string | null;
  applicant_phone: string;
  branch: string | null;
  work_hours: string | null;
}) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const name = data.applicant_name || "(이름 없음)";

  const message = {
    text:
      `🎉 *온보딩 준비 완료 — 매니저 확인 요망*\n` +
      `> *이름:* ${name} (${data.applicant_phone})\n` +
      `> *근무지점:* ${data.branch || "-"}\n` +
      `> *근무시간대:* ${data.work_hours || "-"}\n` +
      `배민 아이디 수신 완료. 만남장소 안내·확정 처리 부탁드립니다.`,
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  } catch (e) {
    console.error("[slack onboarding ready]", e);
  }
}

/**
 * 후보가 매니저 인계(stage='paused') 상태로 전환됐을 때 알림.
 * AI가 응대 어려운 메시지(시급 등 facts 부족)이라 매니저 응답 요청.
 */
export async function sendSlackPausedAlert(data: {
  applicant_name: string | null;
  applicant_phone: string;
  branch: string | null;          // 희망 근무지점 (applicant.branch1)
  reason: string;
  inbound_text?: string;
}) {
  // 매니저 인계 알림은 SLACK_WEBHOOK_URL만 있으면 무조건 발송
  // (SLACK_NOTIFICATIONS_ENABLED 체크 없음 — 인계는 항상 알려야)
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const name = data.applicant_name || "(이름 없음)";
  const inboundLine = data.inbound_text
    ? `\n> *받은 메시지:* ${data.inbound_text}`
    : "";

  const message = {
    text:
      `⏸️ *매니저 인계 필요*\n` +
      `> *지원자:* ${name} (${data.applicant_phone})\n` +
      `> *희망 근무지점:* ${data.branch || "-"}\n` +
      `> *사유:* ${data.reason}${inboundLine}\n` +
      `\n관리자 페이지에서 직접 응대해주세요.`,
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  } catch (e) {
    console.error("[slack paused alert]", e);
  }
}

/**
 * 온보딩 리마인더 발송 후에도 3h 내 회신 없음 — 매니저가 전화 인계 필요.
 */
export async function sendSlackOnboardingHandoff(data: {
  applicant_name: string | null;
  applicant_phone: string;
  branch: string | null;          // 희망 근무지점 (applicant.branch1)
}) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const name = data.applicant_name || "(이름 없음)";

  const message = {
    text:
      `📞 *매니저 전화 인계 필요 — 온보딩 미회신*\n` +
      `> *지원자:* ${name} (${data.applicant_phone})\n` +
      `> *희망 근무지점:* ${data.branch || "-"}\n` +
      `리마인더 발송 후 3시간 내 회신이 없습니다. 직접 전화로 확인 부탁드립니다.`,
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  } catch (e) {
    console.error("[slack onboarding handoff]", e);
  }
}

/**
 * AI 에이전트가 답변 못 만들었을 때 — 매니저 직접 응대 필요 알림
 */
export async function sendSlackAgentAlert(data: {
  applicant_name: string | null;
  applicant_phone: string;
  branch: string | null;
  inbound_text: string;
  missing_info: string;
}) {
  if (!SLACK_ENABLED) return;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const name = data.applicant_name || "(이름 없음)";
  const branch = data.branch ? ` · ${data.branch}` : "";

  const message = {
    text:
      `⚠️ *AI 응대 불가 — 매니저 답변 필요*\n` +
      `> *지원자:* ${name} (${data.applicant_phone})${branch}\n` +
      `> *받은 메시지:* ${data.inbound_text}\n` +
      `> *모자란 정보:* ${data.missing_info}\n` +
      `\n관리자 페이지에서 직접 답변해주세요.`,
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  } catch (e) {
    console.error("[slack agent alert]", e);
  }
}

