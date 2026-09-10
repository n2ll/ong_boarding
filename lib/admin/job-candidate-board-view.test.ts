import assert from "node:assert/strict";
import test from "node:test";

type Candidate = { id: number; agent_stage: string | null; paused_reason?: string; agent_state?: unknown };
type BoardView = {
  linkedCount: number;
  interestCount: number | null;
  groups: Array<{ stage: string; items: Candidate[] }>;
};
type BoardModule = {
  jobCandidateBoardView?: (candidates: Candidate[], interestCount?: number | null, jobTitle?: string) => BoardView;
};

async function loadView(): Promise<BoardModule> {
  try {
    return await import(new URL("./job-candidate-board-view.ts", import.meta.url).href) as BoardModule;
  } catch {
    return {};
  }
}

test("prelinking 50 initialized candidates does not invent interest clicks", async () => {
  const { jobCandidateBoardView } = await loadView();
  assert.equal(typeof jobCandidateBoardView, "function");
  const candidates = Array.from({ length: 50 }, (_, id) => ({ id, agent_stage: "exploration" }));
  const view = jobCandidateBoardView!(candidates, 3);

  assert.equal(view.linkedCount, 50);
  assert.equal(view.interestCount, 3);
  assert.deepEqual(view.groups.map(({ stage, items }) => ({ stage, count: items.length })), [
    { stage: "exploration", count: 50 },
  ]);
});

test("a missing stage is unstarted and contributes no interest evidence", async () => {
  const { jobCandidateBoardView } = await loadView();
  assert.equal(typeof jobCandidateBoardView, "function");
  const view = jobCandidateBoardView!([
    { id: 5, agent_stage: "screening" },
    { id: 4, agent_stage: null },
    { id: 3, agent_stage: "exploration" },
    { id: 2, agent_stage: null },
    { id: 1, agent_stage: "abort" },
  ], 0);

  assert.equal(view.interestCount, 0);
  assert.deepEqual(view.groups.map(({ stage, items }) => ({ stage, ids: items.map(({ id }) => id) })), [
    { stage: "unstarted", ids: [4, 2] },
    { stage: "exploration", ids: [3] },
    { stage: "screening", ids: [5] },
    { stage: "abort", ids: [1] },
  ]);
});

test("unavailable interest counts stay unknown while verified zero remains zero", async () => {
  const { jobCandidateBoardView } = await loadView();
  assert.equal(typeof jobCandidateBoardView, "function");
  const candidates = [{ id: 1, agent_stage: "active" }];

  assert.equal(jobCandidateBoardView!(candidates).interestCount, null);
  assert.equal(jobCandidateBoardView!(candidates, null).interestCount, null);
  assert.equal(jobCandidateBoardView!(candidates, 0).interestCount, 0);
});

test("completed and intentional pauses remain on the board without appearing as unresolved handoffs", async () => {
  const { jobCandidateBoardView } = await loadView();
  const candidates = [
    { id: 1, agent_stage: "paused", agent_state: { meta: { handoff_resolved: { at: "2026-01-02T00:00:00Z" } } } },
    { id: 2, agent_stage: "paused", paused_reason: "매니저 수동 일시정지" },
    { id: 3, agent_stage: "paused", agent_state: { meta: { paused_at: "2026-01-03T00:00:00Z", handoff_resolved: { at: "2026-01-02T00:00:00Z" } } } },
    { id: 4, agent_stage: "paused", agent_state: { meta: { handoff_resolved: { at: "invalid" } } } },
    { id: 5, agent_stage: "screening", agent_state: { meta: { handoff_resolved: { at: "2026-01-02T00:00:00Z" } } } },
  ];
  const before = JSON.stringify(candidates);
  const view = jobCandidateBoardView!(candidates, 0, "가상 배송");
  assert.equal(view.linkedCount, 5);
  assert.deepEqual(view.groups.map(({ stage, items }) => ({ stage, ids: items.map(({ id }) => id) })), [
    { stage: "screening", ids: [5] }, { stage: "paused", ids: [3, 4] },
    { stage: "paused_held", ids: [2] }, { stage: "paused_resolved", ids: [1] },
  ]);
  assert.equal(JSON.stringify(candidates), before);
});

test("review job pauses use the same title-aware disposition as the live handoff queue", async () => {
  const { jobCandidateBoardView } = await loadView();
  const candidates = [{ id: 1, agent_stage: "paused", paused_reason: "문의 확인 필요" }];
  assert.equal(jobCandidateBoardView!(candidates, 0, "[검수] 가상 배송").groups[0].stage, "paused_held");
  assert.equal(jobCandidateBoardView!(candidates, 0, "일반 테스트 배송").groups[0].stage, "paused");
});
