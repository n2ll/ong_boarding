"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { useConfirm } from "./ConfirmDialog";
import { AgentPilotPanel } from "./AgentPilotPanel";
import { AGENT_PILOT_MAX_APPLICANTS } from "@/lib/agent/kill-switch";
import { agentModeView, isAdminAgentModeResponse, type AdminAgentModeResponse } from "@/lib/admin/agent-mode-view";
import { fetchActiveSignalBatches, type PipelineActiveCheck } from "@/lib/admin/pipeline-signal-batches";
import { pipelineFocusedJobMessageReviewIssue } from "@/lib/admin/pipeline-job-context";
import { parseRecruitmentReview, recruitmentSendRecipients, recruitmentSendResults,
  type RecruitmentReview, type RecruitmentSendResult, type RecruitmentTarget } from "@/lib/admin/recruitment-launch";

const stateLabel = { consented: "문자 동의 확인", authorization_required: "원모집 연락 근거 확인 필요", authorized: "이번 모집 연락 근거 저장", blocked: "이번 연락 제외" };
const resultLabel = { recorded: "발송 기록 완료", attention: "발송 확인 필요", failed: "발송 실패", blocked: "보내지 않음" };
const field = "w-full rounded-lg border border-border-strong bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function RecruitmentLaunchPanel({ job, targets, initialBody, onClose, onChanged }: {
  job: { id: number; title: string }; targets: RecruitmentTarget[]; initialBody: string; onClose: () => void; onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [selected, setSelected] = useState<number[]>(() => targets.length <= AGENT_PILOT_MAX_APPLICANTS ? targets.map(row => row.applicant_id) : []);
  const [body, setBody] = useState(initialBody);
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [batchId, setBatchId] = useState(() => crypto.randomUUID());
  const [review, setReview] = useState<RecruitmentReview | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<RecruitmentSendResult[] | null>(null);
  const [linkIds, setLinkIds] = useState<number[]>([]);
  const [linkedIds, setLinkedIds] = useState<number[]>([]);
  const [linkError, setLinkError] = useState("");
  const [mode, setMode] = useState<AdminAgentModeResponse | null>(null);
  const [modeError, setModeError] = useState("");
  const [activeCheck, setActiveCheck] = useState<PipelineActiveCheck | null>(null);
  const chosen = targets.filter(row => selected.includes(row.applicant_id));
  const blocked = review?.recipients.filter(row => row.state === "blocked") ?? [];
  const needsAuthorization = review?.recipients.some(row => row.state === "authorization_required") ?? false;
  const sendRecipients = review ? recruitmentSendRecipients(review) : [];
  const bodyIssue = pipelineFocusedJobMessageReviewIssue({ body, newJobNoticeJobId: job.id });
  const payload = { recipients: chosen.map(({ applicant_id, phone }) => ({ applicant_id, phone })), body: body.trim(),
    subject: "옹고잉 채용 안내", purpose: "new_job", job_id: job.id, recruitment_job_ids: [job.id], bulk_request_id: batchId };
  const lock = (value: boolean) => { busyRef.current = value; setBusy(value); };
  const invalidate = () => { setReview(null); setAcknowledged(false); setError(""); setBatchId(crypto.randomUUID()); };
  const close = async () => {
    if (busyRef.current) return;
    if ((review || results || body !== initialBody || note) && !await confirm({ title: "모집 준비 창을 닫을까요?", description: "저장한 연락 근거와 발송 기록은 남습니다. 이 창의 명단과 후속 작업 선택은 초기화됩니다.", confirmText: "닫기" })) return;
    onClose();
  };
  const check = async (authorize: boolean) => {
    if (busyRef.current || !chosen.length || chosen.length > AGENT_PILOT_MAX_APPLICANTS || !body.trim() || bodyIssue || results) return;
    if (authorize && (!review || blocked.length || !acknowledged || note.trim().length < 20)) return;
    lock(true); setError("");
    try {
      setActiveCheck(await fetchActiveSignalBatches(chosen.map(row => String(row.applicant_id))));
      const response = await fetch("/api/admin/messages/recruitment-contact-authorization", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, mode: authorize ? "authorize" : "review", ...(authorize ? { note: note.trim() } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "연락 근거를 확인하지 못했어요.");
      const next = parseRecruitmentReview(data, chosen);
      if (!next) throw new Error("검토 명단이 요청과 일치하지 않습니다. 다시 확인해주세요.");
      setReview(next);
      if (authorize) toast.success("이번 모집 연락 근거를 저장했어요. 문자는 아직 보내지 않았습니다.");
    } catch (reason) { setReview(null); setError(reason instanceof Error ? reason.message : "확인 실패 · 같은 요청으로 다시 확인해주세요."); }
    finally { lock(false); }
  };
  const send = async () => {
    if (busyRef.current || results || !review || needsAuthorization || blocked.length || sendRecipients.length !== chosen.length) return;
    lock(true);
    if (!await confirm({ title: `${sendRecipients.length}명에게 안내 문자를 보낼까요?`, description: `${job.title}\n검토한 문구를 지금 실제 SMS로 보냅니다. 발송 후 취소할 수 없습니다. 후보 연결과 자동 응대 시작은 별도입니다.`, confirmText: `${sendRecipients.length}명 발송` })) { lock(false); return; }
    setError("");
    // 결과가 유실되더라도 이 창에서는 발송을 다시 실행하지 않는다.
    setResults(recruitmentSendResults(null, sendRecipients));
    try {
      const response = await fetch("/api/admin/messages/bulk-send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, recipients: sendRecipients }) });
      const data = await response.json();
      const next = recruitmentSendResults(response.ok ? data : null, sendRecipients);
      setResults(next); setLinkIds(next.filter(row => row.state === "recorded").map(row => row.applicant_id));
      if (!response.ok) setError(data.error ?? "발송 결과를 확인해주세요. 이 창에서는 재발송하지 않습니다.");
    } catch { setError("발송 응답을 확인하지 못했습니다. 대화 내역에서 확인해주세요. 재발송하지 않습니다."); }
    finally { lock(false); onChanged(); }
  };
  const link = async () => {
    const ids = linkIds.filter(id => results?.some(row => row.applicant_id === id && row.state === "recorded"));
    if (busyRef.current || !ids.length) return;
    lock(true); setLinkError("");
    try {
      const response = await fetch(`/api/admin/jobs/${job.id}/candidates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applicant_ids: ids }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "후보 연결을 확인하지 못했습니다.");
      setLinkedIds(ids); setMode(null); toast.success("선택한 발송 완료자를 공고 후보로 연결했어요. 근무 확정은 아닙니다."); onChanged();
    } catch (reason) { setLinkError(`${reason instanceof Error ? reason.message : "후보 연결 실패"} 문자 발송은 다시 하지 않고 후보 연결만 다시 확인할 수 있습니다.`); }
    finally { lock(false); }
  };
  const loadMode = async () => {
    setModeError("");
    try {
      const response = await fetch("/api/admin/agent/kill-switch", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !isAdminAgentModeResponse(data)) throw new Error("현재 자동 응대 설정을 확인하지 못했습니다.");
      setMode(data);
    } catch (reason) { setMode(null); setModeError(reason instanceof Error ? reason.message : "설정 확인 실패"); }
  };
  const modeView = agentModeView({ data: mode ?? undefined });
  const activeSession = modeView.state === "ready" && (modeView.pilotSession || modeView.testSession);
  return <Modal open onClose={() => void close()} busy={busy} closeOnOutside={false} size="lg" title="모집 연락 준비" description={`${job.title} · 명단과 문구를 검토한 뒤 단계별로 진행합니다.`}>
    <div className="space-y-6 text-sm" onKeyDown={event => event.stopPropagation()}>
      <p className="rounded-xl bg-brand-muted p-3 text-muted-foreground">공고 노출 대상은 그대로 유지됩니다. 이번 연락은 최대 {AGENT_PILOT_MAX_APPLICANTS}명이며, 후보 연결·자동 응대·근무 확정은 각각 별도입니다.</p>
      {!results && <>
        <fieldset disabled={busy || Boolean(review)} className="space-y-2"><legend className="font-bold">1. 이번에 연락할 명단 · {selected.length}/{AGENT_PILOT_MAX_APPLICANTS}명</legend>
          <div className="max-h-52 overflow-y-auto rounded-xl border border-border-strong p-2">{targets.map(target => <label key={target.applicant_id} className="flex min-h-11 items-center gap-3 px-2"><input type="checkbox" checked={selected.includes(target.applicant_id)} disabled={!selected.includes(target.applicant_id) && selected.length >= AGENT_PILOT_MAX_APPLICANTS} onChange={event => { invalidate(); setSelected(ids => event.target.checked ? [...ids, target.applicant_id] : ids.filter(id => id !== target.applicant_id)); }} className="size-4 accent-primary focus-visible:ring-2 focus-visible:ring-ring" /><span>{target.name} · {target.phone || "번호 없음"}</span></label>)}</div>
        </fieldset>
        <label className="block space-y-2"><span className="font-bold">2. 안내 문구 · 일정과 조건을 확인해주세요</span><textarea disabled={busy || Boolean(review)} value={body} onChange={event => { invalidate(); setBody(event.target.value); }} rows={8} maxLength={3000} aria-invalid={Boolean(bodyIssue)} aria-describedby={bodyIssue ? "recruitment-body-issue" : undefined} className={field} /></label>
        {bodyIssue && <p id="recruitment-body-issue" className="text-error-strong">{bodyIssue}</p>}
        {!review ? <Button onClick={() => void check(false)} disabled={busy || !selected.length || selected.length > AGENT_PILOT_MAX_APPLICANTS || !body.trim() || Boolean(bodyIssue)} isLoading={busy}>명단·연락 근거 검토</Button> : <div className="space-y-3 rounded-xl border border-border-strong p-4">
          <p className="font-bold">검토 {new Date(review.reviewed_at).toLocaleString("ko-KR")}</p>
          {activeCheck && !activeCheck.configured && <p className="text-warning-strong">활동 현황 미연동 · 현재 활동 여부는 별도로 확인해주세요.</p>}
          {Boolean(activeCheck?.unchecked) && <p className="text-warning-strong">활동 현황 미확인 {activeCheck?.unchecked}명 · 연락 전 확인이 필요합니다.</p>}
          {Boolean(activeCheck?.active.length) && <div className="space-y-2"><p className="text-warning-strong">현재 활동 중 {activeCheck?.active.map(row => row.name).join(", ")} · 기존 일정과 겹치지 않는지 확인해주세요.</p><Button variant="secondary" disabled={busy} onClick={() => { setSelected(ids => ids.filter(id => !activeCheck?.active.some(row => Number(row.id) === id))); invalidate(); }}>활동 중 인원 제외 후 다시 검토</Button></div>}
          <div className="max-h-52 overflow-y-auto space-y-2">{review.recipients.map(row => <div key={row.applicant_id}><span className="font-semibold">{row.name}</span> · {stateLabel[row.state]}{row.reason && <p className="text-muted-foreground">{row.reason}</p>}</div>)}</div>
          {blocked.length > 0 ? <Button variant="secondary" disabled={busy} onClick={() => { setSelected(ids => ids.filter(id => !blocked.some(row => row.applicant_id === id))); invalidate(); }}>제외 대상 {blocked.length}명 빼고 다시 검토</Button> : needsAuthorization ? <>
            <p className="text-muted-foreground">이관된 원모집 정보는 문자 동의 여부와 별개입니다. 원래 모집 목적의 연락 근거를 직접 확인한 경우에만 기록하세요. 수신거부·명시적 거절은 승인으로 해제되지 않습니다.</p>
            <label className="block space-y-1"><span>확인한 원모집 연락 근거 (20자 이상)</span><textarea value={note} onChange={event => setNote(event.target.value)} maxLength={1000} rows={3} disabled={busy} className={field} /></label>
            <label className="flex min-h-11 items-start gap-2"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy} className="mt-1 size-4 accent-primary focus-visible:ring-2 focus-visible:ring-ring" /><span>선택 명단의 원모집 연락 근거와 이번 공고·문구를 확인했습니다. 개인의 문자 동의 정보를 바꾸지 않습니다.</span></label>
            <Button onClick={() => void check(true)} disabled={busy || !acknowledged || note.trim().length < 20}>이번 연락 근거 저장</Button>
          </> : <>
            {review.expires_at && <p>연락 근거 유효기간: {new Date(review.expires_at).toLocaleString("ko-KR")}</p>}
            <Button onClick={() => void send()} disabled={busy || !sendRecipients.length}>검토한 {sendRecipients.length}명 문자 발송</Button>
          </>}
          <Button variant="ghost" disabled={busy} onClick={invalidate}>명단·문구 다시 수정</Button>
        </div>}
      </>}
      {error && <p role="alert" className="text-error-strong">{error}</p>}
      {results && <section className="space-y-3"><h3 className="font-bold">3. 발송 결과 · 기록 완료 {results.filter(row => row.state === "recorded").length}/{results.length}명</h3>
        <p className="text-muted-foreground">발송 실패·결과 확인 중인 인원에게 이 창에서 다시 보내지 않습니다. 기록 완료는 수신·근무 확정을 뜻하지 않습니다.</p>
        <div className="max-h-60 overflow-y-auto space-y-2">{results.map(row => <div key={row.applicant_id} className="rounded-lg border p-3"><label className="flex min-h-11 items-center gap-2">{row.state === "recorded" && <input type="checkbox" checked={linkIds.includes(row.applicant_id)} disabled={busy || linkedIds.length > 0} onChange={event => setLinkIds(ids => event.target.checked ? [...ids, row.applicant_id] : ids.filter(id => id !== row.applicant_id))} className="size-4 accent-primary focus-visible:ring-2 focus-visible:ring-ring" />}<span>{targets.find(target => target.applicant_id === row.applicant_id)?.name} · {resultLabel[row.state]}</span></label><p className="text-muted-foreground">{row.reason}</p></div>)}</div>
        {!linkedIds.length && <Button onClick={() => void link()} disabled={busy || !linkIds.length}>발송 완료 {linkIds.length}명 후보 연결{linkError ? " 다시 확인" : ""}</Button>}
        {linkError && <p role="alert" className="text-error-strong">{linkError}</p>}
        <Link href="/live?tab=inbox" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center px-2 underline focus-visible:ring-2 focus-visible:ring-ring">문자 기록 확인 (새 창)</Link>
      </section>}
      {linkedIds.length > 0 && <section className="space-y-3"><h3 className="font-bold">4. 후보 연결 완료 {linkedIds.length}명 · 제한 자동 응대</h3>
        <Button variant="secondary" disabled={busy} onClick={() => void loadMode()}>현재 자동 응대 설정 확인</Button>
        {modeError && <p role="alert" className="text-error-strong">{modeError}</p>}
        {mode && (activeSession ? <p role="status">이미 제한 운영이 진행 중입니다. 이번 명단으로 교체하지 않습니다. <Link href="/brain?tab=mode" target="_blank" rel="noopener noreferrer" className="underline">기존 운영 확인 (새 창)</Link></p>
          : mode.env_forced || modeView.mode !== "off" ? <p role="status">현재 설정에서는 새 제한 운영을 시작할 수 없습니다. <Link href="/brain?tab=mode" target="_blank" rel="noopener noreferrer" className="underline">자동 응대 설정 확인 (새 창)</Link></p>
          : <AgentPilotPanel jobs={[job]} jobsError={false} disabled={modeView.state !== "ready" || modeView.mode !== "off" || mode.env_forced} onUpdated={loadMode}
              allowedScope={{ jobId: job.id, applicantIds: linkedIds }} expectedUpdatedAt={mode.updated_at ?? null} />)}
      </section>}
    </div>
  </Modal>;
}
