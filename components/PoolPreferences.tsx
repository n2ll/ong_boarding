"use client";
import { useEffect, useState } from "react";
import { POOL_PREFERENCE_LABELS, parsePoolPreferences, type PoolPreferences as Preferences } from "@/lib/pool-preferences";

export function PoolPreferences({ token }: { token: string }) {
  const [kind, setKind] = useState<Preferences["kind"] | "">("");
  const [fields, setFields] = useState({ area: "", schedule: "", vehicle: "", notice: "" });
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    fetch(`/api/pool/${token}/preferences`, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (controller.signal.aborted) return;
      const saved = parsePoolPreferences(data.preferences);
      if (saved) { setKind(saved.kind); setFields({ area: saved.area, schedule: saved.schedule, vehicle: saved.vehicle, notice: saved.notice }); }
      setUpdatedAt(data.updated_at ?? null);
    }).catch(() => { if (!controller.signal.aborted) setError("저장된 조건을 불러오지 못했어요."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, retry]);
  const save = async () => {
    if (busy) return;
    const preferences = parsePoolPreferences({ kind, ...fields });
    if (!preferences) { setError("희망 유형과 지역·요일/시간·차량을 적어주세요. 아직 모르시면 ‘미정’이라고 적어도 됩니다."); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/pool/${token}/preferences`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(preferences) });
      if (!response.ok) throw new Error();
      const data = await response.json();
      setUpdatedAt(data.updated_at); setEditing(false);
    } catch { setError("저장하지 못했어요. 입력 내용은 그대로 있으니 다시 눌러주세요."); }
    finally { setBusy(false); }
  };
  return <section aria-labelledby="pool-preferences-title" className="mb-6 rounded-2xl border border-border-strong bg-card p-5 shadow-sm">
    <p className="mb-1 text-[14px] font-bold text-primary">인력풀 희망 조건</p>
    <h2 id="pool-preferences-title" className="text-[20px] font-extrabold">어떤 배송 일을 찾으세요?</h2>
    <p className="mt-2 text-[16px] leading-relaxed text-muted-foreground">정기 배송이나 휴무·결원 백업에 관심 있는 조건을 남겨주세요. 지금 모집 중인 자리와는 별개이며, 등록만으로 근무가 배정되지 않아요.</p>
    {loading ? <p role="status" className="mt-4">저장된 조건을 확인하고 있어요.</p> : editing ? <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 font-bold">희망하는 일</legend>
        {(Object.entries(POOL_PREFERENCE_LABELS) as [Preferences["kind"], string][]).map(([value, label]) => <label key={value} className={`flex min-h-12 items-center gap-3 rounded-xl border p-3 text-[17px] ${kind === value ? "border-primary bg-primary/5" : "border-border-strong"}`}><input type="radio" name="pool-preference-kind" checked={kind === value} onChange={() => setKind(value)} className="size-5 accent-primary focus-visible:ring-2 focus-visible:ring-ring" />{label}</label>)}
      </fieldset>
      {([{ key: "area", label: "활동 가능한 지역", placeholder: "예: 성동구·강남구" }, { key: "schedule", label: "가능한 요일·시간", placeholder: "예: 월~금 오후, 주말 오전" }, { key: "vehicle", label: "이용 가능한 차량", placeholder: "예: 세단, 레이밴, 없음, 미정" }, ...((kind === "backup" || kind === "both") ? [{ key: "notice", label: "얼마나 미리 연락받으면 좋을까요? (선택)", placeholder: "예: 하루 전, 당일도 가능" }] : [])] as { key: keyof typeof fields; label: string; placeholder: string }[]).map(({ key, label, placeholder }) => <label key={key} className="block text-[16px] font-bold">{label}<input disabled={busy} value={fields[key]} maxLength={240} onChange={(event) => setFields((previous) => ({ ...previous, [key]: event.target.value }))} placeholder={placeholder} className="mt-2 min-h-12 w-full rounded-xl border border-border-strong bg-background px-3 text-[17px] font-normal focus-visible:ring-2 focus-visible:ring-ring" /></label>)}
      <p className="text-[14px] text-muted-foreground">조건이 바뀌면 다시 수정할 수 있어요. 근무 조건과 투입 여부는 매니저가 별도로 확인해요.</p>
      <button disabled={busy} className="min-h-12 w-full rounded-xl bg-primary px-4 py-3 text-[17px] font-bold text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{busy ? "저장 중…" : "희망 조건 저장"}</button>
    </form> : <div className="mt-4">
      {updatedAt && <p role="status" className="mb-3 text-[16px] leading-relaxed">{kind ? POOL_PREFERENCE_LABELS[kind] : "희망 조건"} · {fields.area} · {fields.schedule}<br />차량: {fields.vehicle}{fields.notice ? ` · 사전 연락: ${fields.notice}` : ""}<br /><span className="text-[14px] text-muted-foreground">마지막 저장: {new Date(updatedAt).toLocaleDateString("ko-KR")}</span></p>}
      <button type="button" onClick={() => error ? setRetry((value) => value + 1) : setEditing(true)} className="min-h-12 w-full rounded-xl border border-primary px-4 py-3 text-[17px] font-bold text-primary focus-visible:ring-2 focus-visible:ring-ring">{error ? "다시 불러오기" : updatedAt ? "희망 조건 수정" : "희망 조건 남기기"}</button>
    </div>}
    {error && <p role="alert" className="mt-3 text-[16px] text-error-strong">{error}</p>}
  </section>;
}
