"use client";

import { useEffect, useState } from "react";
import { buildStaffingReplacementComparison } from "@/lib/admin/staffing-replacement-comparison";
import { backupIntentLabels, staffingToday, trainingStatusLabels, type StaffingPreparationSnapshot, type StaffingPrimaryCandidate } from "@/lib/admin/staffing-preparation";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";

type Candidate = {
  applicant_id: number;
  agent_stage?: string | null;
  applicants: { name: string; own_vehicle: string | null; vehicle_type?: string | null } | null;
};
const availabilityLabels = { unknown: "미확인", available: "가능 기록", unavailable: "불가 기록" };
const roleLabels = { unassigned: "역할 미정", primary_candidate: "본담당 후보", reserve_candidate: "예비 후보" };

export function StaffingReplacementComparison({ date, jobTitle, candidates, snapshots, otherPrimaries, conflictCheckIncomplete, onOpenRecord }: {
  date: string;
  jobTitle?: string;
  candidates: Candidate[];
  snapshots: StaffingPreparationSnapshot[];
  otherPrimaries: StaffingPrimaryCandidate[];
  conflictCheckIncomplete: boolean;
  onOpenRecord: (applicantId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [absentApplicantId, setAbsentApplicantId] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(3);
  const comparison = buildStaffingReplacementComparison({ date, today: staffingToday(), absentApplicantId, candidates, snapshots, otherPrimaries });
  const validSelection = absentApplicantId !== null && comparison.confirmedApplicantIds.includes(absentApplicantId);
  useEffect(() => { if (!validSelection) setAbsentApplicantId(null); }, [validSelection]);
  const byApplicant = new Map(candidates.map((candidate) => [candidate.applicant_id, candidate]));
  const bySnapshot = new Map(snapshots.map((snapshot) => [snapshot.applicant_id, snapshot]));
  const remaining = Math.max(0, comparison.alternatives.length - visibleCount);
  return <div onKeyDown={(event) => { if (open) event.stopPropagation(); }}>
    <Button variant="secondary" className="mt-3 w-full" onClick={() => { setAbsentApplicantId(null); setVisibleCount(3); setOpen(true); }}>대체 후보 비교</Button>
    <Modal open={open} onClose={() => setOpen(false)} size="full" title="결원 발생 시 대체 후보 비교"
      description={`${jobTitle || "현재 공고"} · ${date} · 결원을 가정해 비교하며 실제 확정 기록은 유지됩니다.`}>
      <div className="space-y-4 text-sm">
        {!comparison.confirmedApplicantIds.length ? <p role="status">이 날짜에 투입 확정한 후보가 없어요. 후보 목록의 연락 검토 순서를 확인해주세요.</p> : <>
          <label className="block space-y-2"><span className="font-semibold">이날 누가 못 온다고 가정할까요?</span>
            <select value={validSelection ? absentApplicantId : ""} onChange={(event) => { setAbsentApplicantId(event.target.value ? Number(event.target.value) : null); setVisibleCount(3); }}
              className="min-h-11 w-full rounded-lg border border-border-strong bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="">투입 확정자 선택</option>
              {comparison.confirmedApplicantIds.map((id) => <option key={id} value={id}>{byApplicant.get(id)?.applicants?.name || "이름 미등록"}</option>)}
            </select>
          </label>
          {conflictCheckIncomplete && <p role="alert" className="text-warning-strong">다른 라인의 일부 기록을 확인하지 못했어요. 운행·반납 시간이 겹치는지 직접 확인해주세요.</p>}
          {validSelection && <>
            <p role="status">{byApplicant.get(absentApplicantId!)?.applicants?.name || "선택한 후보"}님 대신 연락 검토할 후보 {comparison.alternatives.length}명 · {Math.min(visibleCount, comparison.alternatives.length)}명 표시</p>
            <p className="text-muted-foreground">이 공고의 미확정 후보를 기존 연락 검토 순서로 보여드려요. 불가·보류·진행 거절·중단 기록이 있는 후보는 비교에서 제외합니다. 전체 후보는 기존 목록에서 확인할 수 있어요.</p>
            {!comparison.alternatives.length ? <p className="rounded-xl bg-muted p-4">현재 기록에서 연락 검토할 대체 후보를 찾지 못했어요. 전체 후보의 최신 의사를 확인하거나 인재풀에서 후보를 추가해주세요.</p> : <div className="grid min-w-0 gap-3 md:grid-cols-3">
              {comparison.alternatives.slice(0, visibleCount).map((recommendation) => {
                const candidate = byApplicant.get(recommendation.applicant_id)!;
                const snapshot = bySnapshot.get(candidate.applicant_id);
                const prep = snapshot?.invalid ? null : snapshot?.preparation;
                const day = prep?.dates.find((entry) => entry.date === date);
                const conflicts = otherPrimaries.filter((entry) => entry.applicant_id === candidate.applicant_id && entry.date === date);
                const name = candidate.applicants?.name || "이름 미등록";
                return <article key={candidate.applicant_id} aria-label={`${name} 대체 후보 비교`} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border-strong bg-card p-4">
                  <div><h3 className="break-words text-base font-bold">{name}</h3><p className="mt-1 font-medium">{recommendation.label}</p><p className="mt-1 break-words text-muted-foreground">{recommendation.reasons.join(" · ")}</p></div>
                  {snapshot?.invalid ? <p role="alert" className="text-warning-strong">최근 기록을 확인할 수 없어 가능일·선탑·참여 정보의 판단을 보류합니다.</p> : <dl className="space-y-2 break-words">
                    <div><dt className="text-muted-foreground">선택일 가능 여부 · 역할</dt><dd>{availabilityLabels[day?.availability ?? "unknown"]} · {roleLabels[day?.role ?? "unassigned"]}</dd></div>
                    <div><dt className="text-muted-foreground">선탑 · 본인 의사</dt><dd>{prep ? trainingStatusLabels[prep.training.status] : "선탑 미확인"} · {backupIntentLabels[prep?.training.backup_intent ?? "unknown"]}</dd></div>
                    <div><dt className="text-muted-foreground">이 공고 실제 참여</dt><dd>{prep ? `선탑 ${prep.records.filter((record) => record.kind === "training").length}건 · 백업 ${prep.records.filter((record) => record.kind === "backup").length}건` : "기록 미확인"}</dd></div>
                  </dl>}
                  <div className="break-words"><p className="text-muted-foreground">차량 정보</p><p>{candidate.applicants?.own_vehicle || "미확인"}{candidate.applicants?.vehicle_type && ` · ${candidate.applicants.vehicle_type}`}</p></div>
                  {conflicts.length > 0 && <p className="break-words text-warning-strong">다른 라인 본담당 후보: {conflicts.map((entry) => entry.job_title).join(" · ")} · 운행·반납 시간 확인 필요</p>}
                  {prep?.follow_up && (prep.follow_up.last_contact || prep.follow_up.next_action) && <details className="rounded-lg bg-muted px-3">
                    <summary className="flex min-h-11 cursor-pointer items-center font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">최근 연락·할 일 보기</summary>
                    <div className="space-y-2 pb-3">
                  {prep?.follow_up?.last_contact && <div className="break-words"><p className="text-muted-foreground">최근 연락 · {prep.follow_up.last_contact.date}</p><p className="whitespace-pre-wrap">{prep.follow_up.last_contact.result}</p></div>}
                  {prep?.follow_up?.next_action && <div className="break-words"><p className="text-muted-foreground">다음 할 일{prep.follow_up.status === "done" ? " · 완료" : ""}</p><p>{prep.follow_up.next_action}</p>{prep.follow_up.owner && <p className="text-muted-foreground">담당 {prep.follow_up.owner}</p>}</div>}
                    </div>
                  </details>}
                  {snapshot?.updated_at && <p className="break-words text-xs text-muted-foreground">기록 저장 {new Date(snapshot.updated_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>}
                  <Button className="mt-auto w-full" onClick={() => { setOpen(false); onOpenRecord(candidate.applicant_id); }} aria-label={`${name} 연락·기록 열기`}>연락·기록 열기</Button>
                </article>;
              })}
            </div>}
            {remaining > 0 && <Button variant="secondary" className="w-full" onClick={() => setVisibleCount((count) => count + 3)}>후보 {Math.min(3, remaining)}명 더 비교 · 남은 {remaining}명</Button>}
          </>}
        </>}
      </div>
    </Modal>
  </div>;
}
