"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { useConfirm } from "./ConfirmDialog";
import { applyStaffingSuggestion, type StaffingSuggestion, type StaffingPrimaryCandidate, parseStaffingPreparation, STAFFING_PREPARATION_LIMITS, type StaffingPreparation, type StaffingPreparationDate, type StaffingPreparationSnapshot } from "@/lib/admin/staffing-preparation";

type Candidate = {
  applicant_id: number;
  responded_at: string | null;
  applicants: { name: string; own_vehicle: string | null } | null;
};
const availabilityLabels = { unknown: "미확인", available: "가능", unavailable: "불가" };
const roleLabels = { unassigned: "역할 미정", primary_candidate: "본담당 후보", reserve_candidate: "예비 후보" };
const emptyPreparation = (): StaffingPreparation => ({ source: "manager", dates: [], training_availability: "", note: "" });
const fieldClass = "min-h-11 w-full min-w-0 rounded-lg border border-border-strong bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function StaffingPreparationPanel({ jobId, candidates }: { jobId: number; candidates: Candidate[] }) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<StaffingPreparationSnapshot[]>([]);
  const [suggestions, setSuggestions] = useState<StaffingSuggestion[]>([]);
  const [otherPrimaries, setOtherPrimaries] = useState<StaffingPrimaryCandidate[]>([]);
  const [conflictCheckIncomplete, setConflictCheckIncomplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [date, setDate] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Candidate | null>(null);
  const [draft, setDraft] = useState<StaffingPreparation>(emptyPreparation);
  const [initial, setInitial] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const request = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setLoadError("");
    fetch(`/api/admin/jobs/${jobId}/staffing-preparation`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "배차 준비를 불러오지 못했어요");
        if (!controller.signal.aborted) {
          setSnapshots(data.preparations); setSuggestions(data.suggestions ?? []);
          setOtherPrimaries(data.primary_candidates ?? []); setConflictCheckIncomplete(data.conflict_check_incomplete !== false);
        }
      }).catch((error) => { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "배차 준비 조회 실패"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, jobId, retry]);
  const startEditing = (candidate: Candidate) => {
    const saved = snapshots.find((item) => item.applicant_id === candidate.applicant_id)?.preparation ?? emptyPreparation();
    const hasSuggestion = suggestions.some((item) => item.applicant_id === candidate.applicant_id && item.date === date);
    const next = date && !hasSuggestion && saved.dates.length < STAFFING_PREPARATION_LIMITS.dates && !saved.dates.some((item) => item.date === date)
      ? { ...saved, dates: [...saved.dates, { date, availability: "unknown" as const, role: "unassigned" as const }] } : saved;
    setEditing(candidate); setDraft(next); setInitial(JSON.stringify(next)); setSaveError(""); request.current = null;
  };
  const closeEditor = async () => {
    if (saving) return;
    if (JSON.stringify(draft) !== initial && !await confirm({ title: "저장하지 않은 변경이 있어요", description: "배차 준비 내용을 버리고 닫을까요?", confirmText: "변경 버리기", destructive: true })) return;
    setEditing(null);
  };
  const updateDate = (index: number, patch: Partial<StaffingPreparationDate>) => setDraft((current) => ({ ...current, dates: current.dates.map((item, i) => {
    if (i !== index) return item;
    const next = { ...item, ...patch };
    return next.availability === "available" ? next : { ...next, role: "unassigned" };
  }) }));
  const save = async () => {
    if (!editing || saving) return;
    const normalized = parseStaffingPreparation(draft);
    if (!normalized) { setSaveError("날짜를 빠짐없이 입력하고 중복된 날짜가 없는지 확인해주세요."); return; }
    const payload = { applicant_id: editing.applicant_id, dates: normalized.dates, training_availability: normalized.training_availability, note: normalized.note };
    const body = JSON.stringify(payload);
    if (request.current?.body !== body) request.current = { body, key: crypto.randomUUID() };
    setSaving(true); setSaveError("");
    try {
      const response = await fetch(`/api/admin/jobs/${jobId}/staffing-preparation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, action_key: request.current.key }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "저장 실패");
      setSnapshots((items) => [...items.filter((item) => item.applicant_id !== data.applicant_id), data]);
      setEditing(null); toast.success("배차 준비를 저장했어요.");
    } catch (error) { setSaveError(`${error instanceof Error ? error.message : "저장 실패"}. 입력 내용은 유지됩니다. 다시 저장해주세요.`); }
    finally { setSaving(false); }
  };
  const dates = [...new Set([...snapshots.flatMap((item) => item.preparation?.dates.map((day) => day.date) ?? []),
    ...suggestions.flatMap((item) => item.date ? [item.date] : [])])].sort();
  const conflictsFor = (applicantId: number, preparation: StaffingPreparation | null | undefined) => otherPrimaries.filter((other) => other.applicant_id === applicantId
    && preparation?.dates.some((day) => day.date === other.date && day.role === "primary_candidate"));
  const editingSuggestion = suggestions.find((item) => item.applicant_id === editing?.applicant_id);
  const editingConflicts = editing ? conflictsFor(editing.applicant_id, draft) : [];
  const shown = candidates.filter((item) => (item.applicants?.name ?? "").includes(query.trim()));
  const counts = snapshots.flatMap((item) => item.preparation?.dates.filter((day) => day.date === date) ?? []);
  return <section className="rounded-2xl border border-border-strong bg-card p-4" onKeyDown={(event) => { if (editing) event.stopPropagation(); }}>
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex min-h-11 w-full items-center justify-between gap-3 text-left font-bold focus-visible:ring-2 focus-visible:ring-ring">날짜별 배차 준비 <span className="text-sm text-muted-foreground">{open ? "접기" : "펼치기"}</span></button>
    {open && <div className="mt-3 space-y-3 text-sm">
      <p className="text-muted-foreground">답장을 확인한 뒤 가능한 날짜와 선탑 시간을 정리하세요. 본담당·예비는 후보 구분이며 근무 확정은 별도로 진행합니다.</p>
      {loading ? <p role="status">배차 준비 불러오는 중…</p> : loadError ? <div role="alert"><p>{loadError}</p><Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>다시 조회</Button></div> : <>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-muted-foreground">답변 제안과 다른 공고 기록은 조회 시점 기준입니다.</p><Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>새로 확인</Button></div>
        {conflictCheckIncomplete && <p role="alert" className="text-warning-strong">다른 공고의 일부 기록을 확인하지 못했어요. 본담당 후보가 겹치는지 직접 확인해주세요.</p>}
        <label className="block space-y-1"><span>비교할 날짜</span><input aria-label="비교할 날짜" type="date" value={date} onChange={(event) => setDate(event.target.value)} className={fieldClass} /></label>
        {dates.length > 0 && <div className="flex flex-wrap gap-2">{dates.map((day) => <button key={day} type="button" aria-pressed={date === day} onClick={() => setDate(day)} className={`min-h-11 rounded-lg border px-3 focus-visible:ring-2 focus-visible:ring-ring ${date === day ? "bg-primary text-primary-foreground" : "bg-background"}`}>{day.slice(5).replace("-", "/")}</button>)}</div>}
        {date && <p role="status">{date} · 가능 {counts.filter((item) => item.availability === "available").length}명 · 본담당 후보 {counts.filter((item) => item.role === "primary_candidate").length}명 · 예비 후보 {counts.filter((item) => item.role === "reserve_candidate").length}명</p>}
        <input aria-label="배차 준비 후보 이름 검색" placeholder="이름 검색" value={query} onChange={(event) => setQuery(event.target.value)} className={fieldClass} />
        <div className="max-h-96 space-y-2 overflow-y-auto">{shown.map((candidate) => {
          const snapshot = snapshots.find((item) => item.applicant_id === candidate.applicant_id);
          const prep = snapshot?.preparation;
          const day = prep?.dates.find((item) => item.date === date);
          const suggestion = suggestions.find((item) => item.applicant_id === candidate.applicant_id);
          const conflicts = conflictsFor(candidate.applicant_id, prep);
          return <div key={candidate.applicant_id} className="rounded-xl border border-border-strong p-3">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0 break-words"><p className="font-bold">{candidate.applicants?.name ?? "이름 미등록"}</p><p className="text-muted-foreground">{candidate.applicants?.own_vehicle || "차량 미확인"}</p></div><Button variant="secondary" onClick={() => startEditing(candidate)} aria-label={`${candidate.applicants?.name ?? "후보"} 배차 준비 편집`}>정리</Button></div>
            {snapshot?.invalid ? <p role="alert" className="text-error-strong">최근 기록을 확인할 수 없어요. 내용을 다시 확인하고 저장해주세요.</p> : <>
              <p className="mt-2">{date ? `${availabilityLabels[day?.availability ?? "unknown"]} · ${roleLabels[day?.role ?? "unassigned"]}` : `날짜 ${prep?.dates.length ?? 0}건 기록`}</p>
              <p className="break-words">선탑 가능 시간: {prep?.training_availability || "미확인"}</p>
              {prep?.note && <p className="whitespace-pre-wrap break-words text-muted-foreground">{prep.note}</p>}
            </>}
            {suggestion && <div className="mt-3 rounded-lg bg-muted p-3"><p className="font-medium">답변에서 찾은 날짜 {suggestion.date ? `· ${suggestion.date} ${availabilityLabels[suggestion.availability]}` : "· 확인 필요"}</p><p className="whitespace-pre-wrap break-words">“{suggestion.quote || "원문 확인 필요"}”</p><p className="text-muted-foreground">정리에서 원문을 확인하고 반영해주세요.</p></div>}
            {conflicts.length > 0 && <p role="alert" className="mt-2 break-words text-warning-strong">같은 날 본담당 후보가 겹칩니다: {conflicts.map((item) => `${item.date} ${item.job_title}`).join(", ")}. 역할 조정은 관리자가 판단해주세요.</p>}
          </div>;
        })}{!shown.length && <p>일치하는 후보가 없습니다.</p>}</div>
      </>}
    </div>}
    <Modal open={!!editing} onClose={() => void closeEditor()} closeOnOutside={false} busy={saving} title={`${editing?.applicants?.name ?? "후보"} 배차 준비`} description="관리자가 확인한 내용을 기록합니다. 저장으로 문자를 보내거나 근무를 확정하지 않습니다." footer={<Button onClick={() => void save()} isLoading={saving}>배차 준비 저장</Button>}>
      <div className="space-y-4 text-sm">
        {editingSuggestion && <div className="space-y-2 rounded-xl border border-border-strong bg-muted p-3">
          <p className="font-bold">수신 답변에서 찾은 제안</p>
          <p className="whitespace-pre-wrap break-words">“{editingSuggestion.quote || "원문 확인 필요"}”</p>
          {editingSuggestion.source_created_at && <p className="text-xs text-muted-foreground">수신 문자 · {new Date(editingSuggestion.source_created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>}
          {editingSuggestion.date ? <>
            <p>{editingSuggestion.date} · {availabilityLabels[editingSuggestion.availability]} · 역할 미정</p>
            <Button variant="secondary" disabled={saving || draft.dates.some((day) => day.date === editingSuggestion.date) || draft.dates.length >= STAFFING_PREPARATION_LIMITS.dates}
              onClick={() => setDraft((current) => applyStaffingSuggestion(current, editingSuggestion))}>원문 확인 후 초안에 반영</Button>
            <p className="text-muted-foreground">이미 입력한 날짜는 유지합니다. 반영 후 날짜를 확인하고 아래에서 저장해주세요.</p>
          </> : <p className="text-warning-strong">확인 필요: {editingSuggestion.reason} 날짜는 직접 정리해주세요.</p>}
        </div>}
        {editingConflicts.length > 0 && <div role="alert" className="rounded-xl border border-warning-strong p-3 text-warning-strong"><p className="font-bold">같은 날 본담당 후보가 겹칩니다</p>{editingConflicts.map((item) => <p key={`${item.job_id}:${item.date}`} className="break-words">{item.date} · {item.job_title}</p>)}<p>다른 공고의 조회 시점 기록입니다. 본담당·예비 역할은 관리자가 판단하며 저장을 계속할 수 있습니다.</p></div>}
        {conflictCheckIncomplete && <p role="alert" className="text-warning-strong">다른 공고의 일부 기록을 확인하지 못했어요. 중복 후보를 직접 확인해주세요.</p>}
        {draft.dates.map((day, index) => <fieldset key={index} disabled={saving} className="min-w-0 space-y-2 rounded-xl border p-3"><legend className="px-1">가능 날짜 {index + 1}</legend>
          <input aria-label={`날짜 ${index + 1}`} type="date" value={day.date} onChange={(event) => updateDate(index, { date: event.target.value })} className={fieldClass} />
          <select aria-label={`가능 여부 ${index + 1}`} value={day.availability} onChange={(event) => updateDate(index, { availability: event.target.value as StaffingPreparationDate["availability"] })} className={fieldClass}>{Object.entries(availabilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label={`후보 역할 ${index + 1}`} value={day.role} disabled={day.availability !== "available"} onChange={(event) => updateDate(index, { role: event.target.value as StaffingPreparationDate["role"] })} className={fieldClass}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <Button variant="ghost" onClick={() => setDraft((current) => ({ ...current, dates: current.dates.filter((_, i) => i !== index) }))}>날짜 삭제</Button>
        </fieldset>)}
        <Button variant="secondary" disabled={saving || draft.dates.length >= STAFFING_PREPARATION_LIMITS.dates} onClick={() => setDraft((current) => ({ ...current, dates: [...current.dates, { date: "", availability: "unknown", role: "unassigned" }] }))}>날짜 추가</Button>
        <label className="block space-y-1"><span>선탑 가능 시간</span><input disabled={saving} value={draft.training_availability} maxLength={STAFFING_PREPARATION_LIMITS.training} onChange={(event) => setDraft((current) => ({ ...current, training_availability: event.target.value }))} className={fieldClass} placeholder="예: 9/16 오전 동승 가능 · 일정 조율 필요" /></label>
        <label className="block space-y-1"><span>관리자 메모</span><textarea disabled={saving} value={draft.note} maxLength={STAFFING_PREPARATION_LIMITS.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} className={`${fieldClass} min-h-24 py-2`} /></label>
        {saveError && <p role="alert" className="text-error-strong">{saveError}</p>}
      </div>
    </Modal>
  </section>;
}
