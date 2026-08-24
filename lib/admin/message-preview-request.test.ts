import assert from "node:assert/strict";
import test from "node:test";

type PreviewMap = Record<number, { body: string; direction: string; created_at: string }>;

type PreviewFetcher = (url: string, init?: RequestInit) => Promise<Response>;

type FetchMessagePreviews = (
  ids: number[],
  options?: { fetcher?: PreviewFetcher; signal?: AbortSignal },
) => Promise<PreviewMap>;

type ParsePreviewRequestIds = (value: unknown) =>
  | { ok: true; ids: number[] }
  | { ok: false; status: 400 | 413 };

async function loadRequestModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./message-preview-request.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("preview client uses bounded POST batches and merges every successful response", async () => {
  const requestModule = await loadRequestModule();
  const fetchMessagePreviews = requestModule.fetchMessagePreviews as FetchMessagePreviews | undefined;
  const ids = [...Array.from({ length: 1_001 }, (_, index) => index + 1), 1_001];
  const controller = new AbortController();
  const requests: number[][] = [];
  let activeRequests = 0;
  let maxConcurrentRequests = 0;

  const fetcher: PreviewFetcher = async (url, init) => {
    assert.equal(url, "/api/admin/messages/preview");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, { "Content-Type": "application/json" });
    assert.equal(init?.signal, controller.signal);

    const body = JSON.parse(String(init?.body)) as { ids: number[] };
    requests.push(body.ids);
    activeRequests += 1;
    maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 2));
    activeRequests -= 1;

    const previews = Object.fromEntries(body.ids.map((id) => [id, {
      body: `message-${id}`,
      direction: "inbound",
      created_at: "2026-08-24T00:00:00.000Z",
    }]));
    return Response.json({ previews });
  };

  assert.equal(typeof fetchMessagePreviews, "function");
  const previews = await fetchMessagePreviews!(ids, { fetcher, signal: controller.signal });

  assert.equal(requests.length, 5);
  assert.equal(requests.every((batch) => batch.length <= 250), true);
  assert.equal(maxConcurrentRequests, 3);
  assert.equal(Object.keys(previews).length, 1_001);
  assert.equal(previews[1_001]?.body, "message-1001");
});

test("preview client rejects the whole lookup when any batch fails", async () => {
  const requestModule = await loadRequestModule();
  const fetchMessagePreviews = requestModule.fetchMessagePreviews as FetchMessagePreviews | undefined;
  let requestCount = 0;

  assert.equal(typeof fetchMessagePreviews, "function");
  await assert.rejects(
    fetchMessagePreviews!(
      Array.from({ length: 501 }, (_, index) => index + 1),
      {
        fetcher: async (_url, init) => {
          requestCount += 1;
          if (requestCount === 2) return Response.json({ error: "unavailable" }, { status: 503 });
          const { ids } = JSON.parse(String(init?.body)) as { ids: number[] };
          return Response.json({ previews: Object.fromEntries(ids.map((id) => [id, { body: "ok" }])) });
        },
      },
    ),
    /preview 503/,
  );
});

test("preview client rejects incomplete or malformed successful responses", async () => {
  const requestModule = await loadRequestModule();
  const fetchMessagePreviews = requestModule.fetchMessagePreviews as FetchMessagePreviews | undefined;
  const validPreview = {
    body: "hello",
    direction: "inbound",
    created_at: "2026-08-24T00:00:00.000Z",
  };

  assert.equal(typeof fetchMessagePreviews, "function");
  await assert.rejects(
    fetchMessagePreviews!([1, 2], {
      fetcher: async () => Response.json({ previews: { 1: validPreview } }),
    }),
    /invalid preview response/,
  );
  await assert.rejects(
    fetchMessagePreviews!([1], {
      fetcher: async () => Response.json({ previews: { 1: { ...validPreview, direction: "" } } }),
    }),
    /invalid preview response/,
  );
});

test("aborting the first request wave prevents later preview batches from starting", async () => {
  const requestModule = await loadRequestModule();
  const fetchMessagePreviews = requestModule.fetchMessagePreviews as FetchMessagePreviews | undefined;
  const controller = new AbortController();
  let startedRequests = 0;

  assert.equal(typeof fetchMessagePreviews, "function");
  const lookup = fetchMessagePreviews!(
    Array.from({ length: 1_001 }, (_, index) => index + 1),
    {
      signal: controller.signal,
      fetcher: async (_url, init) => {
        startedRequests += 1;
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(startedRequests, 3);
  controller.abort();
  await assert.rejects(lookup, (error: unknown) => (
    error instanceof DOMException && error.name === "AbortError"
  ));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(startedRequests, 3);
});

test("preview API parser deduplicates valid IDs and rejects malformed or oversized batches", async () => {
  const requestModule = await loadRequestModule();
  const parsePreviewRequestIds = requestModule.parsePreviewRequestIds as ParsePreviewRequestIds | undefined;

  assert.equal(typeof parsePreviewRequestIds, "function");
  assert.deepEqual(parsePreviewRequestIds!([3, 1, 3]), { ok: true, ids: [3, 1] });
  assert.deepEqual(parsePreviewRequestIds!("3,1"), { ok: false, status: 400 });
  assert.deepEqual(parsePreviewRequestIds!([0, 1]), { ok: false, status: 400 });
  assert.deepEqual(
    parsePreviewRequestIds!(Array.from({ length: 251 }, (_, index) => index + 1)),
    { ok: false, status: 413 },
  );
});
