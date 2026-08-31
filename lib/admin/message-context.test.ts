import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type MessageContextModule = {
  fetchReasoningByMessageIds?: (
    client: unknown,
    messageIds: string[],
  ) => Promise<Map<string, string>>;
  fetchRecentPoolEvents?: (
    client: unknown,
    scope: { applicantId: number; eventTypes: string[]; since: string },
  ) => Promise<Array<{ id: number; created_at: string }>>;
};

async function loadModule(): Promise<MessageContextModule> {
  try {
    return await import(new URL("./message-context.ts", import.meta.url).href) as MessageContextModule;
  } catch {
    return {};
  }
}

type QueryRow = Record<string, unknown>;
type PageResult = {
  data: QueryRow[] | null;
  error: { message: string } | null;
};

function createFakeClient(
  resolvePage: (table: string, values: string[], from: number, to: number) => PageResult,
  calls: string[],
) {
  return {
    from(table: string) {
      let values: string[] = [];
      const query = {
        select(columns: string) {
          calls.push(`select:${table}:${columns}`);
          return query;
        },
        eq(column: string, value: number) {
          calls.push(`eq:${table}:${column}:${value}`);
          return query;
        },
        in(column: string, nextValues: string[]) {
          values = [...nextValues];
          calls.push(`in:${table}:${column}:${nextValues.length}`);
          return query;
        },
        gte(column: string, value: string) {
          calls.push(`gte:${table}:${column}:${value}`);
          return query;
        },
        order(column: string, options: { ascending: boolean }) {
          calls.push(`order:${table}:${column}:${options.ascending ? "asc" : "desc"}`);
          return query;
        },
        async range(from: number, to: number) {
          calls.push(`range:${table}:${from}:${to}`);
          return resolvePage(table, values, from, to);
        },
      };
      return query;
    },
  };
}

type JsonResponse = {
  body: Record<string, unknown>;
  status: number;
};

