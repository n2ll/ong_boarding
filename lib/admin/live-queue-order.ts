export type LiveQueuePriority = "unanswered" | "draft" | "awaiting" | "rest";

const PRIORITY_RANK: Record<LiveQueuePriority, number> = {
  unanswered: 3,
  draft: 2,
  awaiting: 1,
  rest: 0,
};

function activityTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Keeps the operations priority contract, then surfaces actionable waits oldest-first.
 * Passive history stays recent-first. Unknown dates follow known dates and keep source order.
 */
export function orderLiveQueueItems<T>(
  items: readonly T[],
  priorityOf: (item: T) => LiveQueuePriority,
  activityAt: (item: T) => string | null | undefined,
): T[] {
  return items
    .map((item, index) => ({
      item,
      index,
      priority: priorityOf(item),
      timestamp: activityTimestamp(activityAt(item)),
    }))
    .sort((a, b) => {
      const priorityDifference = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
      if (priorityDifference !== 0) return priorityDifference;

      if (a.timestamp === null && b.timestamp !== null) return 1;
      if (a.timestamp !== null && b.timestamp === null) return -1;
      if (a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp) {
        return a.priority === "rest"
          ? b.timestamp - a.timestamp
          : a.timestamp - b.timestamp;
      }

      return a.index - b.index;
    })
    .map(({ item }) => item);
}
