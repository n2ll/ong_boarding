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
  method: "default" | "range";
  from: number;
  to: number;
  equals: Array<[string, unknown]>;
  inValues: Array<[string, unknown[]]>;
  orders: Array<[string, boolean]>;
};

type FakeDatabase = Record<string, Row[]>;

type FakeOptions = {
  fail?: (call: QueryCall) => string | null;
};

type FakeQueryResult = {
  data: Row[] | null;
  error: { message: string } | null;
};

function valueForColumn(row: Row, column: string): unknown {
  if (column === "meta->>purpose") {
    return (row.meta as { purpose?: unknown } | null)?.purpose;
  }
  return row[column];
}

function createSupabaseStub(database: FakeDatabase, calls: QueryCall[], options: FakeOptions = {}) {
  class QueryBuilder {
    readonly table: string;
    readonly equals: Array<[string, unknown]> = [];
    readonly minimums: Array<[string, unknown]> = [];
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

    gte(column: string, value: unknown) {
      this.minimums.push([column, value]);
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
      const rows = (database[this.table] ?? []).filter((row) => (
        this.equals.every(([column, value]) => valueForColumn(row, column) === value)
        && this.minimums.every(([column, minimum]) => {
          const value = valueForColumn(row, column);
          return typeof value === "string" && typeof minimum === "string" && value >= minimum;
        })
        && this.inValues.every(([column, values]) => values.includes(valueForColumn(row, column)))
      ));

      if (this.orders.length === 0) return rows;
      return [...rows].sort((left, right) => {
        for (const [column, ascending] of this.orders) {
          const a = valueForColumn(left, column);
          const b = valueForColumn(right, column);
          if (a === b) continue;
          const comparison = a == null ? -1 : b == null ? 1 : a < b ? -1 : 1;
          return ascending ? comparison : -comparison;
        }
        return 0;
      });
    }

    private result(method: "default" | "range", from: number, to: number): FakeQueryResult {
      const call: QueryCall = {
        table: this.table,
        method,
        from,
        to,
        equals: [...this.equals],
        inValues: this.inValues.map(([column, values]) => [column, [...values]]),
        orders: [...this.orders],
      };
      calls.push(call);
      const error = options.fail?.(call) ?? null;
      if (error) return { data: null, error: { message: error } };
      return { data: this.filteredRows().slice(from, to + 1), error: null };
    }

    async range(from: number, to: number) {
      return this.result("range", from, to);
    }

    async maybeSingle() {
      const rows = this.filteredRows();
      return { data: rows[0] ?? null, error: null };
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: FakeQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      // PostgREST 프로젝트 기본 응답 상한을 실제처럼 재현한다.
      return Promise.resolve(this.result("default", 0, 999)).then(onfulfilled, onrejected);
    }
  }

  return {
    from(table: string) {
      return new QueryBuilder(table);
    },
  };
}

type JsonResponse = {
  body: Record<string, unknown>;
  status: number;
};

type RouteModule = {
  GET: (
    request: { url: string },
    context: { params: Promise<{ id: string }> },
  ) => Promise<JsonResponse>;
};

function loadRouteModule(supabase: ReturnType<typeof createSupabaseStub>): RouteModule {
  const route = new URL("../../app/api/admin/jobs/[id]/announce-targets/route.ts", import.meta.url);
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
    "@/lib/geo": {
      EXPOSURE_JOB_GEO_COLUMNS: "pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_basis",
      distanceToJobKm: () => 0,
    },
    "@/lib/agent/engage": {
      isNightKst: () => false,
      smsJobTitle: (title: string) => title,
    },
    "@/lib/exposure": {
      normalizeRule: () => ({}),
      isExposed: (_applicant: unknown, _rule: unknown, override: string | undefined) => override !== "exclude",
    },
    "@/lib/sms-consent-policy": {
      smsSendBlockReason: (input: { marketingConsent: boolean | null; smsOptOutAt: string | null }) => {
        if (input.smsOptOutAt) return "opt_out";
        return input.marketingConsent === true ? null : "marketing_consent_required";
      },
    },
    "@/lib/admin/postgrest-pagination": { fetchAllPostgrestRows },
    "@/lib/admin/phone-message-identity": { fetchPhoneMessageIdentityIndex },
    "@/lib/ongmanaging": { normalizePhone },
    "@/lib/jobs": {
      isJobEffectivelyClosed: (status: string | null, closesAt: string | null) => (
        status !== "active" || Boolean(closesAt && Date.parse(closesAt) <= FixedDate.now())
      ),
    },
  };

  runInNewContext(output, {
    Date: FixedDate,
    Math,
    Number,
    Set,
    Map,
    URL,
    console: { error() {} },
    exports: compiledModule.exports,
    module: compiledModule,
    require: (specifier: string) => stubs[specifier] ?? {},
  });
  return compiledModule.exports as RouteModule;
}

