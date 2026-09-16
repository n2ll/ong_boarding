import { isSystemJobTitle } from "../jobs.ts";
import { parseStaffingPreparation, participationKindLabels, STAFFING_PREPARATION_EVENT, staffingToday } from "./staffing-preparation.ts";
import { getStaffingMissingResults } from "./staffing-missing-results.ts";
import type { StaffingMissingResult } from "./staffing-missing-results.ts";

export type StaffingFollowUpItem = {
  job_id: number;
  job_title: string;
  applicant_id: number;
  candidate_id: number;
  name: string;
  owner: string;
  next_action: string;
  due_date: string;
  result_checks?: StaffingMissingResult[];
  /** Preserves the manager's own deadline when an older missing result sets the queue priority. */
  manual_due_date?: string;
};
export type StaffingFollowUpQueueData = { today: string; items: StaffingFollowUpItem[]; invalid_records: number };
export type StaffingFollowUpJob = { id: number; title: string };
export type StaffingFollowUpCandidate = {
  id: number; applicant_id: number; job_id: number;
  applicants: { name: string | null } | Array<{ name: string | null }> | null;
};
export type StaffingFollowUpEvent = {
  id: number; applicant_id: number; job_id: number; event_type: string; meta: unknown; created_at: string;
};

export function isStaffingFollowUpJob(job: StaffingFollowUpJob): boolean {
  return !isSystemJobTitle(job.title) && !/^\[검수(?:\s+\d+)?\]/.test(job.title)
    && !/^\[운영 검증\].*E2E\s+테스트/.test(job.title);
}

/** Manager tasks remain pending until explicitly completed, even after recruitment or consultation closes. */
export function buildStaffingFollowUps(input: {
  jobs: StaffingFollowUpJob[]; candidates: StaffingFollowUpCandidate[]; events: StaffingFollowUpEvent[];
}): StaffingFollowUpQueueData {
  const jobs = new Map(input.jobs.filter(isStaffingFollowUpJob).map((job) => [job.id, job]));
  const candidates = new Map(input.candidates.filter((candidate) => jobs.has(candidate.job_id))
    .map((candidate) => [`${candidate.applicant_id}:${candidate.job_id}`, candidate]));
  const latest = new Map<string, StaffingFollowUpEvent>();
  for (const event of input.events) {
    if (event.event_type !== STAFFING_PREPARATION_EVENT) continue;
    const key = `${event.applicant_id}:${event.job_id}`;
    if (!candidates.has(key)) continue;
    const previous = latest.get(key);
    if (!previous || event.created_at > previous.created_at || (event.created_at === previous.created_at && event.id > previous.id)) {
      latest.set(key, event);
    }
  }
  const items: StaffingFollowUpItem[] = [];
  const today = staffingToday();
  let invalid_records = 0;
  for (const [key, event] of latest) {
    // Choose the latest whole snapshot before checking status: cleared or broken records must not revive old work.
    const preparation = parseStaffingPreparation(event.meta);
    if (!preparation) { invalid_records += 1; continue; }
    const followUp = preparation.follow_up;
    const manual = followUp?.status === "open" && followUp.next_action ? followUp : null;
    const resultChecks = getStaffingMissingResults(preparation, today);
    if (!manual && !resultChecks.length) continue;
    const dueDate = [manual?.due_date, resultChecks[0]?.date].filter((date): date is string => Boolean(date)).sort()[0] ?? "";
    const candidate = candidates.get(key)!;
    const applicant = Array.isArray(candidate.applicants) ? candidate.applicants[0] : candidate.applicants;
    items.push({ job_id: event.job_id, job_title: jobs.get(event.job_id)!.title, applicant_id: event.applicant_id,
      candidate_id: candidate.id, name: applicant?.name || "이름 미등록", owner: followUp?.owner ?? "",
      next_action: manual?.next_action ?? `${[...new Set(resultChecks.map((item) => participationKindLabels[item.kind]))].join("·")} 결과 확인`,
      due_date: dueDate, ...(resultChecks.length ? { result_checks: resultChecks, ...(manual ? { manual_due_date: manual.due_date } : {}) } : {}) });
  }
  items.sort((a, b) => Number(!a.due_date) - Number(!b.due_date) || a.due_date.localeCompare(b.due_date)
    || a.job_id - b.job_id || a.applicant_id - b.applicant_id);
  return { today, items, invalid_records };
}
