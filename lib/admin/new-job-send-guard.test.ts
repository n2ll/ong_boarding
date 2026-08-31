import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";
import { fetchPhoneMessageIdentityIndex } from "./phone-message-identity.ts";
import { normalizePhone } from "../ongmanaging.ts";

type Row = Record<string, unknown>;

const NOW = "2026-08-31T12:00:00.000Z";

class FixedDate extends Date {
  static override now(): number {
    return Date.parse(NOW);
  }
}

type QueryCall = {
  table: string;
  method: "default" | "range" | "maybeSingle" | "insert";
  from?: number;
  equals: Array<[string, unknown]>;
  greaterThan: Array<[string, unknown]>;
  inValues: Array<[string, unknown[]]>;
  orders: Array<[string, boolean]>;
};

type FakeOptions = {
  fail?: (call: QueryCall) => string | null;
};

function valueForColumn(row: Row, column: string): unknown {
  if (column === "meta->>purpose") {
    return (row.meta as { purpose?: unknown } | null)?.purpose;
  }
  return row[column];
}

function createSupabaseStub(
  database: Record<string, Row[]>,
  calls: QueryCall[],
  inserted: Array<{ table: string; row: Row }>,
  options: FakeOptions = {},
) {
  class QueryBuilder {
    readonly table: string;
    readonly equals: Array<[string, unknown]> = [];
    readonly greaterThan: Array<[string, unknown]> = [];
    readonly inValues: Array<[string, unknown[]]> = [];
    readonly orders: Array<[string, boolean]> = [];

    constructor(table: string) {
      this.table = table;
    }

    select() { return this; }

    eq(column: string, value: unknown) {
      this.equals.push([column, value]);
      return this;
    }

    gt(column: string, value: unknown) {
      this.greaterThan.push([column, value]);
      return this;
    }

    in(column: string, values: unknown[]) {
      this.inValues.push([column, values]);
      return this;
    }

    order(column: string, options?: { ascending?: boolean }) {
      this.orders.push([column, options?.ascending !== false]);
      return this;
    }

    private filteredRows(): Row[] {
      return (database[this.table] ?? []).filter((row) => (
        this.equals.every(([column, value]) => valueForColumn(row, column) === value)
        && this.greaterThan.every(([column, minimum]) => {
          const value = valueForColumn(row, column);
          return typeof value === "string" && typeof minimum === "string" && value > minimum;
        })
        && this.inValues.every(([column, values]) => values.includes(valueForColumn(row, column)))
      ));
    }

    private result(method: QueryCall["method"], from?: number, to?: number) {
      const call: QueryCall = {
        table: this.table,
        method,
        from,
        equals: [...this.equals],
        greaterThan: [...this.greaterThan],
        inValues: this.inValues.map(([column, values]) => [column, [...values]]),
        orders: [...this.orders],
      };
      calls.push(call);
      const error = options.fail?.(call) ?? null;
      if (error) return { data: null, error: { message: error } };
      const rows = this.filteredRows();
      return {
        data: typeof from === "number" && typeof to === "number" ? rows.slice(from, to + 1) : rows.slice(0, 1_000),
        error: null,
      };
    }

    async maybeSingle() {
      const result = this.result("maybeSingle");
      return { data: result.data?.[0] ?? null, error: result.error };
    }

    async range(from: number, to: number) {
      return this.result("range", from, to);
    }

    async insert(row: Row) {
      const call: QueryCall = {
        table: this.table,
        method: "insert",
        equals: [],
        greaterThan: [],
        inValues: [],
        orders: [],
      };
      calls.push(call);
      const error = options.fail?.(call) ?? null;
      if (!error) inserted.push({ table: this.table, row });
      return { error: error ? { message: error } : null };
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: { data: Row[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(this.result("default")).then(onfulfilled, onrejected);
    }
  }

  return {
    from(table: string) {
      return new QueryBuilder(table);
    },
  };
}

type JsonResponse = { body: Record<string, unknown>; status: number };
type RouteModule = { POST: (request: { json(): Promise<unknown> }) => Promise<JsonResponse> };

function loadRoute(args: {
  database: Record<string, Row[]>;
  options?: FakeOptions;
}) {
  const calls: QueryCall[] = [];
  const inserted: Array<{ table: string; row: Row }> = [];
  const smsCalls: Array<{ phone: string; body: string; subject: string }> = [];
  const supabase = createSupabaseStub(args.database, calls, inserted, args.options);
  const route = new URL("../../app/api/admin/messages/bulk-send/route.ts", import.meta.url);
  const output = ts.transpileModule(readFileSync(route, "utf8"), {
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
  const stubs: Record<string, Record<string, unknown>> = {
    "next/server": { NextResponse: nextResponse },
    "@/lib/supabase": { createServiceClient: () => supabase },
    "@/lib/solapi": {
      sendSms: async (phone: string, body: string, subject: string) => {
        smsCalls.push({ phone, body, subject });
        return { success: true, messageId: "sms-1" };
      },
    },
    "@/lib/blacklist": { fetchBlacklistedPhones: async () => new Set<string>() },
    "@/lib/sms-consent-policy": {
      CURRENT_JOB_WAITLIST_SMS_BODY: "approved waitlist",
      classifyBulkSmsCategory: ({ purpose }: { purpose: string }) => (
        purpose === "new_job" || purpose === "campaign" ? "promotional" : "operational"
      ),
      currentJobClosedSmsBody: () => "approved closed",
      smsRecipientBlockReason: ({ applicant }: { applicant?: { marketingConsent?: boolean } }) => (
        applicant?.marketingConsent === true ? null : "consent_required"
      ),
    },
    "@/lib/agent/general-line": {
      isGeneralLineJob: () => false,
      joinedClientType: () => null,
    },
    "@/lib/jobs": {
      isJobEffectivelyClosed: (status: string | null, closesAt: string | null) => (
        status !== "active" || (!!closesAt && Date.parse(closesAt) <= FixedDate.now())
      ),
    },
    "@/lib/admin/postgrest-pagination": { fetchAllPostgrestRows },
    "@/lib/admin/phone-message-identity": { fetchPhoneMessageIdentityIndex },
    "@/lib/ongmanaging": { normalizePhone },
  };

  runInNewContext(output, {
    Date: FixedDate,
    Number,
    Set,
    Map,
    Promise,
    process,
    console: { error() {} },
    setTimeout: (callback: () => void) => callback(),
    exports: compiledModule.exports,
    module: compiledModule,
    require: (specifier: string) => stubs[specifier] ?? {},
  });

  return {
    route: compiledModule.exports as RouteModule,
    calls,
    inserted,
    smsCalls,
  };
}

function activeJob(overrides: Row = {}): Row {
  return {
    id: 7,
    title: "새 배송 공고",
    status: "active",
    closes_at: null,
    recruit_mode: "internal",
    ...overrides,
  };
}

function applicant(): Row {
  return {
    id: 1,
    name: "지원자",
    phone: "01012345678",
    access_token: "token-1",
    sms_opt_out_at: null,
    marketing_consent: true,
    marketing_consent_at: "2026-08-20T00:00:00.000Z",
    status: "온보딩",
  };
}

function request(
  jobId: number | null = 7,
  recipients: Array<{ applicant_id: number; phone: string }> = [
    { applicant_id: 1, phone: "01012345678" },
  ],
) {
  return {
    async json() {
      return {
        recipients,
        body: "#{이름}님, 새 공고를 확인해 주세요. #{맞춤링크}",
        purpose: "new_job",
        ...(jobId === null ? {} : { job_id: jobId }),
      };
    },
  };
}

function campaignRequest() {
  return {
    async json() {
      return {
        recipients: [{ applicant_id: 1, phone: "01012345678" }],
        body: "새 일자리 안내입니다.",
        purpose: "campaign",
      };
    },
  };
}

test("new-job send rejects a missing job id before sending SMS", async () => {
  const harness = loadRoute({ database: { jobs: [activeJob()], applicants: [applicant()] } });

  const response = await harness.route.POST(request(null));

  assert.equal(response.status, 400);
  assert.match(String(response.body.error), /공고/);
  assert.equal(harness.smsCalls.length, 0);
});

test("new-job send rejects jobs that are not visible in the applicant pull page", async () => {
  for (const blockedJob of [
    activeJob({ recruit_mode: "external" }),
    activeJob({ status: "closed" }),
    activeJob({ closes_at: "2026-08-31T11:59:59.000Z" }),
  ]) {
    const harness = loadRoute({ database: { jobs: [blockedJob], applicants: [applicant()] } });

    const response = await harness.route.POST(request());

    assert.equal(response.status, 409);
    assert.equal(harness.smsCalls.length, 0);
  }
});

test("new-job job lookup failure stops the whole request before sending SMS", async () => {
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()] },
    options: {
      fail: (call) => call.table === "jobs" && call.method === "maybeSingle" ? "database unavailable" : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 503);
  assert.equal(harness.smsCalls.length, 0);
});

test("new-job send skips a recipient who received another new-job notice within seven days", async () => {
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant()],
      messages: [],
      pool_events: [{
        id: 11,
        applicant_id: 1,
        event_type: "ping_sent",
        created_at: "2026-08-25T12:00:01.000Z",
        meta: { purpose: "new_job" },
      }],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.failed, 1);
  assert.match(String((response.body.results as Array<{ error?: string }>)[0]?.error), /7일/);
  assert.equal(harness.smsCalls.length, 0);
});

