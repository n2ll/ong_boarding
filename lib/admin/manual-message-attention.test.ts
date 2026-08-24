import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type AttentionPhase = "checking" | "manual_confirmation" | "history_recovery";

type AttentionItem = {
  applicantId: number;
  jobId: number | null;
  phase: AttentionPhase;
  createdAt: string;
  updatedAt: string;
};

type AttentionCollection = {
  state: "ready" | "error";
  items: AttentionItem[];
  totalCount: number | null;
  truncated: boolean;
};

type AttentionPresentation = {
  badgeLabel: string;
  count: number;
  primaryPhase: AttentionPhase;
  description: string;
  resendAllowed: false;
  actions: readonly [];
};

type AttentionModule = {
  loadManualMessageAttention?: (
    supabase: unknown,
    options?: { applicantId?: number; limit?: number },
  ) => Promise<AttentionCollection>;
  indexManualMessageAttention?: (items: AttentionItem[]) => Map<number, AttentionItem[]>;
  manualMessageAttentionPresentation?: (items: AttentionItem[]) => AttentionPresentation | null;
  manualMessageAttentionRemoteState?: (
    parentState: "loading" | "error" | "empty" | "ready",
    collection: AttentionCollection | undefined,
  ) => "loading" | "ready" | "error";
};

async function loadModule(): Promise<AttentionModule> {
  try {
    return await import(new URL("./manual-message-attention.ts", import.meta.url).href) as AttentionModule;
  } catch {
    return {};
  }
}

type RawRow = {
  idempotency_key: string;
  applicant_id: number | null;
  job_id: number | null;
  body: string;
  status: string;
  provider_correlation_attached: boolean;
  provider_reconcile_status: string;
  created_at: string;
  updated_at: string;
};

function fakeSupabase(rows: RawRow[], queryError: { message: string } | null = null) {
  let selected = [...rows];
  let totalCount = selected.length;

  const query = {
    select() {
      return query;
    },
    in(column: string, values: string[]) {
      selected = selected.filter((row) => values.includes(String(row[column as keyof RawRow])));
      totalCount = selected.length;
      return query;
    },
    eq(column: string, value: unknown) {
      selected = selected.filter((row) => row[column as keyof RawRow] === value);
      totalCount = selected.length;
      return query;
    },
    order(column: string, options?: { ascending?: boolean }) {
      selected.sort((a, b) => {
        const av = String(a[column as keyof RawRow] ?? "");
        const bv = String(b[column as keyof RawRow] ?? "");
        return (options?.ascending === false ? -1 : 1) * av.localeCompare(bv);
      });
      return query;
    },
    limit(value: number) {
      selected = selected.slice(0, value);
      return query;
    },
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: { data: RawRow[] | null; error: { message: string } | null; count: number }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve({ data: queryError ? null : selected, error: queryError, count: totalCount }).then(onfulfilled, onrejected);
    },
  };

  return {
    from(table: string) {
      assert.equal(table, "manual_message_send_requests");
      return query;
    },
  };
}

const rows: RawRow[] = [
  {
    idempotency_key: "11111111-1111-4111-8111-111111111111",
    applicant_id: 11,
    job_id: 101,
    body: "첫 번째 발송 내용",
    status: "sending",
    provider_correlation_attached: true,
    provider_reconcile_status: "pending",
    created_at: "2026-08-24T01:00:00.000Z",
    updated_at: "2026-08-24T01:01:00.000Z",
  },
  {
    idempotency_key: "22222222-2222-4222-8222-222222222222",
    applicant_id: 12,
    job_id: null,
    body: "두 번째 발송 내용",
    status: "unknown",
    provider_correlation_attached: true,
    provider_reconcile_status: "unresolved",
    created_at: "2026-08-24T02:00:00.000Z",
    updated_at: "2026-08-24T02:01:00.000Z",
  },
  {
    idempotency_key: "33333333-3333-4333-8333-333333333333",
    applicant_id: 11,
    job_id: 102,
    body: "세 번째 발송 내용",
    status: "sent",
    provider_correlation_attached: true,
    provider_reconcile_status: "matched",
    created_at: "2026-08-24T03:00:00.000Z",
    updated_at: "2026-08-24T03:01:00.000Z",
  },
  {
    idempotency_key: "44444444-4444-4444-8444-444444444444",
    applicant_id: 13,
    job_id: null,
    body: "확정 실패",
    status: "failed",
    provider_correlation_attached: true,
    provider_reconcile_status: "pending",
    created_at: "2026-08-24T04:00:00.000Z",
    updated_at: "2026-08-24T04:01:00.000Z",
  },
  {
    idempotency_key: "55555555-5555-4555-8555-555555555555",
    applicant_id: 14,
    job_id: null,
    body: "기록 완료",
    status: "recorded",
    provider_correlation_attached: true,
    provider_reconcile_status: "matched",
    created_at: "2026-08-24T05:00:00.000Z",
    updated_at: "2026-08-24T05:01:00.000Z",
  },
];

