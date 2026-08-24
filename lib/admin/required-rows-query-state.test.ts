import assert from "node:assert/strict";
import test from "node:test";

type RequiredRowsQueryStateModule = {
  requiredRowsQueryState?: (sources: Record<string, { data?: unknown; error?: unknown }>) =>
    | { ok: true; rows: Record<string, unknown[]> }
    | { ok: false; failed: string[]; cause: unknown };
};

async function loadModule(): Promise<RequiredRowsQueryStateModule> {
  try {
    return await import(new URL("./required-rows-query-state.ts", import.meta.url).href) as RequiredRowsQueryStateModule;
  } catch {
    return {};
  }
}

test("successful empty row queries remain valid empty results", async () => {
  const { requiredRowsQueryState } = await loadModule();

  assert.equal(typeof requiredRowsQueryState, "function");
  assert.deepEqual(requiredRowsQueryState!({
    jobCandidates: { data: [], error: null },
    jobs: { data: [], error: null },
  }), {
    ok: true,
    rows: {
      jobCandidates: [],
      jobs: [],
    },
  });
});

test("query errors block empty fallbacks and report every failed source", async () => {
  const { requiredRowsQueryState } = await loadModule();
  const candidateError = { message: "job_candidates unavailable" };

  assert.equal(typeof requiredRowsQueryState, "function");
  assert.deepEqual(requiredRowsQueryState!({
    jobCandidates: { data: [], error: candidateError },
    jobs: { data: null, error: { message: "jobs unavailable" } },
  }), {
    ok: false,
    failed: ["jobCandidates", "jobs"],
    cause: candidateError,
  });
});

test("incomplete success payloads fail closed instead of becoming empty arrays", async () => {
  const { requiredRowsQueryState } = await loadModule();

  assert.equal(typeof requiredRowsQueryState, "function");
  const state = requiredRowsQueryState!({
    jobCandidates: { data: undefined, error: null },
    jobs: { data: null, error: null },
    siteManagers: { data: [], error: null },
  });

  assert.equal(state.ok, false);
  if (!state.ok) {
    assert.deepEqual(state.failed, ["jobCandidates", "jobs"]);
    assert.equal(state.cause, "jobCandidates 응답 형식이 올바르지 않습니다.");
  }
});

