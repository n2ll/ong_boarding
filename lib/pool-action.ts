const GENERIC_POOL_ACTION_ERROR = "처리하지 못했어요. 잠시 후 다시 시도해주세요.";

type PoolActionInput = {
  jobId: number;
  action: "interest" | "notify";
  immediate?: boolean;
};

function poolActionAttemptKey(input: PoolActionInput): string {
  return `${input.action}:${input.jobId}:${input.immediate === true ? "immediate" : "standard"}`;
}

export function getPoolActionAttempt(
  attempts: Map<string, string>,
  input: PoolActionInput,
  createId: () => string = () => crypto.randomUUID(),
): { key: string; actionId: string } {
  const key = poolActionAttemptKey(input);
  const existing = attempts.get(key);
  if (existing) return { key, actionId: existing };
  const actionId = createId();
  attempts.set(key, actionId);
  return { key, actionId };
}

export function clearPoolActionAttempt(attempts: Map<string, string>, key: string): void {
  attempts.delete(key);
}

export function poolLoadFailure(status: number): "invalid-link" | "retryable" {
  return status === 400 || status === 404 ? "invalid-link" : "retryable";
}

type PoolActionFetcher = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export async function submitPoolAction(
  input: {
    token: string;
    jobId: number;
    action: "interest" | "notify";
    immediate?: boolean;
    actionId: string;
  },
  fetcher: PoolActionFetcher = fetch,
): Promise<{ ok: true } | { ok: false; error: string; retryable: boolean }> {
  try {
    const payload = input.immediate
      ? { job_id: input.jobId, immediate: true, action_id: input.actionId }
      : { job_id: input.jobId, action_id: input.actionId };
    const response = await fetcher(`/api/pool/${input.token}/${input.action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.ok) return { ok: true };

    const body = await response.json().catch(() => null);
    const error = body && typeof body === "object" && "error" in body
      ? (body as { error?: unknown }).error
      : null;

    return {
      ok: false,
      error: typeof error === "string" && error.trim() ? error.trim() : GENERIC_POOL_ACTION_ERROR,
      retryable: response.status >= 500,
    };
  } catch {
    return { ok: false, error: GENERIC_POOL_ACTION_ERROR, retryable: true };
  }
}
