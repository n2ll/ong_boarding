"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { useConfirm } from "./ConfirmDialog";
import { parseStaffingDemand, type StaffingDemand, type StaffingDemandEvent } from "@/lib/admin/staffing-demand";
import type { StaffingDateBoardCell } from "@/lib/admin/staffing-date-board";

const authorKey = "ongboarding:staffing-author:v1";
const fieldClass = "min-h-11 w-full min-w-0 rounded-lg border border-border-strong bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const stateLabel = { unknown: "수요 미정", off: "운행 없음", operating: "운행함" };

export function StaffingDemandEditor({ jobId, title, capacity, cell, onClose, onSaved }: {
  jobId: number; title: string; capacity: number | null; cell: StaffingDateBoardCell; onClose: () => void; onSaved: () => void;
}) {
  const [state, setState] = useState<StaffingDemand["state"]>(cell.demand_state ?? "unknown");
  const [count, setCount] = useState(cell.demand_state === "operating" && cell.target ? String(cell.target) : "");
  const [baseId, setBaseId] = useState(cell.demand_event_id ?? null);
  const [author, setAuthor] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<{ latest: StaffingDemandEvent | null } | null>(null);
  const request = useRef<{ body: string; key: string } | null>(null);
  const countId = useId();
  const confirm = useConfirm();
  useEffect(() => { try { setAuthor(localStorage.getItem(authorKey) ?? ""); } catch { /* optional convenience */ } }, []);
  const demand = parseStaffingDemand({ state, required_count: state === "unknown" ? null : state === "off" ? 0 : count.trim() ? Number(count) : null });
  const close = async () => {
    if (saving) return;
    if (dirty && !await confirm({ title: "입력한 수요를 닫을까요?", description: "저장하지 않은 입력은 사라집니다.", confirmText: "저장 없이 닫기", destructive: true })) return;
    onClose();
  };
  const save = async () => {
    if (saving || conflict) return;
    if (!demand || !author.trim() || author.trim().length > 80) { setError("작성자 이름과 필요 인원(1~999명)을 확인해주세요."); return; }
    const body = JSON.stringify({ date: cell.date, ...demand, base_event_id: baseId, actor_name: author.trim() });
    if (request.current?.body !== body) request.current = { body, key: crypto.randomUUID() };
    setSaving(true); setError("");
    try {
      const response = await fetch(`/api/admin/jobs/${jobId}/staffing-demand`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...JSON.parse(body), action_key: request.current.key }) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409 && Object.hasOwn(result, "latest")) setConflict({ latest: result.latest });
        throw new Error(result.error ?? "수요를 저장하지 못했어요. 입력은 유지됩니다.");
      }
      try { localStorage.setItem(authorKey, author.trim()); } catch { /* saving must not depend on local storage */ }
      toast.success("날짜별 수요를 저장했어요.");
      onSaved();
      window.dispatchEvent(new Event("ongboarding:staffing-updated"));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "수요를 저장하지 못했어요. 다시 시도해주세요."); }
    finally { setSaving(false); }
  };
  const latestDemand = conflict?.latest ? parseStaffingDemand(conflict.latest) : null;
  return <Modal open onClose={() => void close()} closeOnOutside={false} busy={saving} title="필요 인원"
    description={`${title} · ${cell.date}`}
    footer={<Button onClick={() => void save()} disabled={!!conflict} isLoading={saving}>인원 저장</Button>}>
    <div className="space-y-4">
      <div className="space-y-2 rounded-xl bg-muted p-4">
        <label htmlFor={countId} className="block font-semibold">필요 인원</label>
        <div className="flex items-center gap-3"><input id={countId} aria-describedby={`${countId}-hint`} className={`${fieldClass} max-w-40 text-2xl font-bold`} type="number" inputMode="numeric" min={1} max={999} step={1} value={count} placeholder="숫자 입력" disabled={saving} onChange={(event) => { setCount(event.target.value); setState("operating"); setDirty(true); }} /><span className="font-medium">명</span></div>
        <p id={`${countId}-hint`} className="text-sm text-muted-foreground">실제 투입할 인원만 입력하세요. 예비 후보는 제외합니다.</p>
      </div>
      <fieldset disabled={saving} className="space-y-2"><legend className="mb-2 text-sm font-medium">이 날짜의 모집 계획</legend>
        <div className="grid grid-cols-3 gap-2">{([['operating', '인원 입력'], ['unknown', '아직 미정'], ['off', '운행 없음']] as const).map(([value, label]) => <label key={value} className={`flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border px-2 text-sm ${state === value ? "border-primary bg-primary/10 font-semibold" : "border-border-strong bg-background"}`}>
          <input type="radio" name={`${countId}-state`} value={value} checked={state === value} onChange={() => { setState(value); if (value !== "operating") setCount(""); setDirty(true); }} className="size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />{label}
        </label>)}</div>
      </fieldset>
      <p className="text-sm text-muted-foreground">현재 확정 {cell.confirmed}명 · 예비 후보 {cell.reserve}명{capacity ? ` · 공고 모집인원 ${capacity}명` : ""}</p>
      {cell.confirmed > 0 && demand?.required_count !== null && demand && cell.confirmed > demand.required_count && <p className="rounded-lg bg-warning/10 p-3 text-sm text-warning-strong">기존 확정 {cell.confirmed}명이 수요보다 많습니다. 담당자와 투입 여부를 재확인해주세요. 확정 기록은 유지됩니다.</p>}
      <label className="block space-y-1"><span className="text-sm font-medium">기록 작성자</span><input className={fieldClass} maxLength={80} value={author} disabled={saving} onChange={(event) => { setAuthor(event.target.value); setDirty(true); }} /></label>
      {error && <p role="alert" className="text-sm text-error-strong">{error}</p>}
      {conflict && <div className="space-y-2 rounded-lg border border-border-strong p-3 text-sm">
        <p>최신 수요: {latestDemand ? stateLabel[latestDemand.state] : "수요 미정"}{latestDemand?.state === "operating" ? ` · 필요 ${latestDemand.required_count}명` : ""}</p>
        <p className="text-muted-foreground">내 입력을 최신 수요로 바꾼 뒤 다시 편집할 수 있습니다.</p>
        <Button variant="secondary" onClick={() => {
          setState(latestDemand?.state ?? "unknown"); setCount(latestDemand?.state === "operating" ? String(latestDemand.required_count) : "");
          setBaseId(conflict.latest?.id ?? null); setConflict(null); setError(""); setDirty(false); request.current = null;
        }}>최신 수요 불러오기</Button>
      </div>}
      <p className="text-xs text-muted-foreground">수요가 미정인 날은 부족 인원을 계산하지 않습니다. 수요 저장으로 후보를 확정하거나 취소하지 않습니다.</p>
    </div>
  </Modal>;
}
