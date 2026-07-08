import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { motion } from "motion/react";
import { Siren, Plus, X, Loader2, Save, Trash2, Wallet, ChevronDown, ChevronRight, Briefcase } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";
import { SOS_RESOLUTIONS, COST_CATEGORIES, kstMonth, type SosResolution, type CostCategory } from "@/lib/sos";

/**
 * 긴급 건 기록 카드 (내부 매니저용 · 기록 전용 — 발송 기능 없음).
 * sos_requests(발생~해결 로그) + cost_ledger(월 운영비)를 한 카드에서 수기 관리한다.
 */

interface SosRow {
  id: number;
  created_at: string;
  line_label: string;
  region: string | null;
  vehicle: string | null;
  needed_count: number;
  note: string | null;
  status: "open" | "resolved" | "cancelled";
  resolved_at: string | null;
  resolution: SosResolution | null;
  cost_krw: number | null;
  duration_minutes: number | null;
  resolution_note: string | null;
}

interface SosRes {
  open?: SosRow[];
  recent?: SosRow[];
  month_summary?: { count: number; resolved: number; cost_sum: number };
}

interface LedgerRow {
  id: number;
  month: string;
  category: string;
  amount_krw: number;
  memo: string | null;
}

interface LedgerRes {
  month?: string;
  rows?: LedgerRow[];
  total?: number;
}

interface SosForm {
  line_label: string;
  region: string;
  vehicle: string;
  needed_count: string;
  note: string;
}

interface ResolveForm {
  id: number;
  line_label: string;
  resolution: SosResolution | "";
  cost_krw: string;
  duration_minutes: string;
  resolution_note: string;
}

const EMPTY_SOS_FORM: SosForm = { line_label: "", region: "", vehicle: "", needed_count: "1", note: "" };

function elapsedLabel(iso: string, now: number): string {
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min}분 경과`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 경과`;
  return `${Math.floor(h / 24)}일 경과`;
}

const won = (n: number) => `₩${n.toLocaleString()}`;

