import assert from "node:assert/strict";
import test from "node:test";

type FocusResult =
  | { ok: true; focusJobId: number | null; engage: string }
  | { ok: false; error: string; retryable: boolean };
type Fetcher = (url: string, init?: RequestInit) => Promise<{
  ok: boolean; status: number; json: () => Promise<unknown>;
}>;
type SubmitFocus = (
  input: { token: string; jobId: number; actionId: string },
  fetcher: Fetcher,
  timeoutMs?: number,
) => Promise<FocusResult>;

async function loadPoolActionModule(): Promise<Record<string, unknown>> {
  const modulePath = "./pool-action.ts";
  return await import(modulePath) as Record<string, unknown>;
}

const input = { token: "applicant-token", jobId: 22, actionId: "11111111-1111-4111-8111-111111111111" };

test("a focus switch uses its own durable endpoint and returns the selected job", async () => {
  const poolAction = await loadPoolActionModule();
  const submit = poolAction.submitPoolConversationFocus as SubmitFocus | undefined;
  const requests: { url: string; init?: RequestInit }[] = [];
  assert.equal(typeof submit, "function");
  const result = await submit!(input, async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ focus_job_id: 22, engage: "engaged" }) };
  });
  assert.deepEqual(result, { ok: true, focusJobId: 22, engage: "engaged" });
  assert.equal(requests[0].url, "/api/pool/applicant-token/focus");
  assert.equal(requests[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { job_id: 22, action_id: input.actionId });
});

for (const focusJobId of [11, null]) {
  test(`a replay returns current focus ${focusJobId} rather than the old requested job`, async () => {
    const poolAction = await loadPoolActionModule();
    const submit = poolAction.submitPoolConversationFocus as SubmitFocus | undefined;
    assert.equal(typeof submit, "function");
    const result = await submit!(input, async () => ({
      ok: true, status: 200, json: async () => ({ focus_job_id: focusJobId, engage: "off" }),
    }));
    assert.deepEqual(result, { ok: true, focusJobId, engage: "off" });
  });
}

for (const status of [409, 503]) {
  test(`focus failure ${status} preserves the server message and retry decision`, async () => {
    const poolAction = await loadPoolActionModule();
    const submit = poolAction.submitPoolConversationFocus as SubmitFocus | undefined;
    assert.equal(typeof submit, "function");
    const result = await submit!(input, async () => ({
      ok: false, status, json: async () => ({ error: "이전 문자 처리를 확인 중이에요." }),
    }));
    assert.deepEqual(result, {
      ok: false, error: "이전 문자 처리를 확인 중이에요.", retryable: status === 503,
    });
  });
}

test("a focus timeout can resume the same durable request without changing actions", async () => {
  const poolAction = await loadPoolActionModule();
  const submit = poolAction.submitPoolConversationFocus as SubmitFocus | undefined;
  assert.equal(typeof submit, "function");
  const result = await submit!(input, (_url, init) => new Promise<never>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), 5);
  assert.deepEqual(result, {
    ok: false,
    error: "처리가 지연되고 있어요. 같은 요청으로 다시 시도하면 중복 없이 확인합니다.",
    retryable: true,
  });
});

test("interest-only is sent explicitly even for the immediate-availability follow-up", async () => {
  const poolAction = await loadPoolActionModule();
  const submit = poolAction.submitPoolAction as (
    requestInput: typeof input & { action: "interest"; interestOnly: boolean; immediate?: boolean },
    fetcher: Fetcher,
  ) => Promise<{ ok: boolean }>;
  const requests: { url: string; init?: RequestInit }[] = [];
  const result = await submit({ ...input, action: "interest", interestOnly: true, immediate: true }, async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(requests[0].url, "/api/pool/applicant-token/interest");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    job_id: 22, action_id: input.actionId, immediate: true, interest_only: true,
  });
});

test("focus and interest modes have separate keys and retry within the same mode", async () => {
  const poolAction = await loadPoolActionModule();
  const attempt = poolAction.getPoolActionAttempt as (
    attempts: Map<string, string>,
    input: { jobId: number; action: "interest" | "focus"; interestOnly?: boolean },
    createId: () => string,
  ) => { key: string; actionId: string };
  const attempts = new Map<string, string>();
  let sequence = 0;
  const createId = () => `action-${++sequence}`;
  const ordinary = attempt(attempts, { jobId: 22, action: "interest" }, createId);
  const interestOnly = attempt(attempts, { jobId: 22, action: "interest", interestOnly: true }, createId);
  const focus = attempt(attempts, { jobId: 22, action: "focus" }, createId);
  assert.equal(new Set([ordinary.key, interestOnly.key, focus.key]).size, 3);
  assert.deepEqual(attempt(attempts, { jobId: 22, action: "focus" }, createId), focus);
  assert.deepEqual(attempt(attempts, { jobId: 22, action: "interest", interestOnly: true }, createId), interestOnly);
});
