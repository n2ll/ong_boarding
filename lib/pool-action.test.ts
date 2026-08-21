import assert from "node:assert/strict";
import test from "node:test";

type PoolActionResult =
  | { ok: true }
  | { ok: false; error: string; retryable: boolean };

type PoolActionFetcher = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

type SubmitPoolAction = (
  input: {
    token: string;
    jobId: number;
    action: "interest" | "notify";
    immediate?: boolean;
    actionId: string;
  },
  fetcher?: PoolActionFetcher,
  timeoutMs?: number,
) => Promise<PoolActionResult>;

type PoolActionAttempt = {
  key: string;
  actionId: string;
};

type PoolActionAttemptInput = {
  jobId: number;
  action: "interest" | "notify";
  immediate?: boolean;
};

type PoolLoadFailure = "invalid-link" | "retryable";

async function loadPoolActionModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./pool-action.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("interest action sends the expected endpoint and immediate payload", async () => {
  const poolActionModule = await loadPoolActionModule();
  const submitPoolAction = poolActionModule.submitPoolAction as SubmitPoolAction | undefined;
  let request: { url: string; init?: RequestInit } | undefined;
  const fetcher: PoolActionFetcher = async (url, init) => {
    request = { url, init };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  assert.equal(typeof submitPoolAction, "function");
  const result = await submitPoolAction!(
    {
      token: "sample-token",
      jobId: 17,
      action: "interest",
      immediate: true,
      actionId: "11111111-1111-4111-8111-111111111111",
    },
    fetcher,
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(request?.url, "/api/pool/sample-token/interest");
  assert.equal(request?.init?.method, "POST");
  assert.deepEqual(request?.init?.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    job_id: 17,
    immediate: true,
    action_id: "11111111-1111-4111-8111-111111111111",
  });
});

test("non-retryable server error is preserved so the applicant knows what happened", async () => {
  const poolActionModule = await loadPoolActionModule();
  const submitPoolAction = poolActionModule.submitPoolAction as SubmitPoolAction | undefined;

  assert.equal(typeof submitPoolAction, "function");
  const result = await submitPoolAction!(
    {
      token: "sample-token",
      jobId: 18,
      action: "notify",
      actionId: "22222222-2222-4222-8222-222222222222",
    },
    async () => ({ ok: false, status: 400, json: async () => ({ error: "이미 마감된 공고예요." }) }),
  );

  assert.deepEqual(result, {
    ok: false,
    error: "이미 마감된 공고예요.",
    retryable: false,
  });
});

test("durable write failure is explicitly retryable", async () => {
  const poolActionModule = await loadPoolActionModule();
  const submitPoolAction = poolActionModule.submitPoolAction as SubmitPoolAction | undefined;

  assert.equal(typeof submitPoolAction, "function");
  const result = await submitPoolAction!(
    {
      token: "sample-token",
      jobId: 18,
      action: "notify",
      actionId: "33333333-3333-4333-8333-333333333333",
    },
    async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "요청을 저장하지 못했어요." }),
    }),
  );

  assert.deepEqual(result, {
    ok: false,
    error: "요청을 저장하지 못했어요.",
    retryable: true,
  });
});

test("network failure returns a recoverable inline message", async () => {
  const poolActionModule = await loadPoolActionModule();
  const submitPoolAction = poolActionModule.submitPoolAction as SubmitPoolAction | undefined;

  assert.equal(typeof submitPoolAction, "function");
  const result = await submitPoolAction!(
    {
      token: "sample-token",
      jobId: 19,
      action: "interest",
      actionId: "44444444-4444-4444-8444-444444444444",
    },
    async () => {
      throw new Error("network unavailable");
    },
  );

  assert.deepEqual(result, {
    ok: false,
    error: "처리하지 못했어요. 잠시 후 다시 시도해주세요.",
    retryable: true,
  });
});

test("a timed-out action explains that retrying reuses the same request", async () => {
  const poolActionModule = await loadPoolActionModule();
  const submitPoolAction = poolActionModule.submitPoolAction as SubmitPoolAction | undefined;

  assert.equal(typeof submitPoolAction, "function");
  const result = await submitPoolAction!(
    {
      token: "sample-token",
      jobId: 20,
      action: "interest",
      actionId: "45454545-4545-4545-8545-454545454545",
    },
    (_url, init) => new Promise<never>((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }),
    5,
  );

  assert.deepEqual(result, {
    ok: false,
    error: "처리가 지연되고 있어요. 같은 요청으로 다시 시도하면 중복 없이 확인합니다.",
    retryable: true,
  });
});

test("a failed action reuses its idempotency key until durable success", async () => {
  const poolActionModule = await loadPoolActionModule();
  const getPoolActionAttempt = poolActionModule.getPoolActionAttempt as
    ((
      attempts: Map<string, string>,
      input: PoolActionAttemptInput,
      createId: () => string,
    ) => PoolActionAttempt) | undefined;
  const clearPoolActionAttempt = poolActionModule.clearPoolActionAttempt as
    ((attempts: Map<string, string>, key: string) => void) | undefined;
  const attempts = new Map<string, string>();
  const ids = [
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
  ];
  const createId = () => ids.shift() as string;

  assert.equal(typeof getPoolActionAttempt, "function");
  assert.equal(typeof clearPoolActionAttempt, "function");
  const first = getPoolActionAttempt!(attempts, { jobId: 21, action: "interest" }, createId);
  const retry = getPoolActionAttempt!(attempts, { jobId: 21, action: "interest" }, createId);

  assert.deepEqual(retry, first);
  assert.equal(ids.length, 1);

  clearPoolActionAttempt!(attempts, first.key);
  const afterSuccess = getPoolActionAttempt!(attempts, { jobId: 21, action: "interest" }, createId);
  assert.notEqual(afterSuccess.actionId, first.actionId);
});

test("ordinary interest and immediate availability use separate idempotency keys", async () => {
  const poolActionModule = await loadPoolActionModule();
  const getPoolActionAttempt = poolActionModule.getPoolActionAttempt as
    ((
      attempts: Map<string, string>,
      input: PoolActionAttemptInput,
      createId: () => string,
    ) => PoolActionAttempt) | undefined;
  const attempts = new Map<string, string>();
  const ids = [
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888",
  ];

  assert.equal(typeof getPoolActionAttempt, "function");
  const interest = getPoolActionAttempt!(attempts, { jobId: 22, action: "interest" }, () => ids.shift() as string);
  const immediate = getPoolActionAttempt!(
    attempts,
    { jobId: 22, action: "interest", immediate: true },
    () => ids.shift() as string,
  );

  assert.notEqual(immediate.key, interest.key);
  assert.notEqual(immediate.actionId, interest.actionId);
});

test("initial pool load separates an invalid link from a retryable server failure", async () => {
  const poolActionModule = await loadPoolActionModule();
  const poolLoadFailure = poolActionModule.poolLoadFailure as
    ((status: number) => PoolLoadFailure) | undefined;

  assert.equal(typeof poolLoadFailure, "function");
  assert.equal(poolLoadFailure!(400), "invalid-link");
  assert.equal(poolLoadFailure!(404), "invalid-link");
  assert.equal(poolLoadFailure!(500), "retryable");
  assert.equal(poolLoadFailure!(503), "retryable");
});
