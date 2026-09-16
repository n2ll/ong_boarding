"use client";

import { useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import type { StaffingDateBoardData } from "@/lib/admin/staffing-date-board";
import type { buildDashboardStaffingGaps } from "@/lib/admin/dashboard-staffing-gaps";

const labelDate = (date: string) => new Date(`${date}T12:00:00+09:00`).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", timeZone: "Asia/Seoul" });

type Props = {
  data?: StaffingDateBoardData;
  summary?: ReturnType<typeof buildDashboardStaffingGaps>;
  error?: unknown;
  start: string;
  end: string;
  refreshing: boolean;
  onRetry: () => void;
  onOpen: (path: string) => void;
};

export function StaffingGapSummary({ data, summary, error, start, end, refreshing, onRetry, onOpen }: Props) {
  const [expanded, setExpanded] = useState(false);
  const current = !error && data?.start === start && data.end === end && summary ? summary : undefined;
  return <section id="staffing-gaps" aria-label="가까운 운행일 충원" className="min-w-0 scroll-mt-6 rounded-panel border border-border-strong bg-card p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="font-bold text-foreground">가까운 운행일 충원</h2>
        <p className="mt-1 text-sm text-muted-foreground">{labelDate(start)} ~ {labelDate(end)} · 모집 중인 일반 배송 전체</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" disabled={refreshing} aria-label="가까운 운행일 충원 새로고침" onClick={onRetry}><RefreshCw size={15} aria-hidden="true" />{refreshing ? "조회 중" : "새로고침"}</Button>
        <Button variant="secondary" onClick={() => onOpen(`/jobs?staffing_start=${start}`)}>전체 충원판 <ChevronRight size={15} aria-hidden="true" /></Button>
      </div>
    </div>
    {error ? <p role="alert" className="mt-4 text-sm text-error-strong">충원 현황을 확인하지 못했어요. 새로고침해 다시 확인해주세요.</p>
      : !current ? <p role="status" className="mt-4 text-sm text-muted-foreground">날짜별 필요 인원과 확정 기록을 확인하는 중…</p>
      : <div className="mt-4 space-y-3">
        {!!current.items.length && <div className="divide-y divide-border-strong rounded-xl border border-border-strong">
          {(expanded ? current.items : current.items.slice(0, 3)).map((item) => <button key={`${item.job_id}:${item.date}`} type="button"
            onClick={() => onOpen(`/jobs?staffing_job=${item.job_id}&staffing_date=${item.date}`)}
            aria-label={`${item.title} ${item.date} ${item.label} 후보 확인`}
            className="flex min-h-11 w-full min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl p-3 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4">
            <span className="min-w-0 flex-1 basis-52">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"><span className="font-semibold">{labelDate(item.date)}</span><span className="font-bold text-warning-strong">{item.label}</span></span>
              <span className="mt-1 block break-words font-semibold">{item.title}</span>
              <span className="mt-1 block break-words text-sm text-muted-foreground">{item.detail}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold">후보 확인 <ChevronRight size={16} aria-hidden="true" /></span>
          </button>)}
        </div>}
        {current.items.length > 3 && <Button variant="ghost" className="w-full" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "접기" : `확인할 날짜 ${current.items.length - 3}건 더 보기`}</Button>}
        {!!current.unknownCount && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted p-3">
          <p className="min-w-0 flex-1 basis-52 text-sm">필요 인원 미정 <strong>{current.unknownCount}건</strong><span className="mt-1 block text-muted-foreground">라인별 날짜의 수요를 정하면 부족 인원이 표시됩니다.</span></p>
          <Button variant="secondary" onClick={() => onOpen(`/jobs?staffing_start=${current.firstUnknownDate ?? start}`)}>수요 확인</Button>
        </div>}
        {!current.items.length && <p className="text-sm text-muted-foreground">{!data!.jobs.length ? "모집 중인 일반 배송 공고가 없습니다." : current.unknownCount ? "수요가 미정인 날짜는 충원 여부를 판단하지 않습니다." : "이 기간에 기록된 수요 기준으로 부족 인원이나 확정 충돌이 없습니다."}</p>}
        <p className="text-xs text-muted-foreground">{new Date(data!.updated_at).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" })} 조회 기준 · 예비 후보는 확정 인원에 포함하지 않습니다.</p>
      </div>}
  </section>;
}
