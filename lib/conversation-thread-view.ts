export function conversationMessagesView(input: {
  loading: boolean;
  error: boolean;
  itemCount: number;
}): "loading" | "error" | "empty" | "ready" {
  if (input.loading) return "loading";
  if (input.error) return "error";
  return input.itemCount === 0 ? "empty" : "ready";
}

export interface ConversationContextStatus {
  reasoning: "ready" | "error";
  poolEvents: "ready" | "error";
  jobLabels: "ready" | "error";
}

/** 보조 맥락 상태가 없거나 예상 형식이 아니면 정상으로 추정하지 않는다. */
export function conversationContextStatus(input: unknown): ConversationContextStatus {
  const value = typeof input === "object" && input !== null
    ? input as Record<string, unknown>
    : {};
  return {
    reasoning: value.reasoning === "ready" ? "ready" : "error",
    poolEvents: value.pool_events === "ready" ? "ready" : "error",
    jobLabels: value.job_labels === "ready" ? "ready" : "error",
  };
}

export function conversationContextWarning(
  input: ConversationContextStatus,
): { title: string; detail: string } | null {
  const reasoningFailed = input.reasoning === "error";
  const poolEventsFailed = input.poolEvents === "error";
  const jobLabelsFailed = input.jobLabels === "error";
  if (!reasoningFailed && !poolEventsFailed && !jobLabelsFailed) return null;

  if (!reasoningFailed && !poolEventsFailed && jobLabelsFailed) {
    return {
      title: "공고 라벨을 불러오지 못했어요",
      detail: "대화 내용은 계속 볼 수 있지만, 공고 칩이 누락될 수 있으니 현재 화면만으로 판단하지 마세요.",
    };
  }

  let title = reasoningFailed && poolEventsFailed
    ? "AI 판단 근거와 재접촉 기록을 불러오지 못했어요"
    : reasoningFailed
      ? "AI 판단 근거를 불러오지 못했어요"
      : "재접촉 기록을 불러오지 못했어요";
  if (jobLabelsFailed) {
    title = reasoningFailed && poolEventsFailed
      ? "AI 판단 근거와 재접촉 기록, 공고 라벨을 불러오지 못했어요"
      : reasoningFailed
        ? "AI 판단 근거와 공고 라벨을 불러오지 못했어요"
        : "재접촉 기록과 공고 라벨을 불러오지 못했어요";
  }
  return {
    title,
    detail: "대화 내용은 계속 볼 수 있지만, 누락된 맥락이 있으니 현재 화면만으로 판단하지 마세요.",
  };
}

/** 마지막 성공 스냅샷은 유지하되 현재 대화가 최신이라는 오해를 막는다. */
export function conversationRefreshWarning(
  input: { stale: boolean },
): { title: string; detail: string } | null {
  if (!input.stale) return null;
  return {
    title: "대화 내역을 최신 상태로 갱신하지 못했어요",
    detail: "아래 내용과 발송 확인 상태는 마지막으로 불러온 기록입니다. 새 답장이 누락될 수 있으니 같은 문자를 다시 보내지 말고 다시 확인해 주세요.",
  };
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

/**
 * 화면에 표시할 공고 맥락과 실제 조회·발송에 쓰는 scope를 한 번 더 결속한다.
 * 두 prop이 잠깐이라도 어긋나면 어느 쪽도 추정하지 않고 발송을 잠근다.
 */
export function bindConversationJobContext(input: {
  jobId: number | null;
  draftScope: "all" | "unscoped";
  context: ConversationJobContext;
}): ConversationJobContext {
  if (input.context.state !== "ready") return input.context;
  if (input.jobId !== null) {
    return input.context.scope === "job" && input.context.job.id === input.jobId
      ? input.context
      : { state: "error" };
  }
  if (input.draftScope === "unscoped") {
    return input.context.scope === "unscoped-draft"
      ? input.context
      : { state: "error" };
  }
  return input.context.scope === "general"
    ? input.context
    : { state: "error" };
}

/**
 * 전체 대화에서도 공고 귀속 AI 초안은 보일 수 있다. 일반 작성창의 null job_id 맥락을
 * 빌려 쓰지 않고, 초안이 실제 전송할 job_id의 검증된 라벨에 별도로 결속한다.
 */
export function bindConversationDraftJobContext(input: {
  jobId: number | null;
  draftJobId: number | null;
  draftScope: "all" | "unscoped";
  context: ConversationJobContext;
  draftJob: { id: number; title: string; branch: string | null } | null;
}): ConversationJobContext {
  const base = bindConversationJobContext({
    jobId: input.jobId,
    draftScope: input.draftScope,
    context: input.context,
  });
  if (base.state !== "ready") return base;

  const effectiveJobId = input.jobId ?? input.draftJobId;
  if (effectiveJobId === null) return base;
  if (input.jobId !== null) return base;

  if (
    base.scope !== "general"
    || !input.draftJob
    || input.draftJob.id !== effectiveJobId
  ) {
    return { state: "error" };
  }

  return { state: "ready", scope: "job", job: input.draftJob };
}

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
