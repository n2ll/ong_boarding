import assert from "node:assert/strict";
import test from "node:test";

type BrainOverviewInput = {
  examples?: { category: string; title: string }[];
  examplesError?: boolean;
  branches?: { ai_facts: string | null }[];
  branchesError?: boolean;
  jobs?: { title: string; pay_info: string | null }[];
  jobsError?: boolean;
  handoffs?: { total?: number };
  handoffsError?: boolean;
  killSwitch?: { mode?: "auto" | "draft" | "off"; disabled?: boolean; env_forced?: boolean };
  killSwitchError?: boolean;
};

async function loadOverviewModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./brain-overview.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("unloaded brain data stays unknown instead of showing automatic mode or zero coverage", async () => {
  const overviewModule = await loadOverviewModule();
  const brainOverview = overviewModule.brainOverview as
    | ((input: BrainOverviewInput) => Record<string, unknown>)
    | undefined;

  assert.equal(typeof brainOverview, "function");
  assert.deepEqual(brainOverview!({}), {
    mode: { state: "loading", value: null },
    facts: { state: "loading", value: null },
    branches: { state: "loading", filled: null, total: null },
    jobs: { state: "loading", filled: null, total: null },
    handoffs: { state: "loading", value: null },
  });
});

test("failed brain requests are explicit errors instead of healthy defaults", async () => {
  const overviewModule = await loadOverviewModule();
  const brainOverview = overviewModule.brainOverview as
    | ((input: BrainOverviewInput) => Record<string, { state: string }>)
    | undefined;

  assert.equal(typeof brainOverview, "function");
  const result = brainOverview!({
    examplesError: true,
    branchesError: true,
    jobsError: true,
    handoffsError: true,
    killSwitchError: true,
  });

  assert.equal(result.mode.state, "error");
  assert.equal(result.facts.state, "error");
  assert.equal(result.branches.state, "error");
  assert.equal(result.jobs.state, "error");
  assert.equal(result.handoffs.state, "error");
});

test("loaded empty brain data is the only state rendered as zero and automatic mode", async () => {
  const overviewModule = await loadOverviewModule();
  const brainOverview = overviewModule.brainOverview as
    | ((input: BrainOverviewInput) => Record<string, unknown>)
    | undefined;

  assert.equal(typeof brainOverview, "function");
  assert.deepEqual(brainOverview!({
    examples: [],
    branches: [],
    jobs: [],
    handoffs: { total: 0 },
    killSwitch: { mode: "auto", disabled: false, env_forced: false },
  }), {
    mode: { state: "ready", value: "auto" },
    facts: { state: "ready", value: 0 },
    branches: { state: "ready", filled: 0, total: 0 },
    jobs: { state: "ready", filled: 0, total: 0 },
    handoffs: { state: "ready", value: 0 },
  });
});

test("brain overview counts usable knowledge and treats environment-forced shutdown as off", async () => {
  const overviewModule = await loadOverviewModule();
  const brainOverview = overviewModule.brainOverview as
    | ((input: BrainOverviewInput) => Record<string, unknown>)
    | undefined;

  assert.equal(typeof brainOverview, "function");
  assert.deepEqual(brainOverview!({
    examples: [
      { category: "facts", title: "공통 정책" },
      { category: "facts", title: "__persona__" },
      { category: "knowledge", title: "정산일" },
    ],
    branches: [{ ai_facts: "주차 가능" }, { ai_facts: "  " }, { ai_facts: null }],
    jobs: [
      { title: "공고 A", pay_info: "시급 20,000원" },
      { title: "공고 B", pay_info: null },
      { title: "__system", pay_info: "내부" },
    ],
    handoffs: { total: 4 },
    killSwitch: { mode: "auto", env_forced: true },
  }), {
    mode: { state: "ready", value: "off" },
    facts: { state: "ready", value: 1 },
    branches: { state: "ready", filled: 1, total: 3 },
    jobs: { state: "ready", filled: 1, total: 2 },
    handoffs: { state: "ready", value: 4 },
  });
});
