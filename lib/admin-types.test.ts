import assert from "node:assert/strict";
import test from "node:test";

async function loadAdminTypesModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./admin/types.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("applicant age ignores impossible legacy birth dates", async () => {
  const adminTypesModule = await loadAdminTypesModule();
  const calcAge = adminTypesModule.calcAge as
    | ((birthDate: string | null | undefined) => number | null)
    | undefined;

  assert.equal(typeof calcAge, "function");
  assert.equal(typeof calcAge!("600101"), "number");
  assert.equal(calcAge!("000230"), null);
  assert.equal(calcAge!("991332"), null);
});

test("campaign SMS requires explicit consent and keeps opt-out as the strongest reason", async () => {
  const adminTypesModule = await loadAdminTypesModule();
  const campaignSmsSendability = adminTypesModule.campaignSmsSendability as
    | ((input: {
        phone: string | null;
        hasCustomLink: boolean;
        smsOptOutAt: string | null;
        marketingConsent: boolean | null;
        status: string;
      }) => { sendable: boolean; reason: string | null })
    | undefined;

  assert.equal(typeof campaignSmsSendability, "function");
  const baseline = {
    phone: "01012345678",
    hasCustomLink: true,
    smsOptOutAt: null,
    status: "대기자",
  };
  assert.deepEqual(campaignSmsSendability!({ ...baseline, marketingConsent: true }), {
    sendable: true,
    reason: null,
  });
  assert.deepEqual(campaignSmsSendability!({ ...baseline, marketingConsent: false }), {
    sendable: false,
    reason: "새 일자리 문자 미동의",
  });
  assert.deepEqual(campaignSmsSendability!({ ...baseline, marketingConsent: null }), {
    sendable: false,
    reason: "새 일자리 문자 미동의",
  });
  assert.deepEqual(campaignSmsSendability!({
    ...baseline,
    marketingConsent: false,
    smsOptOutAt: "2026-08-26T00:00:00.000Z",
  }), {
    sendable: false,
    reason: "수신거부",
  });
});

test("manager consent status distinguishes consent, missing consent, and opt-out", async () => {
  const adminTypesModule = await loadAdminTypesModule();
  const marketingSmsState = adminTypesModule.marketingSmsState as
    | ((input: { marketingConsent: boolean | null; smsOptOutAt: string | null }) => string)
    | undefined;

  assert.equal(typeof marketingSmsState, "function");
  assert.equal(marketingSmsState!({ marketingConsent: true, smsOptOutAt: null }), "consented");
  assert.equal(marketingSmsState!({ marketingConsent: false, smsOptOutAt: null }), "not_consented");
  assert.equal(marketingSmsState!({ marketingConsent: null, smsOptOutAt: null }), "not_consented");
  assert.equal(
    marketingSmsState!({ marketingConsent: true, smsOptOutAt: "2026-08-26T00:00:00.000Z" }),
    "opted_out",
  );
});

test("pipeline bulk messages identify campaigns explicitly while keeping waitlist operational", async () => {
  const adminTypesModule = await loadAdminTypesModule();
  const pipelineBulkPurpose = adminTypesModule.pipelineBulkPurpose as
    | ((waitlist: boolean) => string)
    | undefined;
  const pipelineBulkSendability = adminTypesModule.pipelineBulkSendability as
    | ((input: {
        waitlist: boolean;
        phone: string | null;
        hasCustomLink: boolean;
        smsOptOutAt: string | null;
        marketingConsent: boolean | null;
        status: string;
      }) => { sendable: boolean; reason: string | null })
    | undefined;

  assert.equal(typeof pipelineBulkPurpose, "function");
  assert.equal(typeof pipelineBulkSendability, "function");
  assert.equal(pipelineBulkPurpose!(false), "campaign");
  assert.equal(pipelineBulkPurpose!(true), "waitlist");
  const missingConsent = {
    phone: "01012345678",
    hasCustomLink: false,
    smsOptOutAt: null,
    marketingConsent: null,
    status: "대기자",
  };
  assert.deepEqual(pipelineBulkSendability!({ ...missingConsent, waitlist: false }), {
    sendable: false,
    reason: "새 일자리 문자 미동의",
  });
  assert.deepEqual(pipelineBulkSendability!({ ...missingConsent, waitlist: true }), {
    sendable: true,
    reason: null,
  });
  assert.deepEqual(pipelineBulkSendability!({
    ...missingConsent,
    waitlist: true,
    smsOptOutAt: "2026-08-26T00:00:00.000Z",
  }), {
    sendable: false,
    reason: "수신거부",
  });
});

test("opening the bulk composer preserves a selected waitlist job while manual additions clear it", async () => {
  const adminTypesModule = await loadAdminTypesModule();
  const pipelineWaitlistJobAfterAction = adminTypesModule.pipelineWaitlistJobAfterAction as
    | ((currentJobId: number | null, action: "open_composer" | "manual_add" | "manual_remove") => number | null)
    | undefined;

  assert.equal(typeof pipelineWaitlistJobAfterAction, "function");
  assert.equal(pipelineWaitlistJobAfterAction!(42, "open_composer"), 42);
  assert.equal(pipelineWaitlistJobAfterAction!(42, "manual_add"), null);
  assert.equal(pipelineWaitlistJobAfterAction!(42, "manual_remove"), 42);
  assert.equal(pipelineWaitlistJobAfterAction!(null, "open_composer"), null);
});

test("zero-target notice explains consent exclusions before other drop reasons", async () => {
  const adminTypesModule = await loadAdminTypesModule();
  const announceZeroTargetDescription = adminTypesModule.announceZeroTargetDescription as
    | ((input: {
        consent: { total: number; promised: number };
        fatigue: { total: number; promised: number };
        exposure: { total: number; promised: number };
        fatigueDays: number;
      }) => string | null)
    | undefined;

  assert.equal(typeof announceZeroTargetDescription, "function");
  const description = announceZeroTargetDescription!({
    consent: { total: 4, promised: 2 },
    fatigue: { total: 3, promised: 0 },
    exposure: { total: 1, promised: 0 },
    fatigueDays: 7,
  });
  assert.match(description ?? "", /새 일자리 문자.*동의/);
  assert.match(description ?? "", /4명/);
  assert.match(description ?? "", /충원 안내 이력/);
  assert.match(description ?? "", /선탑 완료/);
  assert.doesNotMatch(description ?? "", /약속/);
  assert.doesNotMatch(description ?? "", /이력.*없/);
});

test("new-job consent guards are intentional exclusions rather than retryable failures", async () => {
  const adminTypesModule = await loadAdminTypesModule();
  const isIntentionalCampaignGuardError = adminTypesModule.isIntentionalCampaignGuardError as
    | ((error: string) => boolean)
    | undefined;

  assert.equal(typeof isIntentionalCampaignGuardError, "function");
  assert.equal(isIntentionalCampaignGuardError!("신규 일자리 문자 미동의(발송 제외)"), true);
  assert.equal(isIntentionalCampaignGuardError!("신규 일자리 문자 동의 확인 불가(발송 제외)"), true);
  assert.equal(isIntentionalCampaignGuardError!("네트워크 오류"), false);
});
