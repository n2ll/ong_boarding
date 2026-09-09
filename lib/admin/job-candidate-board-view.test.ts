import assert from "node:assert/strict";
import test from "node:test";

type Candidate = { id: number; agent_stage: string | null };
type BoardView = {
  linkedCount: number;
  interestCount: number | null;
  groups: Array<{ stage: string; items: Candidate[] }>;
};
type BoardModule = {
  jobCandidateBoardView?: (candidates: Candidate[], interestCount?: number | null) => BoardView;
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
