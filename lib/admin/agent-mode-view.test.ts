import assert from "node:assert/strict";
import test from "node:test";

type AgentMode = "auto" | "draft" | "off";

type AgentModeView =
  | { state: "loading" | "error"; mode: null }
  | { state: "stale" | "ready"; mode: AgentMode };

type AgentModeViewModule = {
  agentModeView?: (input: { data?: unknown; error?: unknown }) => AgentModeView;
  fetchFreshAgentMode?: (fetcher: (input: string, init?: RequestInit) => Promise<{
    ok: boolean;
    json: () => Promise<unknown>;
  }>) => Promise<AgentModeView>;
  agentModeAllowsManualSend?: (view: AgentModeView) => boolean;
  agentModeResumeTarget?: (view: AgentModeView) => "auto" | "draft" | null;
  agentModePresentation?: (view: AgentModeView) => {
    kind: "loading" | "error" | "stale" | AgentMode;
    label: string;
    detail: string | null;
    canRetry: boolean;
    claimsAutomatic: boolean;
  };
};

async function loadModule(): Promise<AgentModeViewModule> {
  try {
    return await import(new URL("./agent-mode-view.ts", import.meta.url).href) as AgentModeViewModule;
  } catch {
    return {};
  }
}

test("a missing or failed AI mode response never becomes automatic mode", async () => {
  const { agentModeView } = await loadModule();

  assert.equal(typeof agentModeView, "function");
  assert.deepEqual(agentModeView!({}), { state: "loading", mode: null });
  assert.deepEqual(agentModeView!({ error: new Error("offline") }), { state: "error", mode: null });
});

test("a current response exposes its effective auto, draft, or off mode", async () => {
  const { agentModeView } = await loadModule();

  assert.equal(typeof agentModeView, "function");
  assert.deepEqual(agentModeView!({ data: { mode: "auto", disabled: false, env_forced: false } }), {
    state: "ready",
    mode: "auto",
  });
  assert.deepEqual(agentModeView!({ data: { mode: "draft", disabled: false, env_forced: false } }), {
    state: "ready",
    mode: "draft",
  });
  assert.deepEqual(agentModeView!({ data: { mode: "off", disabled: true, env_forced: false } }), {
    state: "ready",
    mode: "off",
  });
  assert.deepEqual(agentModeView!({ data: { mode: "auto", disabled: false, env_forced: true } }), {
    state: "ready",
    mode: "off",
  });
});

test("a refresh failure marks a valid cached AI mode as stale", async () => {
  const { agentModeView } = await loadModule();

  assert.equal(typeof agentModeView, "function");
  assert.deepEqual(agentModeView!({
    data: { mode: "draft", disabled: false, env_forced: false },
    error: new Error("refresh failed"),
  }), {
    state: "stale",
    mode: "draft",
  });
});

test("an irreversible action accepts only a fresh no-store AI mode response", async () => {
  const { fetchFreshAgentMode } = await loadModule();
  const requests: Array<{ input: string; init?: RequestInit }> = [];

  assert.equal(typeof fetchFreshAgentMode, "function");
  assert.deepEqual(await fetchFreshAgentMode!(async (input, init) => {
    requests.push({ input, init });
    return {
      ok: true,
      json: async () => ({ mode: "draft", disabled: false, env_forced: false }),
    };
  }), { state: "ready", mode: "draft" });
  assert.deepEqual(requests, [{
    input: "/api/admin/agent/kill-switch",
    init: { cache: "no-store" },
  }]);

  assert.deepEqual(await fetchFreshAgentMode!(async () => ({
    ok: false,
    json: async () => ({ mode: "auto", disabled: false, env_forced: false }),
  })), { state: "error", mode: null });
  assert.deepEqual(await fetchFreshAgentMode!(async () => ({
    ok: true,
    json: async () => ({ mode: "auto" }),
  })), { state: "error", mode: null });
  assert.deepEqual(await fetchFreshAgentMode!(async () => {
    throw new Error("offline");
  }), { state: "error", mode: null });
});

