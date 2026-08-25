import type { AdminAgentMode, AdminAgentModeView } from "./agent-mode-view";

export type BrainLoadState = "loading" | "error" | "ready";
export type BrainMode = AdminAgentMode;

export type BrainCountMetric = {
  state: BrainLoadState;
  value: number | null;
};

export type BrainCoverageMetric = {
  state: BrainLoadState;
  filled: number | null;
  total: number | null;
};

export type BrainModeMetric = {
  state: AdminAgentModeView["state"];
  value: BrainMode | null;
};

export type BrainOverviewInput = {
  examples?: { category: string; title: string }[];
  examplesError?: boolean;
  branches?: { ai_facts: string | null }[];
  branchesError?: boolean;
  jobs?: { title: string; pay_info: string | null }[];
  jobsError?: boolean;
  handoffs?: { total?: number };
  handoffsError?: boolean;
  agentMode?: AdminAgentModeView;
};

export type BrainOverview = {
  mode: BrainModeMetric;
  facts: BrainCountMetric;
  branches: BrainCoverageMetric;
  jobs: BrainCoverageMetric;
  handoffs: BrainCountMetric;
};

function countMetric<T>(data: T | undefined, failed: boolean, count: (value: T) => number): BrainCountMetric {
  if (failed) return { state: "error", value: null };
  if (data === undefined) return { state: "loading", value: null };
  return { state: "ready", value: count(data) };
}

function coverageMetric<T>(
  data: T[] | undefined,
  failed: boolean,
  isFilled: (value: T) => boolean,
): BrainCoverageMetric {
  if (failed) return { state: "error", filled: null, total: null };
  if (data === undefined) return { state: "loading", filled: null, total: null };
  return { state: "ready", filled: data.filter(isFilled).length, total: data.length };
}

export function brainOverview(input: BrainOverviewInput): BrainOverview {
  const modeView = input.agentMode ?? { state: "loading" as const, mode: null };
  const mode: BrainModeMetric = { state: modeView.state, value: modeView.mode };

  const visibleJobs = input.jobs?.filter((job) => !job.title.startsWith("__"));

  return {
    mode,
    facts: countMetric(
      input.examples,
      Boolean(input.examplesError),
      (examples) => examples.filter((example) => example.category === "facts" && !example.title.startsWith("__")).length,
    ),
    branches: coverageMetric(
      input.branches,
      Boolean(input.branchesError),
      (branch) => Boolean(branch.ai_facts?.trim()),
    ),
    jobs: coverageMetric(
      visibleJobs,
      Boolean(input.jobsError),
      (job) => Boolean(job.pay_info?.trim()),
    ),
    handoffs: countMetric(
      input.handoffs,
      Boolean(input.handoffsError),
      (handoffs) => handoffs.total ?? 0,
    ),
  };
}
