"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import { applyStaffingNoteChanges, parseStaffingNoteProposal, staffingNoteChangeLabel, staffingNoteChangeValue, type StaffingNoteChange, type StaffingNoteProposal } from "@/lib/admin/staffing-note-draft";
import { backupIntentLabels, followUpContactMethodLabels, staffingToday, trainingStatusLabels, type StaffingPreparation } from "@/lib/admin/staffing-preparation";

const fieldClass = "min-h-11 w-full min-w-0 rounded-lg border border-border-strong bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export function useStaffingNoteDraft(draft: StaffingPreparation) {
  const [note, setNote] = useState("");
  const [referenceDate, setReferenceDate] = useState(staffingToday);
  const [proposal, setProposal] = useState<StaffingNoteProposal | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const invalidate = () => { pending.current?.abort(); pending.current = null; setBusy(false); setProposal(null); setSelected([]); setError(""); };
  const changeNote = (value: string) => { invalidate(); setNote(value); };
  const changeDate = (value: string) => { invalidate(); setReferenceDate(value); };
  const reset = () => { invalidate(); setNote(""); setReferenceDate(staffingToday()); };
  const toggle = (index: number, checked: boolean) => setSelected((current) => {
    const next = checked ? [...current, index] : current.filter((value) => value !== index);
    if (!checked && proposal?.changes[index].field === "next_action") return next.filter((value) => proposal.changes[value].field !== "due_date");
    if (checked && proposal?.changes[index].field === "due_date") {
      const action = proposal.changes.findIndex((change) => change.field === "next_action");
      if (action >= 0 && !next.includes(action)) next.push(action);
    }
    return next;
  });
  const generate = async (jobId: number, applicantId: number) => {
    if (pending.current) return;
    if (!note.trim() || note.length > 1000 || !referenceDate || referenceDate > staffingToday()) { setError("메모와 오늘까지의 기준일을 확인해주세요."); return; }
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(""); setProposal(null);
    try {
      const response = await fetch(`/api/admin/jobs/${jobId}/staffing-note-draft`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ applicant_id: applicantId, note: note.trim(), reference_date: referenceDate }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "메모를 정리하지 못했어요. 다시 시도해주세요.");
      const parsed = parseStaffingNoteProposal(data.proposal, note.trim(), referenceDate);
      if (!parsed) throw new Error("정리 결과를 확인하지 못했어요. 메모를 구체적으로 적고 다시 정리해주세요.");
      if (!controller.signal.aborted) { setProposal(parsed); setSelected(parsed.changes.map((_, index) => index)); }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "메모 정리에 실패했어요. 다시 시도해주세요."); }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  };
  // Keep appended participation IDs stable across save retries and unrelated parent renders.
  const prepared = useMemo(() => proposal && selected.length ? applyStaffingNoteChanges(draft, proposal.changes.filter((_, index) => selected.includes(index))) : null, [draft, proposal, selected]);
  return { note, referenceDate, proposal, selected, busy, error, prepared, changeNote, changeDate, toggle, generate, reset, invalidate };
}

function previousValue(current: StaffingPreparation, change: StaffingNoteChange): string {
  switch (change.field) {
    case "contact": return current.follow_up?.last_contact ? `${current.follow_up.last_contact.date} · ${followUpContactMethodLabels[current.follow_up.last_contact.method]} · ${current.follow_up.last_contact.result}` : "";
    case "training_availability": return current.training_availability;
    case "training_status": return trainingStatusLabels[current.training.status];
    case "backup_intent": return backupIntentLabels[current.training.backup_intent];
    case "next_action": return current.follow_up?.next_action ?? "";
    case "due_date": return current.follow_up?.due_date ?? "";
    case "participation": return current.records.some(record => record.kind === change.value.kind && record.date === change.value.date) ? "같은 종류·날짜의 참여 기록이 있어 추가하지 않습니다." : "";
  }
}

