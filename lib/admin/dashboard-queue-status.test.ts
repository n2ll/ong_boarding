import assert from "node:assert/strict";
import test from "node:test";

type DashboardQueueStatusModule = {
  dashboardQueueStatus?: (state:
    | { state: "loading"; pending: string[] }
    | { state: "error"; failed: string[] }
    | { state: "ready" }
  ) => { tone: "success" | "warning" | "error"; label: string };
};

async function loadModule(): Promise<DashboardQueueStatusModule> {
  try {
    return await import(new URL("./dashboard-queue-status.ts", import.meta.url).href) as DashboardQueueStatusModule;
  } catch {
    return {};
  }
}

test("the dashboard header reports the combined work-queue loading state", async () => {
  const { dashboardQueueStatus } = await loadModule();

  assert.equal(typeof dashboardQueueStatus, "function");
  assert.deepEqual(dashboardQueueStatus!({ state: "loading", pending: ["replies"] }), {
    tone: "warning",
    label: "업무 큐 확인 중…",
  });
});

test("any failed work queue prevents a healthy dashboard claim", async () => {
  const { dashboardQueueStatus } = await loadModule();

  assert.equal(typeof dashboardQueueStatus, "function");
  assert.deepEqual(dashboardQueueStatus!({ state: "error", failed: ["sos"] }), {
    tone: "error",
    label: "일부 업무 큐 확인 불가",
  });
});

test("only a fully ready work queue reports completion", async () => {
  const { dashboardQueueStatus } = await loadModule();

  assert.equal(typeof dashboardQueueStatus, "function");
  assert.deepEqual(dashboardQueueStatus!({ state: "ready" }), {
    tone: "success",
    label: "업무 큐 확인 완료",
  });
});
