import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type ApplicantListRow = { id: number; created_at: string } & Record<string, unknown>;
type ApplicantCandidateRow = {
  id: number;
  applicant_id: number;
  created_at: string;
} & Record<string, unknown>;

type ApplicantListModule = {
  fetchCompleteApplicantRows?: (
    client: unknown,
    scope: { columns: string; source: string | null },
  ) => Promise<ApplicantListRow[]>;
  fetchCompleteApplicantCandidateRows?: (
    client: unknown,
    applicantIds: number[],
  ) => Promise<ApplicantCandidateRow[]>;
};

async function loadModule(): Promise<ApplicantListModule> {
  try {
    return await import(new URL("./applicant-list.ts", import.meta.url).href) as ApplicantListModule;
  } catch {
    return {};
  }
}

type PageResult = {
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
};

type JsonResponse = {
  body: Record<string, unknown>;
  status: number;
};

function loadApplicantsRoute(jobLinksError: string | null) {
  const output = ts.transpileModule(readFileSync(
    new URL("../../app/api/admin/applicants/route.ts", import.meta.url),
    "utf8",
  ), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const compiledModule = { exports: {} as Record<string, unknown> };
  let gatherCalls = 0;
  const applicantRows = [{
    id: 37,
    current_job_id: null,
    access_token: "token",
    experience: null,
  }];
  const supabase = {
    from() {
      const query = {
        select() { return query; },
        in() { return query; },
      };
      return query;
    },
  };
  const nextResponse = {
    json(body: Record<string, unknown>, init?: { status?: number }): JsonResponse {
      return { body, status: init?.status ?? 200 };
    },
  };
  const stubs: Record<string, Record<string, unknown>> = {
    "next/server": { NextResponse: nextResponse },
    "@/lib/supabase": { createServiceClient: () => supabase },
    "@/lib/kakao-geocode": { geocodeAddress: async () => null },
    "@/lib/agent/danggeun-job": { ensureDanggeunSystemJob: async () => 1 },
    "@/lib/agent/baemin-job": { ensureBaeminSystemJob: async () => 1 },
    "@/lib/agent/system-messages": { getSystemMessage: async () => null, fillTemplate: (value: string) => value },
    "@/lib/agent/outbound-safety": { resolveAutomatedOutboundText: (value: string) => value },
    "@/lib/candidate-links": {
      gatherLiveJobLinks: async () => {
        gatherCalls += 1;
        return { links: new Map(), error: jobLinksError };
      },
    },
    "@/lib/message-preview": {
      gatherMessagePreviews: async () => ({}),
      livePreviewTargetIds: () => [],
    },
    "@/lib/admin/manual-message-attention": {
      loadManualMessageAttention: async () => ({ state: "ready", items: [], totalCount: 0, truncated: false }),
    },
    "@/lib/admin/required-rows-query-state": {
      requiredRowsQueryState: (input: Record<string, { data: unknown[] }>) => ({
        ok: true,
        rows: {
          jobCandidates: input.jobCandidates.data,
          jobs: input.jobs.data,
        },
      }),
    },
    "@/lib/application-branch": {
      applicationBranchName: () => null,
      applicationUsesLegacyBmartFlow: () => false,
    },
    "@/lib/agent/general-line": {
      isGeneralLineJob: () => true,
      joinedClientType: () => null,
    },
    "@/lib/admin/applicant-list": {
      fetchCompleteApplicantRows: async () => applicantRows,
      fetchCompleteApplicantCandidateRows: async () => [],
    },
  };

  runInNewContext(output, {
    URL,
    console: { error() {}, warn() {} },
    exports: compiledModule.exports,
    module: compiledModule,
    require: (specifier: string) => stubs[specifier] ?? {},
  });

  return {
    route: compiledModule.exports as {
      GET: (request: { url: string }) => Promise<JsonResponse>;
    },
    gatherCallCount: () => gatherCalls,
  };
}

type QueryScope = {
  table: string;
  source: string | null;
  applicantIds: number[];
};

function createFakeClient(
  resolvePage: (scope: QueryScope, from: number, to: number) => PageResult,
  calls: string[],
) {
  return {
    from(table: string) {
      let source: string | null = null;
      let applicantIds: number[] = [];
      const query = {
        select(columns: string) {
          calls.push(`select:${table}:${columns}`);
          return query;
        },
        eq(column: string, value: string) {
          if (column === "source") source = value;
          calls.push(`eq:${table}:${column}:${value}`);
          return query;
        },
        in(column: string, values: number[]) {
          if (column === "applicant_id") applicantIds = [...values];
          calls.push(`in:${table}:${column}:${values.join(",")}`);
          return query;
        },
        order(column: string, options: { ascending: boolean }) {
          calls.push(`order:${table}:${column}:${options.ascending ? "asc" : "desc"}`);
          return query;
        },
        async range(from: number, to: number) {
          calls.push(`range:${table}:${from}:${to}`);
          return resolvePage({ table, source, applicantIds }, from, to);
        },
      };
      return query;
    },
  };
}

test("loads all applicants after 1000 rows while repeating source and stable ordering on every page", async () => {
  const { fetchCompleteApplicantRows } = await loadModule();
  assert.equal(typeof fetchCompleteApplicantRows, "function");
  if (typeof fetchCompleteApplicantRows !== "function") return;

  const applicants = Array.from({ length: 1_001 }, (_, index) => ({
    id: 2_000 - index,
    created_at: "2026-08-31T00:00:00.000Z",
    source: "manual",
  }));
  const calls: string[] = [];
  const client = createFakeClient((scope, from, to) => {
    assert.equal(scope.table, "applicants");
    assert.equal(scope.source, "manual");
    return { data: applicants.slice(from, to + 1), error: null };
  }, calls);

  const rows = await fetchCompleteApplicantRows(client, {
    columns: "id, created_at, source",
    source: "manual",
  });

  assert.deepEqual([rows[0].id, rows[999].id, rows[1_000].id], [2_000, 1_001, 1_000]);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("range:applicants:")),
    ["range:applicants:0:999", "range:applicants:1000:1999"],
  );
  assert.deepEqual(
    calls.filter((call) => call === "eq:applicants:source:manual"),
    ["eq:applicants:source:manual", "eq:applicants:source:manual"],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("order:applicants:")),
    [
      "order:applicants:created_at:desc",
      "order:applicants:id:desc",
      "order:applicants:created_at:desc",
      "order:applicants:id:desc",
    ],
  );
});

