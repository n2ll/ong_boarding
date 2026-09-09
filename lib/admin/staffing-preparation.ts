export const STAFFING_PREPARATION_EVENT = "staffing_preparation";
export const STAFFING_PREPARATION_LIMITS = { dates: 31, training: 240, note: 1000 } as const;

export type StaffingPreparationDate = {
  date: string;
  availability: "available" | "unavailable" | "unknown";
  role: "primary_candidate" | "reserve_candidate" | "unassigned";
};
/** Manager review only; this never represents a confirmed assignment. */
export type StaffingPreparation = {
  source: "manager";
  dates: StaffingPreparationDate[];
  training_availability: string;
  note: string;
};
export type StaffingPreparationSnapshot = {
  applicant_id: number;
  preparation: StaffingPreparation | null;
  event_id: number | null;
  updated_at: string | null;
  invalid: boolean;
};

export function parseStaffingPreparation(value: unknown): StaffingPreparation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.source !== "manager" || !Array.isArray(data.dates) || data.dates.length > STAFFING_PREPARATION_LIMITS.dates
    || typeof data.training_availability !== "string" || data.training_availability.length > STAFFING_PREPARATION_LIMITS.training
    || typeof data.note !== "string" || data.note.length > STAFFING_PREPARATION_LIMITS.note) return null;
  const dates: StaffingPreparationDate[] = [];
  const seen = new Set<string>();
  for (const item of data.dates) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { date, availability, role } = item as Record<string, unknown>;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(date)) return null;
    const timestamp = Date.parse(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) return null;
    if (availability !== "available" && availability !== "unavailable" && availability !== "unknown") return null;
    if (role !== "primary_candidate" && role !== "reserve_candidate" && role !== "unassigned") return null;
    if (role !== "unassigned" && availability !== "available") return null;
    dates.push({ date, availability, role });
    seen.add(date);
  }
  dates.sort((a, b) => a.date.localeCompare(b.date));
  return { source: "manager", dates, training_availability: data.training_availability.trim(), note: data.note.trim() };
}
