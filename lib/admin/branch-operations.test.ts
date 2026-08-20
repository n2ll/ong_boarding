import assert from "node:assert/strict";
import test from "node:test";

type BranchOperationsModule = {
  branchOverview?: (input: {
    branches?: { active: boolean; ai_facts?: string | null }[];
    applicants?: unknown[];
    jobs?: unknown[];
    managers?: unknown[];
    clients?: unknown[];
    errors?: Partial<Record<"branches" | "applicants" | "jobs" | "managers" | "clients", unknown>>;
  }) =>
    | { state: "loading" }
    | { state: "error"; sources: string[] }
    | { state: "ready"; activeBranches: number; knowledgeGaps: number };
  branchSavePayload?: (form: {
    name: string;
    active: boolean;
    clientId: number | null;
    slotCapacity: Record<string, number>;
    aiFacts: string;
  }) => Record<string, unknown>;
  branchCreateValues?: (body: Record<string, unknown>) => {
    name: string;
    active: boolean;
    client_id: number | null;
    slot_capacity: Record<string, number> | null;
    ai_facts: string | null;
  };
};

async function loadModule(): Promise<BranchOperationsModule> {
  try {
    return await import(new URL("./branch-operations.ts", import.meta.url).href) as BranchOperationsModule;
  } catch {
    return {};
  }
}

test("branch totals stay unknown until every source has loaded", async () => {
  const { branchOverview } = await loadModule();

  assert.equal(typeof branchOverview, "function");
  assert.deepEqual(branchOverview!({ branches: [] }), { state: "loading" });
});

test("a failed branch dependency is reported instead of rendered as zero", async () => {
  const { branchOverview } = await loadModule();

  assert.equal(typeof branchOverview, "function");
  assert.deepEqual(branchOverview!({
    branches: [],
    applicants: [],
    jobs: [],
    managers: [],
    clients: [],
    errors: { jobs: new Error("offline"), managers: new Error("timeout") },
  }), { state: "error", sources: ["jobs", "managers"] });
});

test("knowledge gaps count only active branches without usable AI facts", async () => {
  const { branchOverview } = await loadModule();

  assert.equal(typeof branchOverview, "function");
  assert.deepEqual(branchOverview!({
    branches: [
      { active: true, ai_facts: null },
      { active: true, ai_facts: "  " },
      { active: true, ai_facts: "집결지는 후문" },
      { active: false, ai_facts: null },
    ],
    applicants: [],
    jobs: [],
    managers: [],
    clients: [],
  }), { state: "ready", activeBranches: 3, knowledgeGaps: 2 });
});

test("new branches can save capacity and AI facts in the first request", async () => {
  const { branchSavePayload } = await loadModule();

  assert.equal(typeof branchSavePayload, "function");
  assert.deepEqual(branchSavePayload!({
    name: " 성수 ",
    active: true,
    clientId: 7,
    slotCapacity: { 평일오전: 3 },
    aiFacts: "  후문 집결  ",
  }), {
    name: "성수",
    active: true,
    client_id: 7,
    slot_capacity: { 평일오전: 3 },
    ai_facts: "후문 집결",
  });
});

test("the create API keeps first-step capacity and AI facts instead of dropping them", async () => {
  const { branchCreateValues } = await loadModule();

  assert.equal(typeof branchCreateValues, "function");
  assert.deepEqual(branchCreateValues!({
    name: " 성수 ",
    active: false,
    client_id: 7,
    slot_capacity: { 평일오전: 3, 평일오후: -2, 잘못된값: "4" },
    ai_facts: "  후문 집결  ",
  }), {
    name: "성수",
    active: false,
    client_id: 7,
    slot_capacity: { 평일오전: 3, 평일오후: 0 },
    ai_facts: "후문 집결",
  });
});
