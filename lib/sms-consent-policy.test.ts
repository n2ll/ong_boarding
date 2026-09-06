import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type SmsConsentPolicyModule = {
  classifyBulkSmsCategory?: (input: {
    purpose?: string | null;
    body: string;
    hasVerifiedCurrentJobContext?: boolean;
    hasApprovedCurrentJobBody?: boolean;
  }) =>
    | "operational"
    | "promotional"
    | "unknown";
  classifyDispatchSmsCategory?: (input: { agentState: unknown; hasInterestClick: boolean }) =>
    | "operational"
    | "promotional";
  classifyManualSmsCategory?: (input: {
    purpose?: string | null;
    hasVerifiedCurrentJobContext: boolean;
    body: string;
  }) => "operational" | "promotional";
  hasFutureJobPromotion?: (text: string) => boolean;
  isExplicitSmsOptOutText?: (text: string) => boolean;
  shouldApplyExplicitSmsOptOut?: (input: {
    inboundAt?: string | null;
    marketingConsentAt?: string | null;
  }) => boolean;
  explicitMarketingConsentResponse?: (input: {
    active: boolean;
    inboundText: string;
    priorOutboundText?: string | null;
  }) => boolean | undefined;
  currentJobClosedSmsBody?: (jobTitle: string, generalLine: boolean) => string;
  smsSendBlockReason?: (input: {
    category: string;
    marketingConsent?: boolean | null;
    smsOptOutAt?: string | null;
  }) => "opt_out" | "consent_required" | "recipient_unverified" | "unknown_category" | null;
  marketingConsentPatchFromExplicitResponse?: (input: {
    active: boolean;
    response: boolean | undefined;
    now: string;
  }) => Record<string, unknown> | null;
  marketingConsentStatusLabel?: (value: boolean | null | undefined, smsOptOutAt?: string | null) =>
    | "동의"
    | "거절"
    | "미확인"
    | "수신거부";
  smsRecipientBlockReason?: (input: {
    category: string;
    recipientPhone: string;
    applicant?: {
      phone: string | null;
      marketingConsent: boolean | null;
      smsOptOutAt: string | null;
    };
  }) => "opt_out" | "consent_required" | "unknown_category" | null;
};

async function loadPolicy(): Promise<SmsConsentPolicyModule> {
  try {
    const modulePath = "./sms-consent-policy.ts";
    return await import(modulePath) as SmsConsentPolicyModule;
  } catch {
    return {};
  }
}

test("promotional SMS requires explicit marketing consent", async () => {
  const { smsSendBlockReason } = await loadPolicy();
  assert.equal(typeof smsSendBlockReason, "function");

  assert.equal(smsSendBlockReason?.({ category: "promotional", marketingConsent: true }), null);
  assert.equal(
    smsSendBlockReason?.({ category: "promotional", marketingConsent: false }),
    "consent_required",
  );
  assert.equal(
    smsSendBlockReason?.({ category: "promotional", marketingConsent: null }),
    "consent_required",
  );
  assert.equal(
    smsSendBlockReason?.({ category: "promotional", marketingConsent: undefined }),
    "consent_required",
  );
});

test("operational SMS does not require marketing consent but every category respects opt-out", async () => {
  const { smsSendBlockReason } = await loadPolicy();
  assert.equal(typeof smsSendBlockReason, "function");

  assert.equal(smsSendBlockReason?.({ category: "operational", marketingConsent: false }), null);
  assert.equal(
    smsSendBlockReason?.({
      category: "operational",
      marketingConsent: true,
      smsOptOutAt: "2026-08-26T00:00:00.000Z",
    }),
    "opt_out",
  );
  assert.equal(
    smsSendBlockReason?.({
      category: "promotional",
      marketingConsent: true,
      smsOptOutAt: "2026-08-26T00:00:00.000Z",
    }),
    "opt_out",
  );
});

test("unknown SMS categories fail closed", async () => {
  const { smsSendBlockReason } = await loadPolicy();
  assert.equal(typeof smsSendBlockReason, "function");

  assert.equal(
    smsSendBlockReason?.({ category: "unexpected", marketingConsent: true }),
    "unknown_category",
  );
});

