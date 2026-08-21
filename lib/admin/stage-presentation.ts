export type AgentStageBadgeVariant =
  | "default"
  | "error"
  | "priority-attention"
  | "priority-critical"
  | "stage-exploration"
  | "stage-screening"
  | "stage-onboarding"
  | "stage-active";

export type AgentStagePresentation = {
  label: string;
  variant: AgentStageBadgeVariant;
};

const AGENT_STAGE_PRESENTATION: Record<string, AgentStagePresentation> = {
  interest: { label: "관심 표시", variant: "stage-exploration" },
  exploration: { label: "초기 대화", variant: "stage-exploration" },
  screening: { label: "스크리닝", variant: "stage-screening" },
  onboarding: { label: "온보딩", variant: "stage-onboarding" },
  active: { label: "활동 중", variant: "stage-active" },
  paused: { label: "수동 응대", variant: "priority-critical" },
  abort: { label: "중단", variant: "default" },
};

const APPLICANT_STATUS_VARIANT: Record<string, AgentStageBadgeVariant> = {
  "스크리닝 전": "stage-exploration",
  대기자: "priority-attention",
  "스크리닝 중": "stage-screening",
  "스크리닝 완료": "stage-onboarding",
  확정인력: "stage-active",
  부적합: "error",
  이탈: "error",
};

export function agentStagePresentation(stage: string): AgentStagePresentation {
  return AGENT_STAGE_PRESENTATION[stage] ?? { label: stage, variant: "default" };
}

export function applicantStatusPresentation(status: string): AgentStagePresentation {
  return {
    label: status,
    variant: APPLICANT_STATUS_VARIANT[status] ?? "default",
  };
}
