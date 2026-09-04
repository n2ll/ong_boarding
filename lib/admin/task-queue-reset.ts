export function parseTaskQueueResetAt(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

export function hasTaskQueueActivityAfterReset(
  resetAt: string | null | undefined,
  ...activityAt: Array<string | null | undefined>
): boolean {
  const parsedResetAt = parseTaskQueueResetAt(resetAt);
  if (!parsedResetAt) return true;
  const resetTime = new Date(parsedResetAt).getTime();
  return activityAt.some((value) => {
    const activityTime = typeof value === "string" ? new Date(value).getTime() : Number.NaN;
    return Number.isFinite(activityTime) && activityTime > resetTime;
  });
}
