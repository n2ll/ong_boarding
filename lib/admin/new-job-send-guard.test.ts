import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";
import { fetchPhoneMessageIdentityIndex } from "./phone-message-identity.ts";
import { normalizePhone } from "../ongmanaging.ts";
import { detectConfirmationNuance } from "../agent/outbound-safety.ts";
import {
  bulkBatchRequestFingerprint,
  bulkMessageRequestFingerprint,
  bulkRecipientIdempotencyKey,
  deliverBulkMessage,
  validateBulkRequestId,
} from "../bulk-message-send.ts";

type Row = Record<string, unknown>;

const NOW = "2026-08-31T12:00:00.000Z";
const BULK_REQUEST_ID = "11111111-1111-4111-8111-111111111111";

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
  rpc?: (call: RpcCall) => { data?: unknown; error?: string } | null;
  smsResult?:
    | { success: true; messageId?: string }
    | { success: false; failureKind: "declared" | "unknown"; error?: string };
};

type RpcCall = {
  name: string;
  args: Record<string, unknown>;
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
  rpcCalls: RpcCall[],
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
    async rpc(name: string, args: Record<string, unknown>) {
      const call = { name, args };
      rpcCalls.push(call);
      const override = options.rpc?.(call);
      if (override) {
        return {
          data: override.data ?? null,
          error: override.error ? { message: override.error } : null,
        };
      }
      if (name === "claim_bulk_message_batch") {
        return { data: { outcome: "claimed" }, error: null };
      }
      if (name === "claim_bulk_message_recipient") {
        const batchId = String(args.p_batch_id ?? "");
        const phone = String(args.p_applicant_phone ?? "");
        return {
          data: {
            outcome: "claimed",
            recipient_key: bulkRecipientIdempotencyKey(batchId, phone),
            status: "sending",
            provider_message_id: null,
            reason: null,
          },
          error: null,
        };
      }
      if (name === "record_bulk_message_provider_result") {
        return { data: "recorded", error: null };
      }
      if (name === "finalize_bulk_message_send") {
        return { data: "recorded", error: null };
      }
      return { data: null, error: { message: `unexpected RPC: ${name}` } };
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
  const rpcCalls: RpcCall[] = [];
  const inserted: Array<{ table: string; row: Row }> = [];
  const smsCalls: Array<{
    phone: string;
    body: string;
    subject: string;
    options?: { clientRequestId?: string };
  }> = [];
  const supabase = createSupabaseStub(args.database, calls, inserted, rpcCalls, args.options);
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
      sendSms: async (
        phone: string,
        body: string,
        subject: string,
        options?: { clientRequestId?: string },
      ) => {
        smsCalls.push({ phone, body, subject, options });
        return args.options?.smsResult ?? { success: true, messageId: "sms-1" };
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
    "@/lib/agent/outbound-safety": { detectConfirmationNuance },
    "@/lib/exposure": {
      normalizeRule: (raw: unknown) => raw,
      isExposed: (
        exposureApplicant: { sido?: string | null; suntopDone?: boolean },
        exposureRule: { sido?: string[]; suntopDone?: boolean } | null,
        override: "include" | "exclude" | undefined,
      ) => {
        if (override === "exclude") return false;
        if (override === "include") return true;
        if (!exposureRule) return false;
        if (exposureRule.sido?.length && !exposureRule.sido.includes(exposureApplicant.sido ?? "")) {
          return false;
        }
        if (exposureRule.suntopDone && !exposureApplicant.suntopDone) return false;
        return Boolean(exposureRule.sido?.length || exposureRule.suntopDone);
      },
    },
    "@/lib/geo": {
      EXPOSURE_JOB_GEO_COLUMNS: "pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_basis",
    },
    "@/lib/bulk-message-send": {
      bulkBatchRequestFingerprint,
      bulkMessageRequestFingerprint,
      bulkRecipientIdempotencyKey,
      deliverBulkMessage,
      validateBulkRequestId,
    },
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
    rpcCalls,
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
  body = "#{이름}님, 새 공고를 확인해 주세요. #{맞춤링크}",
  bulkRequestId: unknown = BULK_REQUEST_ID,
) {
  return {
    async json() {
      return {
        recipients,
        body,
        purpose: "new_job",
        bulk_request_id: bulkRequestId,
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
        bulk_request_id: BULK_REQUEST_ID,
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

test("bulk send requires a valid request UUID before any database or provider work", async () => {
  for (const invalidKey of [null, "not-a-uuid"]) {
    const harness = loadRoute({ database: { jobs: [activeJob()], applicants: [applicant()] } });

    const response = await harness.route.POST(request(7, undefined, undefined, invalidKey));

    assert.equal(response.status, 400);
    assert.match(String(response.body.error), /발송 요청 키/);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.rpcCalls.length, 0);
    assert.equal(harness.smsCalls.length, 0);
  }
});

test("bulk send claims the batch and recipient, correlates the provider, and finalizes atomically", async () => {
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()], messages: [], pool_events: [] },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 1);
  assert.equal(response.body.already_sent, 0);
  assert.equal(response.body.sent_recovery_pending, 0);
  assert.equal(response.body.failed, 0);
  assert.equal(response.body.guarded, 0);
  assert.equal(response.body.unknown, 0);
  assert.equal(response.body.recovery_pending, 0);
  assert.equal(harness.smsCalls.length, 1);
  const recipientKey = bulkRecipientIdempotencyKey(BULK_REQUEST_ID, "01012345678");
  assert.equal(harness.smsCalls[0]?.options?.clientRequestId, recipientKey);
  assert.deepEqual(
    harness.rpcCalls.map((call) => call.name),
    [
      "claim_bulk_message_batch",
      "claim_bulk_message_recipient",
      "record_bulk_message_provider_result",
      "finalize_bulk_message_send",
    ],
  );
  const batchClaim = harness.rpcCalls[0];
  assert.equal(batchClaim?.args.p_request_id, BULK_REQUEST_ID);
  assert.equal(batchClaim?.args.p_request_fingerprint, bulkBatchRequestFingerprint({
    body: "#{이름}님, 새 공고를 확인해 주세요. #{맞춤링크}",
    subject: "옹고잉 채용 안내",
    purpose: "new_job",
    jobId: 7,
  }));
  const recipientClaim = harness.rpcCalls[1];
  assert.equal(recipientClaim?.args.p_recipient_fingerprint, bulkMessageRequestFingerprint({
    applicantId: 1,
    phone: "01012345678",
    body: harness.smsCalls[0]?.body ?? "",
    subject: "옹고잉 채용 안내",
    purpose: "new_job",
    jobId: 7,
  }));
  assert.equal(harness.inserted.length, 0, "history must be recorded only by finalize RPC");
  const result = (response.body.results as Array<Record<string, unknown>>)[0];
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    applicant_id: 1,
    phone: "01012345678",
    success: true,
    delivery: "sent",
    state: "recorded",
    recorded: true,
    deduplicated: false,
    recovery_pending: false,
  });
});