test("malformed success payloads remain unavailable instead of defaulting to auto", async () => {
  const { agentModeView } = await loadModule();

  assert.equal(typeof agentModeView, "function");
  assert.deepEqual(agentModeView!({ data: {} }), { state: "error", mode: null });
  assert.deepEqual(agentModeView!({ data: { mode: "auto" } }), { state: "error", mode: null });
  assert.deepEqual(agentModeView!({ data: { mode: "automatic" } }), { state: "error", mode: null });
  assert.deepEqual(agentModeView!({ data: { mode: "auto", disabled: "false" } }), { state: "error", mode: null });
  assert.deepEqual(agentModeView!({ data: { mode: "auto", disabled: false, env_forced: "false" } }), {
    state: "error",
    mode: null,
  });
  assert.deepEqual(agentModeView!({ data: { mode: "auto", disabled: true, env_forced: false } }), {
    state: "error",
    mode: null,
  });
  assert.deepEqual(agentModeView!({ data: { mode: "off", disabled: false, env_forced: false } }), {
    state: "error",
    mode: null,
  });
  assert.deepEqual(agentModeView!({ data: { mode: "auto", disabled: false, env_forced: false, updated_at: 7 } }), {
    state: "error",
    mode: null,
  });
});

test("manual sending opens only for a current mode known not to auto-send", async () => {
  const { agentModeAllowsManualSend } = await loadModule();

  assert.equal(typeof agentModeAllowsManualSend, "function");
  assert.equal(agentModeAllowsManualSend!({ state: "loading", mode: null }), false);
  assert.equal(agentModeAllowsManualSend!({ state: "error", mode: null }), false);
  assert.equal(agentModeAllowsManualSend!({ state: "stale", mode: "off" }), false);
  assert.equal(agentModeAllowsManualSend!({ state: "stale", mode: "draft" }), false);
  assert.equal(agentModeAllowsManualSend!({ state: "ready", mode: "auto" }), false);
  assert.equal(agentModeAllowsManualSend!({ state: "ready", mode: "draft" }), true);
  assert.equal(agentModeAllowsManualSend!({ state: "ready", mode: "off" }), true);
});

test("a paused conversation resumes only into a current auto or draft mode", async () => {
  const { agentModeResumeTarget } = await loadModule();

  assert.equal(typeof agentModeResumeTarget, "function");
  assert.equal(agentModeResumeTarget!({ state: "loading", mode: null }), null);
  assert.equal(agentModeResumeTarget!({ state: "error", mode: null }), null);
  assert.equal(agentModeResumeTarget!({ state: "stale", mode: "auto" }), null);
  assert.equal(agentModeResumeTarget!({ state: "stale", mode: "draft" }), null);
  assert.equal(agentModeResumeTarget!({ state: "ready", mode: "off" }), null);
  assert.equal(agentModeResumeTarget!({ state: "ready", mode: "draft" }), "draft");
  assert.equal(agentModeResumeTarget!({ state: "ready", mode: "auto" }), "auto");
});

test("operator copy claims automatic replies only for a current auto snapshot", async () => {
  const { agentModePresentation } = await loadModule();

  assert.equal(typeof agentModePresentation, "function");
  assert.deepEqual(agentModePresentation!({ state: "loading", mode: null }), {
    kind: "loading",
    label: "AI 모드 확인 중",
    detail: null,
    canRetry: false,
    claimsAutomatic: false,
  });
  assert.deepEqual(agentModePresentation!({ state: "error", mode: null }), {
    kind: "error",
    label: "AI 모드 확인 불가",
    detail: "자동 응대 여부를 추정하지 않습니다.",
    canRetry: true,
    claimsAutomatic: false,
  });
  assert.deepEqual(agentModePresentation!({ state: "stale", mode: "auto" }), {
    kind: "stale",
    label: "AI 모드 갱신 실패",
    detail: "이전 확인: 자동 응대",
    canRetry: true,
    claimsAutomatic: false,
  });
  assert.deepEqual(agentModePresentation!({ state: "ready", mode: "draft" }), {
    kind: "draft",
    label: "코파일럿 · 승인 후 발송",
    detail: null,
    canRetry: false,
    claimsAutomatic: false,
  });
  assert.deepEqual(agentModePresentation!({ state: "ready", mode: "off" }), {
    kind: "off",
    label: "AI 전역 중지됨",
    detail: null,
    canRetry: false,
    claimsAutomatic: false,
  });
  assert.deepEqual(agentModePresentation!({ state: "ready", mode: "auto" }), {
    kind: "auto",
    label: "AI 자동 응대 중",
    detail: null,
    canRetry: false,
    claimsAutomatic: true,
  });
});