export function StaffingNoteDraft({ state, current, disabled, onGenerate, onSave }: {
  state: ReturnType<typeof useStaffingNoteDraft>; current: StaffingPreparation; disabled: boolean; onGenerate: () => void; onSave: (draft: StaffingPreparation) => void;
}) {
  const [dateOpen, setDateOpen] = useState(false);
  const today = staffingToday();
  const isToday = state.referenceDate === today;
  const showDateInput = dateOpen || !isToday;
  return <form id="staffing-note-form" className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (disabled || state.busy) return; if (state.proposal && (!state.selected.length || state.prepared)) onSave(state.prepared ?? current); else if (!state.proposal) onGenerate(); }}>
    <label className="block space-y-2"><span className="font-semibold">통화·진행 메모</span><textarea aria-label="통화·진행 메모" aria-describedby="staffing-note-help" value={state.note} onChange={(event) => state.changeNote(event.target.value)} disabled={disabled || state.busy} maxLength={1000} rows={5} className={`${fieldClass} py-3`} placeholder="예: 오늘 통화함. 다음 주 오전 선탑 희망. 내일 상차지 확인 후 다시 전화하기." /></label>
    <p id="staffing-note-help" className="text-sm text-muted-foreground">원문은 팀 이력에 남습니다. 메모만 저장하면 직접 입력·AI 제안은 반영하지 않습니다.</p>
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <p className={isToday ? "text-sm text-muted-foreground" : "text-sm font-medium"}>{isToday ? `오늘 기준 · ${today}` : `메모 기준일 · ${state.referenceDate || "날짜를 선택해주세요"}`}</p>
        {isToday && <Button type="button" variant="ghost" aria-expanded={showDateInput} aria-controls="staffing-note-date-fields" disabled={disabled || state.busy} onClick={() => setDateOpen((value) => !value)}>{dateOpen ? "기준일 접기" : "기준일 변경"}</Button>}
      </div>
      {showDateInput && <div id="staffing-note-date-fields" className="flex flex-wrap items-center gap-3"><label htmlFor="staffing-note-date" className="text-sm text-muted-foreground">메모 기준일</label><input id="staffing-note-date" type="date" value={state.referenceDate} max={today} onChange={(event) => state.changeDate(event.target.value)} disabled={disabled || state.busy} className={`${fieldClass} w-auto max-w-full`} /></div>}
    </div>
    {state.busy && <p role="status" className="text-muted-foreground">메모에서 기록할 내용을 정리하고 있어요…</p>}
    {state.error && <p role="alert" className="text-error-strong">{state.error}</p>}
    {state.proposal && <section aria-label="AI 기록 초안" className="space-y-3">
      <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">저장할 내용 확인</h3><Button type="button" variant="ghost" disabled={disabled} onClick={state.invalidate}>메모 다시 정리</Button></div>
      <p className="text-sm text-muted-foreground">AI 초안입니다. 맞지 않는 항목은 선택을 해제하세요.</p>
      {state.proposal.changes.map((change, index) => <label key={index} className={`flex min-h-11 cursor-pointer gap-3 rounded-xl border p-3 ${state.selected.includes(index) ? "border-primary/40 bg-primary/5" : "border-border-strong"}`}>
        <input type="checkbox" aria-label={`${staffingNoteChangeLabel(change)} 반영`} checked={state.selected.includes(index)} disabled={disabled} onChange={(event) => state.toggle(index, event.target.checked)} className="mt-1 size-5 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring" />
        <span className="min-w-0 space-y-1 break-words"><span className="block font-medium">{staffingNoteChangeLabel(change)}</span>
          {previousValue(current, change) && <span className="block text-xs text-muted-foreground">기존: {previousValue(current, change)}</span>}
          <span className="block whitespace-pre-wrap">{staffingNoteChangeValue(change)}</span><span className="block text-xs text-muted-foreground">메모: “{change.evidence}”</span>
        </span>
      </label>)}
      {state.proposal.questions.length > 0 && <div className="rounded-xl bg-muted p-3"><p className="font-medium">확인이 필요한 내용</p><ul className="mt-2 list-disc space-y-1 pl-5">{state.proposal.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></div>}
      {!state.proposal.changes.length && <p>확실하게 기록할 내용을 찾지 못했어요. 원문을 그대로 저장하거나 메모를 보완해주세요.</p>}
      {!!state.selected.length && !state.prepared && <p role="alert" className="text-error-strong">선택한 내용을 기존 기록에 반영하기 어렵습니다. 날짜·할 일을 확인하거나 직접 입력해주세요.</p>}
    </section>}
  </form>;
}
