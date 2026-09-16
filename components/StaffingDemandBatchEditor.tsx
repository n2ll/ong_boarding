"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { useConfirm } from "./ConfirmDialog";
import { staffingDateBoardDates, type StaffingDateBoardData } from "@/lib/admin/staffing-date-board";
import { createStaffingDemandBatch, runStaffingDemandBatch, type StaffingDemandBatchItem } from "@/lib/admin/staffing-demand-batch";

const authorKey = "ongboarding:staffing-author:v1";
const fieldClass = "min-h-11 w-full min-w-0 rounded-lg border border-border-strong bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const choiceClass = "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border-strong px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10";
const checkboxClass = "size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const labelDate = (date: string) => new Date(`${date}T12:00:00+09:00`).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", timeZone: "Asia/Seoul" });

export function StaffingDemandBatchEditor({ data, onClose }: { data: StaffingDateBoardData; onClose: () => void }) {
  const [jobIds, setJobIds] = useState<number[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [state, setState] = useState<"operating" | "off">("operating");
  const [count, setCount] = useState("1");
  const [author, setAuthor] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [batch, setBatch] = useState<StaffingDemandBatchItem[] | null>(null);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  const id = useId();
  const confirm = useConfirm();
  useEffect(() => { try { setAuthor(localStorage.getItem(authorKey) ?? ""); } catch { /* optional convenience */ } }, []);
  const days = staffingDateBoardDates(data.start, data.end) ?? [];
  const input = { data, jobIds, dates, state, requiredCount: count.trim() ? Number(count) : NaN, actorName: author.trim() };
  let preview: ReturnType<typeof createStaffingDemandBatch> | null = null;
  let validation = "";
  if (jobIds.length && dates.length) {
    try { preview = createStaffingDemandBatch({ ...input, actorName: author.trim() || "미입력" }, () => ""); }
    catch (failure) { validation = failure instanceof Error ? failure.message : "선택한 내용을 확인해주세요."; }
  }
  const saved = batch?.filter((item) => item.status === "saved").length ?? 0;
  const conflicts = batch?.filter((item) => item.status === "conflict").length ?? 0;
  const failed = batch?.filter((item) => item.status === "failed").length ?? 0;
  const pending = batch?.filter((item) => item.status === "pending").length ?? 0;
  const close = async () => {
    if (savingRef.current) return;
    if ((batch && (failed || pending)) || (!batch && dirty)) {
      if (!await confirm({ title: "입력 창을 닫을까요?", description: batch
        ? "저장된 수요는 유지됩니다. 응답을 확인하지 못한 항목도 실제로는 저장되었을 수 있어요. 실패 항목을 재시도하면 결과를 확인할 수 있습니다."
        : "저장하지 않은 선택과 입력은 사라집니다.", confirmText: "닫기", destructive: true })) return;
    }
    onClose();
  };
  const save = async () => {
    if (savingRef.current) return;
    let items = batch;
    if (!items) {
      try { items = createStaffingDemandBatch(input).items; }
      catch (failure) { setError(failure instanceof Error ? failure.message : "입력 내용을 확인해주세요."); return; }
      if (!items.length) { setError("새로 입력할 날짜가 없습니다. 기존 수요는 날짜별로 수정해주세요."); return; }
    }
    items = items.map((item) => item.status === "failed" ? { ...item, status: "pending" } : item);
    setBatch(items);
    savingRef.current = true; setSaving(true); setError("");
    try {
      try { localStorage.setItem(authorKey, author.trim()); } catch { /* not required for saving */ }
      const result = await runStaffingDemandBatch(items, { onResult: (item) => {
        setBatch((current) => current?.map((previous) => previous.body.action_key === item.body.action_key ? item : previous) ?? null);
      } });
      setBatch(result);
      if (result.every((item) => item.status === "saved")) toast.success(`${result.length}건의 날짜별 수요를 저장했어요.`);
    } catch { setError("일부 결과를 확인하지 못했어요. 입력을 유지한 채 다시 시도해주세요."); }
    finally {
      savingRef.current = false; setSaving(false);
      window.dispatchEvent(new Event("ongboarding:staffing-updated"));
    }
  };
  return <Modal open onClose={() => void close()} closeOnOutside={false} busy={saving} size="lg" title="여러 날짜 필요 인원 입력"
    description="라인과 날짜를 골라 미입력 수요를 한 번에 채우세요."
    footer={<>
      <Button variant="secondary" disabled={saving} onClick={() => void close()}>{batch && !failed && !pending && !conflicts ? "완료" : "닫기"}</Button>
      {(!batch || failed > 0 || pending > 0) && <Button onClick={() => void save()} isLoading={saving}
        disabled={!batch && (!preview?.items.length || !author.trim() || !!validation)}>
        {batch ? `미완료 ${failed + pending}건 다시 시도` : `${preview?.items.length ?? 0}건 저장`}
      </Button>}
    </>}>
    <div className="space-y-5">
      {!batch ? <>
        <fieldset className="space-y-2"><legend className="mb-2 font-semibold">1. 배송 라인</legend>
          <Button size="sm" variant="ghost" onClick={() => { setJobIds(jobIds.length === data.jobs.length ? [] : data.jobs.map((job) => job.job_id)); setDirty(true); }}>{jobIds.length === data.jobs.length ? "라인 선택 해제" : "전체 라인 선택"}</Button>
          {data.jobs.map((job) => <label key={job.job_id} className={choiceClass}>
            <input type="checkbox" className={checkboxClass} checked={jobIds.includes(job.job_id)} onChange={(event) => { setJobIds(event.target.checked ? [...jobIds, job.job_id] : jobIds.filter((value) => value !== job.job_id)); setDirty(true); }} />
            <span className="min-w-0 break-words">{job.title}</span>
          </label>)}
        </fieldset>
        <fieldset className="space-y-2"><legend className="mb-2 font-semibold">2. 적용할 날짜</legend>
          <div className="flex flex-wrap items-center gap-2"><p className="text-sm text-muted-foreground">{data.start} ~ {data.end}</p>
            <Button size="sm" variant="ghost" onClick={() => { setDates(dates.length === days.length ? [] : days); setDirty(true); }}>{dates.length === days.length ? "날짜 선택 해제" : "전체 날짜 선택"}</Button></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{days.map((date) => <label key={date} className={choiceClass}>
            <input type="checkbox" aria-label={`${date} 적용`} className={checkboxClass} checked={dates.includes(date)} onChange={(event) => { setDates(event.target.checked ? [...dates, date] : dates.filter((value) => value !== date)); setDirty(true); }} />{labelDate(date)}
          </label>)}</div>
          <p className="text-sm text-muted-foreground">선택한 라인 모두에 같은 날짜를 적용합니다. 다른 기간은 충원판에서 변경하세요.</p>
        </fieldset>
        <fieldset className="space-y-3"><legend className="mb-2 font-semibold">3. 필요한 인원</legend>
          <div className="grid grid-cols-2 gap-2">{([['operating', '운행함'], ['off', '운행 없음']] as const).map(([value, label]) => <label key={value} className={choiceClass}>
            <input className={checkboxClass} type="radio" name={`${id}-state`} checked={state === value} onChange={() => { setState(value); setDirty(true); }} />{label}
          </label>)}</div>
          {state === "operating" && <label className="flex flex-wrap items-center gap-3"><span className="text-sm font-medium">라인별 하루 필요 인원</span><input className={`${fieldClass} max-w-24 text-lg font-bold`} type="number" inputMode="numeric" min={1} max={999} step={1} value={count} onChange={(event) => { setCount(event.target.value); setDirty(true); }} /><span>명</span></label>}
          <p className="text-sm text-muted-foreground">예비 후보는 별도로 1명 권장 · 필수 아님. 실제 필요 인원에 더하지 않습니다.</p>
        </fieldset>
        <label className="block space-y-1"><span className="text-sm font-medium">기록 작성자</span><input className={fieldClass} maxLength={80} autoComplete="name" value={author} onChange={(event) => { setAuthor(event.target.value); setDirty(true); }} /></label>
      </> : <p className="text-sm">{jobIds.length}개 라인 · {dates.length}일 · {state === "off" ? "운행 없음" : `하루 필요 ${count}명`}</p>}
      {preview && <div className="space-y-2 rounded-xl bg-muted p-4 text-sm">
        <p className="font-semibold">{jobIds.length}개 라인 × {dates.length}일 중 {preview.items.length}건 {state === "off" ? "운행 없음으로 입력" : `필요 ${count}명 입력`}</p>
        <p>기존 기록 {preview.skipped.length}건 유지 · 선택하지 않은 날짜는 그대로</p>
        {preview.skipped.length > 0 && <p className="text-muted-foreground">이미 입력했거나 확인이 필요한 수요는 덮어쓰지 않습니다. 수정은 충원판의 날짜별 버튼을 이용하세요.</p>}
        {!!preview.warnings.length && <details className="text-warning-strong"><summary className="min-h-11 cursor-pointer py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">확인할 기록 {preview.warnings.length}건</summary>
          <ul className="space-y-2">{preview.warnings.map((item) => <li key={`${item.jobId}:${item.date}`} className="break-words">{item.title} · {item.date}<br />{item.message}</li>)}</ul>
        </details>}
      </div>}
      {batch && <div className="space-y-3">
        <p role="status" aria-live="polite" className="rounded-lg bg-muted p-3 font-semibold">저장 {saved}건 · 확인 필요 {conflicts}건 · 결과 미확인 {failed}건{saving ? ` · 처리 중 ${pending}건` : ""}</p>
        {(failed > 0 || conflicts > 0) && <p className="text-sm text-muted-foreground">결과 미확인은 같은 요청으로 다시 확인합니다. 동료가 수정했거나 공고 상태가 바뀐 건은 자동으로 덮어쓰지 않습니다. 창을 닫고 충원판에서 확인해주세요.</p>}
        {batch.filter((item) => item.status === "failed" || item.status === "conflict").map((item) => <div key={item.body.action_key} className="rounded-lg border border-border-strong p-3 text-sm">
          <p className="break-words font-medium">{item.title} · {item.date}</p><p className="mt-1 text-error-strong">{item.error}</p>
        </div>)}
      </div>}
      {(error || validation) && <p role="alert" className="text-sm text-error-strong">{error || validation}</p>}
      <p className="text-xs text-muted-foreground">이 입력으로 지원자가 확정되거나 취소되지 않습니다.</p>
    </div>
  </Modal>;
}
