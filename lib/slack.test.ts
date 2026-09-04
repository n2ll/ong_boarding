import assert from "node:assert/strict";
import test from "node:test";

const previousEnabledAtImport = process.env.SLACK_NOTIFICATIONS_ENABLED;
process.env.SLACK_NOTIFICATIONS_ENABLED = "0";
const {
  getSlackNotificationStatus,
  sendSlackAgentAlert,
  sendSlackOnboardingHandoff,
  sendSlackOnboardingReady,
  sendSlackPausedAlert,
  sendSlackText,
} = await import(new URL("./slack.ts", import.meta.url).href) as typeof import("./slack");
if (previousEnabledAtImport === undefined) delete process.env.SLACK_NOTIFICATIONS_ENABLED;
else process.env.SLACK_NOTIFICATIONS_ENABLED = previousEnabledAtImport;

async function withSlackEnvironment<T>(
  enabled: "0" | "1",
  run: () => Promise<T>,
  webhookUrl: string | null = "https://hooks.slack.test/services/test",
  vercelEnv: string | null = null,
): Promise<T> {
  const previous = {
    enabled: process.env.SLACK_NOTIFICATIONS_ENABLED,
    webhookUrl: process.env.SLACK_WEBHOOK_URL,
    vercelEnv: process.env.VERCEL_ENV,
  };
  process.env.SLACK_NOTIFICATIONS_ENABLED = enabled;
  if (webhookUrl === null) delete process.env.SLACK_WEBHOOK_URL;
  else process.env.SLACK_WEBHOOK_URL = webhookUrl;
  if (vercelEnv === null) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = vercelEnv;
  try {
    return await run();
  } finally {
    if (previous.enabled === undefined) delete process.env.SLACK_NOTIFICATIONS_ENABLED;
    else process.env.SLACK_NOTIFICATIONS_ENABLED = previous.enabled;
    if (previous.webhookUrl === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = previous.webhookUrl;
    if (previous.vercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous.vercelEnv;
  }
}

test("Slack status distinguishes a disabled switch from a missing webhook", () => {
  assert.deepEqual(getSlackNotificationStatus({}), {
    enabled: false,
    webhookConfigured: false,
    active: false,
  });
  assert.deepEqual(getSlackNotificationStatus({
    SLACK_NOTIFICATIONS_ENABLED: "0",
    SLACK_WEBHOOK_URL: "https://hooks.slack.test/services/test",
  }), {
    enabled: false,
    webhookConfigured: true,
    active: false,
  });
  assert.deepEqual(getSlackNotificationStatus({
    SLACK_NOTIFICATIONS_ENABLED: "1",
  }), {
    enabled: true,
    webhookConfigured: false,
    active: false,
  });
  assert.deepEqual(getSlackNotificationStatus({
    SLACK_NOTIFICATIONS_ENABLED: "1",
    SLACK_WEBHOOK_URL: "  https://hooks.slack.test/services/test  ",
  }), {
    enabled: true,
    webhookConfigured: true,
    active: true,
  });
});

test("the global OFF switch prevents every Slack notification from leaving the server", async () => {
  await withSlackEnvironment("0", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("ok", { status: 200 });
    };
    try {
      assert.equal(await sendSlackText("automation alert"), false);
      await sendSlackOnboardingReady({
        applicant_name: "테스트 지원자",
        applicant_phone: "01000000000",
        branch: "테스트 지점",
        work_hours: "오전",
      });
      await sendSlackPausedAlert({
        applicant_name: "테스트 지원자",
        applicant_phone: "01000000000",
        branch: "테스트 지점",
        reason: "매니저 확인 필요",
      });
      assert.deepEqual(await sendSlackOnboardingHandoff({
        applicant_name: "테스트 지원자",
        applicant_phone: "01000000000",
        branch: "테스트 지점",
      }), { kind: "disabled", reason: "switch_off" });
      await sendSlackAgentAlert({
        applicant_name: "테스트 지원자",
        applicant_phone: "01000000000",
        branch: "테스트 지점",
        inbound_text: "문의",
        missing_info: "운영 정보",
      });

      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Vercel Preview prevents every Slack notification from leaving the server", async () => {
  await withSlackEnvironment("1", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("ok", { status: 200 });
    };
    try {
      assert.equal(await sendSlackText("preview automation alert"), false);
      await sendSlackOnboardingReady({
        applicant_name: "테스트 지원자",
        applicant_phone: "01000000000",
        branch: "테스트 지점",
        work_hours: "오전",
      });
      await sendSlackPausedAlert({
        applicant_name: "테스트 지원자",
        applicant_phone: "01000000000",
        branch: "테스트 지점",
        reason: "매니저 확인 필요",
      });
      assert.deepEqual(await sendSlackOnboardingHandoff({
        applicant_name: "테스트 지원자",
        applicant_phone: "01000000000",
        branch: "테스트 지점",
      }), { kind: "disabled", reason: "switch_off" });
      await sendSlackAgentAlert({
        applicant_name: "테스트 지원자",
        applicant_phone: "01000000000",
        branch: "테스트 지점",
        inbound_text: "문의",
        missing_info: "운영 정보",
      });

      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, "https://hooks.slack.test/services/test", "preview");
});

test("the global ON switch allows Slack delivery when a webhook is configured", async () => {
  await withSlackEnvironment("1", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      assert.equal(await sendSlackText("automation alert"), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("an onboarding handoff is only reported as delivered after Slack accepts it", async () => {
  await withSlackEnvironment("1", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    try {
      assert.deepEqual(await sendSlackOnboardingHandoff({
        applicant_name: "테스트 지원자",
        applicant_phone: "01000000000",
        branch: "테스트 지점",
      }), { kind: "failed", error: "Slack returned HTTP 503" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("the global ON switch still sends nothing when the webhook is missing", async () => {
  await withSlackEnvironment("1", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("ok", { status: 200 });
    };
    try {
      assert.equal(await sendSlackText("automation alert"), false);
      assert.deepEqual(await sendSlackOnboardingHandoff({
        applicant_name: "테스트 지원자",
        applicant_phone: "01000000000",
        branch: "테스트 지점",
      }), { kind: "failed", error: "Slack webhook is not configured" });
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, null);
});

test("a successful onboarding handoff reports delivery", async () => {
  await withSlackEnvironment("1", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    try {
      assert.deepEqual(await sendSlackOnboardingHandoff({
        applicant_name: "테스트 지원자",
        applicant_phone: "01000000000",
        branch: "테스트 지점",
      }), { kind: "delivered" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a network failure leaves the onboarding handoff retryable", async () => {
  await withSlackEnvironment("1", async () => {
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    console.error = () => {};
    try {
      assert.deepEqual(await sendSlackOnboardingHandoff({
        applicant_name: "테스트 지원자",
        applicant_phone: "01000000000",
        branch: "테스트 지점",
      }), { kind: "failed", error: "network down" });
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalConsoleError;
    }
  });
});
