import assert from "node:assert/strict";
import test from "node:test";

type DashboardMetricTone = "exploration" | "screening" | "onboarding" | "active";

interface DashboardMetricTile {
  id: string;
  label: string;
  description: string;
  value: number;
  unit: "명";
  tone: DashboardMetricTone;
}

type DashboardMetricsModule = {
  dashboardMetricsState?: (input: { hasSnapshot: boolean; hasError: boolean }) =>
    "loading" | "error" | "stale" | "ready";
  dashboardMetricTiles?: (counts: {
    today: number;
    screening: number;
    screeningComplete: number;
    confirmed: number;
  }) => DashboardMetricTile[];
};

async function loadModule(): Promise<DashboardMetricsModule> {
  try {
    return await import(new URL("./dashboard-metrics.ts", import.meta.url).href) as DashboardMetricsModule;
  } catch {
    return {};
  }
}

test("metric state distinguishes loading, failed, stale, and current snapshots", async () => {
  const { dashboardMetricsState } = await loadModule();

  assert.equal(typeof dashboardMetricsState, "function");
  assert.equal(dashboardMetricsState!({ hasSnapshot: false, hasError: false }), "loading");
  assert.equal(dashboardMetricsState!({ hasSnapshot: false, hasError: true }), "error");
  assert.equal(dashboardMetricsState!({ hasSnapshot: true, hasError: true }), "stale");
  assert.equal(dashboardMetricsState!({ hasSnapshot: true, hasError: false }), "ready");
});

test("metric tiles follow the hiring flow without implying manager confirmation", async () => {
  const { dashboardMetricTiles } = await loadModule();

  assert.equal(typeof dashboardMetricTiles, "function");
  assert.deepEqual(
    dashboardMetricTiles!({ today: 3, screening: 7, screeningComplete: 2, confirmed: 5 }),
    [
      {
        id: "today",
        label: "오늘 신규 유입",
        description: "일괄 임포트 제외",
        value: 3,
        unit: "명",
        tone: "exploration",
      },
      {
        id: "screening",
        label: "현재 스크리닝 중",
        description: "AI가 요건 확인 중",
        value: 7,
        unit: "명",
        tone: "screening",
      },
      {
        id: "screeningComplete",
        label: "스크리닝 완료",
        description: "매니저 확정 전 단계",
        value: 2,
        unit: "명",
        tone: "onboarding",
      },
      {
        id: "confirmed",
        label: "확정 인력",
        description: "매니저가 확정한 인력",
        value: 5,
        unit: "명",
        tone: "active",
      },
    ],
  );
});
