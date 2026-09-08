export type PoolPreferences = { kind: "regular" | "backup" | "both"; area: string; schedule: string; vehicle: string; notice: string };
export const POOL_PREFERENCE_LABELS = { regular: "정기 배송", backup: "휴무·결원 백업", both: "둘 다" } as const;

export function parsePoolPreferences(value: unknown): PoolPreferences | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.kind !== "regular" && data.kind !== "backup" && data.kind !== "both") return null;
  for (const field of ["area", "schedule", "vehicle", "notice"]) {
    if (typeof data[field] !== "string" || (data[field] as string).length > 240) return null;
    if (field !== "notice" && !(data[field] as string).trim()) return null;
  }
  return { kind: data.kind, area: (data.area as string).trim(), schedule: (data.schedule as string).trim(), vehicle: (data.vehicle as string).trim(), notice: (data.notice as string).trim() };
}
