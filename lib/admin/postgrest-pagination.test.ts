import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";
import { jobCandidateAggregateStage } from "./job-operations.ts";

type PageResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

type PaginationModule = {
  fetchAllPostgrestRows?: <T>(
    fetchPage: (from: number, to: number) => Promise<PageResult<T>>,
    label: string,
  ) => Promise<T[]>;
};

async function loadModule(): Promise<PaginationModule> {
  try {
    return await import(new URL("./postgrest-pagination.ts", import.meta.url).href) as PaginationModule;
  } catch {
    return {};
  }
}

type JsonResponse = {
  body: Record<string, unknown>;
  status: number;
};

type RouteModule = {
  GET: (request: { url: string }, context?: { params: Promise<{ id: string }> }) => Promise<JsonResponse>;
};

type QueryResult = {
  data: unknown[] | Record<string, unknown> | null;
  error: { message: string } | null;
};

type QueryResolver = (
  table: string,
  operation: "range" | "single",
  from: number,
  to: number,
) => QueryResult;

function createSupabaseStub(
  resolve: QueryResolver,
  onIn?: (table: string, column: string, values: unknown[]) => void,
  onEq?: (table: string, column: string, value: unknown) => void,
) {
  class QueryBuilder {
    readonly table: string;

    constructor(table: string) {
      this.table = table;
    }

    select() { return this; }
    neq() { return this; }
    order() { return this; }
    eq(column: string, value: unknown) {
      onEq?.(this.table, column, value);
      return this;
    }
    in(column: string, values: unknown[]) {
      onIn?.(this.table, column, values);
      return this;
    }

    async range(from: number, to: number) {
      return resolve(this.table, "range", from, to);
    }

    async single() {
      return resolve(this.table, "single", 0, 0);
    }
  }

  return {
    from(table: string) {
      return new QueryBuilder(table);
    },
  };
}

function loadRouteModule(
  route: URL,
  supabase: ReturnType<typeof createSupabaseStub>,
): RouteModule {
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
    "@/lib/agent/danggeun-job": { DANGGEUN_SYSTEM_JOB_TITLE: "__system__" },
    "@/lib/jobs": { isJobEffectivelyClosed: () => false },
    "@/lib/admin/job-operations": { isReviewReadyCandidate: () => false, jobCandidateAggregateStage },
    "@/lib/admin/postgrest-pagination": { fetchAllPostgrestRows },
  };

  runInNewContext(output, {
    URL,
    console: { error() {} },
    exports: compiledModule.exports,
    module: compiledModule,
    require: (specifier: string) => stubs[specifier] ?? {},
  });
  return compiledModule.exports as RouteModule;
}

test("reads every row after the PostgREST 1000-row boundary", async () => {
  const { fetchAllPostgrestRows } = await loadModule();
  assert.equal(typeof fetchAllPostgrestRows, "function");
  if (typeof fetchAllPostgrestRows !== "function") return;

  const source = Array.from({ length: 1_001 }, (_, index) => ({ id: index + 1 }));
  const windows: Array<[number, number]> = [];
  const rows = await fetchAllPostgrestRows(async (from, to) => {
    windows.push([from, to]);
    return { data: source.slice(from, to + 1), error: null };
  }, "candidate aggregate");

  assert.equal(rows.length, 1_001);
  assert.deepEqual([rows[0].id, rows[999].id, rows[1_000].id], [1, 1_000, 1_001]);
  assert.deepEqual(windows, [[0, 999], [1_000, 1_999]]);
});

test("rejects a later page error instead of returning a partial aggregate", async () => {
  const { fetchAllPostgrestRows } = await loadModule();
  assert.equal(typeof fetchAllPostgrestRows, "function");
  if (typeof fetchAllPostgrestRows !== "function") return;

  let pages = 0;
  await assert.rejects(
    fetchAllPostgrestRows(async () => {
      pages += 1;
      if (pages === 1) {
        return {
          data: Array.from({ length: 1_000 }, (_, index) => ({ id: index + 1 })),
          error: null,
        };
      }
      return { data: null, error: { message: "database unavailable" } };
    }, "interest aggregate"),
    /interest aggregate.*database unavailable/,
  );
  assert.equal(pages, 2);
});

test("rejects a malformed success payload instead of treating it as an empty page", async () => {
  const { fetchAllPostgrestRows } = await loadModule();
  assert.equal(typeof fetchAllPostgrestRows, "function");
  if (typeof fetchAllPostgrestRows !== "function") return;

  await assert.rejects(
    fetchAllPostgrestRows(async () => ({ data: null, error: null }), "job candidates"),
    /job candidates.*응답 형식/,
  );
});

