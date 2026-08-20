export type BrainLoadState = "loading" | "error" | "ready";
export type BrainMode = "auto" | "draft" | "off";

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
  state: BrainLoadState;
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
  killSwitch?: { mode?: BrainMode; disabled?: boolean; env_forced?: boolean };
  killSwitchError?: boolean;
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
  let mode: BrainModeMetric;
  if (input.killSwitchError) {
    mode = { state: "error", value: null };
  } else if (input.killSwitch === undefined) {
    mode = { state: "loading", value: null };
  } else {
    const value = input.killSwitch.env_forced
      ? "off"
      : input.killSwitch.mode ?? (input.killSwitch.disabled ? "off" : "auto");
    mode = { state: "ready", value };
  }

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