test("bulk SMS requires an exact applicant and phone match for every message category", async () => {
  const { smsRecipientBlockReason } = await loadPolicy();
  assert.equal(typeof smsRecipientBlockReason, "function");

  assert.equal(
    smsRecipientBlockReason?.({
      category: "promotional",
      recipientPhone: "010-1234-5678",
      applicant: {
        phone: "01012345678",
        marketingConsent: true,
        smsOptOutAt: null,
      },
    }),
    null,
  );
  assert.equal(
    smsRecipientBlockReason?.({
      category: "promotional",
      recipientPhone: "01012345678",
    }),
    "recipient_unverified",
  );
  assert.equal(
    smsRecipientBlockReason?.({
      category: "promotional",
      recipientPhone: "01012345678",
      applicant: {
        phone: "01099999999",
        marketingConsent: true,
        smsOptOutAt: null,
      },
    }),
    "recipient_unverified",
  );
  assert.equal(
    smsRecipientBlockReason?.({
      category: "operational",
      recipientPhone: "01012345678",
    }),
    "recipient_unverified",
  );
  assert.equal(
    smsRecipientBlockReason?.({
      category: "operational",
      recipientPhone: "01012345678",
      applicant: {
        phone: "01012345678",
        marketingConsent: false,
        smsOptOutAt: null,
      },
    }),
    null,
  );
});

test("bulk SMS classification separates new-job promotion from current-job operations", async () => {
  const { classifyBulkSmsCategory } = await loadPolicy();
  assert.equal(typeof classifyBulkSmsCategory, "function");

  assert.equal(classifyBulkSmsCategory?.({ purpose: "new_job", body: "새 일자리" }), "promotional");
  assert.equal(classifyBulkSmsCategory?.({ purpose: "campaign", body: "다시 연락" }), "promotional");
  assert.equal(
    classifyBulkSmsCategory?.({ purpose: null, body: "조건 확인: #{맞춤링크}" }),
    "promotional",
  );
  assert.equal(
    classifyBulkSmsCategory?.({ purpose: "job_closed", body: "현재 공고 마감: #{맞춤링크}" }),
    "promotional",
  );
  assert.equal(
    classifyBulkSmsCategory?.({ purpose: "job_closed", body: "새 자리가 나면 먼저 안내드릴게요" }),
    "promotional",
  );
  assert.equal(
    classifyBulkSmsCategory?.({
      purpose: "job_closed",
      body: "현재 지원하신 공고가 마감되었습니다",
      hasVerifiedCurrentJobContext: true,
      hasApprovedCurrentJobBody: true,
    }),
    "operational",
  );
  assert.equal(
    classifyBulkSmsCategory?.({
      purpose: "waitlist",
      body: "#{이름}님, 관심 감사합니다. 현재 순차적으로 안내드리고 있어요. 자리가 정리되는 대로 먼저 연락드릴게요! (안내 중단: '그만' 회신)",
      hasVerifiedCurrentJobContext: true,
    }),
    "operational",
  );
  assert.equal(
    classifyBulkSmsCategory?.({ purpose: "waitlist", body: "새 일자리 확인: #{맞춤링크}" }),
    "promotional",
  );
  assert.equal(classifyBulkSmsCategory?.({ purpose: null, body: "서류를 확인해주세요" }), "unknown");
  assert.equal(classifyBulkSmsCategory?.({ purpose: "typo", body: "안내" }), "unknown");
});

test("manual one-to-one SMS defaults to promotional without a verified current-job purpose", async () => {
  const { classifyManualSmsCategory } = await loadPolicy();
  assert.equal(typeof classifyManualSmsCategory, "function");
  assert.equal(
    classifyManualSmsCategory!({ purpose: null, hasVerifiedCurrentJobContext: false, body: "서류를 확인해주세요" }),
    "promotional",
  );
  assert.equal(
    classifyManualSmsCategory!({
      purpose: "current_application",
      hasVerifiedCurrentJobContext: false,
      body: "서류를 확인해주세요",
    }),
    "promotional",
  );
  assert.equal(
    classifyManualSmsCategory!({
      purpose: "current_application",
      hasVerifiedCurrentJobContext: true,
      body: "서류를 확인해주세요",
    }),
    "operational",
  );
  assert.equal(
    classifyManualSmsCategory!({ purpose: "campaign", hasVerifiedCurrentJobContext: true, body: "안내" }),
    "promotional",
  );
  assert.equal(
    classifyManualSmsCategory!({ purpose: "typo", hasVerifiedCurrentJobContext: true, body: "안내" }),
    "promotional",
  );
  assert.equal(
    classifyManualSmsCategory!({
      purpose: "current_application",
      hasVerifiedCurrentJobContext: true,
      body: "새 배송 일자리가 생겼어요. 지원해보세요.",
    }),
    "promotional",
  );
  assert.equal(
    classifyManualSmsCategory!({
      purpose: "current_application",
      hasVerifiedCurrentJobContext: true,
      body: "조건 확인: https://ong.example/p/41f82761-a37a-4f6f-8ad5-8b6b93acb8c1",
    }),
    "promotional",
  );
});

