import assert from "node:assert/strict";
import test from "node:test";

type GatherMessagePreviews = (
  supabase: unknown,
  ids: number[],
  options?: {
    withManual?: boolean;
    throwOnCoreError?: boolean;
    requireComplete?: boolean;
  },
) => Promise<Record<number, { body?: string; direction?: string; last_inbound_at?: string | null; message_id?: number | string; reply_completed?: boolean; handoff_required?: boolean }>>;

type LivePreviewTargetIds = (
  applicants: ({ id: number } & Record<string, unknown>)[],
  now?: number,
) => number[];

async function loadGather(): Promise<GatherMessagePreviews | undefined> {
  try {
    const previewModule = await import(new URL("./message-preview.ts", import.meta.url).href);
    return previewModule.gatherMessagePreviews as GatherMessagePreviews;
  } catch {
    return undefined;
  }
}

async function loadTargetSelector(): Promise<LivePreviewTargetIds | undefined> {
  try {
    const previewModule = await import(new URL("./message-preview.ts", import.meta.url).href);
    return previewModule.livePreviewTargetIds as LivePreviewTargetIds;
  } catch {
    return undefined;
  }
}

function failingMessageClient() {
  const query = {
    select() { return this; },
    in() { return this; },
    order() { return this; },
    range() { return Promise.resolve({ data: null, error: new Error("messages unavailable") }); },
  };
  return { from: () => query };
}

function boundedPreviewClient(options: {
  maxIdsPerRequest?: number;
  failManual?: boolean;
  failDraft?: boolean;
  failStatus?: string;
  completionRows?: Record<string, any>[];
  candidateRows?: Record<string, any>[];
  failMessageApplicantId?: number;
  failMessageFrom?: number;
  delayMs?: number;
  messageRows?: {
    id: number | string;
    applicant_id: number;
    body: string;
    direction: string;
    created_at: string;
    sent_by: string | null;
  }[];
} = {}) {
  const maxIdsPerRequest = options.maxIdsPerRequest ?? Number.POSITIVE_INFINITY;
  const stats = { activeRequests: 0, maxConcurrentRequests: 0 };

  function respond<T>(value: T): Promise<T> {
    if (!options.delayMs) return Promise.resolve(value);
    stats.activeRequests += 1;
    stats.maxConcurrentRequests = Math.max(stats.maxConcurrentRequests, stats.activeRequests);
    return new Promise((resolve) => {
      setTimeout(() => {
        stats.activeRequests -= 1;
        resolve(value);
      }, options.delayMs);
    });
  }

  return {
    stats,
    from(table: string) {
      const state: {
        applicantIds: number[];
        direction: string | null;
        equalities: Array<[string, unknown]>;
        messageIds: unknown[] | null;
        orders: { column: string; ascending: boolean }[];
      } = {
        applicantIds: [],
        direction: null,
        equalities: [],
        messageIds: null,
        orders: [],
      };
      const query = {
        select() { return this; },
        eq(column: string, value: string) {
          if (column === "direction") state.direction = value;
          state.equalities.push([column, value]);
          return this;
        },
        gte() { return this; },
        not() { return this; },
        in(column: string, values: unknown[]) {
          if (column === "applicant_id") state.applicantIds = values as number[];
          if (column === "meta->>message_id") state.messageIds = values;
          return this;
        },
        order(column: string, config?: { ascending?: boolean }) {
          state.orders.push({ column, ascending: config?.ascending !== false });
          return this;
        },
        range(from: number, to: number) {
          if (table === "pool_events" || table === "job_candidates") {
            if (state.applicantIds.length > maxIdsPerRequest) return respond({ data: null, error: new Error("status applicant id request too large") });
            if (options.failStatus === table) return respond({ data: null, error: new Error(`${table} unavailable`) });
            const rows = table === "pool_events" ? options.completionRows ?? [] : options.candidateRows ?? [];
            return respond({ data: rows.filter(row => state.applicantIds.includes(row.applicant_id)
              && state.equalities.every(([key, value]) => row[key] === value)
              && (!state.messageIds || state.messageIds.includes(String(row.meta?.message_id))))
              .slice(from, to + 1), error: null });
          }
          if (table === "messages" && state.direction === "outbound") {
            if (options.failManual) {
              return respond({ data: null, error: new Error("manual discovery unavailable") });
            }
            return respond({ data: [], error: null });
          }
          if (state.applicantIds.length > maxIdsPerRequest) {
            return respond({ data: null, error: new Error("applicant id request too large") });
          }
          if (table === "message_drafts") {
            if (options.failDraft) {
              return respond({ data: null, error: new Error("drafts unavailable") });
            }
            return respond({ data: [], error: null });
          }
          if (
            options.failMessageApplicantId !== undefined
            && state.applicantIds.includes(options.failMessageApplicantId)
          ) {
            return respond({ data: null, error: new Error("message batch unavailable") });
          }
          if (options.failMessageFrom !== undefined && from >= options.failMessageFrom) {
            return respond({ data: null, error: new Error("message page unavailable") });
          }
          const rows = options.messageRows?.filter((row) => state.applicantIds.includes(row.applicant_id))
            ?? state.applicantIds.map((applicantId) => ({
              id: applicantId,
              applicant_id: applicantId,
              body: `message-${applicantId}`,
              direction: "inbound",
              created_at: "2026-08-24T00:00:00.000Z",
              sent_by: null,
            }));
          const orderedRows = [...rows].sort((left, right) => {
            for (const order of state.orders) {
              const leftValue = (left as unknown as Record<string, string | number | null>)[order.column];
              const rightValue = (right as unknown as Record<string, string | number | null>)[order.column];
              if (leftValue === rightValue) continue;
              const comparison = (leftValue ?? "") < (rightValue ?? "") ? -1 : 1;
              return order.ascending ? comparison : -comparison;
            }
            return 0;
          });
          return respond({ data: orderedRows.slice(from, to + 1), error: null });
        },
      };
      return query;
    },
  };
}