function job(exposure: "all" | "targeted" = "all", recruitMode = "internal"): Row {
  return {
    id: 7,
    title: "새 배송 공고",
    status: "active",
    closes_at: null,
    vehicle_required: false,
    exposure,
    exposure_rule: {},
    recruit_mode: recruitMode,
    pickup_lat: 37.5,
    pickup_lng: 127,
    dropoff_lat: null,
    dropoff_lng: null,
    distance_basis: "pickup_only",
  };
}

function event(id: number, applicantId: number, eventType: string, purpose?: string): Row {
  return {
    id,
    applicant_id: applicantId,
    event_type: eventType,
    created_at: NOW,
    meta: purpose ? { purpose } : {},
  };
}

function applicant(id: number): Row {
  return {
    id,
    name: `지원자 ${id}`,
    phone: `0100000${String(id).padStart(4, "0")}`,
    access_token: `token-${id}`,
    status: "온보딩",
    sms_opt_out_at: null,
    marketing_consent: true,
    marketing_consent_at: "2026-08-20T00:00:00.000Z",
    own_vehicle: "없음",
    work_hours: null,
    available_slots: null,
    lat: 37.5,
    lng: 127,
    sido: "서울특별시",
    sigungu: "강남구",
    availability: null,
    applied_at: NOW,
    created_at: NOW,
  };
}

function duplicateEvents(startId: number, applicantId: number, eventType: string, purpose?: string): Row[] {
  return Array.from({ length: 1_000 }, (_, index) => event(startId + index, applicantId, eventType, purpose));
}

function equals(call: QueryCall, column: string, value: unknown): boolean {
  return call.equals.some(([key, actual]) => key === column && actual === value);
}

test("reads every targeting ledger so rows after 1000 still affect inclusion and exclusion", async () => {
  const poolEvents = [
    ...duplicateEvents(1, 1, "suntop_done"),
    event(1_001, 2, "suntop_done"),
    ...duplicateEvents(2_000, 3, "waitlist_notice"),
    event(3_000, 4, "waitlist_notice"),
    ...duplicateEvents(4_000, 5, "notify_request"),
    event(5_000, 6, "notify_request"),
    ...duplicateEvents(6_000, 7, "ping_sent", "pool_engage"),
    event(7_000, 8, "ping_sent", "pool_engage"),
    ...duplicateEvents(8_000, 98, "ping_sent", "new_job"),
    event(9_000, 4, "ping_sent", "new_job"),
  ];
  const database: FakeDatabase = {
    jobs: [job("targeted")],
    pool_events: poolEvents,
    job_candidates: [
      ...Array.from({ length: 1_000 }, (_, index) => ({ id: index + 1, applicant_id: 10_000 + index, job_id: 7 })),
      { id: 1_001, applicant_id: 6, job_id: 7 },
    ],
    applicants: [1, 2, 3, 4, 5, 6, 7, 8, 98].map(applicant),
    job_exposure_targets: [
      ...Array.from({ length: 1_000 }, (_, index) => ({ applicant_id: 20_000 + index, mode: "include", job_id: 7 })),
      { applicant_id: 2, mode: "exclude", job_id: 7 },
    ],
  };
  const calls: QueryCall[] = [];
  const route = loadRouteModule(createSupabaseStub(database, calls));

  const response = await route.GET(
    { url: "http://localhost/api/admin/jobs/7/announce-targets" },
    { params: Promise.resolve({ id: "7" }) },
  );
  const targets = response.body.targets as Array<{
    id: number;
    name: string;
    phone: string;
    access_token: string;
    group: string;
  }>;

  assert.equal(response.status, 200);
  assert.deepEqual(Array.from(targets, (target) => target.id), [1, 3, 5, 8, 7]);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.groups)), { suntop: 1, promised: 1, requested: 1, matched: 2 });

  const secondPages = calls.filter((call) => call.method === "range" && call.from === 1_000);
  assert.equal(secondPages.some((call) => call.table === "pool_events" && equals(call, "event_type", "suntop_done")), true);
  assert.equal(secondPages.some((call) => call.table === "pool_events" && equals(call, "event_type", "waitlist_notice")), true);
  assert.equal(secondPages.some((call) => call.table === "pool_events" && equals(call, "event_type", "notify_request")), true);
  assert.equal(secondPages.some((call) => call.table === "pool_events" && equals(call, "event_type", "ping_sent") && !equals(call, "meta->>purpose", "new_job")), true);
  assert.equal(secondPages.some((call) => call.table === "pool_events" && equals(call, "meta->>purpose", "new_job")), true);
  assert.equal(secondPages.some((call) => call.table === "job_candidates"), true);
  assert.equal(secondPages.some((call) => call.table === "job_exposure_targets"), true);
});

