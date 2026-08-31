import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { fetchAllPostgrestRows } from "./admin/postgrest-pagination.ts";

type CandidateRow = {
  id: number;
  applicant_id: number;
  job_id: number;
  agent_stage: string | null;
  created_at: string;
  updated_at: string;
  jobs: {
    id: number;
    title: string;
    branch: string;
    status: string;
    closes_at: string | null;
  };
};

type CandidateLinksModule = {
  gatherLiveJobLinks: (
    client: unknown,
    applicantIds: number[],
  ) => Promise<{
    links: Map<number, Array<{ job_id: number }>>;
    error: string | null;
  }>;
};

function loadModule(): CandidateLinksModule {
  const output = ts.transpileModule(readFileSync(
    new URL("./candidate-links.ts", import.meta.url),
    "utf8",
  ), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const compiledModule = { exports: {} as Record<string, unknown> };

  runInNewContext(output, {
    exports: compiledModule.exports,
    module: compiledModule,
    require: (specifier: string) => {
      if (specifier === "./admin/postgrest-pagination") return { fetchAllPostgrestRows };
      if (specifier !== "./jobs") return {};
      return {
        isJobEffectivelyClosed: (status: string | null) => status === "closed",
        isSystemJobTitle: (title: string | null) => typeof title === "string" && title.startsWith("__"),
      };
    },
  });
  return compiledModule.exports as CandidateLinksModule;
}

function createFakeClient(
  resolvePage: (ids: number[], from: number, to: number) => {
    data: CandidateRow[] | null;
    error: { message: string } | null;
  },
  calls: string[],
) {
  return {
    from(table: string) {
      assert.equal(table, "job_candidates");
      let ids: number[] = [];
      const query = {
        select(columns: string) {
          calls.push(`select:${columns}`);
          return query;
        },
        in(column: string, values: number[]) {
          assert.equal(column, "applicant_id");
          ids = [...values];
          calls.push(`in:${values.join(",")}`);
          return query;
        },
        or(filter: string) {
          calls.push(`or:${filter}`);
          return query;
        },
        order(column: string, options: { ascending: boolean }) {
          calls.push(`order:${column}:${options.ascending ? "asc" : "desc"}`);
          return query;
        },
        async range(from: number, to: number) {
          calls.push(`range:${ids[0]}:${from}:${to}`);
          return resolvePage(ids, from, to);
        },
      };
      return query;
    },
  };
}

function candidateRow(applicantId: number): CandidateRow {
  return {
    id: applicantId,
    applicant_id: applicantId,
    job_id: applicantId + 10_000,
    agent_stage: "screening",
    created_at: "2026-08-31T00:00:00.000Z",
    updated_at: "2026-08-31T00:00:00.000Z",
    jobs: {
      id: applicantId + 10_000,
      title: `공고 ${applicantId}`,
      branch: "서울",
      status: "active",
      closes_at: null,
    },
  };
}

test("chunks more than 1000 applicant ids while preserving every live job link", async () => {
  const { gatherLiveJobLinks } = loadModule();
  const applicantIds = Array.from({ length: 1_001 }, (_, index) => index + 1);
  const rows = applicantIds.map(candidateRow);
  const calls: string[] = [];
  const client = createFakeClient((ids, from, to) => ({
    data: rows.filter((row) => ids.includes(row.applicant_id)).slice(from, to + 1),
    error: null,
  }), calls);

  const result = await gatherLiveJobLinks(client as never, [1, ...applicantIds]);

  assert.equal(result.error, null);
  assert.equal(result.links.size, 1_001);
  assert.equal(result.links.get(1_001)?.[0].job_id, 11_001);
  const inCalls = calls
    .filter((call) => call.startsWith("in:"))
    .map((call) => call.slice(3).split(","));
  assert.equal(inCalls.length > 1, true);
  assert.equal(inCalls.every((ids) => ids.length <= 250), true);
  assert.equal(calls.filter((call) => call === "order:created_at:asc").length, inCalls.length);
  assert.equal(calls.filter((call) => call === "order:id:asc").length, inCalls.length);
});

test("reports a later id-chunk error so fail-closed callers can reject partial links", async () => {
  const { gatherLiveJobLinks } = loadModule();
  const applicantIds = Array.from({ length: 251 }, (_, index) => index + 1);
  const calls: string[] = [];
  const client = createFakeClient((ids) => ids.includes(251)
    ? { data: null, error: { message: "database unavailable" } }
    : { data: ids.map(candidateRow), error: null }, calls);

  const result = await gatherLiveJobLinks(client as never, applicantIds);

  assert.match(result.error ?? "", /database unavailable/);
  assert.equal(calls.filter((call) => call.startsWith("in:")).length, 2);
});