test("rejects a later applicant page error instead of returning a partial list", async () => {
  const { fetchCompleteApplicantRows } = await loadModule();
  assert.equal(typeof fetchCompleteApplicantRows, "function");
  if (typeof fetchCompleteApplicantRows !== "function") return;

  const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
    id: index + 1,
    created_at: "2026-08-31T00:00:00.000Z",
  }));
  const calls: string[] = [];
  const client = createFakeClient((_scope, from) => from === 0
    ? { data: firstPage, error: null }
    : { data: null, error: { message: "database unavailable" } }, calls);

  await assert.rejects(
    fetchCompleteApplicantRows(client, { columns: "id, created_at", source: null }),
    /지원자 목록.*database unavailable/,
  );
});

test("chunks applicant ids and paginates every job-candidate chunk completely", async () => {
  const { fetchCompleteApplicantCandidateRows } = await loadModule();
  assert.equal(typeof fetchCompleteApplicantCandidateRows, "function");
  if (typeof fetchCompleteApplicantCandidateRows !== "function") return;

  const applicantIds = Array.from({ length: 401 }, (_, index) => index + 1);
  const candidates = applicantIds.flatMap((applicantId) => {
    const count = applicantId === 1 ? 1_001 : 1;
    return Array.from({ length: count }, (_, index) => ({
      id: applicantId * 10_000 + index,
      applicant_id: applicantId,
      created_at: "2026-08-31T00:00:00.000Z",
    }));
  });
  const calls: string[] = [];
  const client = createFakeClient((scope, from, to) => {
    assert.equal(scope.table, "job_candidates");
    return {
      data: candidates
        .filter((row) => scope.applicantIds.includes(row.applicant_id))
        .slice(from, to + 1),
      error: null,
    };
  }, calls);

  const rows = await fetchCompleteApplicantCandidateRows(client, [1, ...applicantIds]);

  assert.equal(rows.length, candidates.length);
  const inCalls = calls
    .filter((call) => call.startsWith("in:job_candidates:applicant_id:"))
    .map((call) => call.split(":").at(-1)?.split(",") ?? []);
  assert.equal(inCalls.length, 4);
  assert.equal(new Set(inCalls.map((ids) => ids.join(","))).size, 3);
  assert.equal(inCalls.every((ids) => ids.length <= 200), true);
  const rangeCalls = calls.filter((call) => call.startsWith("range:job_candidates:"));
  assert.equal(rangeCalls.filter((call) => call === "range:job_candidates:0:999").length, 3);
  assert.equal(rangeCalls.filter((call) => call === "range:job_candidates:1000:1999").length, 1);
});

test("rejects a later job-candidate chunk error instead of returning partial enrichment", async () => {
  const { fetchCompleteApplicantCandidateRows } = await loadModule();
  assert.equal(typeof fetchCompleteApplicantCandidateRows, "function");
  if (typeof fetchCompleteApplicantCandidateRows !== "function") return;

  const applicantIds = Array.from({ length: 201 }, (_, index) => index + 1);
  const calls: string[] = [];
  const client = createFakeClient((scope) => scope.applicantIds.includes(201)
    ? { data: null, error: { message: "database unavailable" } }
    : { data: [{ id: 1, applicant_id: 1, created_at: "2026-08-31T00:00:00.000Z" }], error: null }, calls);

  await assert.rejects(
    fetchCompleteApplicantCandidateRows(client, applicantIds),
    /지원자 공고 단계.*database unavailable/,
  );
});

test("every applicant-list scope that consumes job links rejects an incomplete link map", async () => {
  for (const query of ["", "?scope=live"]) {
    const { route, gatherCallCount } = loadApplicantsRoute("database unavailable");

    const response = await route.GET({
      url: `http://localhost/api/admin/applicants${query}`,
    });

    assert.equal(response.status, 503, `scope ${query || "default"}`);
    assert.equal(response.body.error, "공고 연결 정보를 확인하지 못했어요.");
    assert.equal(gatherCallCount(), 1);
  }
});

test("dashboard and rollup scopes keep skipping the unused job-link lookup", async () => {
  for (const scope of ["dashboard", "rollup"]) {
    const { route, gatherCallCount } = loadApplicantsRoute("must not be observed");

    const response = await route.GET({
      url: `http://localhost/api/admin/applicants?scope=${scope}`,
    });

    assert.equal(response.status, 200, `scope ${scope}`);
    assert.equal(gatherCallCount(), 0);
  }
});
