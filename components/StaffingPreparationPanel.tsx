"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { useConfirm } from "./ConfirmDialog";
import { emptyStaffingTraining, trainingStatusLabels, backupIntentLabels, type StaffingTraining, applyStaffingSuggestion, type StaffingSuggestion, type StaffingPrimaryCandidate, parseStaffingPreparation, STAFFING_PREPARATION_LIMITS, type StaffingPreparation, type StaffingPreparationDate, type StaffingPreparationSnapshot } from "@/lib/admin/staffing-preparation";

type Candidate = {
  applicant_id: number;
  responded_at: string | null;
  applicants: { name: string; own_vehicle: string | null } | null;
};
const availabilityLabels = { unknown: "미확인", available: "가능", unavailable: "불가" };
const roleLabels = { unassigned: "역할 미정", primary_candidate: "본담당 후보", reserve_candidate: "예비 후보" };
const emptyPreparation = (): StaffingPreparation => ({ source: "manager", dates: [], training_availability: "", training: emptyStaffingTraining(), note: "" });
const fieldClass = "min-h-11 w-full min-w-0 rounded-lg border border-border-strong bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const AUTHOR_STORAGE_KEY = "ongboarding:staffing-author:v1";
const formatTime = (at: string) => new Date(at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
function PreparationDetails({ preparation }: { preparation: StaffingPreparation }) {
  const training = preparation.training ?? emptyStaffingTraining();
  return <div className="space-y-1 break-words">
    <p className="font-medium">{trainingStatusLabels[training.status]} · {backupIntentLabels[training.backup_intent]}</p>
    <p>선탑 가능 시간: {preparation.training_availability || "미확인"}</p>
    {training.scheduled_at && <p>선탑 지정 일시: {formatTime(training.scheduled_at)} (한국시간)</p>}
    {training.first_loading_location && <p>선탑 첫 상차지: {training.first_loading_location}</p>}
    {training.linked_pro && <p>선탑 연결 프로: {training.linked_pro}</p>}
    {preparation.dates.length > 0 && <p>날짜별 후보: {preparation.dates.map((day) => `${day.date} ${availabilityLabels[day.availability]} · ${roleLabels[day.role]}`).join(" / ")}</p>}
    {preparation.note && <p className="whitespace-pre-wrap text-muted-foreground">{preparation.note}</p>}
  </div>;
}

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
  const [actorName, setActorName] = useState("");
  const [baseEventId, setBaseEventId] = useState<number | null>(null);
  const [conflict, setConflict] = useState<StaffingPreparationSnapshot | null>(null);
  const [preservedDraft, setPreservedDraft] = useState<StaffingPreparation | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const request = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    try { setActorName(localStorage.getItem(AUTHOR_STORAGE_KEY) ?? ""); } catch { /* Storage is optional. */ }
  }, []);
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
    const snapshot = snapshots.find((item) => item.applicant_id === candidate.applicant_id);
    const saved = parseStaffingPreparation(snapshot?.preparation) ?? emptyPreparation();
    setBaseEventId(snapshot?.event_id ?? null); setConflict(null); setPreservedDraft(null);
    const hasSuggestion = suggestions.some((item) => item.applicant_id === candidate.applicant_id && item.date === date);
    const next = date && !hasSuggestion && saved.dates.length < STAFFING_PREPARATION_LIMITS.dates && !saved.dates.some((item) => item.date === date)
      ? { ...saved, dates: [...saved.dates, { date, availability: "unknown" as const, role: "unassigned" as const }] } : saved;
    setEditing(candidate); setDraft(next); setInitial(JSON.stringify(next)); setSaveError(""); request.current = null;
  };
  const closeEditor = async () => {
    if (saving) return;
    if ((JSON.stringify(draft) !== initial || preservedDraft) && !await confirm({ title: "저장하지 않은 변경이 있어요", description: "배차 준비 내용을 버리고 닫을까요?", confirmText: "변경 버리기", destructive: true })) return;
    setEditing(null);
  };
  const updateDate = (index: number, patch: Partial<StaffingPreparationDate>) => setDraft((current) => ({ ...current, dates: current.dates.map((item, i) => {
    if (i !== index) return item;
    const next = { ...item, ...patch };
    return next.availability === "available" ? next : { ...next, role: "unassigned" };
  }) }));
  const save = async () => {
    if (!editing || saving || conflict) return;
    const normalized = parseStaffingPreparation(draft);
    if (!normalized) { setSaveError("날짜를 빠짐없이 입력하고 중복된 날짜가 없는지 확인해주세요."); return; }
    if (!actorName.trim()) { setSaveError("팀에 공유할 기록 작성자 이름을 입력해주세요."); return; }
    try { localStorage.setItem(AUTHOR_STORAGE_KEY, actorName.trim()); } catch { /* Saving still works without local storage. */ }
    const payload = { applicant_id: editing.applicant_id, base_event_id: baseEventId, actor_name: actorName.trim(),
      dates: normalized.dates, training_availability: normalized.training_availability, training: normalized.training, note: normalized.note };
    const body = JSON.stringify(payload);
    if (request.current?.body !== body) request.current = { body, key: crypto.randomUUID() };
    setSaving(true); setSaveError("");
    try {
      const response = await fetch(`/api/admin/jobs/${jobId}/staffing-preparation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, action_key: request.current.key }) });
      const data = await response.json();
      if (response.status === 409 && data.conflict && data.latest) {
        setConflict(data.latest); setSaveError(data.error); return;
      }
      if (!response.ok) throw new Error(data.error ?? "저장 실패");
      setSnapshots((items) => [...items.filter((item) => item.applicant_id !== data.applicant_id), data]);
      setEditing(null); setRetry((value) => value + 1); toast.success("배차 준비를 저장했어요.");
    } catch (error) { setSaveError(`${error instanceof Error ? error.message : "저장 실패"}. 입력 내용은 유지됩니다. 다시 저장해주세요.`); }
    finally { setSaving(false); }
  };
  const dates = [...new Set([...snapshots.flatMap((item) => item.preparation?.dates.map((day) => day.date) ?? []),
    ...suggestions.flatMap((item) => item.date ? [item.date] : [])])].sort();
  const conflictsFor = (applicantId: number, preparation: StaffingPreparation | null | undefined) => otherPrimaries.filter((other) => other.applicant_id === applicantId
    && preparation?.dates.some((day) => day.date === other.date && day.role === "primary_candidate"));
  const editingSuggestion = suggestions.find((item) => item.applicant_id === editing?.applicant_id);
  const editingConflicts = editing ? conflictsFor(editing.applicant_id, draft) : [];
  const editingSnapshot = snapshots.find((item) => item.applicant_id === editing?.applicant_id);
  const shown = candidates.filter((item) => (item.applicants?.name ?? "").includes(query.trim())
    && (!statusFilter || (snapshots.find((snapshot) => snapshot.applicant_id === item.applicant_id)?.preparation?.training?.status ?? "reviewing") === statusFilter));
  const counts = snapshots.flatMap((item) => item.preparation?.dates.filter((day) => day.date === date) ?? []);
  return <section className="rounded-2xl border border-border-strong bg-card p-4" onKeyDown={(event) => { if (editing) event.stopPropagation(); }}>
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex min-h-11 w-full items-center justify-between gap-3 text-left font-bold focus-visible:ring-2 focus-visible:ring-ring">날짜별 배차 준비 <span className="text-sm text-muted-foreground">{open ? "접기" : "펼치기"}</span></button>
    {open && <div className="mt-3 space-y-3 text-sm">
      <p className="text-muted-foreground">답장을 확인한 뒤 가능한 날짜와 선탑 진행을 정리하세요. 선탑 대상과 순서는 라인별로 매니저가 검토하며, 선탑 후 백업 진행은 본인이 선택합니다. 본담당·예비는 후보 구분이며 근무 확정은 별도로 진행합니다.</p>
      {loading ? <p role="status">배차 준비 불러오는 중…</p> : loadError ? <div role="alert"><p>{loadError}</p><Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>다시 조회</Button></div> : <>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-muted-foreground">답변 제안과 다른 공고 기록은 조회 시점 기준입니다.</p><Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>새로 확인</Button></div>
        {conflictCheckIncomplete && <p role="alert" className="text-warning-strong">다른 공고의 일부 기록을 확인하지 못했어요. 본담당 후보가 겹치는지 직접 확인해주세요.</p>}
        <label className="block space-y-1"><span>비교할 날짜</span><input aria-label="비교할 날짜" type="date" value={date} onChange={(event) => setDate(event.target.value)} className={fieldClass} /></label>
        {dates.length > 0 && <div className="flex flex-wrap gap-2">{dates.map((day) => <button key={day} type="button" aria-pressed={date === day} onClick={() => setDate(day)} className={`min-h-11 rounded-lg border px-3 focus-visible:ring-2 focus-visible:ring-ring ${date === day ? "bg-primary text-primary-foreground" : "bg-background"}`}>{day.slice(5).replace("-", "/")}</button>)}</div>}
        {date && <p role="status">{date} · 가능 {counts.filter((item) => item.availability === "available").length}명 · 본담당 후보 {counts.filter((item) => item.role === "primary_candidate").length}명 · 예비 후보 {counts.filter((item) => item.role === "reserve_candidate").length}명</p>}
        <input aria-label="배차 준비 후보 이름 검색" placeholder="이름 검색" value={query} onChange={(event) => setQuery(event.target.value)} className={fieldClass} />
        <label className="block space-y-1"><span>선탑 진행 필터</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className={fieldClass}><option value="">모든 진행 상태</option>{Object.entries(trainingStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
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
              <p className="mt-1 font-medium">{trainingStatusLabels[prep?.training?.status ?? "reviewing"]} · {backupIntentLabels[prep?.training?.backup_intent ?? "unknown"]}</p>
              <p className="break-words">선탑 가능 시간: {prep?.training_availability || "미확인"}</p>
              {prep?.training?.scheduled_at && <p>선탑 지정: {formatTime(prep.training.scheduled_at)}</p>}
              {prep?.training?.status === "completed" && prep.training.backup_intent === "unknown" && <p className="text-warning-strong">다음 확인: 선탑 후 본인의 백업 진행 의사</p>}
              {prep?.note && <p className="whitespace-pre-wrap break-words text-muted-foreground">{prep.note}</p>}
              {snapshot?.updated_at && <p className="mt-1 text-xs text-muted-foreground">입력한 작성자: {snapshot.actor?.name ?? "미기록"} · {formatTime(snapshot.updated_at)}</p>}
            </>}
            {suggestion && <div className="mt-3 rounded-lg bg-muted p-3"><p className="font-medium">답변에서 찾은 날짜 {suggestion.date ? `· ${suggestion.date} ${availabilityLabels[suggestion.availability]}` : "· 확인 필요"}</p><p className="whitespace-pre-wrap break-words">“{suggestion.quote || "원문 확인 필요"}”</p><p className="text-muted-foreground">정리에서 원문을 확인하고 반영해주세요.</p></div>}
            {conflicts.length > 0 && <p role="alert" className="mt-2 break-words text-warning-strong">같은 날 본담당 후보가 겹칩니다: {conflicts.map((item) => `${item.date} ${item.job_title}`).join(", ")}. 역할 조정은 관리자가 판단해주세요.</p>}
          </div>;
        })}{!shown.length && <p>일치하는 후보가 없습니다.</p>}</div>
      </>}
    </div>}
    <Modal open={!!editing} onClose={() => void closeEditor()} closeOnOutside={false} busy={saving} title={`${editing?.applicants?.name ?? "후보"} 배차 준비`} description="관리자가 확인한 내용을 기록합니다. 저장으로 문자를 보내거나 근무를 확정하지 않습니다." footer={<Button onClick={() => void save()} disabled={!!conflict} isLoading={saving}>배차 준비 저장</Button>}>
      <div className="space-y-4 text-sm">
        <label className="block space-y-1"><span>기록 작성자</span><input disabled={saving} value={actorName} maxLength={STAFFING_PREPARATION_LIMITS.actor} onChange={(event) => setActorName(event.target.value)} className={fieldClass} placeholder="예: 김매니저" /></label>
        <p className="text-xs text-muted-foreground">공용 계정을 쓰는 팀을 위해 직접 입력한 작성자 이름을 표시합니다. 이 브라우저에서 다음 기록에도 사용합니다.</p>
        {conflict && <div className="space-y-2 rounded-xl border border-warning-strong bg-muted p-3">
          <p className="font-bold">동료의 최신 기록</p>
          <p>입력한 작성자: {conflict.actor?.name ?? "미기록"}{conflict.updated_at && ` · ${formatTime(conflict.updated_at)}`}</p>
          {conflict.preparation ? <PreparationDetails preparation={conflict.preparation} /> : <p>최근 기록을 해석하지 못했어요. 이전 이력도 확인해주세요.</p>}
          <p className="text-muted-foreground">내 입력은 아래에 유지됩니다. 최신 기록을 불러오면 내 초안을 따로 보관하므로 비교하며 다시 정리할 수 있습니다.</p>
          <Button variant="secondary" onClick={() => {
            const latest = parseStaffingPreparation(conflict.preparation) ?? emptyPreparation();
            setPreservedDraft(draft); setDraft(latest); setInitial(JSON.stringify(latest)); setBaseEventId(conflict.event_id);
            setSnapshots((items) => [...items.filter((item) => item.applicant_id !== conflict.applicant_id), conflict]);
            setConflict(null); setSaveError(""); request.current = null;
          }}>최신 기록 불러오기</Button>
        </div>}
        {preservedDraft && <details className="rounded-xl border border-border-strong p-3"><summary className="min-h-11 cursor-pointer font-bold focus-visible:ring-2 focus-visible:ring-ring">보관한 내 초안</summary><PreparationDetails preparation={preservedDraft} /></details>}
        <fieldset disabled={saving} className="space-y-3 rounded-xl border border-border-strong p-3"><legend className="px-1 font-bold">선탑 진행 · 팀 공유</legend>
          <label className="block space-y-1"><span>선탑 진행 상태</span><select value={draft.training.status} onChange={(event) => setDraft((current) => ({ ...current, training: { ...current.training, status: event.target.value as StaffingTraining["status"] } }))} className={fieldClass}>{Object.entries(trainingStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="block space-y-1"><span>선탑 후 본인 백업 진행 의사</span><select value={draft.training.backup_intent} onChange={(event) => setDraft((current) => ({ ...current, training: { ...current.training, backup_intent: event.target.value as StaffingTraining["backup_intent"] } }))} className={fieldClass}>{Object.entries(backupIntentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <p className="text-xs text-muted-foreground">선탑 완료와 본인 진행 희망은 각각 확인해 기록합니다. 실제 투입은 매니저가 별도로 확정합니다.</p>
          <label className="block space-y-1"><span>선탑 지정 일시 (한국시간)</span><input type="datetime-local" value={draft.training.scheduled_at.slice(0, 16)} onChange={(event) => setDraft((current) => ({ ...current, training: { ...current.training, scheduled_at: event.target.value ? `${event.target.value}:00+09:00` : "" } }))} className={fieldClass} /></label>
          <label className="block space-y-1"><span>선탑 첫 상차지</span><input value={draft.training.first_loading_location} maxLength={STAFFING_PREPARATION_LIMITS.training} onChange={(event) => setDraft((current) => ({ ...current, training: { ...current.training, first_loading_location: event.target.value } }))} className={fieldClass} placeholder="매니저가 확인한 선탑 첫 상차지" /></label>
          <label className="block space-y-1"><span>선탑 연결 프로</span><input value={draft.training.linked_pro} maxLength={STAFFING_PREPARATION_LIMITS.training} onChange={(event) => setDraft((current) => ({ ...current, training: { ...current.training, linked_pro: event.target.value } }))} className={fieldClass} placeholder="함께 선탑할 프로 이름·연락 참고" /></label>
          <p className="text-xs text-muted-foreground">위 지정 정보는 매니저가 확인해 입력합니다. 공고의 일반 상차지와 선탑 첫 상차지는 다를 수 있습니다.</p>
        </fieldset>
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
        <label className="block space-y-1"><span>관리자 메모 · 팀 공유</span><textarea disabled={saving} value={draft.note} maxLength={STAFFING_PREPARATION_LIMITS.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} className={`${fieldClass} min-h-24 py-2`} /></label>
        {!!editingSnapshot?.history?.length && <details className="rounded-xl border border-border-strong p-3"><summary className="min-h-11 cursor-pointer font-bold focus-visible:ring-2 focus-visible:ring-ring">팀 변경 이력 {editingSnapshot.history.length}건</summary>
          <ol className="space-y-3">{editingSnapshot.history.map((revision) => <li key={revision.event_id} className="space-y-2 border-t border-border-strong pt-3">
            <p className="text-xs text-muted-foreground">입력한 작성자: {revision.actor?.name ?? "미기록"} · {formatTime(revision.updated_at)}</p>
            {revision.preparation ? <PreparationDetails preparation={revision.preparation} /> : <p className="text-error-strong">이 기록은 내용을 확인하지 못했어요.</p>}
          </li>)}</ol>
        </details>}
        {saveError && <p role="alert" className="text-error-strong">{saveError}</p>}
      </div>
    </Modal>
  </section>;
}
