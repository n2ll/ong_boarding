import assert from "node:assert/strict";
import test from "node:test";

type SafetyViolation = {
  kind: "confirmation" | "identity_document" | "mandatory_preparation";
  match: string;
};

async function loadSafetyModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./outbound-safety.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("indirect hiring, selection, deployment, and attendance instructions are blocked", async () => {
  const safetyModule = await loadSafetyModule();
  const detect = safetyModule.detectAutomatedOutboundSafetyViolation as
    | ((text: string) => SafetyViolation | null)
    | undefined;

  assert.equal(typeof detect, "function");
  for (const text of [
    "축하드립니다. 채용됐어요.",
    "이번 업무에 선정됐어요.",
    "다음 주 현장에 투입 예정입니다.",
    "내일 오전 9시에 출근하세요.",
    "지원자에게 출근 지시를 전달합니다.",
    "최종 확정입니다.",
    "이번 일자리로 확정했어요.",
    "내일부터 나와 주세요.",
    "최종 합격을 축하드립니다.",
    "이번 업무 담당자로 선발했습니다.",
  ]) {
    assert.equal(detect!(text)?.kind, "confirmation", text);
  }
});

test("negative and manager-review explanations are not mistaken for confirmation", async () => {
  const safetyModule = await loadSafetyModule();
  const detect = safetyModule.detectAutomatedOutboundSafetyViolation as
    | ((text: string) => SafetyViolation | null)
    | undefined;

  assert.equal(typeof detect, "function");
  for (const text of [
    "앱 설치는 선택 사항이며 채용됐다는 뜻은 아니에요.",
    "앱 설치는 필요하지 않습니다.",
    "안전보건교육은 필수가 아닙니다.",
    "투입 예정은 아직 정해지지 않았습니다.",
    "투입 예정이 아닙니다.",
    "채용 여부와 출근 일정은 담당 매니저가 검토 후 안내합니다.",
    "선정되면 담당 매니저가 별도로 연락드립니다.",
    "관심 있으면 링크에서 조건을 확인해 주세요. 관심 표시는 배정·근무 확정이 아닙니다.",
  ]) {
    assert.equal(detect!(text), null, text);
  }
});

test("automated SMS cannot request an ID-card image but can warn against sending one", async () => {
  const safetyModule = await loadSafetyModule();
  const detect = safetyModule.detectAutomatedOutboundSafetyViolation as
    | ((text: string) => SafetyViolation | null)
    | undefined;

  assert.equal(typeof detect, "function");
  assert.equal(
    detect!("진행을 위해 신분증 사진 1장 회신 부탁드립니다.")?.kind,
    "identity_document"
  );
  assert.equal(
    detect!("신분증을 찍어서 문자로 보내주세요.")?.kind,
    "identity_document"
  );
  assert.equal(
    detect!("운전면허증 앞뒤를 촬영해 회신 부탁드립니다.")?.kind,
    "identity_document"
  );
  assert.equal(
    detect!("신분증 사본을 보내세요.")?.kind,
    "identity_document"
  );
  assert.equal(
    detect!("운전면허증 앞뒤 사진을 공유해주세요.")?.kind,
    "identity_document"
  );
  assert.equal(
    detect!("신분증 사진은 문자로 보내지 마세요. 필요하면 매니저가 승인된 제출 방법을 안내합니다."),
    null
  );
});

test("manager quick replies describe optional preparation and privacy-safe document handling", async () => {
  const safetyModule = await loadSafetyModule();
  const onboarding = safetyModule.PRECONFIRMATION_ONBOARDING_TEMPLATE as string | undefined;
  const identity = safetyModule.PRIVACY_SAFE_ID_DOCUMENT_TEMPLATE as string | undefined;

  assert.equal(typeof onboarding, "string");
  assert.match(onboarding!, /선택/);
  assert.match(onboarding!, /채용[^\n]*(?:확정|의미)|(?:채용|근무)[^\n]*배정[^\n]*아닙니다/);

  assert.equal(typeof identity, "string");
  assert.match(identity!, /신분증[^\n]*문자[^\n]*보내지 마세요/);
  assert.match(identity!, /매니저[^\n]*(?:승인된|안전한)[^\n]*제출 방법/);
  assert.doesNotMatch(identity!, /사진[^\n]*(?:회신|보내\s*주세요|전송|첨부)\s*부탁/);
});

test("pre-confirmation onboarding guides require optional and non-confirmation disclosure", async () => {
  const safetyModule = await loadSafetyModule();
  const detect = safetyModule.detectAutomatedOutboundSafetyViolation as
    | ((text: string) => SafetyViolation | null)
    | undefined;
  const validateGuide = safetyModule.detectPreconfirmationGuideSafetyViolation as
    | ((text: string) => SafetyViolation | null)
    | undefined;
  const safeGuide = safetyModule.PRECONFIRMATION_ONBOARDING_TEMPLATE as string;

  assert.equal(typeof detect, "function");
  for (const text of [
    "배민 커넥트 앱을 설치하고 안전보건교육 영상을 반드시 시청해주세요.",
    "배민 커넥트 앱을 반드시 설치해주세요.",
    "준비를 위해 앱 아이디를 회신 부탁드립니다.",
  ]) {
    assert.equal(detect!(text)?.kind, "mandatory_preparation", text);
  }

  assert.equal(typeof validateGuide, "function");
  assert.equal(
    validateGuide!("배민 커넥트 앱 설치 후 교육 영상을 시청하고 아이디를 회신해주세요.")?.kind,
    "mandatory_preparation"
  );
  assert.equal(validateGuide!(safeGuide), null);
  assert.equal(
    detect!("배민 커넥트 앱 설치 후 아이디를 보내주세요.")?.kind,
    "mandatory_preparation"
  );
});

