import type { AgentTestSession } from "../agent/kill-switch";

export type AdminAgentMode = "auto" | "draft" | "off";

export type AdminAgentModeResponse = {
  mode: AdminAgentMode;
  disabled: boolean;
  env_forced: boolean;
  updated_at?: string | null;
  test_session?: AgentTestSession | null;
};

export type AdminAgentModeSnapshot = {
  configuredMode: AdminAgentMode;
  effectiveMode: AdminAgentMode;
  override: null | {
    kind: "environment";
    variable: "AGENT_DISABLED";
    forcedMode: "off";
  };
  updatedAt: string | null;
};

export type AdminAgentModeView =
  | { state: "loading" | "error"; mode: null }
  | { state: "stale" | "ready"; mode: AdminAgentMode; testSession?: AgentTestSession };

export type AdminAgentModePresentation = {
  kind: "loading" | "error" | "stale" | AdminAgentMode;
  label: string;
  detail: string | null;
  canRetry: boolean;
  claimsAutomatic: boolean;
};

export function isAdminAgentModeResponse(value: unknown): value is AdminAgentModeResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Partial<AdminAgentModeResponse>;
  const validMode = response.mode === "auto" || response.mode === "draft" || response.mode === "off";
  const validUpdatedAt = response.updated_at === undefined
    || response.updated_at === null
    || typeof response.updated_at === "string";
  return validMode
    && typeof response.disabled === "boolean"
    && typeof response.env_forced === "boolean"
    && response.disabled === (response.mode === "off")
    && validUpdatedAt;
}

export function agentModeSnapshot(data: unknown): AdminAgentModeSnapshot | null {
  if (!isAdminAgentModeResponse(data)) return null;
  const override = data.env_forced
    ? {
        kind: "environment" as const,
        variable: "AGENT_DISABLED" as const,
        forcedMode: "off" as const,
      }
    : null;
  return {
    configuredMode: data.mode,
    effectiveMode: override ? "off" : data.mode,
    override,
    updatedAt: data.updated_at ?? null,
  };
}

export function agentModeView(input: {
  data?: unknown;
  error?: unknown;
}): AdminAgentModeView {
  const snapshot = agentModeSnapshot(input.data);
  if (!snapshot) {
    return input.data === undefined && !input.error
      ? { state: "loading", mode: null }
      : { state: "error", mode: null };
  }

  return {
    state: input.error ? "stale" : "ready",
    mode: snapshot.effectiveMode,
    ...(!snapshot.override && isAdminAgentModeResponse(input.data) && input.data.test_session
      && Date.parse(input.data.test_session.expires_at) > Date.now()
      ? { testSession: input.data.test_session } : {}),
  };
}

type AgentModeFetchResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

type AgentModeFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<AgentModeFetchResponse>;

export async function fetchFreshAgentMode(
  fetcher: AgentModeFetcher = fetch,
): Promise<AdminAgentModeView> {
  try {
    const response = await fetcher("/api/admin/agent/kill-switch", { cache: "no-store" });
    if (!response.ok) return { state: "error", mode: null };
    return agentModeView({ data: await response.json() });
  } catch {
    return { state: "error", mode: null };
  }
}

export function agentModeAllowsManualSend(view: AdminAgentModeView): boolean {
  return view.state === "ready" && view.mode !== "auto";
}

export function agentModeResumeTarget(view: AdminAgentModeView): "auto" | "draft" | null {
  if (view.state !== "ready" || view.mode === "off") return null;
  return view.mode;
}

const MODE_NAMES: Record<AdminAgentMode, string> = {
  auto: "자동 응대",
  draft: "코파일럿",
  off: "전역 중지",
};

export function agentModePresentation(view: AdminAgentModeView): AdminAgentModePresentation {
  if (view.state === "loading") {
    return {
      kind: "loading",
      label: "AI 모드 확인 중",
      detail: null,
      canRetry: false,
      claimsAutomatic: false,
    };
  }
  if (view.state === "error") {
    return {
      kind: "error",
      label: "AI 모드 확인 불가",
      detail: "자동 응대 여부를 추정하지 않습니다.",
      canRetry: true,
      claimsAutomatic: false,
    };
  }
  if (view.state === "stale") {
    return {
      kind: "stale",
      label: "AI 모드 갱신 실패",
      detail: `이전 확인: ${MODE_NAMES[view.mode]}`,
      canRetry: true,
      claimsAutomatic: false,
    };
  }
  if (view.state === "ready" && view.testSession) {
    return { kind: "off", label: "테스트 1명만 자동 응대", detail: `일반 지원자 중지 · ${new Date(view.testSession.expires_at).toLocaleTimeString("ko-KR")}까지 검수`, canRetry: false, claimsAutomatic: false };
  }
  if (view.mode === "draft") {
    return {
      kind: "draft",
      label: "코파일럿 · 승인 후 발송",
      detail: null,
      canRetry: false,
      claimsAutomatic: false,
    };
  }
  if (view.mode === "off") {
    return {
      kind: "off",
      label: "AI 전역 중지됨",
      detail: null,
      canRetry: false,
      claimsAutomatic: false,
    };
  }
  return {
    kind: "auto",
    label: "AI 자동 응대 중",
    detail: null,
    canRetry: false,
    claimsAutomatic: true,
  };
}
