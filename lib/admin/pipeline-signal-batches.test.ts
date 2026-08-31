import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";

type ActiveCheck = {
  configured: boolean;
  checked: number;
  active: Array<{ id: number; name: string; reasons: string[] }>;
  unchecked?: number;
};

type PoolEventSummary = {
  last_ping_at: string | null;
  last_link_view_at: string | null;
  last_interest: { job_id: number | null; at: string; immediate: boolean } | null;
  last_reply_at: string | null;
};

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

type SignalBatchModule = {
  pipelineApplicantActionsBlocked?: (
    state: "loading" | "error" | "empty" | "ready",
  ) => boolean;
  fetchActiveSignalBatches?: (
    ids: Array<string | number>,
    fetcher: FetchLike,
    timeoutMs?: number,
  ) => Promise<ActiveCheck>;
  fetchSummarySignalBatches?: (
    ids: Array<string | number>,
    fetcher: FetchLike,
  ) => Promise<Record<number, PoolEventSummary>>;
  pipelineSignalsBlockResults?: (input: {
    excludeActive: boolean;
    summaryDependent: boolean;
    activeComplete: boolean;
    summaryComplete: boolean;
  }) => boolean;
  pipelineActiveCheckBlocksSend?: (input: {
    modalOpen: boolean;
    selectedIds: string[];
    state: "idle" | "loading" | "ready" | "error";
    coveredIds: Set<string>;
  }) => boolean;
  pipelineNeedsSummary?: (input: {
    view: "list" | "kanban" | "map" | "funnel";
    excludeRecentPing: boolean;
    reactionOnly: boolean;
    sortMode: string;
  }) => boolean;
  pipelineSummaryRowStatus?: (input: {
    state: "idle" | "loading" | "ready" | "error";
    currentKey: string | null;
    expectedKey: string;
  }) => "checking" | "ready" | "error";
  pipelineShowsNormalEmptyState?: (input: {
    applicantsState: "loading" | "error" | "empty" | "ready";
    resultCount: number;
    signalsBlocked: boolean;
  }) => boolean;
};

test("pipeline mutations require a fresh successful applicant collection", async () => {
  const { pipelineApplicantActionsBlocked } = await loadSignalBatchModule();
  assert.equal(typeof pipelineApplicantActionsBlocked, "function");
  if (typeof pipelineApplicantActionsBlocked !== "function") return;

  assert.equal(pipelineApplicantActionsBlocked("loading"), true);
  assert.equal(pipelineApplicantActionsBlocked("error"), true);
  assert.equal(pipelineApplicantActionsBlocked("empty"), false);
  assert.equal(pipelineApplicantActionsBlocked("ready"), false);
});

async function loadSignalBatchModule(): Promise<SignalBatchModule> {
  try {
    return await import(new URL("./pipeline-signal-batches.ts", import.meta.url).href) as SignalBatchModule;
  } catch {
    return {};
  }
}

function applicantIdsFrom(init?: RequestInit): number[] {
  const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { applicantIds?: unknown };
  assert.ok(Array.isArray(parsed.applicantIds));
  return parsed.applicantIds as number[];
}

test("active lookup includes the 501st applicant instead of truncating the visible cohort", async () => {
  const { fetchActiveSignalBatches } = await loadSignalBatchModule();
  assert.equal(typeof fetchActiveSignalBatches, "function");
  if (typeof fetchActiveSignalBatches !== "function") return;

  const requested: number[][] = [];
  const fetcher: FetchLike = async (_input, init) => {
    const ids = applicantIdsFrom(init);
    requested.push(ids);
    return {
      ok: true,
      json: async () => ({
        configured: true,
        checked: ids.length,
        active: ids.includes(501)
          ? [{ id: 501, name: "마지막 지원자", reasons: ["active_contract"] }]
          : [],
        unchecked: 0,
      }),
    };
  };

  const result = await fetchActiveSignalBatches(
    Array.from({ length: 501 }, (_, index) => String(index + 1)),
    fetcher,
  );

  assert.deepEqual(requested.map((ids) => ids.length), [500, 1]);
  assert.equal(result.checked, 501);
  assert.deepEqual(result.active.map((row) => row.id), [501]);
});

