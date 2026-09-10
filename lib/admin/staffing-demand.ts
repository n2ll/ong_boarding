export type StaffingDemand = { state: "unknown"; required_count: null } | { state: "off"; required_count: 0 } | { state: "operating"; required_count: number };
export type StaffingDemandEvent = {
  id: number;
  job_id: number;
  work_date: string;
  state: StaffingDemand["state"];
  required_count: number | null;
  base_event_id: number | null;
  request_key: string;
  actor: { account_id: string; name: string };
  created_at: string;
};

export function parseStaffingDemand(value: unknown): StaffingDemand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { state, required_count } = value as Record<string, unknown>;
  if (state === "unknown" && required_count === null) return { state, required_count };
  if (state === "off" && required_count === 0) return { state, required_count };
  if (state === "operating" && typeof required_count === "number" && Number.isSafeInteger(required_count)
    && required_count >= 1 && required_count <= 999) return { state, required_count };
  return null;
}

export function isStaffingDemandDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
