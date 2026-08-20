const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function usageWindowKst(now: Date, days: number): { start: string; end: string } {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("Usage window days must be a positive integer.");
  }
  const end = new Date(now.getTime() + KST_OFFSET_MS);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}
