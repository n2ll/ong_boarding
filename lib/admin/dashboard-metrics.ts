export type DashboardMetricsState = "loading" | "error" | "stale" | "ready";
export type DashboardMetricTone = "exploration" | "screening" | "onboarding" | "active";

export interface DashboardMetricTile {
  id: "today" | "screening" | "screeningComplete" | "confirmed";
  label: string;
  description: string;
  value: number;
  unit: "명";
  tone: DashboardMetricTone;
}

export function dashboardMetricsState(input: {
  hasSnapshot: boolean;
  hasError: boolean;
}): DashboardMetricsState {
  if (!input.hasSnapshot) return input.hasError ? "error" : "loading";
  return input.hasError ? "stale" : "ready";
}

export function dashboardMetricTiles(counts: {
  today: number;
  screening: number;
  screeningComplete: number;
  confirmed: number;
}): DashboardMetricTile[] {
  return [
    {
      id: "today",
      label: "오늘 신규 유입",
      description: "일괄 임포트 제외",
      value: counts.today,
      unit: "명",
      tone: "exploration",
    },
    {
      id: "screening",
      label: "현재 스크리닝 중",
      description: "AI가 요건 확인 중",
      value: counts.screening,
      unit: "명",
      tone: "screening",
    },
    {
      id: "screeningComplete",
      label: "스크리닝 완료",
      description: "매니저 확정 전 단계",
      value: counts.screeningComplete,
      unit: "명",
      tone: "onboarding",
    },
    {
      id: "confirmed",
      label: "확정 인력",
      description: "매니저가 확정한 인력",
      value: counts.confirmed,
      unit: "명",
      tone: "active",
    },
  ];
}