test("returns 500 when a later targeting-ledger page fails instead of returning partial targets", async () => {
  const database: FakeDatabase = {
    jobs: [job()],
    pool_events: duplicateEvents(1, 1, "suntop_done"),
    job_candidates: [],
    applicants: [applicant(1)],
    job_exposure_targets: [],
  };
  const calls: QueryCall[] = [];
  const supabase = createSupabaseStub(database, calls, {
    fail: (call) => (
      call.table === "pool_events"
      && equals(call, "event_type", "suntop_done")
      && call.method === "range"
      && call.from === 1_000
    ) ? "database unavailable" : null,
  });
  const route = loadRouteModule(supabase);

  const response = await route.GET(
    { url: "http://localhost/api/admin/jobs/7/announce-targets" },
    { params: Promise.resolve({ id: "7" }) },
  );

  assert.equal(response.status, 500);
  assert.equal("targets" in response.body, false);
});

test("external-only jobs reject announcement targeting before reading applicant ledgers", async () => {
  const database: FakeDatabase = {
    jobs: [job("all", "external")],
    pool_events: [event(1, 1, "suntop_done")],
    job_candidates: [],
    applicants: [applicant(1)],
    job_exposure_targets: [],
  };
  const calls: QueryCall[] = [];
  const route = loadRouteModule(createSupabaseStub(database, calls));

  const response = await route.GET(
    { url: "http://localhost/api/admin/jobs/7/announce-targets" },
    { params: Promise.resolve({ id: "7" }) },
  );

  assert.equal(response.status, 409);
  assert.match(String(response.body.error), /외부 채널/);
  assert.equal(calls.some((call) => call.table === "pool_events"), false);
});

test("closed or expired jobs reject announcement targeting before reading applicant ledgers", async () => {
  for (const closedJob of [
    { ...job(), status: "closed" },
    { ...job(), closes_at: "2026-08-31T11:59:59.000Z" },
  ]) {
    const database: FakeDatabase = {
      jobs: [closedJob],
      pool_events: [event(1, 1, "suntop_done")],
      job_candidates: [],
      applicants: [applicant(1)],
      job_exposure_targets: [],
    };
    const calls: QueryCall[] = [];
    const route = loadRouteModule(createSupabaseStub(database, calls));

    const response = await route.GET(
      { url: "http://localhost/api/admin/jobs/7/announce-targets" },
      { params: Promise.resolve({ id: "7" }) },
    );

    assert.equal(response.status, 409);
    assert.match(String(response.body.error), /마감/);
    assert.equal(calls.some((call) => call.table === "pool_events"), false);
  }
});

