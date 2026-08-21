import assert from "node:assert/strict";
import test from "node:test";

type RequestTimeoutModule = {
  requestWithTimeout?: <T>(
    request: (signal: AbortSignal) => Promise<T>,
    timeoutMs?: number,
  ) => Promise<T>;
  isRequestTimeoutError?: (error: unknown) => boolean;
};

async function loadRequestTimeoutModule(): Promise<RequestTimeoutModule> {
  try {
    const modulePath = "./request-timeout.ts";
    return await import(modulePath) as RequestTimeoutModule;
  } catch {
    return {};
  }
}

test("a timed-out request is aborted and reported distinctly", async () => {
  const { requestWithTimeout, isRequestTimeoutError } = await loadRequestTimeoutModule();
  let wasAborted = false;

  assert.equal(typeof requestWithTimeout, "function");
  assert.equal(typeof isRequestTimeoutError, "function");
  await assert.rejects(
    requestWithTimeout!((signal) => {
      return new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => {
          wasAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    }, 5),
    (error: unknown) => isRequestTimeoutError!(error),
  );
  assert.equal(wasAborted, true);
});

test("a request that settles before the deadline returns normally", async () => {
  const { requestWithTimeout } = await loadRequestTimeoutModule();

  assert.equal(typeof requestWithTimeout, "function");
  assert.equal(await requestWithTimeout!(async () => "loaded", 50), "loaded");
});
