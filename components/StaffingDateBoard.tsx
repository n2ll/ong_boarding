"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import { StaffingDemandEditor } from "./StaffingDemandEditor";
import { staffingToday } from "@/lib/admin/staffing-preparation";
import { staffingDateBoardDates, type StaffingDateBoardData, type StaffingDateBoardCell } from "@/lib/admin/staffing-date-board";

const fieldClass = "min-h-11 w-full min-w-0 rounded-lg border border-border-strong bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const labelDate = (date: string) => new Date(`${date}T12:00:00+09:00`).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", timeZone: "Asia/Seoul" });

function DateCell({ cell, title, onOpen, onEdit }: { cell: StaffingDateBoardCell; title: string; onOpen: () => void; onEdit: () => void }) {
  const state = cell.demand_state ?? "unknown";
  const target = state === "unknown" || cell.invalid_demand ? null : cell.target;
  return <div className="space-y-2"><button type="button" aria-label={`${title} ${cell.date} 후보 확인`} onClick={onOpen}
    className="flex min-h-36 w-full min-w-0 flex-col gap-2 rounded-xl border border-border-strong bg-background p-3 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <span className="font-semibold lg:sr-only">{labelDate(cell.date)}</span>
    <span className={`text-base font-bold ${cell.shortage ? "text-warning-strong" : "text-foreground"}`}>
      {cell.invalid_demand ? "수요 기록 확인 필요" : state === "off" ? "운행 없음" : target === null ? "수요 미정" : cell.invalid_records ? "기록 확인 필요" : cell.shortage ? `${cell.shortage}명 부족` : "필요 인원 충족"}
    </span>
    <span>{target === null ? "필요 인원 미정" : `필요 ${target}명`} · 확정 {cell.confirmed}명</span>
    <span className="text-muted-foreground">예비 후보 {cell.reserve}명 · 미확정 본담당 {cell.primary - cell.confirmed}명</span>
    {!!cell.invalid_records && <span className="text-warning-strong">최근 기록 {cell.invalid_records}명 확인 불가 · 인원 재확인</span>}
    {target !== null && cell.confirmed > target && <span className="text-warning-strong">{state === "off" ? "운행 없는 날에 확정 인원 있음" : "필요 인원보다 확정 인원 많음"} · 투입 재확인</span>}
    {!!cell.conflicts.length && <span className="break-words text-warning-strong">같은 날 다른 라인에도 확정<br />{cell.conflicts.map((other) => `${other.name} · ${other.other_job_title}`).join(" / ")}<br />운행 시간·반납 시간을 확인하세요.</span>}
    <span className="mt-auto inline-flex items-center gap-1 pt-1 font-semibold">후보 확인 · 진행 기록 <ChevronRight size={15} aria-hidden="true" /></span>
  </button><Button variant="secondary" className="w-full" aria-label={`${title} ${cell.date} 필요 인원 수정`} onClick={onEdit}>{cell.demand_event_id ? "필요 인원 수정" : "필요 인원 입력"}</Button></div>;
}

