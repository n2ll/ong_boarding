export function conversationMessagesView(input: {
  loading: boolean;
  error: boolean;
  itemCount: number;
}): "loading" | "error" | "empty" | "ready" {
  if (input.loading) return "loading";
  if (input.error) return "error";
  return input.itemCount === 0 ? "empty" : "ready";
}

export function conversationAgentPresentation(input: {
  scopeReady: boolean;
  draftScope: "all" | "unscoped";
  agentStage: string | null;
}): {
  kind: "loading" | "unscoped" | "manual" | "paused" | "active";
  showControls: boolean;
  hasActiveFlow: boolean;
  isAiEnabled: boolean;
  notice: string | null;
} {
  if (!input.scopeReady) {
    return {
      kind: "loading",
      showControls: false,
      hasActiveFlow: false,
      isAiEnabled: false,
      notice: null,
    };
  }
  if (input.draftScope === "unscoped") {
    return {
      kind: "unscoped",
      showControls: false,
      hasActiveFlow: false,
      isAiEnabled: false,
      notice: "AI 상태는 공고별로 관리돼요. 공고 탭에서 확인·변경하세요.",
    };
  }

  const hasActiveFlow = input.agentStage != null && input.agentStage !== "abort";
  const isPaused = input.agentStage === "paused";
  return {
    kind: !hasActiveFlow ? "manual" : isPaused ? "paused" : "active",
    showControls: true,
    hasActiveFlow,
    isAiEnabled: hasActiveFlow && !isPaused,
    notice: null,
  };
}