test("new-job fatigue ignores other purposes and notices older than seven days", async () => {
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant()],
      messages: [],
      pool_events: [
        {
          id: 11,
          applicant_id: 1,
          event_type: "ping_sent",
          created_at: "2026-08-25T12:00:01.000Z",
          meta: { purpose: "campaign" },
        },
        {
          id: 12,
          applicant_id: 1,
          event_type: "ping_sent",
          created_at: "2026-08-23T11:59:59.000Z",
          meta: { purpose: "new_job" },
        },
      ],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 1);
  assert.equal(harness.smsCalls.length, 1);
});

test("new-job fatigue reads past the PostgREST 1000-row boundary before sending", async () => {
  const secondApplicant = {
    ...applicant(),
    id: 2,
    phone: "01087654321",
    access_token: "token-2",
  };
  const poolEvents = [
    ...Array.from({ length: 1_000 }, (_, index) => ({
      id: index + 1,
      applicant_id: 1,
      event_type: "ping_sent",
      created_at: "2026-08-30T12:00:00.000Z",
      meta: { purpose: "new_job" },
    })),
    {
      id: 1_001,
      applicant_id: 2,
      event_type: "ping_sent",
      created_at: "2026-08-30T12:00:00.000Z",
      meta: { purpose: "new_job" },
    },
  ];
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant(), secondApplicant],
      messages: [],
      pool_events: poolEvents,
    },
  });

  const response = await harness.route.POST(request(7, [
    { applicant_id: 1, phone: "01012345678" },
    { applicant_id: 2, phone: "01087654321" },
  ]));

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.failed, 2);
  assert.equal(harness.smsCalls.length, 0);
  assert.equal(harness.calls.some((call) => call.table === "pool_events" && call.from === 1_000), true);
});

