"use client";

import { Button } from "./ui/button";
import { getStaffingMissingResults } from "@/lib/admin/staffing-missing-results";
import { participationKindLabels, STAFFING_PREPARATION_LIMITS, type StaffingPreparation } from "@/lib/admin/staffing-preparation";

/** Draft-only actions: the existing editor saves with its revision/confirmation safeguards. */
export function StaffingMissingResults({ value, disabled, onChange, onEditSchedule, onRemoveNonParticipation }: {
  value: StaffingPreparation;
  disabled: boolean;
  onChange: (value: StaffingPreparation) => void;
  onEditSchedule: (kind: "training" | "backup") => void;
  onRemoveNonParticipation: (kind: "training" | "backup", date: string) => void;
}) {
  const missing = getStaffingMissingResults(value);
  const nonParticipations = value.non_participations ?? [];
  return <div className="space-y-3">
    {missing.length > 0 && <fieldset disabled={disabled} className="min-w-0 space-y-3 rounded-xl border border-warning/30 bg-warning-soft p-3">
      <legend className="px-1 font-bold">지난 일정의 결과 확인</legend>
      <p className="text-sm text-muted-foreground">날짜는 지났지만 실제 결과가 기록되지 않았어요. 확인한 내용만 선택한 뒤 저장해주세요.</p>
      {missing.map((item) => <div key={`${item.kind}:${item.date}`} className="space-y-2 border-t border-border pt-3">
        <p className="font-medium">{item.date} · {participationKindLabels[item.kind]}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={value.records.length >= STAFFING_PREPARATION_LIMITS.records}
            aria-label={`${item.date} ${participationKindLabels[item.kind]} 참여 기록`}
            onClick={() => onChange({ ...value, records: [...value.records, { id: crypto.randomUUID(), kind: item.kind, date: item.date, note: "" }] })}>참여 기록</Button>
          <Button variant="secondary" disabled={nonParticipations.length >= STAFFING_PREPARATION_LIMITS.records}
            aria-label={`${item.date} ${participationKindLabels[item.kind]} 미참여 기록`}
            onClick={() => onChange({ ...value, non_participations: [...nonParticipations, { ...item, note: "" }] })}>미참여</Button>
          <Button variant="ghost" onClick={() => onEditSchedule(item.kind)}>일정 수정</Button>
        </div>
      </div>)}
      <p className="text-xs text-muted-foreground">참여 기록은 선탑 교육 완료나 새 투입 확정과 별개입니다.</p>
    </fieldset>}
    {nonParticipations.length > 0 && <fieldset disabled={disabled} className="min-w-0 space-y-3 rounded-xl border border-border-strong p-3">
      <legend className="px-1 font-bold">미참여 기록</legend>
      <p className="text-xs text-muted-foreground">실제 참여 횟수에 포함하지 않습니다. 기존 투입 계획은 유지됩니다.</p>
      {nonParticipations.map((item, index) => <div key={`${item.kind}:${item.date}`} className="space-y-2 border-t border-border pt-3">
        <p className="font-medium">{item.date} · {participationKindLabels[item.kind]} 미참여</p>
        <label className="block space-y-1"><span>사유·팀 메모 (선택)</span>
          <textarea aria-label={`${item.date} ${participationKindLabels[item.kind]} 미참여 메모`} value={item.note} maxLength={STAFFING_PREPARATION_LIMITS.note}
            onChange={(event) => onChange({ ...value, non_participations: nonParticipations.map((record, i) => i === index ? { ...record, note: event.target.value } : record) })}
            className="min-h-20 w-full min-w-0 rounded-lg border border-border-strong bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <Button variant="ghost" aria-label={`${item.date} ${participationKindLabels[item.kind]} 미참여 기록 삭제`}
          onClick={() => onRemoveNonParticipation(item.kind, item.date)}>기록 삭제</Button>
      </div>)}
    </fieldset>}
  </div>;
}