function loadMessagesRoute(options: {
  reasoning?: Map<string, string>;
  reasoningError?: Error;
  events?: QueryRow[];
  eventsError?: Error;
  jobRows?: QueryRow[];
  jobLabelsError?: Error;
}) {
  const output = ts.transpileModule(readFileSync(
    new URL("../../app/api/admin/messages/[applicantId]/route.ts", import.meta.url),
    "utf8",
  ), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const compiledModule = { exports: {} as Record<string, unknown> };
  function createQuery(table: string) {
    const query = {
      select() { return query; },
      update() { return query; },
      eq() { return query; },
      in() { return query; },
      gte() { return query; },
      is() { return query; },
      order() { return query; },
      limit() { return query; },
      async single() {
        return { data: { phone: "01012345678", access_token: "token" }, error: null };
      },
      then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?: ((value: { data: QueryRow[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        const result = table === "jobs"
          ? options.jobLabelsError
            ? { data: null, error: { message: options.jobLabelsError.message } }
            : { data: options.jobRows ?? [], error: null }
          : { data: [], error: null };
        return Promise.resolve(result).then(onfulfilled, onrejected);
      },
    };
    return query;
  }
  const supabase = { from(table: string) { return createQuery(table); } };
  const nextResponse = {
    json(body: Record<string, unknown>, init?: { status?: number }): JsonResponse {
      return { body, status: init?.status ?? 200 };
    },
  };
  const messages = [
    { id: "outbound-1", direction: "outbound", job_id: 41, created_at: "2026-08-31T00:00:00Z" },
    { id: "inbound-1", direction: "inbound", job_id: null, created_at: "2026-08-31T00:01:00Z" },
  ];
  const stubs: Record<string, Record<string, unknown>> = {
    "next/server": { NextResponse: nextResponse },
    "@/lib/supabase": { createServiceClient: () => supabase },
    "@/lib/admin/pending-draft-scope": {
      selectPendingDraftForJob: () => null,
      shouldLoadCandidateAgentState: () => false,
    },
    "@/lib/admin/manual-message-attention": {
      loadManualMessageAttention: async () => ({ state: "ready", items: [], totalCount: 0, truncated: false }),
    },
    "@/lib/admin/message-history": {
      fetchCompleteMessageHistory: async () => messages,
    },
    "@/lib/admin/message-context": {
      fetchReasoningByMessageIds: async () => {
        if (options.reasoningError) throw options.reasoningError;
        return options.reasoning ?? new Map();
      },
      fetchRecentPoolEvents: async () => {
        if (options.eventsError) throw options.eventsError;
        return options.events ?? [];
      },
    },
  };

  runInNewContext(output, {
    URL,
    console: { error() {} },
    exports: compiledModule.exports,
    module: compiledModule,
    require: (specifier: string) => stubs[specifier] ?? {},
  });

  return compiledModule.exports as {
    GET: (
      request: { url: string },
      context: { params: Promise<{ applicantId: string }> },
    ) => Promise<JsonResponse>;
  };
}

test("reasoning lookup chunks more than 1000 outbound message ids without an oversized IN query", async () => {
  const { fetchReasoningByMessageIds } = await loadModule();
  assert.equal(typeof fetchReasoningByMessageIds, "function");
  if (typeof fetchReasoningByMessageIds !== "function") return;

  const messageIds = Array.from(
    { length: 1_001 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  const rows = messageIds.map((id, index) => ({
    id: `draft-${index + 1}`,
    used_message_id: id,
    reasoning: `근거 ${index + 1}`,
  }));
  const calls: string[] = [];
  const client = createFakeClient((table, values, from, to) => {
    assert.equal(table, "message_drafts");
    return {
      data: rows.filter((row) => values.includes(row.used_message_id)).slice(from, to + 1),
      error: null,
    };
  }, calls);

  const reasoning = await fetchReasoningByMessageIds(client, [messageIds[0], ...messageIds]);

  assert.equal(reasoning.size, 1_001);
  assert.equal(reasoning.get(messageIds[0]), "근거 1");
  assert.equal(reasoning.get(messageIds[1_000]), "근거 1001");
  const inCalls = calls.filter((call) => call.startsWith("in:message_drafts:"));
  assert.equal(inCalls.length > 1, true);
  assert.equal(inCalls.every((call) => Number(call.split(":").at(-1)) <= 50), true);
});

test("reasoning lookup rejects a later page error instead of exposing a partial map", async () => {
  const { fetchReasoningByMessageIds } = await loadModule();
  assert.equal(typeof fetchReasoningByMessageIds, "function");
  if (typeof fetchReasoningByMessageIds !== "function") return;

  const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
    id: `draft-${index + 1}`,
    used_message_id: "message-1",
    reasoning: `근거 ${index + 1}`,
  }));
  const calls: string[] = [];
  const client = createFakeClient((_table, _values, from) => from === 0
    ? { data: firstPage, error: null }
    : { data: null, error: { message: "database unavailable" } }, calls);

  await assert.rejects(
    fetchReasoningByMessageIds(client, ["message-1"]),
    /메시지 판단 근거.*database unavailable/,
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("range:message_drafts:")),
    ["range:message_drafts:0:999", "range:message_drafts:1000:1999"],
  );
});

test("recent pool events load beyond 1000 rows with stable created_at and id ordering", async () => {
  const { fetchRecentPoolEvents } = await loadModule();
  assert.equal(typeof fetchRecentPoolEvents, "function");
  if (typeof fetchRecentPoolEvents !== "function") return;

  const events = Array.from({ length: 1_001 }, (_, index) => ({
    id: index + 1,
    event_type: "link_view",
    job_id: null,
    meta: null,
    created_at: "2026-08-31T00:00:00.000Z",
  }));
  const calls: string[] = [];
  const client = createFakeClient((table, _values, from, to) => {
    assert.equal(table, "pool_events");
    return { data: events.slice(from, to + 1), error: null };
  }, calls);

  const rows = await fetchRecentPoolEvents(client, {
    applicantId: 37,
    eventTypes: ["ping_sent", "link_view"],
    since: "2026-06-02T00:00:00.000Z",
  });

  assert.deepEqual([rows[0].id, rows[999].id, rows[1_000].id], [1, 1_000, 1_001]);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("range:pool_events:")),
    ["range:pool_events:0:999", "range:pool_events:1000:1999"],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("order:pool_events:")),
    [
      "order:pool_events:created_at:asc",
      "order:pool_events:id:asc",
      "order:pool_events:created_at:asc",
      "order:pool_events:id:asc",
    ],
  );
});