test("future-job announcements and promises are promotional while a consent question is not", async () => {
  const { hasFutureJobPromotion } = await loadPolicy();
  assert.equal(typeof hasFutureJobPromotion, "function");

  for (const text of [
    "새 배송 일자리가 생겼어요. 지원해보세요.",
    "다음 배송 기회가 생기면 문자로 알려드릴게요.",
    "비슷한 업무가 생기면 연락드릴게요.",
    "티오 추가되면 1순위로 연락드릴게요.",
    "자리가 생기면 이 번호로 안내드릴게요.",
    "자리 생기면 연락드릴게요.",
    "다른 배송 건 생기면 문자드릴게요.",
    "다른 일자리도 안내드릴게요.",
    "비슷한 업무가 있으면 연락드릴게요.",
    "새 공고를 안내드립니다. 지원해보세요.",
    "새로 올라온 강남 배송 공고 보실래요?",
    "새로운 배송 공고 보실래요?",
    "다른 일자리 관심 있으세요?",
    "조건 확인: https://ong.example/p/41f82761-a37a-4f6f-8ad5-8b6b93acb8c1",
    "새 공고 조건 확인: #{맞춤링크}",
  ]) {
    assert.equal(hasFutureJobPromotion!(text), true, text);
  }
  for (const text of [
    "새 일자리가 생길 때 안내 문자를 받아보시겠어요?",
    "다른 업무가 생겼을 때 연락드려도 될까요?",
    "현재 지원하신 공고가 마감되었습니다.",
  ]) {
    assert.equal(hasFutureJobPromotion!(text), false, text);
  }
});

test("agent consent writes require a deterministic explicit inbound answer", async () => {
  const { explicitMarketingConsentResponse } = await loadPolicy();
  assert.equal(typeof explicitMarketingConsentResponse, "function");

  const question = "비슷한 새 일자리가 생길 때 문자로 안내받으시겠어요?";
  assert.equal(explicitMarketingConsentResponse!({ active: true, inboundText: "네", priorOutboundText: question }), true);
  assert.equal(explicitMarketingConsentResponse!({ active: true, inboundText: "네 받을게요", priorOutboundText: question }), true);
  assert.equal(explicitMarketingConsentResponse!({ active: true, inboundText: "문자 받을게요", priorOutboundText: question }), true);
  assert.equal(explicitMarketingConsentResponse!({ active: true, inboundText: "네, 문자 받을게요", priorOutboundText: question }), true);
  assert.equal(explicitMarketingConsentResponse!({ active: true, inboundText: "아니요", priorOutboundText: question }), false);
  assert.equal(explicitMarketingConsentResponse!({ active: true, inboundText: "새 일자리 문자는 받을게요" }), true);
  assert.equal(explicitMarketingConsentResponse!({ active: true, inboundText: "새 일자리 문자는 받지 않을게요" }), false);
  assert.equal(explicitMarketingConsentResponse!({ active: true, inboundText: "네", priorOutboundText: "차량을 보유하고 계신가요?" }), undefined);
  assert.equal(explicitMarketingConsentResponse!({ active: true, inboundText: "글쎄요", priorOutboundText: question }), undefined);
  assert.equal(explicitMarketingConsentResponse!({ active: false, inboundText: "동의합니다", priorOutboundText: question }), undefined);
});

