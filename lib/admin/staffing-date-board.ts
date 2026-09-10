import { isGeneralLineJob, joinedClientType } from "../agent/general-line.ts";
import { isJobEffectivelyClosed } from "../jobs.ts";
import { parseStaffingPreparation, STAFFING_PREPARATION_EVENT } from "./staffing-preparation.ts";

export type StaffingDateBoardCell = {
  date: string;
  target: number | null;
  confirmed: number;
  reserve: number;
  primary: number;
  shortage: number | null;
  conflicts: Array<{ applicant_id: number; name: string; other_job_id: number; other_job_title: string }>;
  invalid_records: number;
};
export type StaffingDateBoardData = {
  start: string;
  end: string;
  jobs: Array<{ job_id: number; title: string; slot: string | null; start_date: string | null; capacity: number | null; cells: StaffingDateBoardCell[] }>;
  updated_at: string;
};
export type StaffingDateBoardJob = {
  id: number; title: string; slot: string | null; start_date: string | null; capacity: number | null;
  status: string | null; closes_at: string | null; client: unknown;
};
export type StaffingDateBoardCandidate = {
  id: number; applicant_id: number; job_id: number; agent_stage: string | null;
  applicants: { name: string | null } | Array<{ name: string | null }> | null;
};
export type StaffingDateBoardEvent = {
  id: number; applicant_id: number; job_id: number; event_type: string; meta: unknown; created_at: string;
};

/** A comparison window, not an assertion that a line operates on every date. */
export function staffingDateBoardDates(start: unknown, end: unknown): string[] | null {
  const valid = (value: unknown): value is string => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const at = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
  };
  if (!valid(start) || !valid(end)) return null;
  const first = Date.parse(`${start}T00:00:00.000Z`);
  const length = (Date.parse(`${end}T00:00:00.000Z`) - first) / 86_400_000 + 1;
  if (length < 1 || length > 7) return null;
  return Array.from({ length }, (_, index) => new Date(first + index * 86_400_000).toISOString().slice(0, 10));
}

export function isStaffingDateBoardJob(job: StaffingDateBoardJob): boolean {
  // Match the explicit review markers used by handoff-disposition; ordinary "테스트" words remain visible.
  if (/^\[검수(?:\s+\d+)?\]/.test(job.title) || /^\[운영 검증\].*E2E\s+테스트/.test(job.title)) return false;
  return !isJobEffectivelyClosed(job.status, job.closes_at)
    && isGeneralLineJob({ title: job.title, client_type: joinedClientType(job.client) });
}

export function buildStaffingDateBoard(input: {
  start: string; end: string; jobs: StaffingDateBoardJob[]; candidates: StaffingDateBoardCandidate[];
  events: StaffingDateBoardEvent[]; updated_at: string;
}): StaffingDateBoardData {
  const dates = staffingDateBoardDates(input.start, input.end);
  if (!dates) throw new Error("비교 기간은 올바른 날짜로 1~7일을 선택해주세요.");
  const jobs = input.jobs.filter(isStaffingDateBoardJob);
  const jobIds = new Set(jobs.map((job) => job.id));
  const candidates = new Map<string, StaffingDateBoardCandidate>();
  for (const candidate of input.candidates) {
    if (jobIds.has(candidate.job_id) && candidate.agent_stage !== "abort") candidates.set(`${candidate.applicant_id}:${candidate.job_id}`, candidate);
  }
  const latest = new Map<string, StaffingDateBoardEvent>();
  for (const event of input.events) {
    if (event.event_type !== STAFFING_PREPARATION_EVENT) continue;
    const key = `${event.applicant_id}:${event.job_id}`;
    if (!candidates.has(key)) continue;
    const previous = latest.get(key);
    if (!previous || event.created_at > previous.created_at || (event.created_at === previous.created_at && event.id > previous.id)) latest.set(key, event);
  }
  const boardJobs = jobs.map((job) => {
    const capacity = Number.isSafeInteger(job.capacity) && Number(job.capacity) > 0 ? job.capacity : null;
    return { job_id: job.id, title: job.title, slot: job.slot, start_date: job.start_date, capacity,
      cells: dates.map((date): StaffingDateBoardCell => ({ date, target: capacity, confirmed: 0, reserve: 0, primary: 0,
        shortage: capacity, conflicts: [], invalid_records: 0 })) };
  });
  const cells = new Map(boardJobs.flatMap((job) => job.cells.map((cell) => [`${job.job_id}:${cell.date}`, cell] as const)));
  const confirmedDates = new Map<string, Array<{ job_id: number; name: string }>>();
  for (const [key, event] of latest) {
    const preparation = parseStaffingPreparation(event.meta);
    if (!preparation) {
      for (const date of dates) cells.get(`${event.job_id}:${date}`)!.invalid_records += 1;
      continue;
    }
    const candidate = candidates.get(key)!;
    const relation = Array.isArray(candidate.applicants) ? candidate.applicants[0] : candidate.applicants;
    for (const day of preparation.dates) {
      const cell = cells.get(`${event.job_id}:${day.date}`);
      if (!cell || day.availability !== "available") continue;
      if (day.role === "reserve_candidate") cell.reserve += 1;
      if (day.role === "primary_candidate") cell.primary += 1;
      if (day.confirmation !== "confirmed") continue;
      cell.confirmed += 1;
      const dateKey = `${event.applicant_id}:${day.date}`;
      const entries = confirmedDates.get(dateKey) ?? [];
      entries.push({ job_id: event.job_id, name: relation?.name ?? "이름 미등록" });
      confirmedDates.set(dateKey, entries);
    }
  }
  const titles = new Map(jobs.map((job) => [job.id, job.title]));
  for (const [key, entries] of confirmedDates) {
    if (entries.length < 2) continue;
    const separator = key.indexOf(":");
    const applicant_id = Number(key.slice(0, separator));
    const date = key.slice(separator + 1);
    for (const entry of entries) {
      const cell = cells.get(`${entry.job_id}:${date}`)!;
      for (const other of entries) if (other.job_id !== entry.job_id) {
        cell.conflicts.push({ applicant_id, name: entry.name, other_job_id: other.job_id, other_job_title: titles.get(other.job_id)! });
      }
    }
  }
  for (const job of boardJobs) for (const cell of job.cells) {
    cell.shortage = cell.target === null ? null : Math.max(0, cell.target - cell.confirmed);
  }
  return { start: input.start, end: input.end, jobs: boardJobs, updated_at: input.updated_at };
}