test("summary lookup merges all three batches for 1001 applicants", async () => {
  const { fetchSummarySignalBatches } = await loadSignalBatchModule();
  assert.equal(typeof fetchSummarySignalBatches, "function");
  if (typeof fetchSummarySignalBatches !== "function") return;

  const requested: number[][] = [];
  const fetcher: FetchLike = async (_input, init) => {
    const ids = applicantIdsFrom(init);
    requested.push(ids);
    const lastId = ids.at(-1)!;
    return {
      ok: true,
      json: async () => ({
        summaryById: {
          [lastId]: {
            last_ping_at: `2026-08-${String(requested.length).padStart(2, "0")}T00:00:00.000Z`,
            last_link_view_at: null,
            last_interest: null,
            last_reply_at: null,
          },
        },
      }),
    };
  };

  const result = await fetchSummarySignalBatches(
    Array.from({ length: 1_001 }, (_, index) => index + 1),
    fetcher,
  );

  assert.deepEqual(requested.map((ids) => ids.length), [500, 500, 1]);
  assert.deepEqual(Object.keys(result).map(Number), [500, 1_000, 1_001]);
});

test("a later signal batch error rejects instead of exposing the first batch as complete", async () => {
  const { fetchActiveSignalBatches } = await loadSignalBatchModule();
  assert.equal(typeof fetchActiveSignalBatches, "function");
  if (typeof fetchActiveSignalBatches !== "function") return;

  let requestCount = 0;
  const fetcher: FetchLike = async (_input, init) => {
    requestCount += 1;
    const ids = applicantIdsFrom(init);
    if (requestCount === 2) {
      return { ok: false, json: async () => ({ error: "upstream unavailable" }) };
    }
    return {
      ok: true,
      json: async () => ({ configured: true, checked: ids.length, active: [], unchecked: 0 }),
    };
  };

  await assert.rejects(
    fetchActiveSignalBatches(
      Array.from({ length: 501 }, (_, index) => index + 1),
      fetcher,
    ),
    /활동 여부.*upstream unavailable/,
  );
});

test("incomplete signal data blocks dependent filters without hiding unrelated list results", async () => {
  const { pipelineSignalsBlockResults } = await loadSignalBatchModule();
  assert.equal(typeof pipelineSignalsBlockResults, "function");
  if (typeof pipelineSignalsBlockResults !== "function") return;

  assert.equal(pipelineSignalsBlockResults({
    excludeActive: true,
    summaryDependent: false,
    activeComplete: false,
    summaryComplete: true,
  }), true);
  assert.equal(pipelineSignalsBlockResults({
    excludeActive: false,
    summaryDependent: true,
    activeComplete: true,
    summaryComplete: false,
  }), true);
  assert.equal(pipelineSignalsBlockResults({
    excludeActive: false,
    summaryDependent: false,
    activeComplete: false,
    summaryComplete: false,
  }), false);
});

test("bulk send remains blocked until every selected applicant is covered by a ready check", async () => {
  const { pipelineActiveCheckBlocksSend } = await loadSignalBatchModule();
  assert.equal(typeof pipelineActiveCheckBlocksSend, "function");
  if (typeof pipelineActiveCheckBlocksSend !== "function") return;

  assert.equal(pipelineActiveCheckBlocksSend({
    modalOpen: true,
    selectedIds: ["1", "501"],
    state: "ready",
    coveredIds: new Set(["1"]),
  }), true);
  assert.equal(pipelineActiveCheckBlocksSend({
    modalOpen: true,
    selectedIds: ["1", "501"],
    state: "error",
    coveredIds: new Set(["1", "501"]),
  }), true);
  assert.equal(pipelineActiveCheckBlocksSend({
    modalOpen: true,
    selectedIds: ["1", "501"],
    state: "ready",
    coveredIds: new Set(["1", "501"]),
  }), false);
});

test("reaction-recent sorting keeps summary lookup active after switching to kanban or map", async () => {
  const { pipelineNeedsSummary } = await loadSignalBatchModule();
  assert.equal(typeof pipelineNeedsSummary, "function");
  if (typeof pipelineNeedsSummary !== "function") return;

  assert.equal(pipelineNeedsSummary({
    view: "kanban",
    excludeRecentPing: false,
    reactionOnly: false,
    sortMode: "reaction_recent",
  }), true);
  assert.equal(pipelineNeedsSummary({
    view: "map",
    excludeRecentPing: false,
    reactionOnly: false,
    sortMode: "reaction_recent",
  }), true);
  assert.equal(pipelineNeedsSummary({
    view: "funnel",
    excludeRecentPing: false,
    reactionOnly: false,
    sortMode: "reaction_recent",
  }), false);
  assert.equal(pipelineNeedsSummary({
    view: "kanban",
    excludeRecentPing: false,
    reactionOnly: false,
    sortMode: "recent",
  }), false);
});

