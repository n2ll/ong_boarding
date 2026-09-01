import assert from "node:assert/strict";
import test from "node:test";

type AttentionCollection = {
  state: "ready" | "error";
  items: Array<{
    batchId: string;
    applicantId: number;
    jobId: number | null;
    purpose: string | null;
    phase: "checking" | "manual_confirmation" | "history_recovery";
    createdAt: string;
    updatedAt: string;
  }>;
  batches: Array<{
    batchId: string;
    jobId: number | null;
    purpose: string | null;
    applicantIds: number[];
    totalCount: number;
    checkingCount: number;
    manualConfirmationCount: number;
    historyRecoveryCount: number;
    oldestCreatedAt: string;
  }>;
  batchCount: number;
  totalCount: number | null;
  checkingCount: number;
  manualConfirmationCount: number;
  historyRecoveryCount: number;
  oldestCreatedAt: string | null;
  oldestAgeMinutes: number | null;
  truncated: boolean;
};

type AttentionPresentation = {
  title: string;
  description: string;
  path: string;
  state: "ready" | "error";
  tone: "red" | "amber";
  urgency: "attention" | "critical";
  priorityLabel?: string;
  resendAllowed: false;
  actions: readonly [];
};

type AttentionModule = {
  loadBulkMessageAttention?: (
    supabase: unknown,
    options?: { now?: number; limit?: number },
  ) => Promise<AttentionCollection>;
  bulkMessageAttentionPresentation?: (
    collection: AttentionCollection,
  ) => AttentionPresentation | null;
};

async function loadModule(): Promise<AttentionModule> {
  try {
    return await import(new URL("./bulk-message-attention.ts", import.meta.url).href) as AttentionModule;
  } catch {
    return {};
  }
}

type RawRow = {
  recipient_key: string;
  batch_id: string;
  status: string;
  provider_correlation_attached: boolean;
  provider_reconcile_status: string;
  applicant_id: number | null;
  job_id: number | null;
  effective_purpose: string;
  created_at: string;
  updated_at: string;
};

function fakeSupabase(
  rows: RawRow[],
  options: { error?: { message: string } | null; onSelect?: (columns: string) => void } = {},
) {
  let selected = [...rows];
  let totalCount = selected.length;

  const query = {
    select(columns: string) {
      options.onSelect?.(columns);
      return query;
    },
    in(column: string, values: string[]) {
      selected = selected.filter((row) => values.includes(String(row[column as keyof RawRow])));
      totalCount = selected.length;
      return query;
    },
    lte(column: string, value: string) {
      selected = selected.filter((row) => String(row[column as keyof RawRow]) <= value);
      totalCount = selected.length;
      return query;
    },
    order(column: string, orderOptions?: { ascending?: boolean }) {
      selected.sort((a, b) => {
        const left = String(a[column as keyof RawRow] ?? "");
        const right = String(b[column as keyof RawRow] ?? "");
        return (orderOptions?.ascending === false ? -1 : 1) * left.localeCompare(right);
      });
      return query;
    },
    limit(value: number) {
      selected = selected.slice(0, value);
      return query;
    },
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: {
        data: RawRow[] | null;
        error: { message: string } | null;
        count: number;
      }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      const error = options.error ?? null;
      return Promise.resolve({ data: error ? null : selected, error, count: totalCount })
        .then(onfulfilled, onrejected);
    },
  };

  return {
    from(table: string) {
      assert.equal(table, "bulk_message_send_requests");
      return query;
    },
  };
}

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const rows: RawRow[] = [
  {
    recipient_key: "11111111-1111-4111-8111-111111111111",
    batch_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "sending",
    provider_correlation_attached: true,
    provider_reconcile_status: "pending",
    applicant_id: 11,
    job_id: 101,
    effective_purpose: "new_job",
    created_at: "2026-09-01T11:00:00.000Z",
    updated_at: "2026-09-01T11:01:00.000Z",
  },
  {
    recipient_key: "22222222-2222-4222-8222-222222222222",
    batch_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "unknown",
    provider_correlation_attached: true,
    provider_reconcile_status: "unresolved",
    applicant_id: 12,
    job_id: 101,
    effective_purpose: "new_job",
    created_at: "2026-09-01T11:10:00.000Z",
    updated_at: "2026-09-01T11:30:00.000Z",
  },
  {
    recipient_key: "33333333-3333-4333-8333-333333333333",
    batch_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    status: "sent",
    provider_correlation_attached: true,
    provider_reconcile_status: "matched",
    applicant_id: 13,
    job_id: 101,
    effective_purpose: "new_job",
    created_at: "2026-09-01T11:20:00.000Z",
    updated_at: "2026-09-01T11:21:00.000Z",
  },
  {
    recipient_key: "44444444-4444-4444-8444-444444444444",
    batch_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    status: "unknown",
    provider_correlation_attached: true,
    provider_reconcile_status: "pending",
    applicant_id: 14,
    job_id: null,
    effective_purpose: "campaign",
    created_at: "2026-09-01T11:58:00.000Z",
    updated_at: "2026-09-01T11:58:00.000Z",
  },
  {
    recipient_key: "55555555-5555-4555-8555-555555555555",
    batch_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    status: "recorded",
    provider_correlation_attached: true,
    provider_reconcile_status: "matched",
    applicant_id: 15,
    job_id: null,
    effective_purpose: "campaign",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  },
];

