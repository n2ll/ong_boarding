import { staffingDateBoardDates, type StaffingDateBoardData } from "./staffing-date-board.ts";
import { parseStaffingDemand, type StaffingDemandEvent } from "./staffing-demand.ts";

type BatchTarget = { jobId: number; title: string; date: string };
export type StaffingDemandBatchItem = BatchTarget & {
  body: Readonly<{ date: string; state: "operating" | "off"; required_count: number;
    base_event_id: null; action_key: string; actor_name: string }>;
  status: "pending" | "saved" | "conflict" | "failed";
  error?: string;
};
export type StaffingDemandBatchSkipped = BatchTarget & { reason: "existing" | "invalid" };
export type StaffingDemandBatchWarning = BatchTarget & { message: string };

export function createStaffingDemandBatch(input: {
  data: StaffingDateBoardData; jobIds: number[]; dates: string[];
  state: "operating" | "off"; requiredCount: number; actorName: string;
}, keyFactory: () => string = () => crypto.randomUUID()): {
  items: StaffingDemandBatchItem[]; skipped: StaffingDemandBatchSkipped[]; warnings: StaffingDemandBatchWarning[];
} {
  const actorName = input.actorName.trim();
  const demand = parseStaffingDemand({ state: input.state, required_count: input.state === "off" ? 0 : input.requiredCount });
  const displayedDates = staffingDateBoardDates(input.data.start, input.data.end);
  const jobIds = [...new Set(input.jobIds)], dates = [...new Set(input.dates)];
  if (!actorName || actorName.length > 80 || !demand || demand.state === "unknown") {
    throw new Error("작성자 이름과 필요 인원(1~999명)을 확인해주세요.");
  }
  if (!displayedDates || !jobIds.length || !dates.length
    || jobIds.some(id => !Number.isSafeInteger(id) || id <= 0 || !input.data.jobs.some(job => job.job_id === id))
    || dates.some(date => !displayedDates.includes(date))) {
    throw new Error("현재 충원판에서 공고와 날짜를 선택해주세요. 한 번에 최대 7일을 입력할 수 있습니다.");
  }
  const items: StaffingDemandBatchItem[] = [], skipped: StaffingDemandBatchSkipped[] = [], warnings: StaffingDemandBatchWarning[] = [];
  for (const job of input.data.jobs.filter(job => jobIds.includes(job.job_id))) {
    for (const date of dates) {
      const target = { jobId: job.job_id, title: job.title, date };
      const cell = job.cells.find(cell => cell.date === date);
      if (!cell || cell.invalid_demand !== false) {
        warnings.push({ ...target, message: "수요 기록 확인 필요" });
        skipped.push({ ...target, reason: "invalid" }); continue;
      }
      if (typeof cell.demand_event_id === "number" && cell.demand_event_id > 0) {
        skipped.push({ ...target, reason: "existing" }); continue;
      }
      if (cell.demand_event_id !== null || cell.demand_state !== "unknown" || cell.target !== null) {
        warnings.push({ ...target, message: "수요 기록 확인 필요" });
        skipped.push({ ...target, reason: "invalid" }); continue;
      }
      const messages: string[] = [];
      if (cell.confirmed > demand.required_count) messages.push(`현재 확정 ${cell.confirmed}명이 입력할 필요 인원 ${demand.required_count}명보다 많습니다.`);
      if (cell.invalid_records > 0 || cell.conflicts.length > 0) messages.push("확인할 후보 기록이나 다른 공고와 겹친 일정이 있습니다.");
      if (messages.length) warnings.push({ ...target, message: messages.join(" ") });
      items.push({ ...target, status: "pending", body: Object.freeze({ date, ...demand,
        base_event_id: null, action_key: keyFactory(), actor_name: actorName }) });
    }
  }
  return { items, skipped, warnings };
}

export async function runStaffingDemandBatch(items: readonly StaffingDemandBatchItem[], options: {
  send?: (item: StaffingDemandBatchItem) => Promise<Pick<Response, "ok" | "status" | "json">>;
  onResult?: (item: StaffingDemandBatchItem) => void;
} = {}): Promise<StaffingDemandBatchItem[]> {
  const send = options.send ?? ((item: StaffingDemandBatchItem) => fetch(`/api/admin/jobs/${item.jobId}/staffing-demand`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.body),
  }));
  const results = items.map(item => ({ ...item }));
  let next = 0;
  const worker = async () => {
    while (next < results.length) {
      const index = next++, item = results[index];
      if (item.status !== "pending" && item.status !== "failed") continue;
      let updated: StaffingDemandBatchItem;
      try {
        const response = await send(item);
        const payload = await response.json().catch(() => null) as { error?: unknown; event?: StaffingDemandEvent } | null;
        if (!response.ok) {
          updated = { ...item, status: response.status === 409 ? "conflict" : "failed",
            error: typeof payload?.error === "string" ? payload.error : "수요를 저장하지 못했어요. 다시 시도해주세요." };
        } else {
          const event = payload?.event;
          if (!event || !Number.isSafeInteger(event.id) || event.id <= 0 || event.job_id !== item.jobId || event.work_date !== item.date
            || event.request_key !== item.body.action_key || event.base_event_id !== null
            || event.state !== item.body.state || event.required_count !== item.body.required_count) {
            throw new Error("저장 결과를 확인하지 못했어요. 같은 요청으로 다시 시도해주세요.");
          }
          updated = { ...item, status: "saved", error: undefined };
        }
      } catch (error) {
        updated = { ...item, status: "failed", error: error instanceof Error ? error.message : "수요를 저장하지 못했어요. 다시 시도해주세요." };
      }
      results[index] = updated;
      options.onResult?.(updated);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, results.length) }, () => worker()));
  return results;
}