test("candidate board fails only for candidate pages and degrades optional job geo to null", () => {
  const routeSource = readFileSync(
    new URL("../../app/api/admin/jobs/[id]/candidates/route.ts", import.meta.url),
    "utf8",
  );
  const getSource = routeSource.slice(
    routeSource.indexOf("export async function GET"),
    routeSource.indexOf("export async function POST"),
  );

  assert.match(getSource, /Promise\.allSettled\(/);
  assert.match(
    getSource,
    /candidateResult\.status === "rejected"[\s\S]*?return NextResponse\.json\(\{ error: "조회 실패" \}, \{ status: 500 \}\)/,
  );
  assert.match(
    getSource,
    /jobResult\.status === "rejected"[\s\S]*?job = null[\s\S]*?jobResult\.value\.error[\s\S]*?job = null/,
  );

  const optionalGeoHandling = getSource.slice(
    getSource.indexOf('if (jobResult.status === "rejected")'),
    getSource.indexOf("const candidates = rows.map"),
  );
  assert.doesNotMatch(optionalGeoHandling, /return NextResponse\.json|throw new Error/);
});

test("admin job list returns rows after the PostgREST 1000-row boundary", async () => {
  const jobs = Array.from({ length: 1_001 }, (_, index) => ({
    id: index + 1,
    status: "active",
    closes_at: null,
  }));
  const supabase = createSupabaseStub((table, operation, from, to) => {
    assert.equal(operation, "range");
    if (table === "jobs") return { data: jobs.slice(from, to + 1), error: null };
    return { data: [], error: null };
  });
  const route = loadRouteModule(
    new URL("../../app/api/admin/jobs/route.ts", import.meta.url),
    supabase,
  );

  const response = await route.GET({ url: "http://localhost/api/admin/jobs" });
  const returnedJobs = response.body.jobs as Array<{ id: number }>;

  assert.equal(response.status, 200);
  assert.equal(returnedJobs.length, 1_001);
  assert.equal(returnedJobs[1_000].id, 1_001);
});

test("admin job aggregates chunk accumulated job ids before building PostgREST in filters", async () => {
  const jobs = Array.from({ length: 1_001 }, (_, index) => ({
    id: index + 1,
    status: "active",
    closes_at: null,
  }));
  const aggregateFilters: Array<{ table: string; ids: number[] }> = [];
  const supabase = createSupabaseStub(
    (table, operation, from, to) => {
      assert.equal(operation, "range");
      if (table === "jobs") return { data: jobs.slice(from, to + 1), error: null };
      return { data: [], error: null };
    },
    (table, column, values) => {
      if ((table === "job_candidates" || table === "pool_events" || table === "application_submission_attribution_performance") && column === "job_id") {
        aggregateFilters.push({ table, ids: values as number[] });
      }
    },
  );
  const route = loadRouteModule(
    new URL("../../app/api/admin/jobs/route.ts", import.meta.url),
    supabase,
  );

  const response = await route.GET({ url: "http://localhost/api/admin/jobs" });

  assert.equal(response.status, 200);
  for (const table of ["job_candidates", "pool_events", "application_submission_attribution_performance"]) {
    const chunks = aggregateFilters.filter((entry) => entry.table === table);
    assert.ok(chunks.length > 1, `${table} should use more than one id chunk`);
    assert.ok(chunks.every((entry) => entry.ids.length <= 250));
    assert.deepEqual(
      [...new Set(chunks.flatMap((entry) => entry.ids))],
      jobs.map((job) => job.id),
    );
  }
});

test("admin job list counts only submissions from verified tracking links", async () => {
  const equalityFilters: Array<{ table: string; column: string; value: unknown }> = [];
  const supabase = createSupabaseStub(
    (table, operation, from, to) => {
      assert.equal(operation, "range");
      if (table === "jobs") {
        return {
          data: [
            { id: 7, status: "active", closes_at: null },
            { id: 8, status: "active", closes_at: null },
          ].slice(from, to + 1),
          error: null,
        };
      }
      if (table === "application_submission_attribution_performance") {
        return {
          data: [
            { submission_id: "submission-1", job_id: 7 },
            { submission_id: "submission-2", job_id: 7 },
          ].slice(from, to + 1),
          error: null,
        };
      }
      return { data: [], error: null };
    },
    undefined,
    (table, column, value) => equalityFilters.push({ table, column, value }),
  );
  const route = loadRouteModule(
    new URL("../../app/api/admin/jobs/route.ts", import.meta.url),
    supabase,
  );

  const response = await route.GET({ url: "http://localhost/api/admin/jobs" });
  const returnedJobs = response.body.jobs as Array<{
    id: number;
    tracking_submission_count: number | null;
  }>;

  assert.equal(response.status, 200);
  assert.deepEqual(
    returnedJobs.map(({ id, tracking_submission_count }) => ({ id, tracking_submission_count })),
    [
      { id: 7, tracking_submission_count: 2 },
      { id: 8, tracking_submission_count: 0 },
    ],
  );
  assert.deepEqual(
    equalityFilters.filter(({ table }) => table === "application_submission_attribution_performance"),
    [{
      table: "application_submission_attribution_performance",
      column: "attribution_method",
      value: "verified_link",
    }],
  );
});

test("admin job list exposes an unavailable tracking submission count when its aggregate fails", async () => {
  const supabase = createSupabaseStub((table, operation, from, to) => {
    assert.equal(operation, "range");
    if (table === "jobs") {
      return {
        data: [{ id: 7, status: "active", closes_at: null }].slice(from, to + 1),
        error: null,
      };
    }
    if (table === "application_submission_attribution_performance") {
      return { data: null, error: { message: "database unavailable" } };
    }
    return { data: [], error: null };
  });
  const route = loadRouteModule(
    new URL("../../app/api/admin/jobs/route.ts", import.meta.url),
    supabase,
  );

  const response = await route.GET({ url: "http://localhost/api/admin/jobs" });
  const returnedJobs = response.body.jobs as Array<{ tracking_submission_count: number | null }>;

  assert.equal(response.status, 200);
  assert.equal(returnedJobs[0].tracking_submission_count, null);
});

test("admin job list counts verified tracking submissions after the PostgREST 1000-row boundary", async () => {
  const submissions = Array.from({ length: 1_001 }, (_, index) => ({
    submission_id: `submission-${index + 1}`,
    job_id: 7,
  }));
  const supabase = createSupabaseStub((table, operation, from, to) => {
    assert.equal(operation, "range");
    if (table === "jobs") {
      return {
        data: [{ id: 7, status: "active", closes_at: null }].slice(from, to + 1),
        error: null,
      };
    }
    if (table === "application_submission_attribution_performance") {
      return { data: submissions.slice(from, to + 1), error: null };
    }
    return { data: [], error: null };
  });
  const route = loadRouteModule(
    new URL("../../app/api/admin/jobs/route.ts", import.meta.url),
    supabase,
  );

  const response = await route.GET({ url: "http://localhost/api/admin/jobs" });
  const returnedJobs = response.body.jobs as Array<{ tracking_submission_count: number | null }>;

  assert.equal(response.status, 200);
  assert.equal(returnedJobs[0].tracking_submission_count, 1_001);
});

test("admin job list rejects a later page error instead of returning a partial list", async () => {
  const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
    id: index + 1,
    status: "active",
    closes_at: null,
  }));
  const supabase = createSupabaseStub((table, _operation, from) => {
    assert.equal(table, "jobs");
    if (from === 0) return { data: firstPage, error: null };
    return { data: null, error: { message: "database unavailable" } };
  });
  const route = loadRouteModule(
    new URL("../../app/api/admin/jobs/route.ts", import.meta.url),
    supabase,
  );

  const response = await route.GET({ url: "http://localhost/api/admin/jobs" });

  assert.equal(response.status, 500);
  assert.equal(response.body.error, "조회 실패");
});

