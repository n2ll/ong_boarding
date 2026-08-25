export function conversationMessagesView(input: {
  loading: boolean;
  error: boolean;
  itemCount: number;
}): "loading" | "error" | "empty" | "ready" {
  if (input.loading) return "loading";
  if (input.error) return "error";
  return input.itemCount === 0 ? "empty" : "ready";
}

export type ConversationJobContext =
  | { state: "loading" }
  | { state: "error" }
  | {
      state: "ready";
      scope: "job";
      job: { id: number; title: string; branch: string | null };
    }
  | { state: "ready"; scope: "general" | "unscoped-draft"; job: null };

export function conversationJobContextPresentation(
  input: ConversationJobContext,
): {
  kind: "loading" | "error" | "job" | "general" | "unscoped-draft";
  label: string;
  title: string;
  detail: string;
  sendReady: boolean;
} {
  if (input.state === "loading") {
    return {
      kind: "loading",
      label: "발송 대상 확인 중",
      title: "공고 맥락을 확인하고 있어요",
      detail: "확인이 끝날 때까지 문자 발송을 잠급니다.",
      sendReady: false,
    };
  }
  if (input.state === "error") {
    return {
      kind: "error",
      label: "발송 대상 확인 실패",
      title: "어느 공고의 대화인지 확인할 수 없어요",
      detail: "오발송을 막기 위해 문자 발송을 잠갔습니다.",
      sendReady: false,
    };
  }
  if (input.scope === "job") {
    const branch = input.job.branch?.trim();
    return {
      kind: "job",
      label: "발송 대상 공고",
      title: input.job.title.trim() || `공고 #${input.job.id}`,
      detail: `${branch ? `${branch} · ` : ""}공고 #${input.job.id} · 이 공고의 대화 기록으로 저장됩니다.`,
      sendReady: true,
    };
  }
  if (input.scope === "unscoped-draft") {
    return {
      kind: "unscoped-draft",
      label: "검수 대상",
      title: "공고 미지정 AI 초안",
      detail: "공고를 추정하지 않고 이 초안만 검수해 발송합니다.",
      sendReady: true,
    };
  }
  return {
    kind: "general",
    label: "발송 대상",
    title: "공고 미지정 · 일반 대화",
    detail: "특정 공고에 연결하지 않고 지원자 대화로 저장됩니다.",
    sendReady: true,
  };
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