export function StaffingDateBoard({ defaultStart, onOpenCandidates }: { defaultStart?: string; onOpenCandidates: (jobId: number, date: string) => void }) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [data, setData] = useState<StaffingDateBoardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<{ job: StaffingDateBoardData["jobs"][number]; cell: StaffingDateBoardCell } | null>(null);
  const days = staffingDateBoardDates(start, end);
  const valid = !!days;
  useEffect(() => {
    const refresh = () => { setData(null); setRevision((value) => value + 1); };
    window.addEventListener("ongboarding:staffing-updated", refresh);
    return () => window.removeEventListener("ongboarding:staffing-updated", refresh);
  }, []);
  useEffect(() => {
    if (!open || !valid) return;
    const controller = new AbortController();
    setLoading(true); setError(""); setData(null);
    fetch(`/api/admin/staffing-date-board?start=${start}&end=${end}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "충원판을 불러오지 못했어요.");
        if (!controller.signal.aborted) setData(body);
      }).catch((failure) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "충원판을 불러오지 못했어요.");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, start, end, valid, revision]);
  const current = !loading && !error && data?.start === start && data.end === end ? data : null;
  const toggle = () => {
    if (!open && !start) {
      const first = defaultStart || staffingToday();
      setStart(first);
      setEnd(new Date(Date.parse(`${first}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10));
    }
    setOpen((value) => !value);
  };
  return <section aria-label="날짜별 충원 현황" className="min-w-0 rounded-panel border border-border-strong bg-card p-3 sm:p-4">
    <button type="button" aria-label="날짜별 충원판" aria-expanded={open} aria-controls="staffing-date-board-content" onClick={toggle}
      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span><span className="block font-bold">날짜별 충원판</span><span className="block text-sm text-muted-foreground">날짜별 수요를 정하고 부족한 라인의 후보를 확인하세요.</span></span>
      {open ? <ChevronDown size={20} aria-hidden="true" /> : <ChevronRight size={20} aria-hidden="true" />}
    </button>
    {open && <div id="staffing-date-board-content" className="mt-4 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
        <label className="min-w-0 space-y-1 sm:max-w-52 sm:flex-1"><span className="block text-sm font-medium">충원 비교 시작일</span><input type="date" value={start} onChange={(event) => setStart(event.target.value)} className={fieldClass} /></label>
        <label className="min-w-0 space-y-1 sm:max-w-52 sm:flex-1"><span className="block text-sm font-medium">충원 비교 종료일</span><input type="date" value={end} min={start} onChange={(event) => setEnd(event.target.value)} className={fieldClass} /></label>
        <Button variant="secondary" className="col-span-2" aria-label="충원판 새로고침" disabled={loading || !valid} onClick={() => { setData(null); setRevision((value) => value + 1); }}><RefreshCw size={15} aria-hidden="true" /> 새로고침</Button>
      </div>
      <p className="text-sm text-muted-foreground">최대 7일 비교 · 수요가 미정인 날은 부족 인원을 계산하지 않습니다. 관리자가 날짜별로 확정한 사람만 충원에 반영하며, 예비 후보는 포함하지 않습니다.</p>
      {!valid ? <p role="alert" className="text-sm text-warning-strong">시작일과 종료일을 포함해 1~7일로 선택해주세요.</p>
        : loading ? <p role="status" className="py-6 text-sm">충원 현황을 불러오는 중…</p>
        : error ? <p role="alert" className="text-sm text-error-strong">{error} 새로고침해 다시 확인해주세요.</p>
        : current && <>
          <p className="text-xs text-muted-foreground">모집 중인 일반 배송 {current.jobs.length}개 라인 · {new Date(current.updated_at).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" })} 조회 기준</p>
          {!current.jobs.length ? <p className="py-6 text-sm">비교할 모집 중인 일반 배송 공고가 없습니다.</p> : <>
            <div className="hidden max-w-full overflow-x-auto lg:block">
              <table className="w-full border-separate border-spacing-2 text-left text-sm">
                <caption className="sr-only">날짜별 실제 필요 인원과 확정·예비·부족 인원</caption>
                <thead><tr><th scope="col" className="min-w-44 px-2 py-1">배송 라인</th>{days!.map((day) => <th scope="col" key={day} className="min-w-40 px-3 py-1 font-semibold">{labelDate(day)}</th>)}</tr></thead>
                <tbody>{current.jobs.map((job) => <tr key={job.job_id}>
                  <th scope="row" className="max-w-64 break-words px-2 py-3 align-top"><p>{job.title}</p>{job.slot && <p className="mt-1 font-normal text-muted-foreground">{job.slot}</p>}</th>
                  {job.cells.map((cell) => <td key={cell.date} className="align-top"><DateCell cell={cell} title={job.title} onOpen={() => onOpenCandidates(job.job_id, cell.date)} onEdit={() => setEditing({ job, cell })} /></td>)}
                </tr>)}</tbody>
              </table>
            </div>
            <div className="space-y-4 lg:hidden">{current.jobs.map((job) => <article key={job.job_id} className="space-y-2">
              <h3 className="break-words font-semibold">{job.title}</h3>{job.slot && <p className="text-sm text-muted-foreground">{job.slot}</p>}
              <div className="grid gap-2 sm:grid-cols-2">{job.cells.map((cell) => <DateCell key={cell.date} cell={cell} title={job.title} onOpen={() => onOpenCandidates(job.job_id, cell.date)} onEdit={() => setEditing({ job, cell })} />)}</div>
            </article>)}</div>
          </>}
        </>}
    </div>}
    {editing && <StaffingDemandEditor jobId={editing.job.job_id} title={editing.job.title} capacity={editing.job.capacity} cell={editing.cell} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
  </section>;
}
