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
  conversationJobContextPresentation?: (input:
    | { state: "loading" }
    | { state: "error" }
    | {
        state: "ready";
        scope: "job";
        job: { id: number; title: string; branch: string | null };
      }
    | { state: "ready"; scope: "general" | "unscoped-draft"; job: null }
  ) => {
    kind: "loading" | "error" | "job" | "general" | "unscoped-draft";
    label: string;
    title: string;
    detail: string;
    sendReady: boolean;
  };
  bindConversationJobContext?: (input: {
    jobId: number | null;
    draftScope: "all" | "unscoped";
    context:
      | { state: "loading" }
      | { state: "error" }
      | {
          state: "ready";
          scope: "job";
          job: { id: number; title: string; branch: string | null };
        }
      | { state: "ready"; scope: "general" | "unscoped-draft"; job: null };
  }) =>
    | { state: "loading" }
    | { state: "error" }
    | {
        state: "ready";
        scope: "job";
        job: { id: number; title: string; branch: string | null };
      }
    | { state: "ready"; scope: "general" | "unscoped-draft"; job: null };
  bindConversationDraftJobContext?: (input: {
    jobId: number | null;
    draftJobId: number | null;
    draftScope: "all" | "unscoped";
    context:
      | { state: "loading" }
      | { state: "error" }
      | {
          state: "ready";
          scope: "job";
          job: { id: number; title: string; branch: string | null };
        }
      | { state: "ready"; scope: "general" | "unscoped-draft"; job: null };
    draftJob: { id: number; title: string; branch: string | null } | null;
  }) =>
    | { state: "loading" }
    | { state: "error" }
    | {
        state: "ready";
        scope: "job";
        job: { id: number; title: string; branch: string | null };
      }
    | { state: "ready"; scope: "general" | "unscoped-draft"; job: null };
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

test("the composer names the exact job that will own the outgoing message", async () => {
  const { conversationJobContextPresentation } = await loadModule();

  assert.equal(typeof conversationJobContextPresentation, "function");
  assert.deepEqual(
    conversationJobContextPresentation!({
      state: "ready",
      scope: "job",
      job: { id: 31, title: "강남 새벽 배송", branch: "강남" },
    }),
    {
      kind: "job",
      label: "발송 대상 공고",
      title: "강남 새벽 배송",
      detail: "강남 · 공고 #31 · 이 공고의 대화 기록으로 저장됩니다.",
      sendReady: true,
    },
  );
});

test("job context lookup uncertainty locks the composer instead of guessing", async () => {
  const { conversationJobContextPresentation } = await loadModule();

  assert.equal(typeof conversationJobContextPresentation, "function");
  assert.deepEqual(
    conversationJobContextPresentation!({ state: "loading" }),
    {
      kind: "loading",
      label: "발송 대상 확인 중",
      title: "공고 맥락을 확인하고 있어요",
      detail: "확인이 끝날 때까지 문자 발송을 잠급니다.",
      sendReady: false,
    },
  );
  assert.deepEqual(
    conversationJobContextPresentation!({ state: "error" }),
    {
      kind: "error",
      label: "발송 대상 확인 실패",
      title: "어느 공고의 대화인지 확인할 수 없어요",
      detail: "오발송을 막기 위해 문자 발송을 잠갔습니다.",
      sendReady: false,
    },
  );
});

test("intentional jobless contexts remain explicit instead of looking like a selected job", async () => {
  const { conversationJobContextPresentation } = await loadModule();

  assert.equal(typeof conversationJobContextPresentation, "function");
  assert.deepEqual(
    conversationJobContextPresentation!({ state: "ready", scope: "general", job: null }),
    {
      kind: "general",
      label: "발송 대상",
      title: "공고 미지정 · 일반 대화",
      detail: "특정 공고에 연결하지 않고 지원자 대화로 저장됩니다.",
      sendReady: true,
    },
  );
  assert.deepEqual(
    conversationJobContextPresentation!({ state: "ready", scope: "unscoped-draft", job: null }),
    {
      kind: "unscoped-draft",
      label: "검수 대상",
      title: "공고 미지정 AI 초안",
      detail: "공고를 추정하지 않고 이 초안만 검수해 발송합니다.",
      sendReady: true,
    },
  );
});

test("a displayed job context unlocks sending only for the exact payload job id", async () => {
  const { bindConversationJobContext } = await loadModule();
  assert.equal(typeof bindConversationJobContext, "function");

  const displayedJob = {
    state: "ready" as const,
    scope: "job" as const,
    job: { id: 31, title: "강남 새벽 배송", branch: "강남" },
  };
  assert.deepEqual(
    bindConversationJobContext!({ jobId: 31, draftScope: "all", context: displayedJob }),
    displayedJob,
  );
  assert.deepEqual(
    bindConversationJobContext!({ jobId: 32, draftScope: "all", context: displayedJob }),
    { state: "error" },
  );
  assert.deepEqual(
    bindConversationJobContext!({ jobId: null, draftScope: "all", context: displayedJob }),
    { state: "error" },
  );
});

test("jobless and unscoped-draft composers cannot borrow each other's send-ready context", async () => {
  const { bindConversationJobContext } = await loadModule();
  assert.equal(typeof bindConversationJobContext, "function");

  const general = { state: "ready" as const, scope: "general" as const, job: null };
  const unscopedDraft = { state: "ready" as const, scope: "unscoped-draft" as const, job: null };
  assert.deepEqual(
    bindConversationJobContext!({ jobId: null, draftScope: "all", context: general }),
    general,
  );
  assert.deepEqual(
    bindConversationJobContext!({ jobId: null, draftScope: "unscoped", context: unscopedDraft }),
    unscopedDraft,
  );
  assert.deepEqual(
    bindConversationJobContext!({ jobId: null, draftScope: "all", context: unscopedDraft }),
    { state: "error" },
  );
  assert.deepEqual(
    bindConversationJobContext!({ jobId: null, draftScope: "unscoped", context: general }),
    { state: "error" },
  );
});

test("a job-bound AI draft in the all-jobs view names its actual outgoing job", async () => {
  const { bindConversationDraftJobContext } = await loadModule();
  assert.equal(typeof bindConversationDraftJobContext, "function");

  const general = { state: "ready" as const, scope: "general" as const, job: null };
  const draftJob = { id: 31, title: "강남 새벽 배송", branch: "강남" };
  assert.deepEqual(
    bindConversationDraftJobContext!({
      jobId: null,
      draftJobId: 31,
      draftScope: "all",
      context: general,
      draftJob,
    }),
    { state: "ready", scope: "job", job: draftJob },
  );
});

test("a job-bound AI draft stays locked when its display label cannot be verified", async () => {
  const { bindConversationDraftJobContext } = await loadModule();
  assert.equal(typeof bindConversationDraftJobContext, "function");

  assert.deepEqual(
    bindConversationDraftJobContext!({
      jobId: null,
      draftJobId: 31,
      draftScope: "all",
      context: { state: "ready", scope: "general", job: null },
      draftJob: null,
    }),
    { state: "error" },
  );
});