test("explicit SMS opt-out is deterministic and does not confuse job availability", async () => {
  const { isExplicitSmsOptOutText, shouldApplyExplicitSmsOptOut } = await loadPolicy();
  assert.equal(typeof isExplicitSmsOptOutText, "function");
  assert.equal(typeof shouldApplyExplicitSmsOptOut, "function");
  for (const text of ["그만", "문자 그만 보내주세요", "수신거부", "연락하지 마세요", "차단할게요"]) {
    assert.equal(isExplicitSmsOptOutText!(text), true, text);
  }
  for (const text of ["이번 주는 어려워요", "이번 공고는 관심 없어요", "지금 하던 일은 그만뒀어요"]) {
    assert.equal(isExplicitSmsOptOutText!(text), false, text);
  }
  assert.equal(shouldApplyExplicitSmsOptOut!({
    inboundAt: "2026-08-26T01:00:00.000Z",
    marketingConsentAt: "2026-08-26T02:00:00.000Z",
  }), false);
  assert.equal(shouldApplyExplicitSmsOptOut!({
    inboundAt: "2026-08-26T02:00:00.000Z",
    marketingConsentAt: "2026-08-26T01:00:00.000Z",
  }), true);
  assert.equal(shouldApplyExplicitSmsOptOut!({ inboundAt: null, marketingConsentAt: null }), true);
});

test("job-closed SMS is operational only for the shared server-approved current-job body", async () => {
  const { classifyBulkSmsCategory, currentJobClosedSmsBody } = await loadPolicy();
  assert.equal(typeof classifyBulkSmsCategory, "function");
  assert.equal(typeof currentJobClosedSmsBody, "function");
  const approved = currentJobClosedSmsBody!("강남 배송원", false);
  assert.equal(
    classifyBulkSmsCategory!({
      purpose: "job_closed",
      body: approved,
      hasVerifiedCurrentJobContext: true,
      hasApprovedCurrentJobBody: true,
    }),
    "operational",
  );
  for (const body of [
    "다음 배송 기회가 생기면 문자로 알려드릴게요",
    "비슷한 업무가 생기면 연락드릴게요",
  ]) {
    assert.equal(
      classifyBulkSmsCategory!({
        purpose: "job_closed",
        body,
        hasVerifiedCurrentJobContext: true,
        hasApprovedCurrentJobBody: false,
      }),
      "promotional",
    );
  }
});

test("waitlist purpose fails closed without both verified job context and approved current-job copy", async () => {
  const { classifyBulkSmsCategory } = await loadPolicy();
  assert.equal(typeof classifyBulkSmsCategory, "function");

  const approvedCurrentJobCopy = "#{이름}님, 관심 감사합니다. 현재 순차적으로 안내드리고 있어요. 자리가 정리되는 대로 먼저 연락드릴게요! (안내 중단: '그만' 회신)";
  assert.equal(
    classifyBulkSmsCategory!({
      purpose: "waitlist",
      body: approvedCurrentJobCopy,
      hasVerifiedCurrentJobContext: false,
    }),
    "promotional",
  );
  assert.equal(
    classifyBulkSmsCategory!({
      purpose: "waitlist",
      body: "다음 채용 기회가 생기면 우선 연락드리겠습니다.",
      hasVerifiedCurrentJobContext: true,
    }),
    "promotional",
  );
  assert.equal(
    classifyBulkSmsCategory!({
      purpose: "waitlist",
      body: approvedCurrentJobCopy,
      hasVerifiedCurrentJobContext: true,
    }),
    "operational",
  );
});

test("an explicit later opt-in records consent and clears the earlier hard opt-out", async () => {
  const { marketingConsentPatchFromExplicitResponse } = await loadPolicy();
  const now = "2026-08-26T04:00:00.000Z";

  assert.equal(typeof marketingConsentPatchFromExplicitResponse, "function");
  assert.deepEqual(marketingConsentPatchFromExplicitResponse!({ active: true, response: true, now }), {
    marketing_consent: true,
    marketing_consent_at: now,
    sms_opt_out_at: null,
  });
  assert.deepEqual(marketingConsentPatchFromExplicitResponse!({ active: true, response: false, now }), {
    marketing_consent: false,
    marketing_consent_at: null,
  });
  assert.equal(marketingConsentPatchFromExplicitResponse!({ active: true, response: undefined, now }), null);
  assert.equal(marketingConsentPatchFromExplicitResponse!({ active: false, response: true, now }), null);
});

test("agent context distinguishes refusal from an unanswered marketing choice", async () => {
  const { marketingConsentStatusLabel } = await loadPolicy();

  assert.equal(typeof marketingConsentStatusLabel, "function");
  assert.equal(marketingConsentStatusLabel?.(true), "동의");
  assert.equal(marketingConsentStatusLabel?.(false), "거절");
  assert.equal(marketingConsentStatusLabel?.(null), "미확인");
  assert.equal(marketingConsentStatusLabel?.(undefined), "미확인");
  assert.equal(marketingConsentStatusLabel?.(true, "2026-08-26T00:00:00.000Z"), "수신거부");
});