test("announcement targets deduplicate normalized phone numbers before the send cap", async () => {
  const first = applicant(1);
  const second = applicant(2);
  first.phone = "010-1234-5678";
  second.phone = "01012345678";
  const database: FakeDatabase = {
    jobs: [job()],
    pool_events: [
      event(1, 1, "suntop_done"),
      event(2, 2, "waitlist_notice"),
    ],
    job_candidates: [],
    applicants: [first, second],
    job_exposure_targets: [],
  };
  const calls: QueryCall[] = [];
  const route = loadRouteModule(createSupabaseStub(database, calls));

  const response = await route.GET(
    { url: "http://localhost/api/admin/jobs/7/announce-targets" },
    { params: Promise.resolve({ id: "7" }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    Array.from(response.body.targets as Array<{ id: number }>, (target) => target.id),
    [1],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.groups)), {
    suntop: 1,
    promised: 0,
    requested: 0,
    matched: 0,
  });
});

test("announcement targeting excludes a phone when a duplicate row is already a candidate for the job", async () => {
  const source = applicant(1);
  source.phone = "010-1234-5678";
  const duplicate = applicant(2);
  duplicate.phone = "01012345678";
  const route = loadRouteModule(createSupabaseStub({
    jobs: [job()],
    pool_events: [event(1, 1, "suntop_done")],
    job_candidates: [{ id: 11, applicant_id: 2, job_id: 7 }],
    applicants: [source, duplicate],
    job_exposure_targets: [],
  }, []));

  const response = await route.GET(
    { url: "http://localhost/api/admin/jobs/7/announce-targets" },
    { params: Promise.resolve({ id: "7" }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(Array.from(response.body.targets as unknown[]), []);
});

test("announcement targeting excludes a phone when a duplicate row has a pool-excluded status", async () => {
  const source = applicant(1);
  source.phone = "010-1234-5678";
  const duplicate = applicant(2);
  duplicate.phone = "01012345678";
  duplicate.status = "확정인력";
  const route = loadRouteModule(createSupabaseStub({
    jobs: [job()],
    pool_events: [event(1, 1, "suntop_done")],
    job_candidates: [],
    applicants: [source, duplicate],
    job_exposure_targets: [],
  }, []));

  const response = await route.GET(
    { url: "http://localhost/api/admin/jobs/7/announce-targets" },
    { params: Promise.resolve({ id: "7" }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(Array.from(response.body.targets as unknown[]), []);
});

test("announcement targeting applies duplicate-row opt-out and fatigue at phone level", async () => {
  const source = applicant(1);
  source.phone = "010-1234-5678";
  const duplicate = applicant(2);
  duplicate.phone = "01012345678";
  duplicate.marketing_consent = false;
  duplicate.marketing_consent_at = null;
  duplicate.sms_opt_out_at = "2026-08-25T00:00:00.000Z";

  const optedOutRoute = loadRouteModule(createSupabaseStub({
    jobs: [job()],
    pool_events: [event(1, 1, "suntop_done")],
    job_candidates: [],
    applicants: [source, duplicate],
    job_exposure_targets: [],
  }, []));
  const optedOutResponse = await optedOutRoute.GET(
    { url: "http://localhost/api/admin/jobs/7/announce-targets" },
    { params: Promise.resolve({ id: "7" }) },
  );

  assert.equal(optedOutResponse.status, 200);
  assert.deepEqual(Array.from(optedOutResponse.body.targets as unknown[]), []);

  duplicate.sms_opt_out_at = null;
  const fatiguedRoute = loadRouteModule(createSupabaseStub({
    jobs: [job()],
    pool_events: [
      event(1, 1, "suntop_done"),
      event(2, 2, "ping_sent", "new_job"),
    ],
    job_candidates: [],
    applicants: [source, duplicate],
    job_exposure_targets: [],
  }, []));
  const fatiguedResponse = await fatiguedRoute.GET(
    { url: "http://localhost/api/admin/jobs/7/announce-targets" },
    { params: Promise.resolve({ id: "7" }) },
  );

  assert.equal(fatiguedResponse.status, 200);
  assert.deepEqual(Array.from(fatiguedResponse.body.targets as unknown[]), []);
});

test("announcement targeting allows a strictly later phone-level re-consent", async () => {
  const source = applicant(1);
  source.phone = "010-1234-5678";
  source.marketing_consent_at = "2026-08-26T00:00:00.000Z";
  const duplicate = applicant(2);
  duplicate.phone = "01012345678";
  duplicate.marketing_consent = false;
  duplicate.marketing_consent_at = null;
  duplicate.sms_opt_out_at = "2026-08-25T00:00:00.000Z";
  const route = loadRouteModule(createSupabaseStub({
    jobs: [job()],
    pool_events: [event(1, 1, "suntop_done")],
    job_candidates: [],
    applicants: [source, duplicate],
    job_exposure_targets: [],
  }, []));

  const response = await route.GET(
    { url: "http://localhost/api/admin/jobs/7/announce-targets" },
    { params: Promise.resolve({ id: "7" }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(Array.from(response.body.targets as Array<{ id: number }>, (target) => target.id), [1]);
});

test("chunks the applicant union and caps newest suntop responders before lower-priority groups", async () => {
  const suntopEvents = Array.from({ length: 1_001 }, (_, index) => ({
    ...event(index + 1, index + 1, "suntop_done"),
    created_at: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
  }));
  const database: FakeDatabase = {
    jobs: [job()],
    pool_events: [...suntopEvents, event(2_000, 2_000, "waitlist_notice")],
    job_candidates: [],
    applicants: [...Array.from({ length: 1_001 }, (_, index) => applicant(index + 1)), applicant(2_000)],
    job_exposure_targets: [],
  };
  const calls: QueryCall[] = [];
  const route = loadRouteModule(createSupabaseStub(database, calls));

  const response = await route.GET(
    { url: "http://localhost/api/admin/jobs/7/announce-targets" },
    { params: Promise.resolve({ id: "7" }) },
  );
  const targets = response.body.targets as Array<{
    id: number;
    name: string;
    phone: string;
    access_token: string;
    group: string;
  }>;

  assert.equal(response.status, 200);
  assert.equal(targets.length, 200);
  assert.deepEqual(Array.from([targets[0], targets[199]], (target) => [
    target.id,
    target.name,
    target.phone,
    target.access_token,
    target.group,
  ]), [
    [1_001, "지원자 1001", "01000001001", "token-1001", "suntop"],
    [802, "지원자 802", "01000000802", "token-802", "suntop"],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.groups)), { suntop: 200, promised: 0, requested: 0, matched: 0 });

  const applicantCalls = calls.filter((call) => call.table === "applicants");
  assert.equal(applicantCalls.length > 1, true);
  assert.equal(applicantCalls.every((call) => call.method === "range"), true);
  assert.equal(applicantCalls.every((call) => (call.inValues[0]?.[1].length ?? 0) <= 250), true);
  const suntopCalls = calls.filter((call) => call.table === "pool_events" && equals(call, "event_type", "suntop_done"));
  assert.equal(suntopCalls.every((call) => call.orders[0]?.[0] === "created_at" && call.orders[0]?.[1] === false), true);
  assert.equal(suntopCalls.every((call) => call.orders[1]?.[0] === "id" && call.orders[1]?.[1] === false), true);
});

test("returns 500 when a later applicant-id chunk fails instead of using earlier chunks", async () => {
  const database: FakeDatabase = {
    jobs: [job()],
    pool_events: Array.from({ length: 251 }, (_, index) => event(index + 1, index + 1, "suntop_done")),
    job_candidates: [],
    applicants: Array.from({ length: 251 }, (_, index) => applicant(index + 1)),
    job_exposure_targets: [],
  };
  const calls: QueryCall[] = [];
  const supabase = createSupabaseStub(database, calls, {
    fail: (call) => (
      call.table === "applicants"
      && call.method === "range"
      && call.inValues.some(([, values]) => values.includes(1))
    ) ? "applicant batch unavailable" : null,
  });
  const route = loadRouteModule(supabase);

  const response = await route.GET(
    { url: "http://localhost/api/admin/jobs/7/announce-targets" },
    { params: Promise.resolve({ id: "7" }) },
  );

  assert.equal(response.status, 500);
  assert.equal("targets" in response.body, false);
  assert.equal(calls.filter((call) => (
    call.table === "applicants"
    && call.inValues.some(([column]) => column === "id")
  )).length, 2);
});
