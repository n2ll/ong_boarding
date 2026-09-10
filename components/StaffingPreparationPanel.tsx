"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { useConfirm } from "./ConfirmDialog";
import { ApplicantDetailPanel } from "./ApplicantDetailPanel";
import { StaffingFollowUpFields, StaffingFollowUpSummary, staffingFollowUpState } from "./StaffingFollowUpFields";
import { emptyStaffingTraining, trainingStatusLabels, backupIntentLabels, participationKindLabels, staffingToday, type StaffingParticipationRecord, type StaffingTraining, applyStaffingSuggestion, type StaffingSuggestion, type StaffingPrimaryCandidate, parseStaffingPreparation, STAFFING_PREPARATION_LIMITS, type StaffingPreparation, type StaffingPreparationDate, type StaffingPreparationSnapshot } from "@/lib/admin/staffing-preparation";

type Candidate = {
  applicant_id: number;
  agent_stage?: string | null;
  responded_at: string | null;
  applicants: { name: string; own_vehicle: string | null; phone?: string | null } | null;
};
const availabilityLabels = { unknown: "미확인", available: "가능", unavailable: "불가" };
const roleLabels = { unassigned: "역할 미정", primary_candidate: "본담당 후보", reserve_candidate: "예비 후보" };
const emptyPreparation = (): StaffingPreparation => ({ source: "manager", dates: [], training_availability: "", training: emptyStaffingTraining(), records: [], note: "" });
const fieldClass = "min-h-11 w-full min-w-0 rounded-lg border border-border-strong bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const AUTHOR_STORAGE_KEY = "ongboarding:staffing-author:v1";
const formatTime = (at: string) => new Date(at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
const nextTrainingAction = (preparation?: StaffingPreparation | null) => {
  const training = preparation?.training ?? emptyStaffingTraining();
  if (training.status === "on_hold" || training.backup_intent === "declined") return "보류·거절 내용을 확인한 뒤 연락 여부 검토";
  if (training.status === "completed") return training.backup_intent === "unknown" ? "선탑 후 본인의 백업 진행 의사 확인" : "본인 의사에 따라 백업 후보 검토";
  if (training.status === "scheduled") return "선탑 일시·첫 상차지·연결 프로를 대화에서 안내";
  if (training.status === "coordinating" || preparation?.training_availability) return "문자나 전화로 선탑 일시·첫 상차지·연결 프로 조율";
  return "원문에서 선탑 참여 의사·본인 가능 시간 확인";
};
function PreparationDetails({ preparation }: { preparation: StaffingPreparation }) {
  const training = preparation.training ?? emptyStaffingTraining();
  return <div className="space-y-1 break-words">
    <p className="font-medium">{trainingStatusLabels[training.status]} · {backupIntentLabels[training.backup_intent]}</p>
    <p>선탑 가능 시간: {preparation.training_availability || "미확인"}</p>
    {training.scheduled_at && <p>선탑 지정 일시: {formatTime(training.scheduled_at)} (한국시간)</p>}
    {training.first_loading_location && <p>선탑 첫 상차지: {training.first_loading_location}</p>}
    {training.linked_pro && <p>선탑 연결 프로: {training.linked_pro}</p>}
    {preparation.dates.length > 0 && <p>날짜별 후보: {preparation.dates.map((day) => `${day.date} ${availabilityLabels[day.availability]} · ${roleLabels[day.role]}${day.confirmation === "confirmed" ? " · 투입 확정" : ""}`).join(" / ")}</p>}
    <p className="font-medium">실제 참여 {(preparation.records ?? []).length}건</p>
    <ul className="space-y-1">{(preparation.records ?? []).map((record) => <li key={record.id} className="whitespace-pre-wrap">{record.date} · {participationKindLabels[record.kind]}{record.note && ` · ${record.note}`}</li>)}</ul>
    <StaffingFollowUpSummary value={preparation.follow_up} />
    {preparation.note && <p className="whitespace-pre-wrap text-muted-foreground">{preparation.note}</p>}
  </div>;
}

export function StaffingPreparationPanel({ jobId, jobTitle, candidates, initialDate = "", initialOpen = false, allowNewConfirmation = true }: { jobId: number; jobTitle?: string; candidates: Candidate[]; initialDate?: string; initialOpen?: boolean; allowNewConfirmation?: boolean }) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(initialOpen);
  const [snapshots, setSnapshots] = useState<StaffingPreparationSnapshot[]>([]);
  const [suggestions, setSuggestions] = useState<StaffingSuggestion[]>([]);
  const [otherPrimaries, setOtherPrimaries] = useState<StaffingPrimaryCandidate[]>([]);
  const [conflictCheckIncomplete, setConflictCheckIncomplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [date, setDate] = useState(initialDate);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Candidate | null>(null);
  const [editorMode, setEditorMode] = useState<"preparation" | "follow_up">("preparation");
  const [followUpFilter, setFollowUpFilter] = useState("all");
  const [ownerQuery, setOwnerQuery] = useState("");
  const [contactCandidate, setContactCandidate] = useState<Candidate | null>(null);
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
  const startEditing = (candidate: Candidate, mode: "preparation" | "follow_up" = "preparation") => {
    const snapshot = snapshots.find((item) => item.applicant_id === candidate.applicant_id);
    const saved = parseStaffingPreparation(snapshot?.preparation) ?? emptyPreparation();
    setBaseEventId(snapshot?.event_id ?? null); setConflict(null); setPreservedDraft(null);
    const hasSuggestion = suggestions.some((item) => item.applicant_id === candidate.applicant_id && item.date === date);
    const next = mode === "preparation" && date && !hasSuggestion && saved.dates.length < STAFFING_PREPARATION_LIMITS.dates && !saved.dates.some((item) => item.date === date)
      ? { ...saved, dates: [...saved.dates, { date, availability: "unknown" as const, role: "unassigned" as const }] } : saved;
    setEditorMode(mode); setEditing(candidate); setDraft(next); setInitial(JSON.stringify(next)); setSaveError(""); request.current = null;
  };
  const closeEditor = async () => {
    if (saving) return;
    if ((JSON.stringify(draft) !== initial || preservedDraft) && !await confirm({ title: "저장하지 않은 변경이 있어요", description: "배차 준비 내용을 버리고 닫을까요?", confirmText: "변경 버리기", destructive: true })) return;
    setEditing(null);
  };
  const updateDate = (index: number, patch: Partial<StaffingPreparationDate>) => setDraft((current) => ({ ...current, dates: current.dates.map((item, i) => {
    if (i !== index) return item;
    const next = { ...item, ...patch };
    if (next.availability !== "available") next.role = "unassigned";
    if (next.role !== "primary_candidate" && next.confirmation) next.confirmation = "unconfirmed";
    return next;
  }) }));
  const updateRecord = (id: string, patch: Partial<Omit<StaffingParticipationRecord, "id">>) => {
    setDraft((current) => ({ ...current, records: current.records.map((record) => record.id === id ? { ...record, ...patch } : record) }));
    setSaveError("");
  };
  const removeRecord = async (id: string) => {
    if (!await confirm({ title: "실제 참여 기록을 삭제할까요?", description: "저장하면 현재 목록에서 삭제됩니다. 이전에 저장한 내용은 팀 변경 이력에서 확인할 수 있습니다.", confirmText: "삭제", destructive: true })) return;
    setDraft((current) => ({ ...current, records: current.records.filter((record) => record.id !== id) }));
  };
  const save = async () => {
    if (!editing || saving || conflict) return;
    if (draft.records.some((record) => !record.date || record.date > staffingToday())) { setSaveError("실제 참여 일자는 오늘까지의 날짜로 빠짐없이 입력해주세요. (한국시간 기준)"); return; }
    if (draft.follow_up?.last_contact && (!draft.follow_up.last_contact.date || draft.follow_up.last_contact.date > staffingToday() || !draft.follow_up.last_contact.result.trim())) {
      setSaveError("연락 결과와 오늘까지의 실제 연락 일자를 입력해주세요. (한국시간 기준)"); return;
    }
    const normalized = parseStaffingPreparation(draft);
    if (!normalized) { setSaveError("날짜가 유효하고 중복되지 않는지, 연락 결과와 다음 할 일 입력이 올바른지 확인해주세요."); return; }
    if (!actorName.trim()) { setSaveError("팀에 공유할 기록 작성자 이름을 입력해주세요."); return; }
    const previous = parseStaffingPreparation(JSON.parse(initial));
    const before = new Set(previous?.dates.filter((day) => day.confirmation === "confirmed").map((day) => day.date));
    const after = new Set(normalized.dates.filter((day) => day.confirmation === "confirmed").map((day) => day.date));
    const added = [...after].filter((day) => !before.has(day));
    const removed = [...before].filter((day) => !after.has(day));
    if (added.length && (!allowNewConfirmation || editing.agent_stage === "abort")) { setSaveError("마감된 공고나 중단된 후보는 새로 투입 확정할 수 없습니다. 기존 확정 취소와 메모 수정은 가능합니다."); return; }
    if (added.length || removed.length) {
      setSaving(true);
      const approved = await confirm({
        title: added.length ? "날짜별 투입을 확정할까요?" : "날짜별 투입 확정을 취소할까요?",
        description: `${jobTitle ?? "현재 공고"} · ${editing.applicants?.name ?? "후보"}\n${added.length ? `확정: ${added.join(", ")}\n` : ""}${removed.length ? `확정 취소: ${removed.join(", ")}\n` : ""}관리자가 지원자와 협의한 날짜인지 확인해주세요. 이 저장으로 문자는 발송되지 않습니다.`,
        confirmText: added.length ? "확정하고 저장" : "취소하고 저장", destructive: !added.length,
      });
      if (!approved) { setSaving(false); return; }
    }
    try { localStorage.setItem(AUTHOR_STORAGE_KEY, actorName.trim()); } catch { /* Saving still works without local storage. */ }
    const payload = { applicant_id: editing.applicant_id, base_event_id: baseEventId, actor_name: actorName.trim(), confirmation_version: 1,
      dates: normalized.dates, training_availability: normalized.training_availability, training: normalized.training, records: normalized.records, note: normalized.note, follow_up: normalized.follow_up ?? null };
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
      setEditing(null); setRetry((value) => value + 1); toast.success(editorMode === "follow_up" ? "연락·할 일을 팀에 공유했어요." : "배차 준비를 저장했어요.");
      window.dispatchEvent(new Event("ongboarding:staffing-updated"));
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
  const shown = candidates.filter((item) => {
    const prep = snapshots.find((snapshot) => snapshot.applicant_id === item.applicant_id)?.preparation;
    const followUpState = staffingFollowUpState(prep?.follow_up);
    return (item.applicants?.name ?? "").includes(query.trim())
      && (!statusFilter || (prep?.training?.status ?? "reviewing") === statusFilter)
      && (prep?.follow_up?.owner ?? "").includes(ownerQuery.trim())
      && (followUpFilter === "all" || (followUpFilter === "open" ? followUpState === "open" || followUpState === "due" : followUpState === followUpFilter));
  });
  const counts = snapshots.flatMap((item) => item.preparation?.dates.filter((day) => day.date === date) ?? []);
  const contactActions = (candidate: Candidate) => {
    const phone = candidate.applicants?.phone?.replace(/[^0-9+]/g, "");
    const name = candidate.applicants?.name ?? "후보";
    return <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={saving} onClick={() => setContactCandidate(candidate)} aria-label={`${name} 선탑 대화 열기`}>대화 열기</Button>
      {phone ? <a href={`tel:${phone}`} aria-label={`${name}에게 전화하기`} className="inline-flex min-h-11 items-center rounded-lg border border-border-strong bg-background px-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">전화하기</a> : <span className="flex min-h-11 items-center text-muted-foreground">전화번호 미등록</span>}
    </div>;
  };
  return <section className="rounded-2xl border border-border-strong bg-card p-4" onKeyDown={(event) => { if (editing || contactCandidate) event.stopPropagation(); }}>
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex min-h-11 w-full items-center justify-between gap-3 text-left font-bold focus-visible:ring-2 focus-visible:ring-ring">날짜별 배차 준비 <span className="text-sm text-muted-foreground">{open ? "접기" : "펼치기"}</span></button>
    {open && <div className="mt-3 space-y-3 text-sm">
      <p className="text-muted-foreground">답장을 확인한 뒤 가능한 날짜와 선탑 진행을 정리하세요. 선탑 후 백업 진행은 본인이 선택합니다. 본담당·예비는 후보 구분이며, 관리자가 ‘날짜별 투입 확정’을 체크하고 저장한 날짜만 충원판에 반영합니다.</p>
      {loading ? <p role="status">배차 준비 불러오는 중…</p> : loadError ? <div role="alert"><p>{loadError}</p><Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>다시 조회</Button></div> : <>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-muted-foreground">답변 제안과 다른 공고 기록은 조회 시점 기준입니다.</p><Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>새로 확인</Button></div>
        {conflictCheckIncomplete && <p role="alert" className="text-warning-strong">다른 공고의 일부 기록을 확인하지 못했어요. 본담당 후보가 겹치는지 직접 확인해주세요.</p>}
        <label className="block space-y-1"><span>비교할 날짜</span><input aria-label="비교할 날짜" type="date" value={date} onChange={(event) => setDate(event.target.value)} className={fieldClass} /></label>
        {dates.length > 0 && <div className="flex flex-wrap gap-2">{dates.map((day) => <button key={day} type="button" aria-pressed={date === day} onClick={() => setDate(day)} className={`min-h-11 rounded-lg border px-3 focus-visible:ring-2 focus-visible:ring-ring ${date === day ? "bg-primary text-primary-foreground" : "bg-background"}`}>{day.slice(5).replace("-", "/")}</button>)}</div>}
        {date && <p role="status">{date} · 확정 {counts.filter((item) => item.confirmation === "confirmed").length}명 · 본담당 후보 {counts.filter((item) => item.role === "primary_candidate").length}명 · 예비 후보 {counts.filter((item) => item.role === "reserve_candidate").length}명</p>}
        <input aria-label="배차 준비 후보 이름 검색" placeholder="이름 검색" value={query} onChange={(event) => setQuery(event.target.value)} className={fieldClass} />
        <label className="block space-y-1"><span>선탑 진행 필터</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className={fieldClass}><option value="">모든 진행 상태</option>{Object.entries(trainingStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="block min-w-0 space-y-1"><span>후속 할 일 필터</span><select value={followUpFilter} onChange={(event) => setFollowUpFilter(event.target.value)} className={fieldClass}><option value="all">모든 후보</option><option value="open">미완료 할 일</option><option value="due">오늘까지 처리할 일</option><option value="done">완료한 일</option></select></label>
          <label className="block min-w-0 space-y-1"><span>담당자 검색</span><input value={ownerQuery} onChange={(event) => setOwnerQuery(event.target.value)} className={fieldClass} placeholder="담당자 이름" /></label>
        </div>
        <div className="max-h-96 space-y-2 overflow-y-auto">{shown.map((candidate) => {
          const snapshot = snapshots.find((item) => item.applicant_id === candidate.applicant_id);
          const prep = snapshot?.preparation;
          const day = prep?.dates.find((item) => item.date === date);
          const suggestion = suggestions.find((item) => item.applicant_id === candidate.applicant_id);
          const conflicts = conflictsFor(candidate.applicant_id, prep);
          return <div key={candidate.applicant_id} className="rounded-xl border border-border-strong p-3">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0 break-words"><p className="font-bold">{candidate.applicants?.name ?? "이름 미등록"}</p><p className="text-muted-foreground">{candidate.applicants?.own_vehicle || "차량 미확인"}</p></div><Button variant="secondary" onClick={() => startEditing(candidate)} aria-label={`${candidate.applicants?.name ?? "후보"} 배차 준비 편집`}>정리</Button></div>
            {snapshot?.invalid ? <p role="alert" className="text-error-strong">최근 기록을 확인할 수 없어요. 내용을 다시 확인하고 저장해주세요.</p> : <>
              <p className="mt-2">{date ? `${availabilityLabels[day?.availability ?? "unknown"]} · ${roleLabels[day?.role ?? "unassigned"]}${day?.confirmation === "confirmed" ? " · 투입 확정" : ""}` : `날짜 ${prep?.dates.length ?? 0}건 기록`}</p>
              <p className="mt-1 font-medium">{trainingStatusLabels[prep?.training?.status ?? "reviewing"]} · {backupIntentLabels[prep?.training?.backup_intent ?? "unknown"]}</p>
              <p className="break-words">선탑 가능 시간: {prep?.training_availability || "미확인"}</p>
              {prep?.training?.scheduled_at && <p>선탑 지정: {formatTime(prep.training.scheduled_at)}</p>}
              <p className="mt-1">실제 참여: 선탑 {prep?.records?.filter((record) => record.kind === "training").length ?? 0}건 · 백업 {prep?.records?.filter((record) => record.kind === "backup").length ?? 0}건</p>
              <div className="mt-2"><StaffingFollowUpSummary value={prep?.follow_up} /></div>
              {!prep?.follow_up?.next_action && <p className="mt-2 text-info">다음 확인: {nextTrainingAction(prep)}</p>}
              {prep?.note && <p className="whitespace-pre-wrap break-words text-muted-foreground">{prep.note}</p>}
              {snapshot?.updated_at && <p className="mt-1 text-xs text-muted-foreground">입력한 작성자: {snapshot.actor?.name ?? "미기록"} · {formatTime(snapshot.updated_at)}</p>}
            </>}
            {suggestion && <div className="mt-3 rounded-lg bg-muted p-3"><p className="font-medium">{suggestion.kind === "training" ? "선탑 관련 답변 · 원문 확인" : `답변에서 찾은 날짜 ${suggestion.date ? `· ${suggestion.date} ${availabilityLabels[suggestion.availability]}` : "· 확인 필요"}`}</p><p className="whitespace-pre-wrap break-words">“{suggestion.quote || "원문 확인 필요"}”</p><p className="text-muted-foreground">정리에서 원문을 확인하고 반영해주세요.</p></div>}
            <div className="mt-3 flex flex-wrap gap-2">{contactActions(candidate)}<Button variant="secondary" disabled={snapshot?.invalid} onClick={() => startEditing(candidate, "follow_up")} aria-label={`${candidate.applicants?.name ?? "후보"} 연락·할 일 기록`}>연락·할 일 기록</Button></div>
            {conflicts.length > 0 && <p role="alert" className="mt-2 break-words text-warning-strong">같은 날 본담당 후보가 겹칩니다: {conflicts.map((item) => `${item.date} ${item.job_title}`).join(", ")}. 역할 조정은 관리자가 판단해주세요.</p>}
          </div>;
        })}{!shown.length && <p>일치하는 후보가 없습니다.</p>}</div>
      </>}
    </div>}
    <Modal open={!!editing && !contactCandidate} onClose={() => void closeEditor()} closeOnOutside={false} busy={saving} title={`${editing?.applicants?.name ?? "후보"} ${editorMode === "follow_up" ? "연락·다음 할 일" : "배차 준비"}`} description={editorMode === "follow_up" ? "연락한 내용과 누가 언제 이어서 처리할지 팀에 공유하세요." : "관리자가 확인한 내용을 기록합니다. 날짜별 확정은 체크 후 확인하며, 저장으로 문자를 보내지는 않습니다."} footer={<Button onClick={() => void save()} disabled={!!conflict} isLoading={saving}>{editorMode === "follow_up" ? "연락·할 일 저장" : "배차 준비 저장"}</Button>}>
      <div className="space-y-4 text-sm">
        <div className="space-y-2 rounded-xl border border-border-strong bg-muted p-3">
          {editorMode === "preparation" && <><p className="font-bold">다음 확인: {nextTrainingAction(draft)}</p><p>선탑 의사와 가능한 시간을 확인한 뒤 매니저가 직접 연락해 실제 일정을 조율합니다.</p></>}
          {editing && contactActions(editing)}
          <p className="text-xs text-muted-foreground">대화를 닫으면 입력 중인 기록으로 돌아옵니다. 연락 후 결과를 직접 남겨주세요.</p>
        </div>
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
        <StaffingFollowUpFields value={draft.follow_up} disabled={saving} onChange={(follow_up) => { setDraft((current) => ({ ...current, follow_up })); setSaveError(""); }} />
        {editorMode === "preparation" && <>
        {editingConflicts.length > 0 && <div role="alert" className="rounded-xl border border-warning-strong p-3 text-warning-strong"><p className="font-bold">같은 날 본담당 후보가 겹칩니다</p>{editingConflicts.map((item) => <p key={`${item.job_id}:${item.date}`} className="break-words">{item.date} · {item.job_title}</p>)}<p>다른 공고의 조회 시점 기록입니다. 본담당·예비 역할은 관리자가 판단하며 저장을 계속할 수 있습니다.</p></div>}
        {conflictCheckIncomplete && <p role="alert" className="text-warning-strong">다른 공고의 일부 기록을 확인하지 못했어요. 중복 후보를 직접 확인해주세요.</p>}
        {draft.dates.map((day, index) => <fieldset key={index} disabled={saving} className="min-w-0 space-y-2 rounded-xl border p-3"><legend className="px-1">가능 날짜 {index + 1}</legend>
          <input aria-label={`날짜 ${index + 1}`} type="date" value={day.date} onChange={(event) => updateDate(index, { date: event.target.value })} className={fieldClass} />
          <select aria-label={`가능 여부 ${index + 1}`} value={day.availability} onChange={(event) => updateDate(index, { availability: event.target.value as StaffingPreparationDate["availability"] })} className={fieldClass}>{Object.entries(availabilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label={`후보 역할 ${index + 1}`} value={day.role} disabled={day.availability !== "available"} onChange={(event) => updateDate(index, { role: event.target.value as StaffingPreparationDate["role"] })} className={fieldClass}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <label className="flex min-h-11 items-center gap-3 rounded-lg bg-muted px-3 py-2"><input type="checkbox" aria-label={`날짜별 투입 확정 ${index + 1}`} checked={day.confirmation === "confirmed"} disabled={day.availability !== "available" || day.role !== "primary_candidate" || (day.confirmation !== "confirmed" && (!allowNewConfirmation || editing?.agent_stage === "abort"))} onChange={(event) => updateDate(index, { confirmation: event.target.checked ? "confirmed" : "unconfirmed" })} className="size-5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /><span>날짜별 투입 확정</span></label>
          <p className="text-xs text-muted-foreground">{!allowNewConfirmation || editing?.agent_stage === "abort" ? "현재 새 확정은 불가합니다. 기존 확정 취소와 메모 수정은 가능합니다." : "가능한 본담당 후보만 확정할 수 있습니다. 지원자와 협의 후 체크해주세요."}</p>
          <Button variant="ghost" onClick={() => setDraft((current) => ({ ...current, dates: current.dates.filter((_, i) => i !== index) }))}>날짜 삭제</Button>
        </fieldset>)}
        <Button variant="secondary" disabled={saving || draft.dates.length >= STAFFING_PREPARATION_LIMITS.dates} onClick={() => setDraft((current) => ({ ...current, dates: [...current.dates, { date: "", availability: "unknown", role: "unassigned" }] }))}>날짜 추가</Button>
        <fieldset disabled={saving} className="space-y-3 rounded-xl border border-border-strong p-3"><legend className="px-1 font-bold">선탑 진행 · 팀 공유</legend>
          <label className="block space-y-1"><span>선탑 진행 상태</span><select value={draft.training.status} onChange={(event) => setDraft((current) => ({ ...current, training: { ...current.training, status: event.target.value as StaffingTraining["status"] } }))} className={fieldClass}>{Object.entries(trainingStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="block space-y-1"><span>선탑 후 본인 백업 진행 의사</span><select value={draft.training.backup_intent} onChange={(event) => setDraft((current) => ({ ...current, training: { ...current.training, backup_intent: event.target.value as StaffingTraining["backup_intent"] } }))} className={fieldClass}>{Object.entries(backupIntentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <p className="text-xs text-muted-foreground">선탑 완료와 본인 진행 희망은 각각 확인해 기록합니다. 실제 투입은 매니저가 별도로 확정합니다.</p>
          <label className="block space-y-1"><span>선탑 지정 일시 (한국시간)</span><input type="datetime-local" value={draft.training.scheduled_at.slice(0, 16)} onChange={(event) => setDraft((current) => ({ ...current, training: { ...current.training, scheduled_at: event.target.value ? `${event.target.value}:00+09:00` : "" } }))} className={fieldClass} /></label>
          <label className="block space-y-1"><span>선탑 첫 상차지</span><input value={draft.training.first_loading_location} maxLength={STAFFING_PREPARATION_LIMITS.training} onChange={(event) => setDraft((current) => ({ ...current, training: { ...current.training, first_loading_location: event.target.value } }))} className={fieldClass} placeholder="매니저가 확인한 선탑 첫 상차지" /></label>
          <label className="block space-y-1"><span>선탑 연결 프로</span><input value={draft.training.linked_pro} maxLength={STAFFING_PREPARATION_LIMITS.training} onChange={(event) => setDraft((current) => ({ ...current, training: { ...current.training, linked_pro: event.target.value } }))} className={fieldClass} placeholder="함께 선탑할 프로 이름·연락 참고" /></label>
          <p className="text-xs text-muted-foreground">위 지정 정보는 매니저가 확인해 입력합니다. 공고의 일반 상차지와 선탑 첫 상차지는 다를 수 있습니다.</p>
        </fieldset>
        <fieldset disabled={saving} className="min-w-0 space-y-3 rounded-xl border border-border-strong p-3"><legend className="px-1 font-bold">실제 참여 이력</legend>
          <p className="text-muted-foreground">실제로 참여한 선탑과 수행한 백업을 기록하세요. 예정 일시는 선탑 진행에서 조율하고, 실제 참여 일자는 참여 후 입력합니다.</p>
          {!draft.records.length && <p>아직 기록한 실제 참여가 없습니다.</p>}
          {draft.records.map((record, index) => <fieldset key={record.id} className="min-w-0 space-y-2 rounded-xl border border-border-strong p-3"><legend className="px-1 font-medium">참여 기록 {index + 1}</legend>
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              <label className="block min-w-0 space-y-1"><span>참여 종류</span><select aria-label={`참여 종류 ${index + 1}`} value={record.kind} onChange={(event) => updateRecord(record.id, { kind: event.target.value as StaffingParticipationRecord["kind"] })} className={fieldClass}>{Object.entries(participationKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="block min-w-0 space-y-1"><span>실제 참여 일자 (한국시간)</span><input aria-label={`실제 참여 일자 ${index + 1}`} type="date" max={staffingToday()} value={record.date} onChange={(event) => updateRecord(record.id, { date: event.target.value })} className={fieldClass} /></label>
            </div>
            <label className="block min-w-0 space-y-1"><span>참여 비고</span><textarea aria-label={`참여 비고 ${index + 1}`} value={record.note} maxLength={STAFFING_PREPARATION_LIMITS.note} onChange={(event) => updateRecord(record.id, { note: event.target.value })} className={`${fieldClass} min-h-20 py-2`} placeholder="예: 실제 교육·배송 라인, 함께한 프로, 수행 내용" /></label>
            <Button variant="ghost" aria-label={`참여 기록 ${index + 1} 삭제`} onClick={() => void removeRecord(record.id)}>기록 삭제</Button>
          </fieldset>)}
          <Button variant="secondary" disabled={draft.records.length >= STAFFING_PREPARATION_LIMITS.records} onClick={() => setDraft((current) => ({ ...current, records: [...current.records, { id: crypto.randomUUID(), kind: "training", date: "", note: "" }] }))}>실제 참여 추가</Button>
          <p className="text-xs text-muted-foreground">수정·삭제 전 저장 내용은 아래 팀 변경 이력에 남습니다.</p>
        </fieldset>
        {editingSuggestion && <div className="space-y-2 rounded-xl border border-border-strong bg-muted p-3">
          <p className="font-bold">{editingSuggestion.kind === "training" ? "선탑 관련 답변 · 원문 확인" : "수신 답변에서 찾은 제안"}</p>
          <p className="whitespace-pre-wrap break-words">“{editingSuggestion.quote || "원문 확인 필요"}”</p>
          {editingSuggestion.source_created_at && <p className="text-xs text-muted-foreground">수신 문자 · {new Date(editingSuggestion.source_created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>}
          {editingSuggestion.date ? <>
            <p>{editingSuggestion.date} · {availabilityLabels[editingSuggestion.availability]} · 역할 미정</p>
            <Button variant="secondary" disabled={saving || draft.dates.some((day) => day.date === editingSuggestion.date) || draft.dates.length >= STAFFING_PREPARATION_LIMITS.dates}
              onClick={() => setDraft((current) => applyStaffingSuggestion(current, editingSuggestion))}>원문 확인 후 초안에 반영</Button>
            <p className="text-muted-foreground">이미 입력한 날짜는 유지합니다. 반영 후 날짜를 확인하고 아래에서 저장해주세요.</p>
          </> : <p className="text-warning-strong">확인 필요: {editingSuggestion.reason} 날짜는 직접 정리해주세요.</p>}
        </div>}
        <label className="block space-y-1"><span>선탑 가능 시간</span><input disabled={saving} value={draft.training_availability} maxLength={STAFFING_PREPARATION_LIMITS.training} onChange={(event) => setDraft((current) => ({ ...current, training_availability: event.target.value }))} className={fieldClass} placeholder="예: 9/16 오전 동승 가능 · 일정 조율 필요" /></label>
        </>}
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
    {/* 후보 보드의 transform·z-index 밖에 띄워 모바일 내비가 대화창을 가리지 않게 한다. */}
    {contactCandidate && createPortal(<div className="relative z-50">
      <ApplicantDetailPanel isOpen applicantId={contactCandidate.applicant_id} jobId={jobId} initialTab="chat" onClose={() => setContactCandidate(null)} onChanged={() => setRetry((value) => value + 1)} />
    </div>, document.body)}
  </section>;
}
