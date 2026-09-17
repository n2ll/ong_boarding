import { parseStaffingPreparation, type StaffingPreparationSnapshot } from "./staffing-preparation.ts";

export type StaffingRecordMode = "follow_up" | "training" | "participation";
export type StaffingRecordEntry = { jobId: number; applicantId: number; mode: StaffingRecordMode };

export function parseStaffingRecordEntry(params: Pick<URLSearchParams, "get">): StaffingRecordEntry | null {
  const job = params.get("record_job");
  const applicant = params.get("record_applicant");
  const mode = params.get("record_mode") ?? "follow_up";
  const validId = (value: string | null) => !!value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  if (!validId(job) || !validId(applicant) || !["follow_up", "training", "participation"].includes(mode)) return null;
  return { jobId: Number(job), applicantId: Number(applicant), mode: mode as StaffingRecordMode };
}

export function canOpenStaffingRecord(snapshot: StaffingPreparationSnapshot | undefined, allowEmpty: boolean): boolean {
  if (!snapshot || snapshot.invalid) return false;
  if (snapshot.event_id === null) return allowEmpty && snapshot.preparation === null;
  return Number.isSafeInteger(snapshot.event_id) && snapshot.event_id > 0 && !!parseStaffingPreparation(snapshot.preparation);
}