test("the durable attention feed includes every no-resend outbox state and excludes settled requests", async () => {
  const { loadManualMessageAttention } = await loadModule();

  assert.equal(typeof loadManualMessageAttention, "function");
  assert.deepEqual(
    await loadManualMessageAttention!(fakeSupabase(rows)),
    {
      state: "ready",
      items: [
        {
          applicantId: 11,
          jobId: 101,
          phase: "checking",
          createdAt: "2026-08-24T01:00:00.000Z",
          updatedAt: "2026-08-24T01:01:00.000Z",
        },
        {
          applicantId: 12,
          jobId: null,
          phase: "manual_confirmation",
          createdAt: "2026-08-24T02:00:00.000Z",
          updatedAt: "2026-08-24T02:01:00.000Z",
        },
        {
          applicantId: 11,
          jobId: 102,
          phase: "history_recovery",
          createdAt: "2026-08-24T03:00:00.000Z",
          updatedAt: "2026-08-24T03:01:00.000Z",
        },
      ],
      totalCount: 3,
      truncated: false,
    },
  );
});

test("the attention feed stays scoped to one applicant without collapsing multiple requests", async () => {
  const { loadManualMessageAttention, indexManualMessageAttention } = await loadModule();

  assert.equal(typeof loadManualMessageAttention, "function");
  assert.equal(typeof indexManualMessageAttention, "function");
  const result = await loadManualMessageAttention!(fakeSupabase(rows), { applicantId: 11 });
  assert.deepEqual(result.items.map((item) => [item.jobId, item.phase]), [
    [101, "checking"],
    [102, "history_recovery"],
  ]);
  assert.deepEqual(
    [...indexManualMessageAttention!(result.items).entries()].map(([applicantId, items]) => [
      applicantId,
      items.map((item) => [item.jobId, item.phase]),
    ]),
    [[11, [
      [101, "checking"],
      [102, "history_recovery"],
    ]]],
  );
});

test("an attention lookup failure is explicit instead of looking like zero work", async () => {
  const { loadManualMessageAttention } = await loadModule();

  assert.equal(typeof loadManualMessageAttention, "function");
  assert.deepEqual(
    await loadManualMessageAttention!(fakeSupabase(rows, { message: "database unavailable" })),
    { state: "error", items: [], totalCount: null, truncated: false },
  );
});

test("an attention query that reaches its cap reports truncation instead of silently hiding work", async () => {
  const { loadManualMessageAttention } = await loadModule();

  assert.equal(typeof loadManualMessageAttention, "function");
  const result = await loadManualMessageAttention!(fakeSupabase(rows), { limit: 2 });
  assert.deepEqual(result.items.map((item) => [item.applicantId, item.phase]), [
    [11, "checking"],
    [12, "manual_confirmation"],
  ]);
  assert.equal(result.totalCount, 3);
  assert.equal(result.truncated, true);
});

test("the live presentation is warning-only and exposes no retry or resend action", async () => {
  const { loadManualMessageAttention, manualMessageAttentionPresentation } = await loadModule();

  assert.equal(typeof loadManualMessageAttention, "function");
  assert.equal(typeof manualMessageAttentionPresentation, "function");
  const result = await loadManualMessageAttention!(fakeSupabase(rows), { applicantId: 11 });
  const presentation = manualMessageAttentionPresentation!(result.items);

  assert.equal(presentation?.badgeLabel, "발송 확인 필요");
  assert.equal(presentation?.count, 2);
  assert.equal(presentation?.primaryPhase, "checking");
  assert.match(presentation?.description ?? "", /다시 보내지 않습니다/);
  assert.equal(presentation?.resendAllowed, false);
  assert.deepEqual(presentation?.actions, []);
  assert.equal(manualMessageAttentionPresentation!([]), null);
});

test("a parent collection failure overrides a cached clear attention result", async () => {
  const { manualMessageAttentionRemoteState } = await loadModule();

  assert.equal(typeof manualMessageAttentionRemoteState, "function");
  const cachedClear: AttentionCollection = {
    state: "ready",
    items: [],
    totalCount: 0,
    truncated: false,
  };
  assert.equal(manualMessageAttentionRemoteState!("error", cachedClear), "error");
  assert.equal(manualMessageAttentionRemoteState!("loading", undefined), "loading");
  assert.equal(manualMessageAttentionRemoteState!("ready", cachedClear), "ready");
});

test("a failed message poll invalidates the cached attention state", () => {
  const thread = readFileSync(
    new URL("../../components/ConversationThread.tsx", import.meta.url),
    "utf8",
  );
  const loadStart = thread.indexOf("const loadMessages = useCallback");
  const loadEnd = thread.indexOf("useEffect(() => {\n    loadMessages();", loadStart);
  const loadMessagesSource = thread.slice(loadStart, loadEnd);

  assert.match(
    loadMessagesSource,
    /catch \{[\s\S]*?setManualMessageAttention\(FAILED_MANUAL_MESSAGE_ATTENTION\)/,
  );
});

test("active attention lookups have a partial index for applicant polling", () => {
  const migration = readFileSync(
    new URL("../../docs/migrations/2026-08-manual-message-attention-index.sql", import.meta.url),
    "utf8",
  );

  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS manual_message_send_requests_attention_applicant_idx[\s\S]*?\(applicant_id, created_at\)[\s\S]*?WHERE status IN \('sending', 'unknown', 'sent'\)/i,
  );
});