test("strict preview callers can distinguish a core query failure from a true empty result", async () => {
  const gatherMessagePreviews = await loadGather();

  assert.equal(typeof gatherMessagePreviews, "function");
  await assert.rejects(
    gatherMessagePreviews!(failingMessageClient(), [1], { throwOnCoreError: true }),
    /messages unavailable/,
  );
});

test("legacy supplementary callers keep the existing empty fallback", async () => {
  const gatherMessagePreviews = await loadGather();

  assert.equal(typeof gatherMessagePreviews, "function");
  assert.deepEqual(await gatherMessagePreviews!(failingMessageClient(), [1]), {});
});

test("preview lookup covers more than 500 applicants without oversized id requests", async () => {
  const gatherMessagePreviews = await loadGather();
  const ids = Array.from({ length: 650 }, (_, index) => index + 1);

  assert.equal(typeof gatherMessagePreviews, "function");
  const previews = await gatherMessagePreviews!(
    boundedPreviewClient({ maxIdsPerRequest: 250 }),
    ids,
    { requireComplete: true },
  );

  assert.equal(Object.keys(previews).length, ids.length);
  assert.equal(previews[650]?.body, "message-650");
});

test("preview pagination keeps the latest row and reaches an inbound row past a tied timestamp boundary", async () => {
  const gatherMessagePreviews = await loadGather();
  const createdAt = "2026-08-24T00:00:00.000Z";
  const messageRows = Array.from({ length: 1_001 }, (_, index) => ({
    id: index + 1,
    applicant_id: 1,
    body: `message-${index + 1}`,
    direction: index === 0 ? "inbound" : "outbound",
    created_at: createdAt,
    sent_by: index === 0 ? null : "agent",
  }));

  assert.equal(typeof gatherMessagePreviews, "function");
  const previews = await gatherMessagePreviews!(
    boundedPreviewClient({ messageRows }),
    [1],
    { requireComplete: true },
  );

  assert.equal(previews[1]?.body, "message-1001");
  assert.equal(previews[1]?.direction, "outbound");
  assert.equal(previews[1]?.last_inbound_at, createdAt);
});

test("preview lookup never opens more than three id batches concurrently", async () => {
  const gatherMessagePreviews = await loadGather();
  const ids = Array.from({ length: 1_001 }, (_, index) => index + 1);
  const client = boundedPreviewClient({ delayMs: 2 });

  assert.equal(typeof gatherMessagePreviews, "function");
  const previews = await gatherMessagePreviews!(client, ids, { requireComplete: true });

  assert.equal(Object.keys(previews).length, ids.length);
  assert.equal(client.stats.maxConcurrentRequests, 3);
});

test("live preview targeting keeps the oldest candidate after the former 500-person boundary", async () => {
  const livePreviewTargetIds = await loadTargetSelector();
  const now = new Date("2026-08-24T00:00:00.000Z").getTime();
  const applicants = Array.from({ length: 501 }, (_, index) => ({
    id: index + 1,
    status: "기타",
    agent_stage: "abort",
    created_at: "2025-01-01T00:00:00.000Z",
    last_message_at: new Date(now - index * 60_000).toISOString(),
  }));

  assert.equal(typeof livePreviewTargetIds, "function");
  const ids = livePreviewTargetIds!(applicants, now);

  assert.equal(ids.length, applicants.length);
  assert.equal(ids.at(-1), 501);
});

test("complete preview lookup fails instead of hiding a manual discovery error", async () => {
  const gatherMessagePreviews = await loadGather();

  assert.equal(typeof gatherMessagePreviews, "function");
  await assert.rejects(
    gatherMessagePreviews!(
      boundedPreviewClient({ failManual: true }),
      [1],
      { withManual: true, requireComplete: true },
    ),
    /manual discovery unavailable/,
  );
});

test("complete preview lookup rejects when a later id batch fails", async () => {
  const gatherMessagePreviews = await loadGather();
  const ids = Array.from({ length: 300 }, (_, index) => index + 1);

  assert.equal(typeof gatherMessagePreviews, "function");
  await assert.rejects(
    gatherMessagePreviews!(
      boundedPreviewClient({ failMessageApplicantId: 251 }),
      ids,
      { requireComplete: true },
    ),
    /message batch unavailable/,
  );
});

