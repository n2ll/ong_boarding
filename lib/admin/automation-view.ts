import type { AdminAgentMode, AdminAgentModeView } from "./agent-mode-view";

export type AutomationLoadState = "loading" | "error" | "ready";

export type AutomationMetric = {
  state: AutomationLoadState;
  value: number | null;
};

export type AutomationAiMetric = {
  state: AdminAgentModeView["state"];
  mode: AdminAgentMode | null;
  value: "확인 중" | "확인 실패" | "갱신 실패" | "자동 응대" | "코파일럿" | "전역 중지" | "테스트 1명만 자동 응대";
  detail: string | null;
  disabled: boolean | null;
  claimsAutomatic: boolean;
  canRetry: boolean;
};

export type AutomationOverviewInput = {
  applicants?: { status: string }[];
  applicantsError?: boolean;
  agentMode?: AdminAgentModeView;
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

  const modeView = input.agentMode ?? { state: "loading" as const, mode: null };
  const testSession = modeView.state === "ready" ? modeView.testSession : undefined;
  const value: AutomationAiMetric["value"] = modeView.state === "loading"
    ? "확인 중"
    : modeView.state === "error"
      ? "확인 실패"
      : modeView.state === "stale"
        ? "갱신 실패"
        : testSession ? "테스트 1명만 자동 응대"
        : modeView.mode === "auto"
          ? "자동 응대"
          : modeView.mode === "draft"
            ? "코파일럿"
            : "전역 중지";
  const previousModeName = modeView.mode === "auto"
    ? "자동 응대"
    : modeView.mode === "draft"
      ? "코파일럿"
      : "전역 중지";
  const ai: AutomationAiMetric = {
    state: modeView.state,
    mode: modeView.mode,
    value,
    detail: modeView.state === "error"
      ? "자동 응대 여부를 추정하지 않습니다."
      : modeView.state === "stale"
        ? `이전 확인: ${previousModeName}`
        : testSession ? "일반 지원자와 예약 작업은 중지 상태입니다." : null,
    disabled: modeView.state === "ready" ? modeView.mode === "off" : null,
    claimsAutomatic: modeView.state === "ready" && modeView.mode === "auto",
    canRetry: modeView.state === "error" || modeView.state === "stale",
  };

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
