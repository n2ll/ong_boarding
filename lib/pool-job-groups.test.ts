import assert from "node:assert/strict";
import test from "node:test";

type Job = {
  id: number;
  expired: boolean;
  fit: "ok" | "warn" | "unknown";
  status: "none" | "interested" | "talking" | "paused" | "ended";
};

async function loadPoolJobGroupsModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./pool-job-groups.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("only untouched mismatched jobs are folded without changing server order", async () => {
  const poolJobGroupsModule = await loadPoolJobGroupsModule();
  const poolJobGroups = poolJobGroupsModule.poolJobGroups as
    | ((jobs: Job[]) => {
      activeCount: number;
      main: Job[];
      others: Job[];
      expired: Job[];
      forceShowOthers: boolean;
    })
    | undefined;
  const jobs: Job[] = [
    { id: 1, expired: false, fit: "ok", status: "none" },
    { id: 2, expired: false, fit: "warn", status: "none" },
    { id: 3, expired: false, fit: "warn", status: "interested" },
    { id: 4, expired: true, fit: "ok", status: "none" },
    { id: 5, expired: false, fit: "unknown", status: "talking" },
    { id: 6, expired: false, fit: "warn", status: "ended" },
  ];

  assert.equal(typeof poolJobGroups, "function");
  const result = poolJobGroups!(jobs);
  assert.equal(result.activeCount, 5);
  assert.deepEqual(result.main.map((job) => job.id), [1, 3, 5, 6]);
  assert.deepEqual(result.others.map((job) => job.id), [2]);
  assert.deepEqual(result.expired.map((job) => job.id), [4]);
  assert.equal(result.forceShowOthers, false);
});

test("mismatched jobs are shown automatically when every open job would be folded", async () => {
  const poolJobGroupsModule = await loadPoolJobGroupsModule();
  const poolJobGroups = poolJobGroupsModule.poolJobGroups as
    | ((jobs: Job[]) => { main: Job[]; others: Job[]; forceShowOthers: boolean })
    | undefined;
  const jobs: Job[] = [
    { id: 10, expired: false, fit: "warn", status: "none" },
    { id: 11, expired: false, fit: "warn", status: "none" },
  ];

  assert.equal(typeof poolJobGroups, "function");
  const result = poolJobGroups!(jobs);
  assert.deepEqual(result.main, []);
  assert.deepEqual(result.others.map((job) => job.id), [10, 11]);
  assert.equal(result.forceShowOthers, true);
});

test("an expired-only list does not force open the mismatched section", async () => {
  const poolJobGroupsModule = await loadPoolJobGroupsModule();
  const poolJobGroups = poolJobGroupsModule.poolJobGroups as
    | ((jobs: Job[]) => { activeCount: number; forceShowOthers: boolean })
    | undefined;

  assert.equal(typeof poolJobGroups, "function");
  assert.deepEqual(
    poolJobGroups!([{ id: 20, expired: true, fit: "warn", status: "none" }]),
    {
      activeCount: 0,
      main: [],
      others: [],
      expired: [{ id: 20, expired: true, fit: "warn", status: "none" }],
      forceShowOthers: false,
    },
  );
});