test("an existing sent recipient is finalized without calling the provider again", async () => {
  const recipientKey = bulkRecipientIdempotencyKey(BULK_REQUEST_ID, "01012345678");
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()], messages: [], pool_events: [] },
    options: {
      rpc: (call) => call.name === "claim_bulk_message_recipient"
        ? {
            data: {
              outcome: "existing",
              recipient_key: recipientKey,
              status: "sent",
              provider_message_id: "sms-existing",
              reason: null,
            },
          }
        : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.already_sent, 1);
  assert.equal(response.body.sent_recovery_pending, 0);
  assert.equal(harness.smsCalls.length, 0);
  assert.equal(
    harness.rpcCalls.some((call) => call.name === "record_bulk_message_provider_result"),
    false,
  );
  assert.equal(
    harness.rpcCalls.some((call) => call.name === "finalize_bulk_message_send"),
    true,
  );
  const result = (response.body.results as Array<Record<string, unknown>>)[0];
  assert.equal(result?.state, "recorded");
  assert.equal(result?.deduplicated, true);
  assert.equal(result?.recorded, true);
});

test("an existing unknown recipient is never resent and is reported for recovery", async () => {
  const recipientKey = bulkRecipientIdempotencyKey(BULK_REQUEST_ID, "01012345678");
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()], messages: [], pool_events: [] },
    options: {
      rpc: (call) => call.name === "claim_bulk_message_recipient"
        ? {
            data: {
              outcome: "existing",
              recipient_key: recipientKey,
              status: "unknown",
              provider_message_id: null,
              reason: "provider response missing",
            },
          }
        : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.already_sent, 0);
  assert.equal(response.body.sent_recovery_pending, 0);
  assert.equal(response.body.unknown, 1);
  assert.equal(response.body.failed, 0);
  assert.equal(response.body.guarded, 0);
  assert.equal(response.body.recovery_pending, 1);
  assert.equal(harness.smsCalls.length, 0);
  assert.equal(
    harness.rpcCalls.some((call) => call.name === "finalize_bulk_message_send"),
    false,
  );
  const result = (response.body.results as Array<Record<string, unknown>>)[0];
  assert.equal(result?.delivery, "unknown");
  assert.equal(result?.state, "unknown");
  assert.equal(result?.deduplicated, true);
});

