import type { StaffingDateBoardData } from "./staffing-date-board.ts";

export type DashboardStaffingGapItem = {
  job_id: number;
  title: string;
  date: string;
  kind: "shortage" | "review";
  label: string;
  detail: string;
};

export function buildDashboardStaffingGaps(data: StaffingDateBoardData): {
  items: DashboardStaffingGapItem[];
  unknownCount: number;
  firstUnknownDate: string | null;
} {
  const items: DashboardStaffingGapItem[] = [];
  let unknownCount = 0;
  let firstUnknownDate: string | null = null;

  for (const job of data.jobs) for (const cell of job.cells) {
    if (cell.date < data.start || cell.date > data.end) continue;
    const target = cell.invalid_demand || cell.demand_state === "unknown" ? null : cell.target;
    if (target === null) {
      unknownCount += 1;
      if (firstUnknownDate === null || cell.date < firstUnknownDate) firstUnknownDate = cell.date;
    }

    const reasons: string[] = [];
    if (cell.invalid_demand) reasons.push("수요 기록 확인 필요");
    if (cell.invalid_records > 0) reasons.push(`최근 기록 ${cell.invalid_records}명 확인 불가`);
    if (cell.conflicts.length) {
      reasons.push(`같은 날 다른 라인에도 확정: ${cell.conflicts.map((other) => `${other.name} · ${other.other_job_title}`).join(" / ")}`);
    }
    if (target !== null && cell.confirmed > target) {
      reasons.push(cell.demand_state === "off" ? "운행 없는 날에 확정 인원 있음" : "필요 인원보다 확정 인원 많음");
    }

    const detail = `${target === null ? "필요 인원 미정" : `필요 ${target}명`} · ${cell.invalid_records ? "확인된 확정" : "확정"} ${cell.confirmed}명 · 예비 후보 ${cell.reserve}명`;
    const item = { job_id: job.job_id, title: job.title, date: cell.date };
    if (reasons.length) {
      items.push({ ...item, kind: "review", label: "기록 확인 필요", detail: `${detail} · ${reasons.join(" · ")}` });
    } else if (cell.demand_state === "operating" && target !== null && cell.shortage !== null && cell.shortage > 0) {
      items.push({ ...item, kind: "shortage", label: `${cell.shortage}명 부족`, detail });
    }
  }

  // Stable sorting preserves the board's job order for the same date.
  items.sort((a, b) => a.date.localeCompare(b.date));
  return { items, unknownCount, firstUnknownDate };
}