test("the persistent bulk attention feed waits five minutes and exposes no phone or body", async () => {
  const { loadBulkMessageAttention } = await loadModule();
  let selectedColumns = "";

  assert.equal(typeof loadBulkMessageAttention, "function");
  const result = await loadBulkMessageAttention!(fakeSupabase(rows, {
    onSelect: (columns) => { selectedColumns = columns; },
  }), { now: NOW });

  assert.deepEqual(result, {
    state: "ready",
    items: [
      {
        batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        applicantId: 11,
        jobId: 101,
        purpose: "new_job",
        phase: "checking",
        createdAt: "2026-09-01T11:00:00.000Z",
        updatedAt: "2026-09-01T11:01:00.000Z",
      },
      {
        batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        applicantId: 12,
        jobId: 101,
        purpose: "new_job",
        phase: "manual_confirmation",
        createdAt: "2026-09-01T11:10:00.000Z",
        updatedAt: "2026-09-01T11:30:00.000Z",
      },
      {
        batchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        applicantId: 13,
        jobId: 101,
        purpose: "new_job",
        phase: "history_recovery",
        createdAt: "2026-09-01T11:20:00.000Z",
        updatedAt: "2026-09-01T11:21:00.000Z",
      },
    ],
    batches: [
      {
        batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        jobId: 101,
        purpose: "new_job",
        applicantIds: [11, 12],
        totalCount: 2,
        checkingCount: 1,
        manualConfirmationCount: 1,
        historyRecoveryCount: 0,
        oldestCreatedAt: "2026-09-01T11:00:00.000Z",
      },
      {
        batchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        jobId: 101,
        purpose: "new_job",
        applicantIds: [13],
        totalCount: 1,
        checkingCount: 0,
        manualConfirmationCount: 0,
        historyRecoveryCount: 1,
        oldestCreatedAt: "2026-09-01T11:20:00.000Z",
      },
    ],
    batchCount: 2,
    totalCount: 3,
    checkingCount: 1,
    manualConfirmationCount: 1,
    historyRecoveryCount: 1,
    oldestCreatedAt: "2026-09-01T11:00:00.000Z",
    oldestAgeMinutes: 60,
    truncated: false,
  });
  assert.doesNotMatch(selectedColumns, /phone|body|subject|error/i);
});

test("a bulk attention lookup failure is explicit instead of becoming zero", async () => {
  const { loadBulkMessageAttention } = await loadModule();

  assert.equal(typeof loadBulkMessageAttention, "function");
  assert.deepEqual(
    await loadBulkMessageAttention!(fakeSupabase(rows, {
      error: { message: "outbox unavailable" },
    }), { now: NOW }),
    {
      state: "error",
      items: [],
      batches: [],
      batchCount: 0,
      totalCount: null,
      checkingCount: 0,
      manualConfirmationCount: 0,
      historyRecoveryCount: 0,
      oldestCreatedAt: null,
      oldestAgeMinutes: null,
      truncated: false,
    },
  );
});

test("a capped bulk attention feed reports truncation", async () => {
  const { loadBulkMessageAttention } = await loadModule();

  assert.equal(typeof loadBulkMessageAttention, "function");
  const result = await loadBulkMessageAttention!(fakeSupabase(rows), { now: NOW, limit: 2 });
  assert.equal(result.totalCount, 3);
  assert.equal(result.checkingCount + result.manualConfirmationCount + result.historyRecoveryCount, 2);
  assert.equal(result.truncated, true);
});

test("manual confirmation outranks automatic and history recovery without offering resend", async () => {
  const { loadBulkMessageAttention, bulkMessageAttentionPresentation } = await loadModule();

  assert.equal(typeof loadBulkMessageAttention, "function");
  assert.equal(typeof bulkMessageAttentionPresentation, "function");
  const collection = await loadBulkMessageAttention!(fakeSupabase(rows), { now: NOW });
  const presentation = bulkMessageAttentionPresentation!(collection);

  assert.equal(presentation?.title, "문자 발송 묶음 2개 확인 필요");
  assert.equal(presentation?.urgency, "critical");
  assert.equal(presentation?.priorityLabel, "수동 확인");
  assert.equal(presentation?.tone, "red");
  assert.equal(presentation?.state, "ready");
  assert.match(presentation?.description ?? "", /자동 재발송하지 않습니다/);
  assert.match(presentation?.description ?? "", /발송 3건/);
  assert.equal(presentation?.path, "/pipeline?bulk_attention=1");
  assert.equal(presentation?.resendAllowed, false);
  assert.deepEqual(presentation?.actions, []);
});

test("a clear collection stays quiet while a failed lookup remains visible and blocks resend", async () => {
  const { bulkMessageAttentionPresentation } = await loadModule();

  assert.equal(typeof bulkMessageAttentionPresentation, "function");
  const clear: AttentionCollection = {
    state: "ready",
    items: [],
    batches: [],
    batchCount: 0,
    totalCount: 0,
    checkingCount: 0,
    manualConfirmationCount: 0,
    historyRecoveryCount: 0,
    oldestCreatedAt: null,
    oldestAgeMinutes: null,
    truncated: false,
  };
  assert.equal(bulkMessageAttentionPresentation!(clear), null);
  const failed = bulkMessageAttentionPresentation!({ ...clear, state: "error", totalCount: null });
  assert.equal(failed?.state, "error");
  assert.equal(failed?.tone, "red");
  assert.equal(failed?.priorityLabel, "조회 실패");
  assert.match(failed?.description ?? "", /다시 보내지 마세요/);
  assert.equal(failed?.resendAllowed, false);
});
