"use client";
import { useEffect, useState } from "react";
import type { AgentPilotSession } from "@/lib/agent/kill-switch";
import { useConfirm } from "./ConfirmDialog";
import { toast } from "sonner";

type Target = { id: number; name: string; phone_suffix: string; job_ids: number[] };
export function AgentPilotPanel({ jobs, jobsError, session, disabled, onUpdated }: { jobs: { id: number; title: string }[]; jobsError: boolean; session?: AgentPilotSession; disabled: boolean; onUpdated: () => Promise<unknown> }) {
  const confirm = useConfirm();
  const [jobIds, setJobIds] = useState<number[]>([]);
  const [applicantIds, setApplicantIds] = useState<number[]>([]);
  const [hours, setHours] = useState(1);
  const [targets, setTargets] = useState<Target[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const key = (session?.job_ids ?? jobIds).join(",");
  useEffect(() => {
    const controller = new AbortController();
    setTargets([]); setApplicantIds([]); setError(""); setLoading(Boolean(key));
    if (!key) return () => controller.abort();
    fetch(`/api/admin/agent/pilot-targets?job_ids=${key}`, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "대상 조회 실패");
      if (!controller.signal.aborted) setTargets(data.targets);
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "대상 조회 실패"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [key, retry]);
  const change = async (stop: boolean) => {
    if (busy || disabled) return;
    const selected = targets.filter((target) => applicantIds.includes(target.id));
    if (!stop && (!selected.length || loading || error || jobsError || jobIds.some((id) => !jobs.some((job) => job.id === id)))) return;
    const accepted = await confirm(stop ? { title: "제한 자동 응대를 중단할까요?", description: "선택 대상의 새 답장에도 AI가 자동 응대하지 않습니다.", confirmText: "중단", destructive: true } : {
      title: "선택한 대상만 자동 응대를 시작할까요?",
      description: `${selected.map((target) => `${target.name}(끝 ${target.phone_suffix})`).join(", ")} · ${jobs.filter((job) => jobIds.includes(job.id)).map((job) => job.title).join(", ")} · ${hours}시간. 시작 이후의 새 문자에만 실제 답장을 보냅니다. 개별 중지는 유지하며 첫 안내 문자는 보내지 않습니다.`, confirmText: "제한 자동 응대 시작",
    });
    if (!accepted) return;
    setBusy(true);
    try {
      const response = await fetch("/api/admin/agent/kill-switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(stop ? { mode: "off" } : { mode: "pilot", job_ids: jobIds, applicant_ids: applicantIds, duration_hours: hours }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "설정 저장 실패");
      await onUpdated();
      toast.success(stop ? "제한 자동 응대를 중단했어요." : "선택한 대상의 새 답장에만 자동 응대합니다.");
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : "설정 저장 실패"); }
    finally { setBusy(false); }
  };
  const unavailable = disabled || busy;
  return <section className="mt-4 rounded-xl border border-border-strong bg-card p-4" aria-labelledby="pilot-title">
    <h3 id="pilot-title" className="text-[16px] font-bold">파일럿 자동 응대</h3>
    {session ? <div className="mt-3 space-y-3 text-sm">
      <p role="status">선택 {session.applicant_ids.length}명 · 공고 {session.job_ids.length}개만 자동 응대합니다. 개별 중지와 수신거부는 유지됩니다.</p>
      <p>종료: {new Date(session.expires_at).toLocaleString("ko-KR")}</p>
      <p className="text-muted-foreground">대상: {session.applicant_ids.map((id) => { const target = targets.find((item) => item.id === id); return target ? `${target.name}(끝 ${target.phone_suffix})` : `대상 #${id} (명단 확인 필요)`; }).join(", ")} · 공고: {session.job_ids.map((id) => jobs.find((job) => job.id === id)?.title ?? `#${id}`).join(", ")}</p>
      <button disabled={unavailable} type="button" onClick={() => void change(true)} className="min-h-11 rounded-lg border border-error px-4 font-bold text-error-strong focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">지금 중단</button>
    </div> : <div className="mt-3 space-y-4 text-sm">
      <p className="text-muted-foreground">최대 10명·3개 실제 공고에만 새 답장을 보냅니다. 첫 안내 문자와 예약 발송은 실행하지 않습니다.</p>
      <fieldset disabled={unavailable} className="space-y-2"><legend className="mb-2 font-bold">1. 운영할 공고</legend>
        {jobsError ? <p role="alert">공고 목록을 확인하지 못했습니다.</p> : jobs.map((job) => <label key={job.id} className="flex min-h-11 items-center gap-2 rounded-lg border p-3"><input type="checkbox" checked={jobIds.includes(job.id)} disabled={!jobIds.includes(job.id) && jobIds.length >= 3} onChange={(event) => setJobIds((ids) => event.target.checked ? [...ids, job.id] : ids.filter((id) => id !== job.id))} className="size-4 accent-primary focus-visible:ring-2 focus-visible:ring-ring" />{job.title}</label>)}
        {!jobsError && !jobs.length && <p>실제 모집이 시작되면 공고를 등록한 뒤 선택해주세요. 인력풀 희망 조건은 공고 없이 본인 링크에서 받을 수 있습니다.</p>}
      </fieldset>
      {jobIds.length > 0 && <fieldset disabled={unavailable || loading} className="space-y-2"><legend className="mb-2 font-bold">2. 이 공고의 후보 선택 ({applicantIds.length}/10명)</legend>
        {loading ? <p role="status">후보 확인 중…</p> : targets.map((target) => <label key={target.id} className="flex min-h-11 items-center gap-2 rounded-lg border p-3"><input type="checkbox" checked={applicantIds.includes(target.id)} disabled={!applicantIds.includes(target.id) && applicantIds.length >= 10} onChange={(event) => setApplicantIds((ids) => event.target.checked ? [...ids, target.id] : ids.filter((id) => id !== target.id))} className="size-4 accent-primary focus-visible:ring-2 focus-visible:ring-ring" /><span>{target.name} · 전화 끝 {target.phone_suffix}</span></label>)}
        {!loading && !error && !targets.length && <p>시작할 후보가 없습니다. 공고에 후보를 추가하거나 관심 접수를 받은 뒤 새로고침해주세요. 개별 중지·수신거부·제외·확정 인력은 선택할 수 없습니다.</p>}
        {error && <p role="alert" className="text-error-strong">{error}</p>}
        <button type="button" onClick={() => setRetry((value) => value + 1)} className="min-h-11 rounded-lg border px-3 focus-visible:ring-2 focus-visible:ring-ring">후보 새로고침</button>
      </fieldset>}
      <label className="block font-bold">3. 운영 기간<select disabled={unavailable} value={hours} onChange={(event) => setHours(Number(event.target.value))} className="ml-3 min-h-11 rounded-lg border bg-background px-3 focus-visible:ring-2 focus-visible:ring-ring">{[1, 4, 24].map((hour) => <option key={hour} value={hour}>{hour}시간</option>)}</select></label>
      <p className="text-muted-foreground">선택 밖 공고나 시작 전 미응답 문자가 섞이면 수동 응대가 필요합니다. 기간이 끝나면 자동 중지됩니다.</p>
      <button disabled={unavailable || jobsError || loading || !!error || !applicantIds.length || !jobIds.length || jobIds.some((id) => !jobs.some((job) => job.id === id))} type="button" onClick={() => void change(false)} className="min-h-11 rounded-lg bg-primary px-4 font-bold text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">선택 대상 확인 후 시작</button>
    </div>}
  </section>;
}
