"use client";

import { useState } from "react";
import { ArrowRight, CalendarClock, Loader2 } from "lucide-react";
import { participationKindLabels } from "@/lib/admin/staffing-preparation";
import type { StaffingFollowUpItem, StaffingFollowUpQueueData } from "@/lib/admin/staffing-follow-ups";
import { Button } from "./ui/button";

export function StaffingFollowUpQueue({
  data,
  error,
  onRetry,
  onOpen,
}: {
  data?: StaffingFollowUpQueueData;
  error?: unknown;
  onRetry: () => void;
  onOpen: (item: StaffingFollowUpItem) => void;
}) {
  const [filter, setFilter] = useState<"due" | "all">("due");
  const [visibleCount, setVisibleCount] = useState(5);
  const dueItems = data?.items.filter((item) => item.due_date && item.due_date <= data.today) ?? [];
  const items = filter === "due" ? dueItems : data?.items ?? [];
  const remaining = Math.max(0, items.length - visibleCount);
  const incomplete = Boolean(error) || (data?.invalid_records ?? 0) > 0;

  return (
    <section id="staffing-followups" aria-labelledby="staffing-followups-title" className="min-w-0 rounded-2xl border border-border-strong bg-card p-4 sm:p-5">
      <div className="flex items-start gap-2.5">
        <CalendarClock aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h2 id="staffing-followups-title" className="text-base font-bold text-foreground">오늘 후속 연락·결과 확인</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">연락할 일과 지난 일정의 미기록 결과{data ? ` · ${data.today}` : ""}</p>
        </div>
      </div>

      {!data ? (
        error ? (
          <div role="alert" className="mt-4 rounded-xl border border-error/30 bg-error-soft p-3 text-sm text-error-strong">
            <p>후속 연락·결과 확인 목록을 불러오지 못했어요.</p>
            <Button type="button" size="sm" onClick={onRetry} className="mt-2">다시 시도</Button>
          </div>
        ) : (
          <p role="status" className="mt-4 flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" size={16} className="animate-spin motion-reduce:animate-none" />
            후속 연락·결과를 불러오는 중…
          </p>
        )
      ) : (
        <>
          {error ? (
            <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm text-warning-strong">
              <p className="min-w-0 flex-1">새로 불러오지 못해 이전 조회 결과를 표시하고 있어요.</p>
              <Button type="button" size="sm" onClick={onRetry}>다시 시도</Button>
            </div>
          ) : null}
          {data.invalid_records > 0 ? (
            <p role="status" className="mt-3 rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm text-warning-strong">
              진행 기록 {data.invalid_records}건을 확인하지 못했어요. 확인된 항목만 표시합니다.
            </p>
          ) : null}

          <div role="group" aria-label="후속 연락 예정일 필터" className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={filter === "due" ? "primary" : "secondary"}
              aria-pressed={filter === "due"}
              onClick={() => { setFilter("due"); setVisibleCount(5); }}
            >
              오늘·기한 지남 {incomplete ? "확인된 " : ""}{dueItems.length}건
            </Button>
            <Button
              type="button"
              size="sm"
              variant={filter === "all" ? "primary" : "secondary"}
              aria-pressed={filter === "all"}
              onClick={() => { setFilter("all"); setVisibleCount(5); }}
            >
              전체 할 일 {incomplete ? "확인된 " : ""}{data.items.length}건
            </Button>
          </div>

          {items.length === 0 ? (
            <p role="status" className="mt-4 text-sm text-muted-foreground">
              {incomplete
                ? "현재 확인된 항목이 없어요. 위 안내를 확인해 주세요."
                : filter === "due"
                  ? "오늘 확인할 후속 연락이나 미기록 결과가 없어요."
                  : "남아 있는 후속 연락이나 미기록 결과가 없어요."}
              {filter === "due" && data.items.length > 0 ? " 이후 일정과 예정일 미정 항목은 전체 할 일에서 확인하세요." : ""}
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {items.slice(0, visibleCount).map((item) => {
                const isOverdue = Boolean(item.due_date) && item.due_date < data.today;
                const isToday = item.due_date === data.today;
                const hasResults = Boolean(item.result_checks?.length);
                const actionLabel = hasResults ? "결과 기록 열기" : "연락·기록 열기";
                return (
                  <li key={`${item.job_id}:${item.candidate_id}`} className="flex min-w-0 flex-col gap-3 py-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="max-w-full break-words text-sm font-bold text-foreground">{item.name || "이름 미상"}</span>
                        <span className="min-w-0 max-w-full break-words text-xs text-muted-foreground">{item.job_title}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{item.next_action}</p>
                      {hasResults && <p className="mt-1 break-words text-sm text-warning-strong">
                        결과 미기록: {item.result_checks!.map((check) => `${check.date} ${participationKindLabels[check.kind]}`).join(" · ")}
                      </p>}
                      {item.manual_due_date !== undefined && <p className="mt-1 text-xs text-muted-foreground">연락 예정일: {item.manual_due_date || "미정"}</p>}
                      <div className="mt-2 flex min-w-0 flex-wrap gap-1.5 text-xs">
                        <span className="max-w-full break-words rounded-full bg-muted px-2 py-1 text-muted-foreground">담당 {item.owner || "미지정"}</span>
                        <span className={`rounded-full px-2 py-1 ${isOverdue ? "bg-priority-critical-soft text-priority-critical-ink" : isToday ? "bg-priority-attention-soft text-priority-attention-ink" : "bg-muted text-muted-foreground"}`}>
                          {item.due_date ? `${hasResults ? "결과 확인" : isOverdue ? "기한 지남" : isToday ? "오늘" : "예정"} · ${item.due_date}` : "예정일 미정"}
                        </span>
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      aria-label={`${item.name || "이름 미상"} · ${item.job_title} ${actionLabel}`}
                      onClick={() => onOpen(item)}
                      className="w-full sm:w-auto"
                    >
                      {actionLabel} <ArrowRight aria-hidden="true" size={14} />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {remaining > 0 ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setVisibleCount((count) => count + 5)} className="mt-1 w-full">
              {Math.min(5, remaining)}건 더 보기 · {remaining}건 남음
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
