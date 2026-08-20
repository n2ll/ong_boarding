import assert from "node:assert/strict";
import test from "node:test";

type JobRow = {
  id: number;
  branch: string | null;
  branch_id: number | null;
  client_id: number | null;
};

type BranchRow = {
  id: number;
  name: string;
  client_id: number | null;
};

type BackfillPlan = {
  jobBranches: Array<{ jobId: number; branchId: number; clientId: number | null }>;
  jobClients: Array<{ jobId: number; clientId: number }>;
};

type BackfillModule = {
  safeDataIntegrityBackfillPlan?: (jobs: JobRow[], branches: BranchRow[]) => BackfillPlan;
};

async function loadModule(): Promise<BackfillModule> {
  try {
    return await import(new URL("./data-integrity-backfill.ts", import.meta.url).href) as BackfillModule;
  } catch {
    return {};
  }
}

test("a unique exact branch name can safely link a job without inventing branch ownership", async () => {
  const { safeDataIntegrityBackfillPlan } = await loadModule();
  const jobs: JobRow[] = [{ id: 10, branch: "강남점", branch_id: null, client_id: null }];
  const branches: BranchRow[] = [{ id: 3, name: "강남점", client_id: null }];

  assert.equal(typeof safeDataIntegrityBackfillPlan, "function");
  assert.deepEqual(safeDataIntegrityBackfillPlan!(jobs, branches), {
    jobBranches: [{ jobId: 10, branchId: 3, clientId: null }],
    jobClients: [],
  });
});

test("duplicate branch names are ambiguous and never auto-linked", async () => {
  const { safeDataIntegrityBackfillPlan } = await loadModule();
  const jobs: JobRow[] = [{ id: 10, branch: "중앙점", branch_id: null, client_id: null }];
  const branches: BranchRow[] = [
    { id: 3, name: "중앙점", client_id: 1 },
    { id: 4, name: "중앙점", client_id: 2 },
  ];

  assert.equal(typeof safeDataIntegrityBackfillPlan, "function");
  assert.deepEqual(safeDataIntegrityBackfillPlan!(jobs, branches), {
    jobBranches: [],
    jobClients: [],
  });
});

test("a job inherits a client only from its already-known branch", async () => {
  const { safeDataIntegrityBackfillPlan } = await loadModule();
  const jobs: JobRow[] = [{ id: 10, branch: "강남점", branch_id: 3, client_id: null }];
  const branches: BranchRow[] = [{ id: 3, name: "강남점", client_id: 7 }];

  assert.equal(typeof safeDataIntegrityBackfillPlan, "function");
  assert.deepEqual(safeDataIntegrityBackfillPlan!(jobs, branches), {
    jobBranches: [],
    jobClients: [{ jobId: 10, clientId: 7 }],
  });
});

test("an existing conflicting job-client relationship is never overwritten or cross-linked", async () => {
  const { safeDataIntegrityBackfillPlan } = await loadModule();
  const jobs: JobRow[] = [{ id: 10, branch: "강남점", branch_id: null, client_id: 8 }];
  const branches: BranchRow[] = [{ id: 3, name: "강남점", client_id: 7 }];

  assert.equal(typeof safeDataIntegrityBackfillPlan, "function");
  assert.deepEqual(safeDataIntegrityBackfillPlan!(jobs, branches), {
    jobBranches: [],
    jobClients: [],
  });
});
