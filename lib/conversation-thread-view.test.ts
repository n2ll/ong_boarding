import assert from "node:assert/strict";
import test from "node:test";

type ConversationThreadViewModule = {
  conversationMessagesView?: (input: {
    loading: boolean;
    error: boolean;
    itemCount: number;
  }) => "loading" | "error" | "empty" | "ready";
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
