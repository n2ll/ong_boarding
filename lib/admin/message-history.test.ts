import assert from "node:assert/strict";
import test from "node:test";

type PageResult = {
  data: Array<{ id: number; created_at: string }> | null;
  error: { message: string } | null;
};

type MessageHistoryModule = {
  fetchCompleteMessageHistory?: (
    client: unknown,
    scope: { applicantId: number; applicantPhone: string | null; jobId: number | null },
  ) => Promise<Array<{ id: number; created_at: string }>>;
};

async function loadModule(): Promise<MessageHistoryModule> {
  try {
    return await import(new URL("./message-history.ts", import.meta.url).href) as MessageHistoryModule;
  } catch {
    return {};
  }
}

function createFakeClient(
  getPage: (from: number, to: number) => PageResult,
  calls: string[],
) {
  return {
    from(table: string) {
      calls.push(`from:${table}`);
      const query = {
        select(columns: string) {
          calls.push(`select:${columns}`);
          return query;
        },
        or(filter: string) {
          calls.push(`or:${filter}`);
          return query;
        },
        eq(column: string, value: number) {
          calls.push(`eq:${column}:${value}`);
          return query;
        },
        order(column: string, options: { ascending: boolean }) {
          calls.push(`order:${column}:${options.ascending ? "asc" : "desc"}`);
          return query;
        },
        async range(from: number, to: number) {
          calls.push(`range:${from}:${to}`);
          return getPage(from, to);
        },
      };
      return query;
    },
  };
}

test("loads message history beyond 1000 rows with stable order and the same job context", async () => {
  const { fetchCompleteMessageHistory } = await loadModule();
  assert.equal(typeof fetchCompleteMessageHistory, "function");
  if (typeof fetchCompleteMessageHistory !== "function") return;

  const source = Array.from({ length: 1_001 }, (_, index) => ({
    id: index + 1,
    created_at: `2026-08-31T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
  }));
  const calls: string[] = [];
  const client = createFakeClient(
    (from, to) => ({ data: source.slice(from, to + 1), error: null }),
    calls,
  );

  const rows = await fetchCompleteMessageHistory(client, {
    applicantId: 37,
    applicantPhone: "01012345678",
    jobId: 12,
  });

  assert.deepEqual([rows[0].id, rows[999].id, rows[1_000].id], [1, 1_000, 1_001]);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("range:")),
    ["range:0:999", "range:1000:1999"],
  );
  assert.deepEqual(
    calls.filter((call) => call === "or:applicant_id.eq.37,applicant_phone.eq.01012345678"),
    [
      "or:applicant_id.eq.37,applicant_phone.eq.01012345678",
      "or:applicant_id.eq.37,applicant_phone.eq.01012345678",
    ],
  );
  assert.deepEqual(
    calls.filter((call) => call === "or:job_id.eq.12,job_id.is.null"),
    ["or:job_id.eq.12,job_id.is.null", "or:job_id.eq.12,job_id.is.null"],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("order:")),
    [
      "order:created_at:asc",
      "order:id:asc",
      "order:created_at:asc",
      "order:id:asc",
    ],
  );
});

test("rejects a later message page error instead of returning partial history", async () => {
  const { fetchCompleteMessageHistory } = await loadModule();
  assert.equal(typeof fetchCompleteMessageHistory, "function");
  if (typeof fetchCompleteMessageHistory !== "function") return;

  const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
    id: index + 1,
    created_at: "2026-08-31T00:00:00.000Z",
  }));
  const calls: string[] = [];
  const client = createFakeClient(
    (from) => from === 0
      ? { data: firstPage, error: null }
      : { data: null, error: { message: "database unavailable" } },
    calls,
  );

  await assert.rejects(
    fetchCompleteMessageHistory(client, {
      applicantId: 37,
      applicantPhone: null,
      jobId: null,
    }),
    /메시지 대화.*database unavailable/,
  );
  assert.deepEqual(
    calls.filter((call) => call === "eq:applicant_id:37"),
    ["eq:applicant_id:37", "eq:applicant_id:37"],
  );
});