test("new-job fatigue lookup failure stops the whole request before sending SMS", async () => {
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()], messages: [], pool_events: [] },
    options: {
      fail: (call) => (
        call.table === "pool_events"
        && call.equals.some(([column, value]) => column === "meta->>purpose" && value === "new_job")
      ) ? "fatigue ledger unavailable" : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 503);
  assert.equal(harness.smsCalls.length, 0);
});

test("a later fatigue page failure also stops the whole request before sending SMS", async () => {
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant()],
      messages: [],
      pool_events: Array.from({ length: 1_000 }, (_, index) => ({
        id: index + 1,
        applicant_id: 1,
        event_type: "ping_sent",
        created_at: "2026-08-30T12:00:00.000Z",
        meta: { purpose: "new_job" },
      })),
    },
    options: {
      fail: (call) => (
        call.table === "pool_events"
        && call.method === "range"
        && call.from === 1_000
        && call.equals.some(([column, value]) => column === "meta->>purpose" && value === "new_job")
      ) ? "later fatigue page unavailable" : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 503);
  assert.equal(harness.smsCalls.length, 0);
});

test("new-job send still sends for an active pull-visible job without recent fatigue", async () => {
  const harness = loadRoute({
    database: { jobs: [activeJob({ recruit_mode: "both" })], applicants: [applicant()], messages: [], pool_events: [] },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 1);
  assert.equal(harness.smsCalls.length, 1);
});

test("new-job send excludes a phone when a duplicate row is already a candidate for the job", async () => {
  const duplicate = {
    ...applicant(),
    id: 2,
    phone: "010-1234-5678",
  };
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant(), duplicate],
      job_candidates: [{ id: 11, applicant_id: 2, job_id: 7 }],
      messages: [],
      pool_events: [],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.match(String((response.body.results as Array<{ error?: string }>)[0]?.error), /이미.*후보/);
  assert.equal(harness.smsCalls.length, 0);
});

