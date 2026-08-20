import assert from "node:assert/strict";
import test from "node:test";

type Client = {
  active: boolean;
  branches_count: number;
  active_jobs: number;
};

type MasterClient = {
  lineCount: number;
  workerCount: number;
};

type IntegrityReport = {
  jobs_backfillable: number;
  jobs_client_backfillable: number;
  jobs_unmatched: number;
  jobs_missing_client: number;
  branches_missing_client: number;
};

type ShipperOperationsModule = {
  clientRegistryOverview?: (input: { clients?: Client[]; error?: unknown }) => unknown;
  masterRegistryOverview?: (input: {
    clients?: MasterClient[];
    error?: unknown;
    configured?: boolean;
  }) => unknown;
  integrityOverview?: (input: {
    report?: IntegrityReport | null;
    error?: unknown;
  }) => unknown;
};

async function loadModule(): Promise<ShipperOperationsModule> {
  try {
    return await import(new URL("./shipper-operations.ts", import.meta.url).href) as ShipperOperationsModule;
  } catch {
    return {};
  }
}

test("client registry metrics stay unknown while loading", async () => {
  const { clientRegistryOverview } = await loadModule();

  assert.equal(typeof clientRegistryOverview, "function");
  assert.deepEqual(clientRegistryOverview!({}), { state: "loading" });
});

test("client registry failure is not rendered as an empty registry", async () => {
  const { clientRegistryOverview } = await loadModule();

  assert.equal(typeof clientRegistryOverview, "function");
  assert.deepEqual(clientRegistryOverview!({ clients: [], error: new Error("offline") }), {
    state: "error",
  });
});

test("a loaded empty client registry has its own empty state", async () => {
  const { clientRegistryOverview } = await loadModule();

  assert.equal(typeof clientRegistryOverview, "function");
  assert.deepEqual(clientRegistryOverview!({ clients: [] }), { state: "empty" });
});

test("ready client registry summarizes operational workload", async () => {
  const { clientRegistryOverview } = await loadModule();

  assert.equal(typeof clientRegistryOverview, "function");
  assert.deepEqual(clientRegistryOverview!({
    clients: [
      { active: true, branches_count: 3, active_jobs: 2 },
      { active: false, branches_count: 1, active_jobs: 0 },
      { active: true, branches_count: 4, active_jobs: 5 },
    ],
  }), {
    state: "ready",
    total: 3,
    active: 2,
    branches: 8,
    activeJobs: 7,
  });
});

test("external master distinguishes unconfigured, empty, and failed sources", async () => {
  const { masterRegistryOverview } = await loadModule();

  assert.equal(typeof masterRegistryOverview, "function");
  assert.deepEqual(masterRegistryOverview!({}), { state: "loading" });
  assert.deepEqual(masterRegistryOverview!({ clients: [], configured: false }), { state: "unconfigured" });
  assert.deepEqual(masterRegistryOverview!({ clients: [], configured: true }), { state: "empty" });
  assert.deepEqual(masterRegistryOverview!({
    clients: [],
    configured: true,
    error: new Error("timeout"),
  }), { state: "error" });
});

test("ready external master summarizes contract source volume", async () => {
  const { masterRegistryOverview } = await loadModule();

  assert.equal(typeof masterRegistryOverview, "function");
  assert.deepEqual(masterRegistryOverview!({
    configured: true,
    clients: [
      { lineCount: 3, workerCount: 8 },
      { lineCount: 2, workerCount: 5 },
    ],
  }), {
    state: "ready",
    clients: 2,
    lines: 5,
    workers: 13,
  });
});

test("integrity report counts every actionable gap", async () => {
  const { integrityOverview } = await loadModule();

  assert.equal(typeof integrityOverview, "function");
  assert.deepEqual(integrityOverview!({
    report: {
      jobs_backfillable: 2,
      jobs_client_backfillable: 1,
      jobs_unmatched: 3,
      jobs_missing_client: 1,
      branches_missing_client: 4,
    },
  }), { state: "ready", issues: 10, autoFixable: 3 });
});

test("integrity source distinguishes loading, missing, and failed reports", async () => {
  const { integrityOverview } = await loadModule();

  assert.equal(typeof integrityOverview, "function");
  assert.deepEqual(integrityOverview!({}), { state: "loading" });
  assert.deepEqual(integrityOverview!({ report: null }), { state: "empty" });
  assert.deepEqual(integrityOverview!({ report: null, error: new Error("offline") }), {
    state: "error",
  });
});
