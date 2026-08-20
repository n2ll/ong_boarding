import assert from "node:assert/strict";
import test from "node:test";

type OverviewInput = {
  applicants?: { status: string }[];
  applicantsError?: boolean;
  killSwitch?: { disabled?: boolean; env_forced?: boolean };
  killSwitchError?: boolean;
  inbox?: unknown[];
  inboxError?: boolean;
  activeJobs?: { title: string }[];
  activeJobsError?: boolean;
};

async function loadViewModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./automation-view.js";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("unloaded automation data stays unknown instead of looking healthy or empty", async () => {
  const view = await loadViewModule();
  const automationOverview = view.automationOverview as
    | ((input: OverviewInput) => Record<string, { state: string; value: unknown }>)
    | undefined;

  assert.equal(typeof automationOverview, "function");
  assert.deepEqual(automationOverview!({}), {
    ai: { state: "loading", value: null, disabled: null },
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
    killSwitchError: true,
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

test("loaded empty data is the only state rendered as zero and healthy", async () => {
  const view = await loadViewModule();
  const automationOverview = view.automationOverview as
    | ((input: OverviewInput) => Record<string, { state: string; value: unknown }>)
    | undefined;

  assert.equal(typeof automationOverview, "function");
  assert.deepEqual(automationOverview!({
    applicants: [],
    killSwitch: { disabled: false, env_forced: false },
    inbox: [],
    activeJobs: [],
  }), {
    ai: { state: "ready", value: "작동 중", disabled: false },
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
    killSwitch: { disabled: true },
    inbox: [{}, {}, {}],
    activeJobs: [{ title: "현장 A" }, { title: "__system" }, { title: "현장 B" }],
  }), {
    ai: { state: "ready", value: "중단됨", disabled: true },
    screening: { state: "ready", value: 2 },
    confirmed: { state: "ready", value: 1 },
    waiting: { state: "ready", value: 1 },
    inbox: { state: "ready", value: 3 },
    activeJobs: { state: "ready", value: 2 },
  });
});