test("summary rows stay unconfirmed until the complete current lookup is ready", async () => {
  const { pipelineSummaryRowStatus } = await loadSignalBatchModule();
  assert.equal(typeof pipelineSummaryRowStatus, "function");
  if (typeof pipelineSummaryRowStatus !== "function") return;

  assert.equal(pipelineSummaryRowStatus({
    state: "loading",
    currentKey: null,
    expectedKey: "1,2",
  }), "checking");
  assert.equal(pipelineSummaryRowStatus({
    state: "ready",
    currentKey: "1",
    expectedKey: "1,2",
  }), "checking");
  assert.equal(pipelineSummaryRowStatus({
    state: "ready",
    currentKey: "1,2",
    expectedKey: "1,2",
  }), "ready");
});

test("summary rows expose a failed lookup instead of reporting no reply", async () => {
  const { pipelineSummaryRowStatus } = await loadSignalBatchModule();
  assert.equal(typeof pipelineSummaryRowStatus, "function");
  if (typeof pipelineSummaryRowStatus !== "function") return;

  assert.equal(pipelineSummaryRowStatus({
    state: "error",
    currentKey: null,
    expectedKey: "1,2",
  }), "error");
});

test("signal-blocked results suppress the normal no-applicants empty state", async () => {
  const { pipelineShowsNormalEmptyState } = await loadSignalBatchModule();
  assert.equal(typeof pipelineShowsNormalEmptyState, "function");
  if (typeof pipelineShowsNormalEmptyState !== "function") return;

  assert.equal(pipelineShowsNormalEmptyState({
    applicantsState: "ready",
    resultCount: 0,
    signalsBlocked: true,
  }), false);
  assert.equal(pipelineShowsNormalEmptyState({
    applicantsState: "ready",
    resultCount: 0,
    signalsBlocked: false,
  }), true);
});

test("a hung signal request times out and aborts the underlying fetch", async () => {
  const { fetchActiveSignalBatches } = await loadSignalBatchModule();
  assert.equal(typeof fetchActiveSignalBatches, "function");
  if (typeof fetchActiveSignalBatches !== "function") return;

  const observed: { signal: AbortSignal | null } = { signal: null };
  const fetcher: FetchLike = async (_input, init) => {
    observed.signal = init?.signal instanceof AbortSignal ? init.signal : null;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      ok: true,
      json: async () => ({ configured: true, checked: 1, active: [], unchecked: 0 }),
    };
  };

  await assert.rejects(
    fetchActiveSignalBatches([1], fetcher, 5),
    /Request timed out/,
  );
  assert.equal(observed.signal?.aborted, true);
});

