"use client";

import { emptyStaffingFollowUp, followUpContactMethodLabels, staffingToday, STAFFING_PREPARATION_LIMITS, type StaffingFollowUp } from "@/lib/admin/staffing-preparation";
import { Button } from "./ui/button";
import { useConfirm } from "./ConfirmDialog";

const fieldClass = "min-h-11 w-full min-w-0 rounded-lg border border-border-strong bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function staffingFollowUpState(value?: StaffingFollowUp | null, today = staffingToday()) {
  if (!value?.next_action.trim()) return "none";
  if (value.status === "done") return "done";
  return value.due_date && value.due_date <= today ? "due" : "open";
}

export function StaffingFollowUpSummary({ value }: { value?: StaffingFollowUp | null }) {
  if (!value || (!value.next_action && !value.owner && !value.last_contact)) return null;
  const state = staffingFollowUpState(value);
  const label = state === "done" ? "완료한 일" : state === "due" ? (value.due_date < staffingToday() ? "예정일 지남" : "오늘 처리") : "다음 할 일";
  return <div className="space-y-1 break-words rounded-lg bg-muted p-3">
    {value.next_action && <p className={`font-medium ${state === "due" ? "text-warning-strong" : ""}`}>{label}: {value.next_action}</p>}
    {(value.owner || value.next_action) && <p className="text-muted-foreground">담당자: {value.owner || "미지정"}{value.next_action && ` · ${value.due_date ? `예정일 ${value.due_date}` : "예정일 미정"}`}</p>}
    {value.last_contact && <><p className="text-muted-foreground">최근 연락: {value.last_contact.date} · {followUpContactMethodLabels[value.last_contact.method]}</p><p className="whitespace-pre-wrap">{value.last_contact.result}</p></>}
  </div>;
}

export function StaffingFollowUpFields({ value, onChange, disabled }: { value?: StaffingFollowUp | null; onChange: (value: StaffingFollowUp | null) => void; disabled: boolean }) {
  const confirm = useConfirm();
  const current = value ?? emptyStaffingFollowUp();
  const update = (patch: Partial<StaffingFollowUp>) => onChange({ ...current, ...patch });
  return <fieldset disabled={disabled} className="min-w-0 space-y-3 rounded-xl border border-border-strong p-3">
    <legend className="px-1 font-bold">연락 결과 · 다음 할 일</legend>
    {current.last_contact ? <>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="block min-w-0 space-y-1"><span>최근 연락 일자</span><input type="date" max={staffingToday()} value={current.last_contact.date} onChange={(event) => update({ last_contact: { ...current.last_contact!, date: event.target.value } })} className={fieldClass} /></label>
        <label className="block min-w-0 space-y-1"><span>연락 방법</span><select value={current.last_contact.method} onChange={(event) => update({ last_contact: { ...current.last_contact!, method: event.target.value as NonNullable<StaffingFollowUp["last_contact"]>["method"] } })} className={fieldClass}>{Object.entries(followUpContactMethodLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      </div>
      <label className="block space-y-1"><span>연락 결과</span><textarea value={current.last_contact.result} maxLength={STAFFING_PREPARATION_LIMITS.followUpResult} onChange={(event) => update({ last_contact: { ...current.last_contact!, result: event.target.value } })} className={`${fieldClass} min-h-20 py-2`} placeholder="예: 부재중. 내일 오전 통화 요청 / 9월 16일 선탑 희망" /></label>
    </> : <Button variant="secondary" onClick={() => update({ last_contact: { date: staffingToday(), method: "phone", result: "" } })}>연락 기록 추가</Button>}
    <label className="block space-y-1"><span>다음 할 일</span><input value={current.next_action} maxLength={STAFFING_PREPARATION_LIMITS.followUpAction} onChange={(event) => update({ next_action: event.target.value, ...(!event.target.value.trim() ? { due_date: "", status: "open" as const } : {}) })} className={fieldClass} placeholder="예: 선탑 첫 상차지 확인 후 전화 안내" /></label>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className="block min-w-0 space-y-1"><span>후속 담당자</span><input value={current.owner} maxLength={STAFFING_PREPARATION_LIMITS.followUpOwner} onChange={(event) => update({ owner: event.target.value })} className={fieldClass} placeholder="예: 김매니저" /></label>
      <label className="block min-w-0 space-y-1"><span>처리 예정일</span><input type="date" value={current.due_date} disabled={!current.next_action.trim()} onChange={(event) => update({ due_date: event.target.value })} className={fieldClass} /></label>
    </div>
    <label className="flex min-h-11 items-center gap-3 rounded-lg bg-muted px-3 py-2"><input type="checkbox" checked={current.status === "done"} disabled={!current.next_action.trim()} onChange={(event) => update({ status: event.target.checked ? "done" : "open" })} className="size-5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /><span>할 일 완료</span></label>
    <p className="text-xs text-muted-foreground">팀이 확인한 연락 결과를 기록하세요. 할 일 완료와 선탑·투입 확정은 별도로 관리합니다.</p>
    {value && <Button variant="ghost" onClick={async () => {
      if (await confirm({ title: "연락·할 일 기록을 비울까요?", description: "저장 후 현재 기록에서 비워집니다. 이전 저장 내용은 팀 변경 이력에 남습니다.", confirmText: "기록 비우기", destructive: true })) onChange(null);
    }}>연락·할 일 비우기</Button>}
  </fieldset>;
}
