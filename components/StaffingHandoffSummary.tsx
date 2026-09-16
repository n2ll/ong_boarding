"use client";

import useSWR from "swr";
import { Loader2 } from "lucide-react";
import { backupIntentLabels, followUpContactMethodLabels, parseStaffingPreparation, participationKindLabels, trainingStatusLabels, type StaffingPreparationSnapshot } from "@/lib/admin/staffing-preparation";
import { Button } from "./ui/button";

type PreparationResponse = { preparations: StaffingPreparationSnapshot[] };
const formatTime = (at: string) => new Date(at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
async function loadPreparation(url: string): Promise<PreparationResponse> {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || !Array.isArray(data.preparations)) throw new Error("진행 기록 조회 실패");
  return data;
}

/** Mounted only while expanded; the job URL isolates and shares the existing read-only query. */
export function StaffingHandoffSummary({ jobId, applicantId }: { jobId: number; applicantId: number }) {
  const { data, error, isValidating, mutate } = useSWR<PreparationResponse>(
    `/api/admin/jobs/${jobId}/staffing-preparation`, loadPreparation,
    { revalidateOnMount: true, refreshInterval: 60_000, shouldRetryOnError: false },
  );
  const snapshot = data?.preparations.find((item) => item.applicant_id === applicantId);
  const preparation = snapshot?.invalid ? null : parseStaffingPreparation(snapshot?.preparation);
  const contact = preparation?.follow_up?.last_contact;
  const memo = preparation ? snapshot?.history.find((item) => item.manager_note) : undefined;
  const confirmedDates = preparation?.dates.filter((day) => day.confirmation === "confirmed") ?? [];

  return <div className="space-y-3 rounded-xl bg-muted p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-bold">팀에 저장된 최근 진행</p>
      <Button type="button" size="sm" variant="ghost" disabled={isValidating} onClick={() => void mutate()}>
        {isValidating ? <><Loader2 aria-hidden="true" size={14} className="animate-spin motion-reduce:animate-none" /> 확인 중</> : "다시 확인"}
      </Button>
    </div>
    {error && <p role="alert" className="text-warning-strong">{data ? "최신 조회에 실패해 이전 조회 결과를 표시하고 있어요. 다시 확인해주세요." : "진행 기록을 불러오지 못했어요. 다시 확인해주세요."}</p>}
    {!data && !error && <p role="status" className="text-muted-foreground">진행 기록을 불러오는 중…</p>}
    {data && (!snapshot || !snapshot.event_id) && <p role="status">이 공고에 저장된 진행 기록이 없어요. 기록 화면에서 현재 상태를 확인해주세요.</p>}
    {snapshot?.event_id && !preparation ? <p role="alert" className="text-warning-strong">최근 기록을 해석하지 못했어요. 기록 화면에서 확인해주세요.</p> : null}
    {preparation && <>
      <div className="space-y-1">
        <p className="font-medium">최근 연락</p>
        {contact ? <><p className="text-muted-foreground">{contact.date} · {followUpContactMethodLabels[contact.method]}</p><p className="whitespace-pre-wrap break-words">{contact.result}</p></> : <p className="text-muted-foreground">저장된 연락 결과가 없어요.</p>}
      </div>
      <div className="space-y-1 break-words">
        <p className="font-medium">{trainingStatusLabels[preparation.training.status]} · {backupIntentLabels[preparation.training.backup_intent]}</p>
        <p>선탑 가능 시간: {preparation.training_availability || "미확인"}</p>
        {preparation.training.scheduled_at && <p>선탑 지정 일시: {formatTime(preparation.training.scheduled_at)} (한국시간)</p>}
        {preparation.training.first_loading_location && <p>첫 상차지: {preparation.training.first_loading_location}</p>}
        {preparation.training.linked_pro && <p>연결 프로: {preparation.training.linked_pro}</p>}
        <p>매니저 투입 확정: {confirmedDates.length ? confirmedDates.map((day) => day.date).join(" · ") : "기록 없음"}</p>
      </div>
      <div className="space-y-1 break-words">
        <p className="font-medium">실제 참여 {preparation.records.length}건 · 미참여 {preparation.non_participations?.length ?? 0}건</p>
        {preparation.records.length > 0 && <p>최근 참여: {preparation.records.slice(0, 3).map((record) => `${record.date} ${participationKindLabels[record.kind]}`).join(" · ")}</p>}
        {!!preparation.non_participations?.length && <p>최근 미참여: {preparation.non_participations.slice(0, 3).map((record) => `${record.date} ${participationKindLabels[record.kind]}`).join(" · ")}</p>}
      </div>
      {preparation.note && <div><p className="font-medium">팀 메모</p><p className="mt-1 whitespace-pre-wrap break-words">{preparation.note}</p></div>}
      {memo?.manager_note && <details className="rounded-lg border border-border-strong px-3">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">최근 통화·진행 메모 원문 보기</summary>
        <p className="whitespace-pre-wrap break-words">{memo.manager_note.text}</p>
        <p className="my-2 break-words text-xs text-muted-foreground">기준일 {memo.manager_note.reference_date} · 작성자 {memo.actor?.name || "미기록"} · 저장 {formatTime(memo.updated_at)}</p>
      </details>}
      <p className="break-words text-xs text-muted-foreground">기록 작성자: {snapshot?.actor?.name || "미기록"}{snapshot?.updated_at && ` · 저장 ${formatTime(snapshot.updated_at)}`}</p>
    </>}
  </div>;
}