test("batch claim conflict fails closed before any recipient claim or provider call", async () => {
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()], messages: [], pool_events: [] },
    options: {
      rpc: (call) => call.name === "claim_bulk_message_batch"
        ? { data: { outcome: "conflict", reason: "fingerprint mismatch" } }
        : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 409);
  assert.match(String(response.body.error), /요청 키|내용/);
  assert.deepEqual(harness.rpcCalls.map((call) => call.name), ["claim_bulk_message_batch"]);
  assert.equal(harness.smsCalls.length, 0);
});

test("batch claim RPC failure fails closed before any recipient claim or provider call", async () => {
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()], messages: [], pool_events: [] },
    options: {
      rpc: (call) => call.name === "claim_bulk_message_batch"
        ? { error: "outbox unavailable" }
        : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 503);
  assert.match(String(response.body.error), /안전하게 저장/);
  assert.deepEqual(harness.rpcCalls.map((call) => call.name), ["claim_bulk_message_batch"]);
  assert.equal(harness.smsCalls.length, 0);
});

test("recipient claim RPC failure blocks that recipient without calling the provider", async () => {
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()], messages: [], pool_events: [] },
    options: {
      rpc: (call) => call.name === "claim_bulk_message_recipient"
        ? { error: "outbox unavailable" }
        : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.failed, 0);
  assert.equal(response.body.guarded, 1);
  assert.equal(harness.smsCalls.length, 0);
  const result = (response.body.results as Array<Record<string, unknown>>)[0];
  assert.equal(result?.delivery, "not_sent");
  assert.equal(result?.state, "blocked");
});

test("an atomic phone guard owned by another batch blocks without a key mismatch or provider call", async () => {
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()], messages: [], pool_events: [] },
    options: {
      rpc: (call) => call.name === "claim_bulk_message_recipient"
        ? {
            data: {
              outcome: "blocked",
              recipient_key: "22222222-2222-4222-8222-222222222222",
              status: "sent",
              provider_message_id: "sms-other-batch",
              reason: "recent_new_job",
            },
          }
        : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(harness.smsCalls.length, 0);
  const result = (response.body.results as Array<Record<string, unknown>>)[0];
  assert.equal(result?.state, "blocked");
  assert.equal(result?.deduplicated, true);
  assert.match(String(result?.error), /7일/);
});