test("complete preview lookup rejects when a later message page fails", async () => {
  const gatherMessagePreviews = await loadGather();
  const messageRows = Array.from({ length: 1_001 }, (_, index) => ({
    id: 1_001 - index,
    applicant_id: 1,
    body: `message-${index}`,
    direction: index === 1_000 ? "inbound" : "outbound",
    created_at: new Date(Date.UTC(2026, 7, 24, 0, 0, 0) - index * 1_000).toISOString(),
    sent_by: index === 1_000 ? null : "agent",
  }));

  assert.equal(typeof gatherMessagePreviews, "function");
  await assert.rejects(
    gatherMessagePreviews!(
      boundedPreviewClient({ messageRows, failMessageFrom: 1_000 }),
      [1],
      { requireComplete: true },
    ),
    /message page unavailable/,
  );
});

test("complete preview lookup fails instead of returning partial draft state", async () => {
  const gatherMessagePreviews = await loadGather();

  assert.equal(typeof gatherMessagePreviews, "function");
  await assert.rejects(
    gatherMessagePreviews!(
      boundedPreviewClient({ failDraft: true }),
      [1],
      { requireComplete: true },
    ),
    /drafts unavailable/,
  );
});

// Break caught: treating a completed prior message, or one resolved candidate, as the whole conversation being done.
test("production UUID previews load exact completion and unresolved handoff state", async () => {
  const gather = await loadGather();
  const uuid = "4bd5096c-0790-4eb2-b1bd-e46ecfd78b81";
  const newer = "4bd5096c-0790-4eb2-b1bd-e46ecfd78b82";
  const previews = await gather!(boundedPreviewClient({
    messageRows: [uuid, newer].map((id, index) => ({ id, applicant_id: index + 1, body: "네", direction: "inbound", created_at: "2026-09-16T00:00:00Z", sent_by: null })),
    completionRows: [
      { id: 1, applicant_id: 1, event_type: "reply_completed", meta: { message_id: uuid } },
      { id: 2, applicant_id: 2, event_type: "reply_completed", meta: { message_id: uuid } },
    ],
    candidateRows: [{ id: 1, applicant_id: 2, agent_stage: "paused", paused_reason: "문의 확인 필요", jobs: { title: "마감 공고" } }],
  }), [1, 2], { throwOnCoreError: true });
  assert.equal(previews[1].message_id, uuid);
  assert.equal(previews[1].reply_completed, true);
  assert.equal(previews[2].reply_completed, false);
  assert.equal(previews[2].handoff_required, true);
});

test("completion is tied to the exact latest inbound and current human work across all jobs", async () => {
  const gather = await loadGather();
  assert.equal(typeof gather, "function");
  const previews = await gather!(boundedPreviewClient({
    completionRows: [
      { id: 1, applicant_id: 1, event_type: "reply_completed", meta: { message_id: 1 } },
      { id: 2, applicant_id: 2, event_type: "reply_completed", meta: { message_id: 999 } },
      { id: 3, applicant_id: 2, event_type: "handoff_resolved", meta: { message_id: 2 } },
    ],
    candidateRows: [
      { id: 1, applicant_id: 1, agent_stage: "paused", agent_state: { meta: { handoff_resolved: { at: "2026-09-01T00:00:00Z" } } }, jobs: { title: "오전 배송" } },
      { id: 2, applicant_id: 1, agent_stage: "paused", paused_reason: "문의 확인 필요", jobs: { title: "마감된 오후 배송" } },
      { id: 3, applicant_id: 2, agent_stage: "paused", paused_reason: "매니저 수동 일시정지", jobs: { title: "배송" } },
      { id: 4, applicant_id: 2, agent_stage: "screening", jobs: { title: "배송" } },
    ],
  }), [1, 2], { throwOnCoreError: true });
  assert.equal(previews[1].message_id, 1);
  assert.equal(previews[1].reply_completed, true);
  assert.equal(previews[1].handoff_required, true);
  assert.equal(previews[2].reply_completed, false);
  assert.equal(previews[2].handoff_required, false);
});

for (const failStatus of ["pool_events", "job_candidates"]) {
  test(`dashboard refuses to call a failed ${failStatus} lookup an empty queue`, async () => {
    const gather = await loadGather();
    assert.equal(typeof gather, "function");
    await assert.rejects(gather!(boundedPreviewClient({ failStatus }), [1], { throwOnCoreError: true }), /unavailable/);
  });
}

test("handoff lookup reaches required work after a full page of resolved candidates", async () => {
  const gather = await loadGather();
  assert.equal(typeof gather, "function");
  const candidateRows = Array.from({ length: 1_001 }, (_, i) => ({ id: i + 1, applicant_id: 1, agent_stage: "paused",
    jobs: { title: "배송" }, agent_state: i < 1_000 ? { meta: { handoff_resolved: { at: "2026-09-01T00:00:00Z" } } } : null }));
  const previews = await gather!(boundedPreviewClient({ candidateRows }), [1], { requireComplete: true });
  assert.equal(previews[1].handoff_required, true);
});