test("new-job send excludes a phone when a duplicate row has a pool-excluded status", async () => {
  const duplicate = {
    ...applicant(),
    id: 2,
    phone: "010-1234-5678",
    status: "확정인력",
  };
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant(), duplicate],
      job_candidates: [],
      messages: [],
      pool_events: [],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.match(String((response.body.results as Array<{ error?: string }>)[0]?.error), /확정인력/);
  assert.equal(harness.smsCalls.length, 0);
});

test("new-job send treats an opt-out on a duplicate applicant row as phone-level", async () => {
  const optedOutDuplicate = {
    ...applicant(),
    id: 2,
    phone: "010-1234-5678",
    marketing_consent: false,
    marketing_consent_at: null,
    sms_opt_out_at: "2026-08-25T00:00:00.000Z",
  };
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant(), optedOutDuplicate],
      messages: [],
      pool_events: [],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.match(String((response.body.results as Array<{ error?: string }>)[0]?.error), /수신거부/);
  assert.equal(harness.smsCalls.length, 0);
});

test("a strictly later explicit consent can clear an older duplicate-row opt-out", async () => {
  const reconsented = {
    ...applicant(),
    marketing_consent_at: "2026-08-26T00:00:00.000Z",
  };
  const olderOptOutDuplicate = {
    ...applicant(),
    id: 2,
    phone: "010-1234-5678",
    marketing_consent: false,
    marketing_consent_at: null,
    sms_opt_out_at: "2026-08-25T00:00:00.000Z",
  };
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [reconsented, olderOptOutDuplicate],
      messages: [],
      pool_events: [],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 1);
  assert.equal(harness.smsCalls.length, 1);
});

test("new-job fatigue on a duplicate applicant row blocks the shared phone", async () => {
  const duplicate = {
    ...applicant(),
    id: 2,
    phone: "010-1234-5678",
  };
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant(), duplicate],
      messages: [],
      pool_events: [{
        id: 11,
        applicant_id: 2,
        event_type: "ping_sent",
        created_at: "2026-08-30T00:00:00.000Z",
        meta: { purpose: "new_job" },
      }],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.match(String((response.body.results as Array<{ error?: string }>)[0]?.error), /7일/);
  assert.equal(harness.smsCalls.length, 0);
});

test("phone identity lookup failure stops promotional SMS before sending", async () => {
  const fillerApplicants = Array.from({ length: 1_000 }, (_, index) => ({
    ...applicant(),
    id: index + 2,
    phone: `011${String(index).padStart(8, "0")}`,
  }));
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant(), ...fillerApplicants],
      messages: [],
      pool_events: [],
    },
    options: {
      fail: (call) => call.table === "applicants" && call.method === "range" && call.from === 1_000
        ? "later identity page unavailable"
        : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 503);
  assert.equal(harness.smsCalls.length, 0);
});