test("unsafe database onboarding overrides fall back to a validated guide", async () => {
  const safetyModule = await loadSafetyModule();
  const resolveGuide = safetyModule.resolvePreconfirmationGuideText as
    | ((stored: string | null, fallback: string) => string | null)
    | undefined;
  const validateGuide = safetyModule.detectPreconfirmationGuideSafetyViolation as
    | ((text: string) => SafetyViolation | null)
    | undefined;
  const fallback = safetyModule.PRECONFIRMATION_ONBOARDING_TEMPLATE as string;
  const unsafeOverride = "채용됐어요. 배민 커넥트 앱 설치와 교육을 반드시 완료해주세요.";

  assert.equal(typeof resolveGuide, "function");
  assert.equal(typeof validateGuide, "function");
  const resolved = resolveGuide!(unsafeOverride, fallback);
  assert.notEqual(resolved, unsafeOverride);
  assert.equal(typeof resolved, "string");
  assert.equal(validateGuide!(resolved!), null);
});

test("all automated database messages use a safe final-text fallback", async () => {
  const safetyModule = await loadSafetyModule();
  const resolve = safetyModule.resolveAutomatedOutboundText as
    | ((stored: string | null, fallback: string) => string | null)
    | undefined;
  const fallback = "지원 의사가 접수됐어요. 근무 여부는 매니저 검토 후 별도로 안내합니다.";

  assert.equal(typeof resolve, "function");
  assert.equal(resolve!("최종 확정입니다. 내일부터 나와 주세요.", fallback), fallback);
  assert.equal(resolve!("관심 감사합니다. 몇 가지 확인할게요.", fallback), "관심 감사합니다. 몇 가지 확인할게요.");
  assert.equal(resolve!("신분증 사본을 보내세요.", "채용됐어요."), null);
});

test("validated database onboarding overrides remain editable at runtime", async () => {
  const safetyModule = await loadSafetyModule();
  const resolveGuide = safetyModule.resolvePreconfirmationGuideText as
    | ((stored: string | null, fallback: string) => string | null)
    | undefined;
  const safeOverride = "앱 설치는 원하실 경우 미리 하실 수 있는 선택 사항이며, 채용이나 근무 배정 확정을 의미하지 않습니다.";
  const fallback = safetyModule.PRECONFIRMATION_ONBOARDING_TEMPLATE as string;

  assert.equal(typeof resolveGuide, "function");
  assert.equal(resolveGuide!(safeOverride, fallback), safeOverride);
});

test("onboarding deadlines remain optional preparation rather than an assignment deadline", async () => {
  const safetyModule = await loadSafetyModule();
  const buildGuide = safetyModule.buildSafePreconfirmationOnboardingGuide as
    | ((stored: string | null, fallback: string, deadline: string) => string | null)
    | undefined;
  const validateGuide = safetyModule.detectPreconfirmationGuideSafetyViolation as
    | ((text: string) => SafetyViolation | null)
    | undefined;
  const fallback = safetyModule.PRECONFIRMATION_ONBOARDING_TEMPLATE as string;

  assert.equal(typeof buildGuide, "function");
  const guide = buildGuide!(
    "업무 진행을 위해 앱 설치와 교육을 반드시 완료해주세요.",
    fallback,
    "8월 21일 오후 3시"
  );
  assert.equal(typeof guide, "string");
  assert.match(guide!, /8월 21일 오후 3시/);
  assert.match(guide!, /(?:선택|어려우시면 나중에)/);
  assert.doesNotMatch(guide!, /반드시[^\n]*(?:회신|완료|설치|교육)/);
  assert.equal(validateGuide!(guide!), null);
});

test("pre-confirmation reminders stay optional and do not threaten automatic rejection", async () => {
  const safetyModule = await loadSafetyModule();
  const reminder = safetyModule.PRECONFIRMATION_ONBOARDING_REMINDER_TEMPLATE as string | undefined;
  const validateGuide = safetyModule.detectPreconfirmationGuideSafetyViolation as
    | ((text: string) => SafetyViolation | null)
    | undefined;

  assert.equal(typeof reminder, "string");
  assert.match(reminder!, /선택/);
  assert.match(reminder!, /(?:채용|근무)[^\n]*(?:확정|배정)[^\n]*(?:아니|의미하지)/);
  assert.doesNotMatch(reminder!, /(?:회신이 없|미회신)[^\n]*(?:중단|탈락|제외)/);
  assert.equal(validateGuide!(reminder!), null);
});

test("manual manager messages allow confirmed hiring language but still block ID-card image requests", async () => {
  const safetyModule = await loadSafetyModule();
  const detectManual = safetyModule.detectManualOutboundSafetyViolation as
    | ((text: string) => SafetyViolation | null)
    | undefined;

  assert.equal(typeof detectManual, "function");
  assert.equal(detectManual!("담당 매니저가 최종 확인했습니다. 채용됐어요."), null);
  assert.equal(
    detectManual!("확정 절차를 위해 신분증 사진을 문자로 회신 부탁드립니다.")?.kind,
    "identity_document"
  );
});