test("closed-job, suspended B mart, and manual paths persist or enforce explicit consent", async () => {
  const [policy, screening, router, manualSend, bulkSend, bulkOutboxMigration] = await Promise.all([
    readFile(new URL("./sms-consent-policy.ts", import.meta.url), "utf8"),
    readFile(new URL("./agent/stages/screening.ts", import.meta.url), "utf8"),
    readFile(new URL("./agent/router.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/messages/send/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/messages/bulk-send/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/migrations/2026-09-bulk-message-outbox.sql", import.meta.url), "utf8"),
  ]);
  const closedNoticeStart = policy.indexOf("CURRENT_JOB_CLOSED_SMS_TEMPLATE");
  const suntopStart = policy.indexOf("CURRENT_JOB_CLOSED_SUNTOP_LINE", closedNoticeStart);
  const closedNotice = policy.slice(closedNoticeStart, suntopStart);

  assert.ok(closedNoticeStart >= 0);
  assert.doesNotMatch(closedNotice, /#\{맞춤링크\}|다른 공고|새 자리가 나오는 대로|가장 먼저 안내/);
  assert.match(screening, /marketing_consent\?: boolean/);
  assert.match(screening, /marketingConsentPatchFromExplicitResponse/);
  assert.match(screening, /explicitMarketingConsentResponse/);
  assert.match(screening, /marketingConsentStatusLabel/);
  assert.match(screening, /이미 거절로 표시된 지원자에게는 다시 묻/);
  const closureHistoryStart = router.indexOf("// 마감 안내 모드");
  const closureHistoryEnd = router.indexOf("// 5) Transition", closureHistoryStart);
  const closureHistory = router.slice(closureHistoryStart, closureHistoryEnd);
  assert.match(closureHistory, /event_type:\s*"waitlist_notice"/);
  assert.doesNotMatch(closureHistory, /marketing_consent\s*===\s*true/);
  assert.match(bulkSend, /finalize_bulk_message_send/);
  assert.doesNotMatch(bulkSend, /from\("pool_events"\)\.insert/);
  assert.match(
    bulkOutboxMigration,
    /v_request\.effective_purpose = 'job_closed'[\s\S]*?'waitlist_notice'/,
  );
  assert.match(manualSend, /classifyManualSmsCategory/);
  assert.match(manualSend, /body:\s*messageBody/);
  assert.match(manualSend, /marketing_consent/);
  assert.match(manualSend, /신규 일자리 문자 미동의/);
});

test("manual and dispatch sends enforce phone-level opt-out immediately before the provider", async () => {
  const [manualSend, dispatch] = await Promise.all([
    readFile(new URL("../app/api/admin/messages/send/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/jobs/[id]/dispatch/route.ts", import.meta.url), "utf8"),
  ]);
  const manualBoundary = manualSend.slice(
    manualSend.indexOf("send: async () =>"),
    manualSend.indexOf("markUnknown: async"),
  );
  const dispatchLoop = dispatch.slice(
    dispatch.indexOf("for (const c of candidates)"),
    dispatch.indexOf("return NextResponse.json", dispatch.indexOf("for (const c of candidates)")),
  );

  assert.match(manualBoundary, /fetchPhoneMessageIdentityIndex/);
  assert.match(manualBoundary, /hasActiveSmsOptOut/);
  assert.ok(manualBoundary.indexOf("hasActiveSmsOptOut") < manualBoundary.indexOf("return sendSms("));
  assert.match(dispatch, /fetchPhoneMessageIdentityIndex/);
  assert.match(dispatchLoop, /hasActiveSmsOptOut/);
  assert.ok(dispatchLoop.indexOf("hasActiveSmsOptOut") < dispatchLoop.indexOf("await sendSms("));
});

test("every automated SMS path blocks future-job promotion without effective consent", async () => {
  const [router, active, agent, webhook, applyRoute, engage] = await Promise.all([
    readFile(new URL("./agent/router.ts", import.meta.url), "utf8"),
    readFile(new URL("./agent/stages/active.ts", import.meta.url), "utf8"),
    readFile(new URL("./agent.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/webhooks/supabase-new-message/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/apply/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./agent/engage.ts", import.meta.url), "utf8"),
  ]);

  assert.match(router, /hasFutureJobPromotion/);
  assert.match(router, /sms_opt_out_at/);
  assert.ok(router.indexOf("hasFutureJobPromotion") < router.indexOf("sendSms(applicant.phone"));
  assert.match(active, /marketing_consent/);
  assert.match(active, /sms_opt_out_at/);
  assert.match(agent, /새 일자리 문자 상태/);
  assert.doesNotMatch(agent, /티오 생길 때 연락드릴게요/);
  assert.match(webhook, /hasFutureJobPromotion/);
  assert.doesNotMatch(webhook, /다른 배송·물류 업무 수요가 생기면 가장 먼저 안내/);
  assert.match(applyRoute, /inserted\.marketing_consent/);
  assert.match(engage, /hasFutureJobPromotion/);
});

test("matched inbound explicit opt-out is persisted before routing and ends the turn", async () => {
  const [webhook, router, sweeper] = await Promise.all([
    readFile(new URL("../app/api/webhooks/supabase-new-message/route.ts", import.meta.url), "utf8"),
    readFile(new URL("./agent/router.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/cron/inbound-sweeper/route.ts", import.meta.url), "utf8"),
  ]);
  const explicitOptOut = webhook.indexOf("isExplicitSmsOptOutText(text)");
  const availabilityCostGate = webhook.indexOf("await classifyAvailabilitySignal");
  const routerCall = webhook.lastIndexOf("runAgentForCandidate({");

  assert.ok(explicitOptOut >= 0);
  assert.ok(explicitOptOut < availabilityCostGate);
  assert.match(webhook.slice(explicitOptOut, routerCall), /sms_opt_out_at/);
  assert.match(webhook.slice(explicitOptOut, availabilityCostGate), /agent_invoked:\s*false/);
  assert.match(webhook.slice(explicitOptOut, availabilityCostGate), /shouldApplyExplicitSmsOptOut/);

  const routerOptOut = router.indexOf("isExplicitSmsOptOutText(inbound_text)");
  const modeLookup = router.indexOf("getAgentMode(supabase,");
  assert.ok(routerOptOut >= 0 && routerOptOut < modeLookup);
  assert.match(router.slice(routerOptOut, modeLookup), /sms_opt_out_at/);
  assert.match(router.slice(routerOptOut, modeLookup), /shouldApplyExplicitSmsOptOut/);
  assert.match(router.slice(routerOptOut, modeLookup), /agent skipped|skipped:/);
  assert.match(sweeper, /runAgentForCandidate/);
  const sweeperOptOut = sweeper.indexOf("isExplicitSmsOptOutText");
  const sweeperRoute = sweeper.indexOf("pickCandidateForInbound", sweeperOptOut);
  assert.ok(sweeperOptOut >= 0 && sweeperOptOut < sweeperRoute);
  assert.match(sweeper.slice(sweeperOptOut, sweeperRoute), /sms_opt_out_at/);
  assert.match(sweeper.slice(sweeperOptOut, sweeperRoute), /shouldApplyExplicitSmsOptOut/);
  assert.match(sweeper.slice(sweeperOptOut, sweeperRoute), /continue/);
});

test("dispatch treats only applicant-initiated current-job candidates as operational", async () => {
  const { classifyDispatchSmsCategory } = await loadPolicy();
  assert.equal(typeof classifyDispatchSmsCategory, "function");

  assert.equal(classifyDispatchSmsCategory?.({
    agentState: { meta: { entry: "web_apply" } },
    hasInterestClick: false,
  }), "operational");
  assert.equal(classifyDispatchSmsCategory?.({
    agentState: null,
    hasInterestClick: true,
  }), "operational");
  for (const agentState of [null, {}, { meta: null }, { meta: { entry: "manual" } }, "web_apply"]) {
    assert.equal(classifyDispatchSmsCategory?.({
      agentState,
      hasInterestClick: false,
    }), "promotional");
  }
});

test("waitlist bulk UI requires an explicitly selected current job before send", async () => {
  const pipeline = await readFile(
    new URL("../components/Pipeline.tsx", import.meta.url),
    "utf8",
  );
  const handler = pipeline.slice(
    pipeline.indexOf("const handleBulkSend"),
    pipeline.indexOf("const handleCardClick"),
  );

  assert.match(handler, /isWaitlist\s*&&\s*waitlistJobId\s*===\s*null/);
  assert.match(pipeline, /isWaitlistBulk\s*&&\s*waitlistJobId\s*===\s*null/);
  assert.match(pipeline, /먼저[^\n]*공고 관심자 선택/);
});