test("Pipeline wires the complete filtered and selected cohorts into fail-safe batch lookups", () => {
  const source = readFileSync(
    new URL("../../components/Pipeline.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /fetchActiveSignalBatches/);
  assert.match(source, /fetchSummarySignalBatches/);
  assert.match(source, /pipelineNeedsSummary/);
  assert.match(source, /const visibleIdsKey = baseFilteredCards\.map\(\(c\) => c\.id\)\.join\(","\)/);
  assert.doesNotMatch(source, /baseFilteredCards\.slice\(0,\s*500\)/);
  assert.doesNotMatch(
    source,
    /Array\.from\(selectedRows\)[\s\S]{0,120}?\.slice\(0,\s*500\)/,
  );
  assert.match(source, /activeCheckState === "error"/);
  assert.match(source, /disabled=\{applicantActionsBlocked \|\| waitlistContextMissing \|\| activeCheckBlocking\}/);
  assert.match(source, /id="pipeline-bulk-active-check-status"[\s\S]*?role="status"/);
  assert.match(
    source,
    /aria-describedby=\{activeCheckBlocking \? "pipeline-bulk-active-check-status" : undefined\}/,
  );
  assert.match(source, /motion-reduce:animate-none/);
});

test("the bulk message modal keeps its actions visible while dense safety notices scroll", () => {
  const source = readFileSync(
    new URL("../../components/Pipeline.tsx", import.meta.url),
    "utf8",
  );
  const modalStart = source.indexOf("{/* 2. Bulk Message/Campaign Modal */}");
  const modalEnd = source.indexOf("</Modal>", modalStart);
  const modal = source.slice(modalStart, modalEnd);

  assert.match(modal, /border-b border-border-strong bg-background[^\n]*shrink-0/);
  assert.match(modal, /min-h-0 flex-1 overflow-y-auto p-6 space-y-5/);
  assert.match(modal, /border-t border-border-strong bg-white[^\n]*shrink-0/);
});

type PoolEvent = {
  id: number;
  applicant_id: number;
  job_id: number | null;
  event_type: string;
  meta: Record<string, unknown> | null;
  created_at: string;
};

type JsonResponse = { body: Record<string, unknown>; status: number };

function loadSummaryRoute(events: PoolEvent[]) {
  const orders: Array<{ column: string; ascending: boolean }> = [];

  class QueryBuilder {
    select() { return this; }
    in() { return this; }
    order(column: string, options?: { ascending?: boolean }) {
      orders.push({ column, ascending: options?.ascending ?? true });
      return this;
    }
    async range(from: number, to: number) {
      const sorted = [...events].sort((left, right) => {
        for (const order of orders) {
          const a = left[order.column as keyof PoolEvent];
          const b = right[order.column as keyof PoolEvent];
          const compared = String(a).localeCompare(String(b));
          if (compared !== 0) return order.ascending ? compared : -compared;
        }
        return 0;
      });
      return { data: sorted.slice(from, to + 1), error: null };
    }
  }

  const source = readFileSync(
    new URL("../../app/api/admin/pool-events/summary/route.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const compiledModule = { exports: {} as Record<string, unknown> };
  const nextResponse = {
    json(body: Record<string, unknown>, init?: { status?: number }): JsonResponse {
      return { body, status: init?.status ?? 200 };
    },
  };

  runInNewContext(output, {
    console: { error() {} },
    exports: compiledModule.exports,
    module: compiledModule,
    require: (specifier: string) => {
      if (specifier === "next/server") return { NextResponse: nextResponse };
      if (specifier === "@/lib/supabase") {
        return { createServiceClient: () => ({ from: () => new QueryBuilder() }) };
      }
      if (specifier === "@/lib/admin/postgrest-pagination") return { fetchAllPostgrestRows };
      return {};
    },
  });

  return {
    route: compiledModule.exports as {
      POST: (request: { json: () => Promise<unknown> }) => Promise<JsonResponse>;
    },
    orders,
  };
}

test("pool event summary reads row 5001 and uses a stable newest-first order", async () => {
  const sameTime = "2026-08-31T10:00:00.000Z";
  const events: PoolEvent[] = [
    { id: 1, applicant_id: 3, job_id: 11, event_type: "interest_click", meta: null, created_at: sameTime },
    { id: 2, applicant_id: 3, job_id: 22, event_type: "interest_click", meta: null, created_at: sameTime },
    ...Array.from({ length: 4_998 }, (_, index) => ({
      id: index + 10,
      applicant_id: 1,
      job_id: null,
      event_type: "ping_sent",
      meta: null,
      created_at: new Date(Date.UTC(2026, 7, 30, 23, 59, 59) - index).toISOString(),
    })),
    { id: 9_999, applicant_id: 2, job_id: null, event_type: "ping_reply", meta: null, created_at: "2020-01-01T00:00:00.000Z" },
  ];
  assert.equal(events.length, 5_001);
  const { route, orders } = loadSummaryRoute(events);

  const response = await route.POST({ json: async () => ({ applicantIds: [1, 2, 3] }) });
  const summary = response.body.summaryById as Record<number, PoolEventSummary>;

  assert.equal(response.status, 200);
  assert.equal(summary[2].last_reply_at, "2020-01-01T00:00:00.000Z");
  assert.equal(summary[3].last_interest?.job_id, 22);
  assert.deepEqual(orders.slice(0, 2), [
    { column: "created_at", ascending: false },
    { column: "id", ascending: false },
  ]);
});
