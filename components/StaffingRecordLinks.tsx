"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { StaffingCandidate } from "./StaffingPreparationPanel";
import { Button } from "./ui/button";

// 상세 패널을 다시 여는 기존 공고 보드와 순환 로딩하지 않도록 편집기는 필요할 때만 불러온다.
const StaffingRecordEditor = dynamic(
  () => import("./StaffingPreparationPanel").then((module) => module.StaffingPreparationPanel),
  { loading: () => <p role="status" className="mt-2 text-xs text-muted-foreground">기록창을 여는 중…</p> },
);

export function StaffingRecordLinks({
  jobId, jobTitle, candidate, allowNewConfirmation, disabled = false, compact = false,
  onChanged, onDirtyChange,
}: {
  jobId: number;
  jobTitle: string;
  candidate: StaffingCandidate;
  allowNewConfirmation: boolean;
  disabled?: boolean;
  compact?: boolean;
  onChanged?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  return <section aria-label="선택 공고 진행 기록" className={compact ? "shrink-0 border-b border-border-strong bg-card px-4 py-3" : "min-w-0 rounded-2xl border border-border-strong bg-card p-3.5"}>
    <p className="mb-2 break-words text-xs text-muted-foreground">{jobTitle}</p>
    <Button ref={triggerRef} variant="secondary" className="min-h-11 w-full" disabled={disabled} onClick={() => setOpen(true)}>연락·선탑·투입 기록</Button>
    {!compact && <p className="mt-2 text-xs text-muted-foreground">연락한 내용부터 실제 참여 결과까지, 이 공고의 기록을 팀과 공유하세요.</p>}
    {open && <StaffingRecordEditor
      key={`${jobId}:${candidate.applicant_id}`}
      recordOnly
      jobId={jobId}
      jobTitle={jobTitle}
      candidates={[candidate]}
      initialApplicantId={candidate.applicant_id}
      allowEmptyInitialRecord
      allowNewConfirmation={allowNewConfirmation}
      onRecordClose={close}
      onRecordSaved={onChanged}
      onRecordDirtyChange={onDirtyChange}
    />}
  </section>;
}
