export type DashboardUrgency = "blocker" | "critical" | "attention";

export type DashboardPriorityItem = {
  urgency: DashboardUrgency;
  ageMinutes?: number | null;
  priorityLabel?: string;
};

const URGENCY_WEIGHT: Record<DashboardUrgency, number> = {
  blocker: 3,
  critical: 2,
  attention: 1,
};

export function isDashboardPrimaryPriority(
  sourceState: "loading" | "error" | "ready",
  index: number,
): boolean {
  return sourceState === "ready" && index === 0;
}

export function orderDashboardUrgentItems<T extends DashboardPriorityItem>(
  items: readonly T[],
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const urgency = URGENCY_WEIGHT[b.item.urgency] - URGENCY_WEIGHT[a.item.urgency];
      if (urgency !== 0) return urgency;

      const age = (b.item.ageMinutes ?? -1) - (a.item.ageMinutes ?? -1);
      return age !== 0 ? age : a.index - b.index;
    })
    .map(({ item }) => item);
}

export function dashboardQueuePreview<T>(
  items: readonly T[],
  limit = 5,
): { visible: T[]; remaining: number } {
  const safeLimit = Math.max(0, Math.floor(limit));
  return {
    visible: items.slice(0, safeLimit),
    remaining: Math.max(0, items.length - safeLimit),
  };
}

export function oldestUntouchedReplyDays(
  items: readonly {
    agent_stage?: string | null;
    last_message_at?: string | null;
    created_at?: string | null;
  }[],
  now: number,
): number | null {
  let oldest = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (item.agent_stage === "paused") continue;
    const timestamp = new Date(item.last_message_at ?? item.created_at ?? "").getTime();
    if (Number.isFinite(timestamp)) oldest = Math.min(oldest, timestamp);
  }
  return Number.isFinite(oldest)
    ? Math.max(0, Math.floor((now - oldest) / 86_400_000))
    : null;
}

export function dashboardUrgencyLabel(
  item: Pick<DashboardPriorityItem, "urgency" | "priorityLabel">,
): string {
  if (item.priorityLabel) return item.priorityLabel;
  if (item.urgency === "blocker") return "운영 차단";
  if (item.urgency === "critical") return "장기 지연";
  return "확인 필요";
}