test("recent pool events reject a later page error instead of returning a partial timeline", async () => {
  const { fetchRecentPoolEvents } = await loadModule();
  assert.equal(typeof fetchRecentPoolEvents, "function");
  if (typeof fetchRecentPoolEvents !== "function") return;

  const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
    id: index + 1,
    event_type: "ping_sent",
    job_id: null,
    meta: null,
    created_at: "2026-08-31T00:00:00.000Z",
  }));
  const calls: string[] = [];
  const client = createFakeClient((_table, _values, from) => from === 0
    ? { data: firstPage, error: null }
    : { data: null, error: { message: "database unavailable" } }, calls);

  await assert.rejects(
    fetchRecentPoolEvents(client, {
      applicantId: 37,
      eventTypes: ["ping_sent"],
      since: "2026-06-02T00:00:00.000Z",
    }),
    /재컨택 이벤트.*database unavailable/,
  );
});

test("messages route exposes complete auxiliary context and reports both context sources ready", async () => {
  const route = loadMessagesRoute({
    reasoning: new Map([["outbound-1", "자동 응대 근거"]]),
    events: [{
      id: 1,
      event_type: "link_view",
      job_id: null,
      meta: null,
      created_at: "2026-08-31T00:00:30Z",
    }],
  });

  const response = await route.GET(
    { url: "http://localhost/api/admin/messages/37" },
    { params: Promise.resolve({ applicantId: "37" }) },
  );
  const messages = response.body.messages as Array<{ id: string; reasoning: string | null }>;
  const contextStatus = response.body.context_status as Record<string, string>;

  assert.equal(response.status, 200);
  assert.equal(messages[0].reasoning, "자동 응대 근거");
  assert.equal(messages[1].reasoning, null);
  assert.equal((response.body.events as QueryRow[]).length, 1);
  assert.equal(contextStatus.reasoning, "ready");
  assert.equal(contextStatus.pool_events, "ready");
  assert.equal(contextStatus.job_labels, "ready");
});

test("messages route discards failed auxiliary context instead of returning a partial normal payload", async () => {
  const route = loadMessagesRoute({
    reasoningError: new Error("reasoning second page failed"),
    eventsError: new Error("events second page failed"),
  });

  const response = await route.GET(
    { url: "http://localhost/api/admin/messages/37" },
    { params: Promise.resolve({ applicantId: "37" }) },
  );
  const messages = response.body.messages as Array<{ reasoning: string | null }>;
  const contextStatus = response.body.context_status as Record<string, string>;

  assert.equal(response.status, 200);
  assert.deepEqual(messages.map((message) => message.reasoning), [null, null]);
  assert.equal((response.body.events as QueryRow[]).length, 0);
  assert.equal(contextStatus.reasoning, "error");
  assert.equal(contextStatus.pool_events, "error");
  assert.equal(contextStatus.job_labels, "ready");
});

test("messages route keeps core messages but exposes a failed job-label lookup", async () => {
  const route = loadMessagesRoute({
    reasoning: new Map([["outbound-1", "자동 응대 근거"]]),
    jobLabelsError: new Error("jobs lookup unavailable"),
  });

  const response = await route.GET(
    { url: "http://localhost/api/admin/messages/37" },
    { params: Promise.resolve({ applicantId: "37" }) },
  );
  const messages = response.body.messages as Array<{ id: string }>;
  const contextStatus = response.body.context_status as Record<string, string>;

  assert.equal(response.status, 200);
  assert.deepEqual(messages.map((message) => message.id), ["outbound-1", "inbound-1"]);
  assert.equal(contextStatus.reasoning, "ready");
  assert.equal(contextStatus.pool_events, "ready");
  assert.equal(contextStatus.job_labels, "error");
});
