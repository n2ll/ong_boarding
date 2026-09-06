import assert from "node:assert/strict";
import test from "node:test";

type OverviewInput = {
  applicants?: { status: string }[];
  applicantsError?: boolean;
  agentMode?:
    | { state: "loading" | "error"; mode: null }
    | { state: "stale" | "ready"; mode: "auto" | "draft" | "off"; testSession?: { mode: "test"; applicant_id: number; started_at: string; expires_at: string } };
  inbox?: unknown[];
  inboxError?: boolean;
  activeJobs?: { title: string }[];
  activeJobsError?: boolean;
};

async function loadViewModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./automation-view.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("automation overview labels a limited test without claiming global automation", async () => {
  const { automationOverview } = await loadViewModule() as {
    automationOverview: (input: OverviewInput) => { ai: { value: string; detail: string | null; claimsAutomatic: boolean } };
  };
  const result = automationOverview({ agentMode: { state: "ready", mode: "off", testSession: {
    mode: "test", applicant_id: 7, started_at: new Date().toISOString(), expires_at: new Date(Date.now()+60000).toISOString(),
  } } });
  assert.equal(result.ai.value, "테스트 1명만 자동 응대");
  assert.match(result.ai.detail!, /일반 지원자/);
  assert.equal(result.ai.claimsAutomatic, false);
});

test("unloaded automation data stays unknown instead of looking healthy or empty", async () => {
  const view = await loadViewModule();
  const automationOverview = view.automationOverview as
    | ((input: OverviewInput) => Record<string, { state: string; value: unknown }>)
    | undefined;

  assert.equal(typeof automationOverview, "function");
  assert.deepEqual(automationOverview!({}), {
    ai: {
      state: "loading",
      mode: null,
      value: "확인 중",
      detail: null,
      disabled: null,
      claimsAutomatic: false,
      canRetry: false,
    },
    screening: { state: "loading", value: null },
    confirmed: { state: "loading", value: null },
    waiting: { state: "loading", value: null },
    inbox: { state: "loading", value: null },
    activeJobs: { state: "loading", value: null },
  });
});

test("failed automation requests are errors instead of zero counts", async () => {
  const view = await loadViewModule();
  const automationOverview = view.automationOverview as
    | ((input: OverviewInput) => Record<string, { state: string; value: unknown }>)
    | undefined;

  assert.equal(typeof automationOverview, "function");
  const result = automationOverview!({
    applicantsError: true,
    agentMode: { state: "error", mode: null },
    inboxError: true,
    activeJobsError: true,
  });

  assert.equal(result.ai.state, "error");
  assert.equal(result.screening.state, "error");
  assert.equal(result.confirmed.state, "error");
  assert.equal(result.waiting.state, "error");
  assert.equal(result.inbox.state, "error");
  assert.equal(result.activeJobs.state, "error");
});

test("automation distinguishes draft, stale, and effective-off AI modes", async () => {
  const view = await loadViewModule();
  const automationOverview = view.automationOverview as
    | ((input: OverviewInput) => Record<string, unknown>)
    | undefined;

  assert.equal(typeof automationOverview, "function");
  assert.deepEqual((automationOverview!({
    agentMode: { state: "ready", mode: "draft" },
  }) as { ai: unknown }).ai, {
    state: "ready",
    mode: "draft",
    value: "코파일럿",
    detail: null,
    disabled: false,
    claimsAutomatic: false,
    canRetry: false,
  });
  assert.deepEqual((automationOverview!({
    agentMode: { state: "stale", mode: "auto" },
  }) as { ai: unknown }).ai, {
    state: "stale",
    mode: "auto",
    value: "갱신 실패",
    detail: "이전 확인: 자동 응대",
    disabled: null,
    claimsAutomatic: false,
    canRetry: true,
  });
  assert.equal((automationOverview!({
    agentMode: { state: "stale", mode: "draft" },
  }) as { ai: { detail: string } }).ai.detail, "이전 확인: 코파일럿");
  assert.equal((automationOverview!({
    agentMode: { state: "stale", mode: "off" },
  }) as { ai: { detail: string } }).ai.detail, "이전 확인: 전역 중지");
  assert.deepEqual((automationOverview!({
    agentMode: { state: "ready", mode: "off" },
  }) as { ai: unknown }).ai, {
    state: "ready",
    mode: "off",
    value: "전역 중지",
    detail: null,
    disabled: true,
    claimsAutomatic: false,
    canRetry: false,
  });
});

test("loaded empty data is the only state rendered as zero and healthy", async () => {
  const view = await loadViewModule();
  const automationOverview = view.automationOverview as
    | ((input: OverviewInput) => Record<string, { state: string; value: unknown }>)
    | undefined;

  assert.equal(typeof automationOverview, "function");
  assert.deepEqual(automationOverview!({
    applicants: [],
    agentMode: { state: "ready", mode: "auto" },
    inbox: [],
    activeJobs: [],
  }), {
    ai: {
      state: "ready",
      mode: "auto",
      value: "자동 응대",
      detail: null,
      disabled: false,
      claimsAutomatic: true,
      canRetry: false,
    },
    screening: { state: "ready", value: 0 },
    confirmed: { state: "ready", value: 0 },
    waiting: { state: "ready", value: 0 },
    inbox: { state: "ready", value: 0 },
    activeJobs: { state: "ready", value: 0 },
  });
});

test("overview counts operational statuses and excludes internal jobs", async () => {
  const view = await loadViewModule();
  const automationOverview = view.automationOverview as
    | ((input: OverviewInput) => Record<string, { state: string; value: unknown }>)
    | undefined;

  assert.equal(typeof automationOverview, "function");
  assert.deepEqual(automationOverview!({
    applicants: [
      { status: "스크리닝 중" },
      { status: "스크리닝 중" },
      { status: "확정인력" },
      { status: "대기자" },
      { status: "지원자" },
    ],
    agentMode: { state: "ready", mode: "off" },
    inbox: [{}, {}, {}],
    activeJobs: [{ title: "현장 A" }, { title: "__system" }, { title: "현장 B" }],
  }), {
    ai: {
      state: "ready",
      mode: "off",
      value: "전역 중지",
      detail: null,
      disabled: true,
      claimsAutomatic: false,
      canRetry: false,
    },
    screening: { state: "ready", value: 2 },
    confirmed: { state: "ready", value: 1 },
    waiting: { state: "ready", value: 1 },
    inbox: { state: "ready", value: 3 },
    activeJobs: { state: "ready", value: 2 },
  });
});