test("provider success with unavailable atomic finalization is truthful and recovery-pending", async () => {
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()], messages: [], pool_events: [] },
    options: {
      rpc: (call) => call.name === "finalize_bulk_message_send"
        ? { data: "unavailable" }
        : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.already_sent, 0);
  assert.equal(response.body.sent_recovery_pending, 1);
  assert.equal(response.body.failed, 0);
  assert.equal(response.body.unknown, 0);
  assert.equal(response.body.recovery_pending, 1);
  assert.equal(harness.smsCalls.length, 1);
  assert.equal(
    harness.rpcCalls.some((call) => call.name === "finalize_bulk_message_send"),
    true,
  );
  const result = (response.body.results as Array<Record<string, unknown>>)[0];
  assert.equal(result?.delivery, "sent");
  assert.equal(result?.state, "sent_unrecorded");
  assert.equal(result?.recorded, false);
  assert.equal(result?.recovery_pending, true);
});

test("a declared provider failure is unknown when the outbox release cannot be persisted", async () => {
  const harness = loadRoute({
    database: { jobs: [activeJob()], applicants: [applicant()], messages: [], pool_events: [] },
    options: {
      smsResult: { success: false, failureKind: "declared", error: "잔액 부족" },
      rpc: (call) => call.name === "record_bulk_message_provider_result"
        ? { error: "database unavailable" }
        : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.already_sent, 0);
  assert.equal(response.body.sent_recovery_pending, 0);
  assert.equal(response.body.unknown, 1);
  assert.equal(response.body.failed, 0);
  assert.equal(response.body.guarded, 0);
  assert.equal(response.body.recovery_pending, 1);
  const result = (response.body.results as Array<Record<string, unknown>>)[0];
  assert.equal(result?.state, "unknown");
  assert.equal(result?.recovery_pending, true);
  assert.match(String(result?.error), /재발송하지 않/);
});

test("direct new-job API rejects an announcement without the personal job link", async () => {
  const harness = loadRoute({ database: { jobs: [activeJob()], applicants: [applicant()] } });

  const response = await harness.route.POST(request(7, undefined, "#{이름}님, 새 공고가 있어요."));

  assert.equal(response.status, 400);
  assert.match(String(response.body.error), /맞춤링크/);
  assert.equal(harness.smsCalls.length, 0);
  assert.equal(harness.calls.length, 0, "invalid copy should fail before database work");
});

test("direct new-job API rejects copy that implies assignment or confirmation", async () => {
  const harness = loadRoute({ database: { jobs: [activeJob()], applicants: [applicant()] } });

  const response = await harness.route.POST(request(
    7,
    undefined,
    "#{이름}님, 근무 확정됐어요. #{맞춤링크}",
  ));

  assert.equal(response.status, 400);
  assert.match(String(response.body.error), /확정|배정/);
  assert.equal(harness.smsCalls.length, 0);
  assert.equal(harness.calls.length, 0, "unsafe copy should fail before database work");
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
  assert.equal(response.body.guarded, 1);
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
  assert.equal(response.body.guarded, 2);
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

test("direct new-job API cannot bypass a targeted job's empty exposure", async () => {
  const harness = loadRoute({
    database: {
      jobs: [activeJob({ exposure: "targeted", exposure_rule: null })],
      applicants: [applicant()],
      job_exposure_targets: [],
      messages: [],
      pool_events: [],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.guarded, 1);
  assert.match(String((response.body.results as Array<{ error?: string }>)[0]?.error), /노출 대상/);
  assert.equal(harness.smsCalls.length, 0);
});

test("targeted new-job send allows an explicitly included recipient", async () => {
  const harness = loadRoute({
    database: {
      jobs: [activeJob({ exposure: "targeted", exposure_rule: null })],
      applicants: [applicant()],
      job_exposure_targets: [{ job_id: 7, applicant_id: 1, mode: "include" }],
      messages: [],
      pool_events: [],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 1);
  assert.equal(response.body.failed, 0);
  assert.equal(harness.smsCalls.length, 1);
});

test("targeted new-job send applies the shared exposure rule per recipient", async () => {
  const matchingApplicant = { ...applicant(), sido: "서울특별시" };
  const nonMatchingApplicant = {
    ...applicant(),
    id: 2,
    name: "비대상 지원자",
    phone: "01087654321",
    access_token: "token-2",
    sido: "부산광역시",
  };
  const harness = loadRoute({
    database: {
      jobs: [activeJob({
        exposure: "targeted",
        exposure_rule: { sido: ["서울특별시"] },
      })],
      applicants: [matchingApplicant, nonMatchingApplicant],
      job_exposure_targets: [],
      messages: [],
      pool_events: [],
    },
  });

  const response = await harness.route.POST(request(7, [
    { applicant_id: 1, phone: "010-1234-5678" },
    { applicant_id: 2, phone: "01087654321" },
  ]));

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 1);
  assert.equal(response.body.guarded, 1);
  assert.equal(harness.smsCalls.length, 1);
  assert.equal(harness.smsCalls[0]?.phone, "01012345678");
  assert.match(String((response.body.results as Array<{ error?: string }>)[1]?.error), /노출 대상/);
});

test("targeted new-job send supplies current suntop completion to exposure rules", async () => {
  const harness = loadRoute({
    database: {
      jobs: [activeJob({
        exposure: "targeted",
        exposure_rule: { suntopDone: true },
      })],
      applicants: [applicant()],
      job_exposure_targets: [],
      messages: [],
      pool_events: [{
        id: 21,
        applicant_id: 1,
        event_type: "suntop_done",
        created_at: "2026-08-20T00:00:00.000Z",
      }],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 1);
  assert.equal(response.body.failed, 0);
  assert.equal(harness.smsCalls.length, 1);
});

test("targeted new-job send gives an explicit exclude precedence over a matching rule", async () => {
  const harness = loadRoute({
    database: {
      jobs: [activeJob({
        exposure: "targeted",
        exposure_rule: { sido: ["서울특별시"] },
      })],
      applicants: [{ ...applicant(), sido: "서울특별시" }],
      job_exposure_targets: [{ job_id: 7, applicant_id: 1, mode: "exclude" }],
      messages: [],
      pool_events: [],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.guarded, 1);
  assert.match(String((response.body.results as Array<{ error?: string }>)[0]?.error), /노출 대상/);
  assert.equal(harness.smsCalls.length, 0);
});

test("targeted exposure is bound to the applicant token, not borrowed from a duplicate phone row", async () => {
  const duplicate = {
    ...applicant(),
    id: 2,
    phone: "010-1234-5678",
    access_token: "token-2",
  };
  const harness = loadRoute({
    database: {
      jobs: [activeJob({ exposure: "targeted", exposure_rule: null })],
      applicants: [applicant(), duplicate],
      job_exposure_targets: [{ job_id: 7, applicant_id: 2, mode: "include" }],
      messages: [],
      pool_events: [],
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.equal(response.body.guarded, 1);
  assert.equal(harness.smsCalls.length, 0);
});

test("targeted exposure lookup failure stops direct new-job API sends", async () => {
  const harness = loadRoute({
    database: {
      jobs: [activeJob({ exposure: "targeted", exposure_rule: null })],
      applicants: [applicant()],
      job_exposure_targets: [],
    },
    options: {
      fail: (call) => call.table === "job_exposure_targets" ? "exposure ledger unavailable" : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 503);
  assert.match(String(response.body.error), /노출 대상/);
  assert.equal(harness.smsCalls.length, 0);
});

test("targeted suntop-rule lookup failure stops direct new-job API sends", async () => {
  const harness = loadRoute({
    database: {
      jobs: [activeJob({ exposure: "targeted", exposure_rule: { suntopDone: true } })],
      applicants: [applicant()],
      job_exposure_targets: [],
      pool_events: [],
    },
    options: {
      fail: (call) => (
        call.table === "pool_events"
        && call.equals.some(([column, value]) => column === "event_type" && value === "suntop_done")
      ) ? "suntop ledger unavailable" : null,
    },
  });

  const response = await harness.route.POST(request());

  assert.equal(response.status, 503);
  assert.match(String(response.body.error), /노출 조건/);
  assert.equal(harness.smsCalls.length, 0);
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
  assert.equal(response.body.guarded, 1);
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
