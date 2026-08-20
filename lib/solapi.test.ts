import assert from "node:assert/strict";
import test from "node:test";

const { sendSms, sendAlimtalk, sendNotification, findSmsByClientRequestId } = await import(
  new URL("./solapi.ts", import.meta.url).href
) as typeof import("./solapi");

async function withLiveSmsEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const previous = {
    dryRun: process.env.SMS_DRY_RUN,
    apiKey: process.env.SOLAPI_API_KEY,
    apiSecret: process.env.SOLAPI_API_SECRET,
    pfId: process.env.SOLAPI_PFID,
    applyTemplate: process.env.SOLAPI_TEMPLATE_APPLY_RECEIVED,
  };
  process.env.SMS_DRY_RUN = "0";
  process.env.SOLAPI_API_KEY = "test-key";
  process.env.SOLAPI_API_SECRET = "test-secret";
  process.env.SOLAPI_PFID = "test-pf";
  try {
    return await run();
  } finally {
    if (previous.dryRun === undefined) delete process.env.SMS_DRY_RUN;
    else process.env.SMS_DRY_RUN = previous.dryRun;
    if (previous.apiKey === undefined) delete process.env.SOLAPI_API_KEY;
    else process.env.SOLAPI_API_KEY = previous.apiKey;
    if (previous.apiSecret === undefined) delete process.env.SOLAPI_API_SECRET;
    else process.env.SOLAPI_API_SECRET = previous.apiSecret;
    if (previous.pfId === undefined) delete process.env.SOLAPI_PFID;
    else process.env.SOLAPI_PFID = previous.pfId;
    if (previous.applyTemplate === undefined) delete process.env.SOLAPI_TEMPLATE_APPLY_RECEIVED;
    else process.env.SOLAPI_TEMPLATE_APPLY_RECEIVED = previous.applyTemplate;
  }
}

test("an HTTP 5xx response is delivery-unknown, not a provider-declared rejection", async () => {
  await withLiveSmsEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("temporary upstream failure", { status: 503 });
    try {
      assert.deepEqual(await sendSms("01012345678", "test message"), {
        success: false,
        failureKind: "unknown",
        error: "temporary upstream failure",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("an HTTP 200 registration failure is a provider-declared rejection", async () => {
  await withLiveSmsEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      groupInfo: { count: { registeredFailed: 1 } },
      failedMessageList: [{ statusCode: "InvalidPhoneNumber", statusMessage: "invalid phone" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    try {
      assert.deepEqual(await sendSms("01012345678", "test message"), {
        success: false,
        failureKind: "declared",
        error: "발송 등록 실패: invalid phone",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Alimtalk preserves SOLAPI's declared registration failure through notification delivery", async () => {
  await withLiveSmsEnvironment(async () => {
    process.env.SOLAPI_TEMPLATE_APPLY_RECEIVED = "apply-template";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      groupInfo: { count: { registeredFailed: 1 } },
      failedMessageList: [{ statusCode: "NotEnoughBalance", statusMessage: "insufficient balance" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    try {
      assert.deepEqual(
        await sendAlimtalk("01012345678", "apply-template", {}, "fallback"),
        {
          success: false,
          failureKind: "declared",
          error: "발송 등록 실패: insufficient balance",
        },
      );
      assert.deepEqual(
        await sendNotification("01012345678", "APPLY_RECEIVED", {}, "fallback"),
        {
          success: false,
          failureKind: "declared",
          error: "발송 등록 실패: insufficient balance",
          via: "alimtalk",
          templateId: "apply-template",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("an Alimtalk HTTP error remains delivery-unknown", async () => {
  await withLiveSmsEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("temporary upstream failure", { status: 503 });
    try {
      assert.deepEqual(await sendAlimtalk("01012345678", "apply-template", {}, "fallback"), {
        success: false,
        failureKind: "unknown",
        error: "temporary upstream failure",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a manual SMS carries its pre-persisted request id in provider custom fields", async () => {
  await withLiveSmsEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        groupInfo: { groupId: "provider-group-1", count: { registeredFailed: 0 } },
        failedMessageList: [],
        messageList: [{ messageId: "provider-message-1", statusCode: "2000" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      const correlatedSend = sendSms as unknown as (
        to: string,
        text: string,
        subject: string | undefined,
        options: { clientRequestId: string }
      ) => ReturnType<typeof sendSms>;
      await correlatedSend(
        "01012345678",
        "복구 가능한 수동 메시지",
        undefined,
        { clientRequestId: "41f82761-a37a-4f6f-8ad5-8b6b93acb8c1" }
      );

      const messages = (
        (requestBody as Record<string, unknown> | null)?.messages
      ) as Array<Record<string, unknown>>;
      assert.deepEqual(messages[0]?.customFields, {
        ongboardingRequestId: "41f82761-a37a-4f6f-8ad5-8b6b93acb8c1",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("provider reconciliation accepts only the exact custom-field correlation", async () => {
  await withLiveSmsEnvironment(async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      messageList: {
        "same-recipient-only": {
          messageId: "same-recipient-only",
          to: "01012345678",
          text: "같은 본문",
          customFields: {},
        },
        "wrong-correlation": {
          messageId: "wrong-correlation",
          to: "01012345678",
          text: "같은 본문",
          customFields: { ongboardingRequestId: "different-request" },
        },
        "exact-correlation": {
          messageId: "exact-correlation",
          to: "01012345678",
          text: "같은 본문",
          customFields: {
            ongboardingRequestId: "41f82761-a37a-4f6f-8ad5-8b6b93acb8c1",
          },
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const result = await findSmsByClientRequestId({
      phone: "01012345678",
      clientRequestId: "41f82761-a37a-4f6f-8ad5-8b6b93acb8c1",
      createdAt: "2026-08-20T01:00:00.000Z",
      fetchImpl,
    });
    assert.deepEqual(result, { kind: "found", messageId: "exact-correlation" });
  });
});

test("provider reconciliation preserves unknown when no exact correlation is visible", async () => {
  await withLiveSmsEnvironment(async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      messageList: {
        "same-recipient-only": {
          messageId: "same-recipient-only",
          to: "01012345678",
          customFields: {},
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const result = await findSmsByClientRequestId({
      phone: "01012345678",
      clientRequestId: "41f82761-a37a-4f6f-8ad5-8b6b93acb8c1",
      createdAt: "2026-08-20T01:00:00.000Z",
      fetchImpl,
    });
    assert.deepEqual(result, { kind: "not_found" });
  });
});

test("provider reconciliation searches a bounded window around the original send", async () => {
  await withLiveSmsEnvironment(async () => {
    let requestedUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ messageList: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const createdAt = "2026-08-20T01:00:00.000Z";

    await findSmsByClientRequestId({
      phone: "01012345678",
      clientRequestId: "41f82761-a37a-4f6f-8ad5-8b6b93acb8c1",
      createdAt,
      fetchImpl,
    });

    const params = new URL(requestedUrl).searchParams;
    assert.equal(params.get("startDate"), "2026-08-20T00:50:00.000Z");
    assert.equal(params.get("endDate"), "2026-08-20T01:30:00.000Z");
  });
});