/** 빈 문자열 → null, 아니면 0 이상 정수. 잘못된 입력이면 undefined(검증 실패). */
function parseOptInt(s: string): number | null | undefined {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function SosLedgerCard() {
  const router = useRouter();
  const confirm = useConfirm();
  const { data: sosRes, mutate: mutateSos } = useSWR<SosRes>("/api/admin/sos");
  const { data: ledgerRes, mutate: mutateLedger } = useSWR<LedgerRes>("/api/admin/cost-ledger");

  const openRows = sosRes?.open ?? [];
  const recentRows = sosRes?.recent ?? [];
  const summary = sosRes?.month_summary;
  const ledgerRows = ledgerRes?.rows ?? [];
  const ledgerTotal = ledgerRes?.total ?? 0;

  // '경과' 표시가 화면에 머무는 동안 갱신되도록 1분 틱 (Dashboard 동기화 라벨과 동일 패턴)
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const [saving, setSaving] = useState(false);
  const [createForm, setCreateForm] = useState<SosForm | null>(null);
  const [resolveForm, setResolveForm] = useState<ResolveForm | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ledgerForm, setLedgerForm] = useState<{ category: CostCategory; amount_krw: string; memo: string }>({
    category: "backup_labor",
    amount_krw: "",
    memo: "",
  });

  const handleCreate = async () => {
    if (!createForm) return;
    const label = createForm.line_label.trim();
    if (!label) return toast.error("라인/권역 라벨을 입력해주세요.");
    const needed = Number(createForm.needed_count);
    if (!Number.isInteger(needed) || needed < 1) return toast.error("필요 인원은 1 이상의 정수여야 해요.");
    setSaving(true);
    try {
      const res = await fetch("/api/admin/sos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          line_label: label,
          region: createForm.region.trim() || undefined,
          vehicle: createForm.vehicle.trim() || undefined,
          needed_count: needed,
          note: createForm.note.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "기록에 실패했어요");
        return;
      }
      toast.success("긴급 건을 기록했어요.");
      setCreateForm(null);
      await mutateSos();
    } catch {
      toast.error("기록에 실패했어요");
    } finally {
      setSaving(false);
    }
  };

  // 긴급 건을 공고 등록으로 넘긴다 — 라인·권역·차종을 프리필해 재입력을 없앤다.
  const handleMakeJob = (r: SosRow) => {
    const params = new URLSearchParams({ new: "1", sos_id: String(r.id), line: r.line_label, period: "하루" });
    if (r.region) params.set("region", r.region);
    if (r.vehicle) params.set("vehicle", r.vehicle);
    router.push(`/jobs?${params.toString()}`);
  };

  const handleResolve = async () => {
    if (!resolveForm) return;
    if (!resolveForm.resolution) return toast.error("해결 방법을 선택해주세요.");
    const cost = parseOptInt(resolveForm.cost_krw);
    if (cost === undefined) return toast.error("비용은 0 이상의 정수(원)로 입력해주세요.");
    const duration = parseOptInt(resolveForm.duration_minutes);
    if (duration === undefined) return toast.error("실소요는 0 이상의 정수(분)로 입력해주세요.");
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/sos/${resolveForm.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "resolved",
          resolution: resolveForm.resolution,
          cost_krw: cost,
          duration_minutes: duration,
          resolution_note: resolveForm.resolution_note.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "해결 기록에 실패했어요");
        return;
      }
      toast.success("해결로 기록했어요.");
      setResolveForm(null);
      await mutateSos();
    } catch {
      toast.error("해결 기록에 실패했어요");
    } finally {
      setSaving(false);
    }
  };

  const handleAddLedger = async () => {
    const amount = Number(ledgerForm.amount_krw);
    if (!Number.isSafeInteger(amount) || amount <= 0) return toast.error("금액은 양의 정수(원)로 입력해주세요.");
    setSaving(true);
    try {
      const res = await fetch("/api/admin/cost-ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month: ledgerRes?.month ?? kstMonth(),
          category: ledgerForm.category,
          amount_krw: amount,
          memo: ledgerForm.memo.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "운영비 추가에 실패했어요");
        return;
      }
      toast.success("운영비를 추가했어요.");
      setLedgerForm((f) => ({ ...f, amount_krw: "", memo: "" }));
      await mutateLedger();
    } catch {
      toast.error("운영비 추가에 실패했어요");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteLedger = async (row: LedgerRow) => {
    const label = COST_CATEGORIES[row.category as CostCategory] ?? row.category;
    if (!(await confirm({
      title: "운영비 항목을 삭제할까요?",
      description: `${label} ${won(row.amount_krw)} 항목을 삭제합니다.`,
      confirmText: "삭제",
      destructive: true,
    }))) return;
    try {
      const res = await fetch(`/api/admin/cost-ledger?id=${row.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "삭제에 실패했어요");
        return;
      }
      toast.success("운영비 항목을 삭제했어요.");
      await mutateLedger();
    } catch {
      toast.error("삭제에 실패했어요");
    }
  };

  const inputCls =
    "w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]";

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} className="bg-white border border-[#E2E8F0] rounded-[16px] p-6 shadow-sm flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-[15px] font-bold text-[#1A202C] flex items-center gap-1.5"><Siren size={15} className="text-[#E53E3E]" /> 긴급 건 기록</h2>
          <div className="text-[12px] text-[#718096] mt-0.5">결원·증차 발생~해결 로그와 월 운영비 (기록 전용)</div>
        </div>
        <button
          onClick={() => setCreateForm({ ...EMPTY_SOS_FORM })}
          className="flex items-center gap-1.5 text-[12px] font-bold text-white bg-[#E53E3E] hover:bg-[#C53030] px-3 py-1.5 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E53E3E]/40"
        >
          <Plus size={14} /> 긴급 건 기록
        </button>
      </div>

      {/* 이번 달 요약 */}
      <div className="bg-[#F7FAFC] rounded-xl px-4 py-2.5 text-[12.5px] font-semibold text-[#4A5568] mb-4">
        이번 달 긴급 <b className="text-[#1A202C]">{summary?.count ?? 0}건</b> · 해결 <b className="text-[#1A202C]">{summary?.resolved ?? 0}건</b> · 건별 비용 <b className="text-[#1A202C]">{won(summary?.cost_sum ?? 0)}</b> + 월 운영비 <b className="text-[#1A202C]">{won(ledgerTotal)}</b>
      </div>

      {/* 진행 중 건 */}
      {openRows.length === 0 ? (
        <div className="py-4 text-center text-[13px] text-[#A0AEC0]">진행 중인 긴급 건이 없어요.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {openRows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 p-3 border border-[#FEB2B2] bg-[#FFF5F5] rounded-xl">
              <span className="w-2 h-2 rounded-full bg-[#E53E3E] animate-pulse shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-bold text-[#1A202C] truncate">{r.line_label}</div>
                <div className="text-[11.5px] text-[#9B2C2C] truncate">
                  {[r.region, r.vehicle, `${r.needed_count}명 필요`, r.note].filter(Boolean).join(" · ")}
                </div>
              </div>
              <span className="text-[11.5px] font-bold text-[#C53030] shrink-0">{elapsedLabel(r.created_at, nowTick)}</span>
              <button
                onClick={() => handleMakeJob(r)}
                className="flex items-center gap-1 text-[11.5px] font-bold text-[#4A5568] bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] px-3 py-1.5 rounded-lg shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
              >
                <Briefcase size={13} /> 공고로 만들기
              </button>
              <button
                onClick={() => setResolveForm({ id: r.id, line_label: r.line_label, resolution: "", cost_krw: "", duration_minutes: "", resolution_note: "" })}
                className="text-[11.5px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] px-3 py-1.5 rounded-lg shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
              >
                해결 기록
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 최근 처리 내역 */}
      {recentRows.length > 0 && (
        <div className="mt-3 border-t border-[#F1F4F8] pt-3">
          <div className="text-[11.5px] font-bold text-[#718096] mb-1.5">최근 처리</div>
          <div className="flex flex-col gap-1">
            {recentRows.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-[12px] text-[#4A5568]">
                <span className="font-semibold truncate">{r.line_label}</span>
                <span className="text-[#A0AEC0] shrink-0">
                  {r.status === "cancelled" ? "취소 종결" : r.resolution ? SOS_RESOLUTIONS[r.resolution] : "해결"}
                  {typeof r.cost_krw === "number" && r.cost_krw > 0 ? ` · ${won(r.cost_krw)}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 월 운영비 (접이식) */}
      <div className="mt-4 border-t border-[#F1F4F8] pt-3">
        <button
          onClick={() => setLedgerOpen((o) => !o)}
          className="w-full flex items-center justify-between text-[12.5px] font-bold text-[#4A5568] hover:text-[#1A202C] rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
        >
          <span className="flex items-center gap-1.5"><Wallet size={14} className="text-[#3182CE]" /> {ledgerRes?.month ?? kstMonth()} 운영비 {won(ledgerTotal)}</span>
          {ledgerOpen ? <ChevronDown size={15} className="text-[#A0AEC0]" /> : <ChevronRight size={15} className="text-[#A0AEC0]" />}
        </button>

        {ledgerOpen && (
          <div className="mt-3 flex flex-col gap-2">
            {ledgerRows.length === 0 && (
              <div className="text-[12px] text-[#A0AEC0]">이번 달 입력된 운영비가 없어요.</div>
            )}
            {ledgerRows.map((row) => (
              <div key={row.id} className="flex items-center gap-3 px-3 py-2 bg-[#F7FAFC] rounded-lg">
                <span className="text-[12px] font-bold text-[#4A5568] w-[110px] shrink-0">{COST_CATEGORIES[row.category as CostCategory] ?? row.category}</span>
                <span className="text-[12.5px] font-extrabold text-[#1A202C] shrink-0">{won(row.amount_krw)}</span>
                <span className="flex-1 text-[11.5px] text-[#A0AEC0] truncate">{row.memo}</span>
                <button
                  onClick={() => handleDeleteLedger(row)}
                  title="삭제"
                  className="text-[#A0AEC0] hover:text-[#E53E3E] p-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E53E3E]/40"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}

            {/* 추가 폼 */}
            <div className="flex items-center gap-2 mt-1">
              <select
                value={ledgerForm.category}
                onChange={(e) => setLedgerForm({ ...ledgerForm, category: e.target.value as CostCategory })}
                className="px-3 py-2 border border-[#E2E8F0] rounded-lg text-[12.5px] bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
              >
                {(Object.entries(COST_CATEGORIES) as [CostCategory, string][]).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                placeholder="금액(원)"
                value={ledgerForm.amount_krw}
                onChange={(e) => setLedgerForm({ ...ledgerForm, amount_krw: e.target.value })}
                className="w-[110px] px-3 py-2 border border-[#E2E8F0] rounded-lg text-[12.5px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
              />
              <input
                placeholder="메모 (선택)"
                value={ledgerForm.memo}
                onChange={(e) => setLedgerForm({ ...ledgerForm, memo: e.target.value })}
                className="flex-1 px-3 py-2 border border-[#E2E8F0] rounded-lg text-[12.5px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
              />
              <button
                onClick={handleAddLedger}
                disabled={saving}
                className="flex items-center gap-1 text-[12px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] px-3 py-2 rounded-lg disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
              >
                <Plus size={13} /> 추가
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 긴급 건 기록 모달 */}
      {createForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => !saving && setCreateForm(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#E2E8F0] sticky top-0 bg-white">
              <h2 className="text-[18px] font-extrabold text-[#1A202C]">긴급 건 기록</h2>
              <button onClick={() => setCreateForm(null)} className="text-[#A0AEC0] hover:text-[#4A5568] p-1 rounded-lg"><X size={20} /></button>
            </div>
            <div className="p-6 flex flex-col gap-5">
              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">라인/권역 라벨 <span className="text-[#E53E3E]">*</span></label>
                <input
                  value={createForm.line_label}
                  onChange={(e) => setCreateForm({ ...createForm, line_label: e.target.value })}
                  placeholder="예: 강서 새벽 배민"
                  className={inputCls}
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">권역</label>
                  <input value={createForm.region} onChange={(e) => setCreateForm({ ...createForm, region: e.target.value })} placeholder="예: 강서" className={inputCls} />
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">차종</label>
                  <input value={createForm.vehicle} onChange={(e) => setCreateForm({ ...createForm, vehicle: e.target.value })} placeholder="예: 1톤" className={inputCls} />
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">필요 인원</label>
                  <input
                    type="number"
                    min={1}
                    value={createForm.needed_count}
                    onChange={(e) => setCreateForm({ ...createForm, needed_count: e.target.value })}
                    onFocus={(e) => e.target.select()}
                    className={inputCls}
                  />
                </div>
              </div>
              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">메모</label>
                <textarea
                  value={createForm.note}
                  onChange={(e) => setCreateForm({ ...createForm, note: e.target.value })}
                  rows={2}
                  placeholder="예: 무단결근 발생, 오전 중 대체 필요"
                  className={`${inputCls} leading-relaxed resize-none`}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0] sticky bottom-0 bg-white">
              <button onClick={() => setCreateForm(null)} disabled={saving} className="px-4 py-2.5 rounded-xl text-[13px] font-bold text-[#718096] hover:bg-[#F7FAFC] border border-[#E2E8F0] disabled:opacity-50">취소</button>
              <button onClick={handleCreate} disabled={saving} className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-[13px] font-bold text-white bg-[#E53E3E] hover:bg-[#C53030] disabled:opacity-60">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Siren size={15} />} 기록
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 해결 기록 모달 */}
      {resolveForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => !saving && setResolveForm(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-5 border-b border-[#E2E8F0] sticky top-0 bg-white">
              <h2 className="text-[18px] font-extrabold text-[#1A202C]">해결 기록 — {resolveForm.line_label}</h2>
              <button onClick={() => setResolveForm(null)} className="text-[#A0AEC0] hover:text-[#4A5568] p-1 rounded-lg"><X size={20} /></button>
            </div>
            <div className="p-6 flex flex-col gap-5">
              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">해결 방법 <span className="text-[#E53E3E]">*</span></label>
                <select
                  value={resolveForm.resolution}
                  onChange={(e) => setResolveForm({ ...resolveForm, resolution: e.target.value as SosResolution | "" })}
                  className={`${inputCls} bg-white`}
                >
                  <option value="">선택해주세요</option>
                  {(Object.entries(SOS_RESOLUTIONS) as [SosResolution, string][]).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">든 비용 (원)</label>
                  <input
                    type="number"
                    min={0}
                    value={resolveForm.cost_krw}
                    onChange={(e) => setResolveForm({ ...resolveForm, cost_krw: e.target.value })}
                    placeholder="예: 150000"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">실소요 (분)</label>
                  <input
                    type="number"
                    min={0}
                    value={resolveForm.duration_minutes}
                    onChange={(e) => setResolveForm({ ...resolveForm, duration_minutes: e.target.value })}
                    placeholder="예: 40"
                    className={inputCls}
                  />
                </div>
              </div>
              <div>
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">메모</label>
                <textarea
                  value={resolveForm.resolution_note}
                  onChange={(e) => setResolveForm({ ...resolveForm, resolution_note: e.target.value })}
                  rows={2}
                  placeholder="예: 용차 김OO, 프리미엄 5만"
                  className={`${inputCls} leading-relaxed resize-none`}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[#E2E8F0] sticky bottom-0 bg-white">
              <button onClick={() => setResolveForm(null)} disabled={saving} className="px-4 py-2.5 rounded-xl text-[13px] font-bold text-[#718096] hover:bg-[#F7FAFC] border border-[#E2E8F0] disabled:opacity-50">취소</button>
              <button onClick={handleResolve} disabled={saving} className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-[13px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] disabled:opacity-60">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} 해결로 기록
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