test("an unknown recipient phone produces one failed result instead of duplicate failure rows", async () => {
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant()],
      messages: [],
      pool_events: [],
    },
  });

  const response = await harness.route.POST(request(7, [
    { applicant_id: 1, phone: "01099998888" },
  ]));

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.failed, 1);
  assert.equal((response.body.results as unknown[]).length, 1);
  assert.equal(harness.smsCalls.length, 0);
});

test("ten-minute message dedupe first-page failure stops the whole request", async () => {
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()], messages: [], pool_events: [] },
    options: {
      fail: (call) => call.table === "messages" ? "messages unavailable" : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 503);
  assert.equal(harness.smsCalls.length, 0);
});

test("ten-minute message dedupe later-page failure stops the whole request", async () => {
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant()],
      messages: Array.from({ length: 1_000 }, (_, index) => ({
        id: index + 1,
        applicant_id: 1,
        direction: "outbound",
        sent_by: "system-bulk",
        created_at: "2026-08-31T11:59:00.000Z",
      })),
      pool_events: [],
    },
    options: {
      fail: (call) => call.table === "messages" && call.method === "range" && call.from === 1_000
        ? "later messages page unavailable"
        : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 503);
  assert.equal(harness.smsCalls.length, 0);
});

test("cross-notice first-page failure stops the whole request", async () => {
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()], messages: [], pool_events: [] },
    options: {
      fail: (call) => (
        call.table === "pool_events"
        && !call.equals.some(([column]) => column === "meta->>purpose")
      ) ? "cross-notice unavailable" : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 503);
  assert.equal(harness.smsCalls.length, 0);
});

test("cross-notice later-page failure stops the whole request", async () => {
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant()],
      messages: [],
      pool_events: Array.from({ length: 1_000 }, (_, index) => ({
        id: index + 1,
        applicant_id: 1,
        event_type: "ping_sent",
        created_at: "2026-08-31T11:00:00.000Z",
        meta: { purpose: "new_job" },
      })),
    },
    options: {
      fail: (call) => (
        call.table === "pool_events"
        && call.method === "range"
        && call.from === 1_000
        && !call.equals.some(([column]) => column === "meta->>purpose")
      ) ? "later cross-notice page unavailable" : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 503);
  assert.equal(harness.smsCalls.length, 0);
});

test("ten-minute message dedupe on a duplicate applicant row blocks the shared phone", async () => {
  const duplicate = {
    ...applicant(),
    id: 2,
    phone: "010-1234-5678",
  };
  const harness = loadRoute({
    database: {
      jobs: [activeJob()],
      applicants: [applicant(), duplicate],
      messages: [{
        id: 1,
        applicant_id: 2,
        direction: "outbound",
        sent_by: "system-bulk",
        created_at: "2026-08-31T11:59:00.000Z",
      }],
      pool_events: [],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.match(String((response.body.results as Array<{ error?: string }>)[0]?.error), /최근 발송/);
  assert.equal(harness.smsCalls.length, 0);
});

test("cross-notice dedupe on a duplicate applicant row blocks the shared phone", async () => {
  const duplicate = {
    ...applicant(),
    id: 2,
    phone: "010-1234-5678",
  };
  const harness = loadRoute({
    database: {
      applicants: [applicant(), duplicate],
      messages: [],
      pool_events: [{
        id: 1,
        applicant_id: 2,
        event_type: "ping_sent",
        created_at: "2026-08-31T11:00:00.000Z",
        meta: { purpose: "campaign" },
      }],
    },
  });

  const response = await harness.route.POST(campaignRequest());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.match(String((response.body.results as Array<{ error?: string }>)[0]?.error), /24시간/);
  assert.equal(harness.smsCalls.length, 0);
});
