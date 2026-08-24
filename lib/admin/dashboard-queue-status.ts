import type { RemoteSourcesState } from "@/lib/admin/remote-data-state";

export type DashboardQueueStatus = {
  tone: "success" | "warning" | "error";
  label: string;
};

export function dashboardQueueStatus(state: RemoteSourcesState): DashboardQueueStatus {
  if (state.state === "error") {
    return { tone: "error", label: "일부 업무 큐 확인 불가" };
  }
  if (state.state === "loading") {
    return { tone: "warning", label: "업무 큐 확인 중…" };
  }
  return { tone: "success", label: "업무 큐 확인 완료" };
}
