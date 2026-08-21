import assert from "node:assert/strict";
import test from "node:test";

type AgentStagePresentation = {
  label: string;
  variant:
    | "default"
    | "error"
    | "priority-attention"
    | "priority-critical"
    | "stage-exploration"
    | "stage-screening"
    | "stage-onboarding"
    | "stage-active";
};

async function loadPresentationModule(): Promise<Record<string, unknown>> {
  try {
    return await import(new URL("./stage-presentation.ts", import.meta.url).href) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("agent stages share one low-chroma label and tone contract", async () => {
  const presentationModule = await loadPresentationModule();
  const agentStagePresentation = presentationModule.agentStagePresentation as
    | ((stage: string) => AgentStagePresentation)
    | undefined;

  assert.equal(typeof agentStagePresentation, "function");
  assert.deepEqual(
    ["interest", "exploration", "screening", "onboarding", "active", "paused", "abort"].map((stage) =>
      agentStagePresentation!(stage),
    ),
    [
      { label: "관심 표시", variant: "stage-exploration" },
      { label: "초기 대화", variant: "stage-exploration" },
      { label: "스크리닝", variant: "stage-screening" },
      { label: "온보딩", variant: "stage-onboarding" },
      { label: "활동 중", variant: "stage-active" },
      { label: "수동 응대", variant: "priority-critical" },
      { label: "중단", variant: "default" },
    ],
  );
});

test("unknown stages stay readable and neutral", async () => {
  const presentationModule = await loadPresentationModule();
  const agentStagePresentation = presentationModule.agentStagePresentation as
    | ((stage: string) => AgentStagePresentation)
    | undefined;

  assert.equal(typeof agentStagePresentation, "function");
  assert.deepEqual(agentStagePresentation!("custom_review"), {
    label: "custom_review",
    variant: "default",
  });
});

test("applicant statuses use stages for progress and error only for terminal rejection", async () => {
  const presentationModule = await loadPresentationModule();
  const applicantStatusPresentation = presentationModule.applicantStatusPresentation as
    | ((status: string) => AgentStagePresentation)
    | undefined;

  assert.equal(typeof applicantStatusPresentation, "function");
  assert.deepEqual(
    ["스크리닝 전", "대기자", "스크리닝 중", "스크리닝 완료", "확정인력", "부적합", "이탈", "기타"].map((status) =>
      applicantStatusPresentation!(status),
    ),
    [
      { label: "스크리닝 전", variant: "stage-exploration" },
      { label: "대기자", variant: "priority-attention" },
      { label: "스크리닝 중", variant: "stage-screening" },
      { label: "스크리닝 완료", variant: "stage-onboarding" },
      { label: "확정인력", variant: "stage-active" },
      { label: "부적합", variant: "error" },
      { label: "이탈", variant: "error" },
      { label: "기타", variant: "default" },
    ],
  );
});
