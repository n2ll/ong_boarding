import assert from "node:assert/strict";
import test from "node:test";

type ConversationThreadViewModule = {
  conversationMessagesView?: (input: {
    loading: boolean;
    error: boolean;
    itemCount: number;
  }) => "loading" | "error" | "empty" | "ready";
  conversationAgentPresentation?: (input: {
    scopeReady: boolean;
    draftScope: "all" | "unscoped";
    agentStage: string | null;
  }) => {
    kind: "loading" | "unscoped" | "manual" | "paused" | "active";
    showControls: boolean;
    hasActiveFlow: boolean;
    isAiEnabled: boolean;
    notice: string | null;
  };
};

async function loadModule(): Promise<ConversationThreadViewModule> {
  try {
    return await import(new URL("./conversation-thread-view.ts", import.meta.url).href) as ConversationThreadViewModule;
  } catch {
    return {};
  }
}

test("a failed cold fetch is an error instead of an empty conversation", async () => {
  const { conversationMessagesView } = await loadModule();
  assert.equal(typeof conversationMessagesView, "function");
  assert.equal(
    conversationMessagesView!({ loading: false, error: true, itemCount: 0 }),
    "error"
  );
});

test("only a successful loaded zero-item response is empty", async () => {
  const { conversationMessagesView } = await loadModule();
  assert.equal(typeof conversationMessagesView, "function");
  assert.equal(
    conversationMessagesView!({ loading: false, error: false, itemCount: 0 }),
    "empty"
  );
  assert.equal(
    conversationMessagesView!({ loading: true, error: false, itemCount: 0 }),
    "loading"
  );
  assert.equal(
    conversationMessagesView!({ loading: false, error: false, itemCount: 2 }),
    "ready"
  );
});

test("an unscoped draft never exposes or inherits a job-level AI state", async () => {
  const { conversationAgentPresentation } = await loadModule();

  assert.equal(typeof conversationAgentPresentation, "function");
  assert.deepEqual(
    conversationAgentPresentation!({
      scopeReady: true,
      draftScope: "unscoped",
      agentStage: "screening",
    }),
    {
      kind: "unscoped",
      showControls: false,
      hasActiveFlow: false,
      isAiEnabled: false,
      notice: "AI 상태는 공고별로 관리돼요. 공고 탭에서 확인·변경하세요.",
    },
  );
});
