export type AutomationLoadState = "loading" | "error" | "ready";

export type AutomationMetric = {
  state: AutomationLoadState;
  value: number | null;
};

export type AutomationAiMetric = {
  state: AutomationLoadState;
  value: "작동 중" | "중단됨" | null;
  disabled: boolean | null;
};

export type AutomationOverviewInput = {
  applicants?: { status: string }[];
  applicantsError?: boolean;
  killSwitch?: { disabled?: boolean; env_forced?: boolean };
  killSwitchError?: boolean;
  inbox?: unknown[];
  inboxError?: boolean;
  activeJobs?: { title: string }[];
  activeJobsError?: boolean;
};

export type AutomationOverview = {
  ai: AutomationAiMetric;
  screening: AutomationMetric;
  confirmed: AutomationMetric;
  waiting: AutomationMetric;
  inbox: AutomationMetric;
  activeJobs: AutomationMetric;
};

function metric<T>(data: T | undefined, failed: boolean, count: (data: T) => number): AutomationMetric {
  if (failed) return { state: "error", value: null };
  if (data === undefined) return { state: "loading", value: null };
  return { state: "ready", value: count(data) };
}

export function automationOverview(input: AutomationOverviewInput): AutomationOverview {
  const applicantMetric = (status: string) => metric(
    input.applicants,
    Boolean(input.applicantsError),
    (applicants) => applicants.filter((applicant) => applicant.status === status).length,
  );

  let ai: AutomationAiMetric;
  if (input.killSwitchError) {
    ai = { state: "error", value: null, disabled: null };
  } else if (input.killSwitch === undefined) {
    ai = { state: "loading", value: null, disabled: null };
  } else {
    const disabled = Boolean(input.killSwitch.disabled || input.killSwitch.env_forced);
    ai = { state: "ready", value: disabled ? "중단됨" : "작동 중", disabled };
  }

  return {
    ai,
    screening: applicantMetric("스크리닝 중"),
    confirmed: applicantMetric("확정인력"),
    waiting: applicantMetric("대기자"),
    inbox: metric(input.inbox, Boolean(input.inboxError), (items) => items.length),
    activeJobs: metric(
      input.activeJobs,
      Boolean(input.activeJobsError),
      (jobs) => jobs.filter((job) => !String(job.title).startsWith("__")).length,
    ),
  };
}
