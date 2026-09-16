import { staffingToday } from "./staffing-preparation.ts";
import type { StaffingParticipationRecord, StaffingPreparation } from "./staffing-preparation.ts";

export type StaffingMissingResult = Pick<StaffingParticipationRecord, "kind" | "date">;

/** An elapsed plan requests manager review; it never implies participation or changes the plan. */
export function getStaffingMissingResults(preparation: StaffingPreparation, today = staffingToday()): StaffingMissingResult[] {
  const resolved = new Set([...preparation.records, ...(preparation.non_participations ?? [])].map((item) => `${item.kind}:${item.date}`));
  const missing: StaffingMissingResult[] = [];
  const training = preparation.training;
  const trainingDate = training.scheduled_at.slice(0, 10);
  if ((training.status === "scheduled" || training.status === "completed") && trainingDate && trainingDate < today
    && !resolved.has(`training:${trainingDate}`)) missing.push({ kind: "training", date: trainingDate });
  for (const day of preparation.dates) {
    if (day.confirmation === "confirmed" && day.date < today && !resolved.has(`backup:${day.date}`)) {
      missing.push({ kind: "backup", date: day.date });
    }
  }
  return missing.sort((a, b) => a.date.localeCompare(b.date) || Number(a.kind === "backup") - Number(b.kind === "backup"));
}