test("single job detail counts candidates after the PostgREST 1000-row boundary", async () => {
  const candidates = Array.from({ length: 1_001 }, (_, index) => ({
    id: index + 1,
    agent_stage: index === 1_000 ? null : "screening",
    sent_at: index === 1_000 ? null : "2026-09-03T12:00:00.000Z",
    responded_at: null,
  }));
  const supabase = createSupabaseStub((table, operation, from, to) => {
    if (table === "jobs" && operation === "single") {
      return { data: { id: 7, title: "테스트 공고" }, error: null };
    }
    assert.equal(table, "job_candidates");
    return { data: candidates.slice(from, to + 1), error: null };
  });
  const route = loadRouteModule(
    new URL("../../app/api/admin/jobs/[id]/route.ts", import.meta.url),
    supabase,
  );

  const response = await route.GET(
    { url: "http://localhost/api/admin/jobs/7" },
    { params: Promise.resolve({ id: "7" }) },
  );

  assert.equal(response.status, 200);
  const counts = response.body.counts as Record<string, number>;
  assert.equal(counts.screening, 1_000);
  assert.equal(counts.sent, 1);
});

test("single job detail rejects a later candidate page error instead of returning partial counts", async () => {
  const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
    id: index + 1,
    agent_stage: "screening",
    sent_at: "2026-09-03T12:00:00.000Z",
    responded_at: null,
  }));
  const supabase = createSupabaseStub((table, operation, from) => {
    if (table === "jobs" && operation === "single") {
      return { data: { id: 7, title: "테스트 공고" }, error: null };
    }
    if (from === 0) return { data: firstPage, error: null };
    return { data: null, error: { message: "database unavailable" } };
  });
  const route = loadRouteModule(
    new URL("../../app/api/admin/jobs/[id]/route.ts", import.meta.url),
    supabase,
  );

  const response = await route.GET(
    { url: "http://localhost/api/admin/jobs/7" },
    { params: Promise.resolve({ id: "7" }) },
  );

  assert.equal(response.status, 500);
  assert.equal(response.body.error, "후보 집계 조회 실패");
});
