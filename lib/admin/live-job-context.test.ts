import assert from "node:assert/strict";
import test from "node:test";

type LiveJobContextModule = {
  liveConversationJobContext?: (input: {
    activeApplicantId: number;
    ownerApplicantId: number | null;
    loadState: "idle" | "loading" | "error" | "ready";
    jobs: ReadonlyArray<{ job_id: number; title: string; branch: string | null }>;
    selectedJobId: number | null;
    unscopedDraft: boolean;
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

async function loadModule(): Promise<LiveJobContextModule> {
  try {
    return await import(new URL("./live-job-context.ts", import.meta.url).href) as LiveJobContextModule;
  } catch {
    return {};
  }
}

test("a job list owned by the previous applicant is never reused for the next applicant", async () => {
  const { liveConversationJobContext } = await loadModule();

  assert.equal(typeof liveConversationJobContext, "function");
  assert.deepEqual(
    liveConversationJobContext!({
      activeApplicantId: 22,
      ownerApplicantId: 11,
      loadState: "ready",
      jobs: [{ job_id: 31, title: "A 공고", branch: "강남" }],
      selectedJobId: 31,
      unscopedDraft: false,
    }),
    { state: "loading" },
  );
});

test("a failed job lookup and an inconsistent selection both fail closed", async () => {
  const { liveConversationJobContext } = await loadModule();

  assert.equal(typeof liveConversationJobContext, "function");
  const base = {
    activeApplicantId: 22,
    ownerApplicantId: 22,
    jobs: [{ job_id: 41, title: "B 공고", branch: null }],
    unscopedDraft: false,
  } as const;
  assert.deepEqual(
    liveConversationJobContext!({ ...base, loadState: "error", selectedJobId: null }),
    { state: "error" },
  );
  assert.deepEqual(
    liveConversationJobContext!({ ...base, loadState: "ready", selectedJobId: null }),
    { state: "error" },
  );
  assert.deepEqual(
    liveConversationJobContext!({ ...base, loadState: "ready", selectedJobId: 999 }),
    { state: "error" },
  );
});

test("ready live job states preserve exact job, general, and unscoped-draft meanings", async () => {
  const { liveConversationJobContext } = await loadModule();

  assert.equal(typeof liveConversationJobContext, "function");
  assert.deepEqual(
    liveConversationJobContext!({
      activeApplicantId: 22,
      ownerApplicantId: 22,
      loadState: "ready",
      jobs: [{ job_id: 41, title: "B 공고", branch: "송파" }],
      selectedJobId: 41,
      unscopedDraft: false,
    }),
    {
      state: "ready",
      scope: "job",
      job: { id: 41, title: "B 공고", branch: "송파" },
    },
  );
  assert.deepEqual(
    liveConversationJobContext!({
      activeApplicantId: 22,
      ownerApplicantId: 22,
      loadState: "ready",
      jobs: [],
      selectedJobId: null,
      unscopedDraft: false,
    }),
    { state: "ready", scope: "general", job: null },
  );
  assert.deepEqual(
    liveConversationJobContext!({
      activeApplicantId: 22,
      ownerApplicantId: 22,
      loadState: "ready",
      jobs: [{ job_id: 41, title: "B 공고", branch: "송파" }],
      selectedJobId: null,
      unscopedDraft: true,
    }),
    { state: "ready", scope: "unscoped-draft", job: null },
  );
});
