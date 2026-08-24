import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { motion } from "motion/react";
import { Siren, Plus, X, Loader2, Save, Trash2, Wallet, ChevronDown, ChevronRight, Briefcase, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "./ui/modal";
import { Button } from "./ui/button";
import { TextField, TextareaField, SelectField } from "./ui/field";
import { useConfirm } from "./ConfirmDialog";
import { SOS_RESOLUTIONS, COST_CATEGORIES, kstMonth, type SosResolution, type CostCategory } from "@/lib/sos";
import {
  sosLedgerCardView,
  type SosLedgerCostData as LedgerRes,
  type SosLedgerCostRow as LedgerRow,
  type SosLedgerSosData as SosRes,
  type SosLedgerSosRow as SosRow,
} from "@/lib/admin/sos-ledger-card-view";

/**
 * 긴급 건 기록 카드 (내부 매니저용 · 기록 전용 — 발송 기능 없음).
 * sos_requests(발생~해결 로그) + cost_ledger(월 운영비)를 한 카드에서 수기 관리한다.
 */

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
  const ledgerDetailsId = useId();
  const {
    data: sosRes,
    error: sosError,
    mutate: mutateSos,
    isValidating: sosValidating,
  } = useSWR<SosRes>("/api/admin/sos");
  const {
    data: ledgerRes,
    error: ledgerError,
    mutate: mutateLedger,
    isValidating: ledgerValidating,
  } = useSWR<LedgerRes>("/api/admin/cost-ledger");
  const view = sosLedgerCardView({ sosData: sosRes, sosError, ledgerData: ledgerRes, ledgerError });
  const sosData = view.sos.state === "ready" || view.sos.state === "stale" ? view.sos.data : undefined;
  const ledgerData = view.ledger.state === "ready" || view.ledger.state === "stale" ? view.ledger.data : undefined;
  const openRows = sosData?.open ?? [];
  const recentRows = sosData?.recent ?? [];
  const summary = sosData?.month_summary;
  const ledgerRows = ledgerData?.rows ?? [];
  const ledgerTotal = ledgerData?.total ?? 0;

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
          month: ledgerData?.month ?? kstMonth(),
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
    "w-full px-4 py-3 border border-control-border rounded-2xl text-sm focus:outline-none focus-visible:border-foreground/65 focus-visible:ring-2 focus-visible:ring-ring";
  const retrySosButton = (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => void mutateSos()}
      isLoading={sosValidating}
      className="self-start shadow-none"
    >
      {sosValidating ? "갱신 중" : "다시 시도"}
    </Button>
  );
  const retryLedgerButton = (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => void mutateLedger()}
      isLoading={ledgerValidating}
      className="self-start shadow-none"
    >
      {ledgerValidating ? "갱신 중" : "다시 시도"}
    </Button>
  );

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }} className="flex flex-col rounded-panel border border-border-strong bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-[16px] font-bold text-foreground flex items-center gap-1.5"><Siren size={15} className="text-priority-critical-ink" /> 긴급 건 기록</h2>
          <div className="text-[12px] text-muted-foreground mt-0.5">결원·증차 발생~해결 로그와 월 운영비 (기록 전용)</div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setCreateForm({ ...EMPTY_SOS_FORM })}
          className="border-priority-critical/25 bg-priority-critical-soft text-priority-critical-ink shadow-none hover:bg-priority-critical-soft/70"
        >
          <Plus size={14} /> 긴급 건 기록
        </Button>
      </div>

      {(view.sos.state === "error" || view.sos.state === "stale") && (
        <div
          role="alert"
          className={`mb-4 flex flex-col gap-3 rounded-2xl border p-3.5 ${
            view.sos.state === "error"
              ? "border-error/30 bg-error-soft text-error-strong"
              : "border-warning/30 bg-warning-soft text-warning-strong"
          }`}
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <div>
              <div className="text-[13px] font-bold">
                {view.sos.state === "error" ? "긴급 건 현황을 불러오지 못했어요" : "긴급 건 업데이트에 실패했어요"}
              </div>
              <div className="mt-0.5 text-[12px] leading-relaxed">
                {view.sos.state === "error"
                  ? "진행 중 0건이라는 뜻이 아닙니다. 확인 전에는 빈 상태로 판단하지 마세요."
                  : "아래에는 마지막으로 확인한 이전 값을 표시합니다."}
              </div>
            </div>
          </div>
          {retrySosButton}
        </div>
      )}

      {/* 이번 달 요약 */}
      <div className="mb-4 rounded-2xl bg-background/70 px-4 py-2.5 text-[13px] font-semibold text-gray-700">
        이번 달 긴급 <b className="text-foreground">{summary ? `${summary.count}건` : "—"}</b>
        <span aria-hidden="true"> · </span>
        해결 <b className="text-foreground">{summary ? `${summary.resolved}건` : "—"}</b>
        <span aria-hidden="true"> · </span>
        건별 비용 <b className="text-foreground">{summary ? won(summary.cost_sum) : "—"}</b>
        <span aria-hidden="true"> + </span>
        월 운영비 <b className="text-foreground">{ledgerData ? won(ledgerTotal) : "—"}</b>
      </div>

      {/* 진행 중 건 */}
      {view.sos.state === "loading" ? (
        <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 py-4 text-[13px] font-medium text-muted-foreground">
          <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> 긴급 건 현황 확인 중…
        </div>
      ) : view.sos.state === "error" ? (
        <div className="py-4 text-center text-[13px] font-medium text-error-strong">진행 중 긴급 건을 확인할 수 없어요.</div>
      ) : openRows.length === 0 ? (
        <div className="py-4 text-center text-[13px] text-muted-foreground">진행 중인 긴급 건이 없어요. 결원·증차가 생기면 오른쪽 위 &lsquo;긴급 건 기록&rsquo;으로 남겨주세요.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {openRows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 rounded-2xl border border-priority-critical/25 bg-priority-critical-soft p-3">
              <span className="h-2 w-2 shrink-0 rounded-full bg-priority-critical" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-bold text-foreground truncate">{r.line_label}</div>
                <div className="truncate text-[12px] text-priority-critical-ink">
                  {[r.region, r.vehicle, `${r.needed_count}명 필요`, r.note].filter(Boolean).join(" · ")}
                </div>
              </div>
              <span className="shrink-0 text-[12px] font-bold text-priority-critical-ink">{elapsedLabel(r.created_at, nowTick)}</span>
              <button
                onClick={() => handleMakeJob(r)}
                className="flex items-center gap-1 text-[12px] font-bold text-gray-700 bg-white border border-border-strong hover:bg-background px-3 py-1.5 rounded-lg shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Briefcase size={13} /> 공고로 만들기
              </button>
              <button
                onClick={() => setResolveForm({ id: r.id, line_label: r.line_label, resolution: "", cost_krw: "", duration_minutes: "", resolution_note: "" })}
                className="text-[12px] font-bold text-white bg-foreground hover:bg-gray-800 px-3 py-1.5 rounded-lg shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                해결 기록
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 최근 처리 내역 */}
      {recentRows.length > 0 && (
        <div className="mt-3 border-t border-muted pt-3">
          <div className="text-[12px] font-bold text-muted-foreground mb-1.5">최근 처리</div>
          <div className="flex flex-col gap-1">
            {recentRows.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-[12px] text-gray-700">
                <span className="font-semibold truncate">{r.line_label}</span>
                <span className="text-muted-foreground shrink-0">
                  {r.status === "cancelled" ? "취소 종결" : r.resolution ? SOS_RESOLUTIONS[r.resolution] : "해결"}
                  {typeof r.cost_krw === "number" && r.cost_krw > 0 ? ` · ${won(r.cost_krw)}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 월 운영비 (접이식) */}
      <div className="mt-4 border-t border-muted pt-3">
        {view.ledger.state === "loading" ? (
          <div role="status" aria-live="polite" className="flex items-center gap-2 px-1 py-2 text-[13px] font-bold text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> 월 운영비 확인 중…
          </div>
        ) : view.ledger.state === "error" ? (
          <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-error/30 bg-error-soft p-3.5 text-error-strong">
            <div className="flex min-w-0 items-start gap-2.5">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <div>
                <div className="text-[13px] font-bold">월 운영비를 불러오지 못했어요</div>
                <div className="mt-0.5 text-[12px] leading-relaxed">₩0이라는 뜻이 아닙니다. 긴급 건 현황과는 별도로 다시 확인해 주세요.</div>
              </div>
            </div>
            {retryLedgerButton}
          </div>
        ) : (
          <>
            <button
              onClick={() => setLedgerOpen((o) => !o)}
              aria-expanded={ledgerOpen}
              aria-controls={ledgerDetailsId}
              className="flex min-h-9 w-full items-center justify-between rounded-lg px-1 text-[13px] font-bold text-gray-700 transition-colors hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-1.5"><Wallet size={14} className="text-info" /> {ledgerData?.month ?? kstMonth()} 운영비 {won(ledgerTotal)}</span>
              {ledgerOpen ? <ChevronDown size={15} className="text-muted-foreground" /> : <ChevronRight size={15} className="text-muted-foreground" />}
            </button>

            {view.ledger.state === "stale" && (
              <div role="alert" className="mt-2 flex flex-col gap-3 rounded-2xl border border-warning/30 bg-warning-soft p-3.5 text-warning-strong">
                <div className="flex min-w-0 items-start gap-2.5">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <div>
                    <div className="text-[13px] font-bold">운영비 업데이트에 실패했어요</div>
                    <div className="mt-0.5 text-[12px] leading-relaxed">마지막으로 확인한 이전 값을 표시합니다.</div>
                  </div>
                </div>
                {retryLedgerButton}
              </div>
            )}

            {ledgerOpen && (
              <div id={ledgerDetailsId} className="mt-3 flex flex-col gap-2">
                {ledgerRows.length === 0 && (
                  <div className="text-[12px] text-muted-foreground">이번 달 입력된 운영비가 없어요.</div>
                )}
                {ledgerRows.map((row) => (
                  <div key={row.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 rounded-lg bg-background px-3 py-2">
                    <span className="truncate text-[12px] font-bold text-gray-700">{COST_CATEGORIES[row.category as CostCategory] ?? row.category}</span>
                    <span className="shrink-0 text-[13px] font-extrabold text-foreground">{won(row.amount_krw)}</span>
                    <button
                      onClick={() => handleDeleteLedger(row)}
                      title="삭제"
                      className="after:absolute after:-inset-2 after:content-[''] relative text-muted-foreground hover:text-error p-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/40"
                    >
                      <Trash2 size={14} />
                    </button>
                    {row.memo && <span className="col-span-3 truncate text-[12px] text-muted-foreground">{row.memo}</span>}
                  </div>
                ))}

                {/* 추가 폼 */}
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                  <select
                    value={ledgerForm.category}
                    onChange={(e) => setLedgerForm({ ...ledgerForm, category: e.target.value as CostCategory })}
                    className="min-w-[140px] flex-1 rounded-lg border border-control-border bg-white px-3 py-2 pr-8 text-[13px] focus:outline-none focus-visible:border-foreground/65 focus-visible:ring-2 focus-visible:ring-ring"
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
                    className="w-[110px] flex-none rounded-2xl border border-control-border px-3 py-2 text-[13px] focus:outline-none focus-visible:border-foreground/65 focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <input
                    placeholder="메모 (선택)"
                    value={ledgerForm.memo}
                    onChange={(e) => setLedgerForm({ ...ledgerForm, memo: e.target.value })}
                    className="min-w-[140px] flex-[2_1_180px] rounded-2xl border border-control-border px-3 py-2 text-[13px] focus:outline-none focus-visible:border-foreground/65 focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <button
                    onClick={handleAddLedger}
                    disabled={saving}
                    className="flex min-h-10 flex-none items-center gap-1 rounded-lg bg-foreground px-3 py-2 text-[12px] font-bold text-white transition-colors hover:bg-gray-800 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Plus size={13} /> 추가
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 긴급 건 기록 모달 */}
      <Modal
        open={Boolean(createForm)}
        onClose={() => setCreateForm(null)}
        busy={saving}
        size="lg"
        title="긴급 건 기록"
        description="지금 사람이 비는 자리를 남겨 둡니다. 아직 아무에게도 문자가 나가지 않습니다."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCreateForm(null)} disabled={saving}>취소</Button>
                <Button size="sm" variant="primary" onClick={handleCreate} isLoading={saving}>
              <Siren size={15} /> 기록
            </Button>
          </>
        }
      >
        {createForm && (
          <div className="flex flex-col gap-4">
            <TextField
              required
              label="라인/권역 라벨"
              value={createForm.line_label}
              onChange={(e) => setCreateForm({ ...createForm, line_label: e.target.value })}
              placeholder="예: 강서 새벽 배민"
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <TextField
                label="권역"
                value={createForm.region}
                onChange={(e) => setCreateForm({ ...createForm, region: e.target.value })}
                placeholder="예: 강서"
              />
              <TextField
                label="차종"
                value={createForm.vehicle}
                onChange={(e) => setCreateForm({ ...createForm, vehicle: e.target.value })}
                placeholder="예: 1톤"
              />
              <TextField
                label="필요 인원"
                type="number"
                min={1}
                value={createForm.needed_count}
                onChange={(e) => setCreateForm({ ...createForm, needed_count: e.target.value })}
                onFocus={(e) => e.target.select()}
              />
            </div>
            <TextareaField
              label="메모"
              rows={2}
              value={createForm.note}
              onChange={(e) => setCreateForm({ ...createForm, note: e.target.value })}
              placeholder="예: 무단결근 발생, 오전 중 대체 필요"
            />
          </div>
        )}
      </Modal>

      {/* 해결 기록 모달 */}
      <Modal
        open={Boolean(resolveForm)}
        onClose={() => setResolveForm(null)}
        busy={saving}
        size="lg"
        title={resolveForm ? `해결 기록 \u2014 ${resolveForm.line_label}` : "해결 기록"}
        description="어떻게 메웠는지와 든 비용을 남깁니다. 이 값이 대체 비용 원장이 됩니다."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setResolveForm(null)} disabled={saving}>취소</Button>
            <Button size="sm" onClick={handleResolve} isLoading={saving}>
              <Save size={15} /> 해결로 기록
            </Button>
          </>
        }
      >
        {resolveForm && (
          <div className="flex flex-col gap-4">
            <SelectField
              required
              label="해결 방법"
              value={resolveForm.resolution}
              onChange={(e) => setResolveForm({ ...resolveForm, resolution: e.target.value as SosResolution | "" })}
            >
              <option value="">선택해주세요</option>
              {(Object.entries(SOS_RESOLUTIONS) as [SosResolution, string][]).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </SelectField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField
                label="든 비용 (원)"
                type="number"
                min={0}
                value={resolveForm.cost_krw}
                onChange={(e) => setResolveForm({ ...resolveForm, cost_krw: e.target.value })}
                placeholder="예: 150000"
              />
              <TextField
                label="실소요 (분)"
                type="number"
                min={0}
                value={resolveForm.duration_minutes}
                onChange={(e) => setResolveForm({ ...resolveForm, duration_minutes: e.target.value })}
                placeholder="예: 40"
              />
            </div>
            <TextareaField
              label="메모"
              rows={2}
              value={resolveForm.resolution_note}
              onChange={(e) => setResolveForm({ ...resolveForm, resolution_note: e.target.value })}
              placeholder="예: 용차 김OO, 프리미엄 5만"
            />
          </div>
        )}
      </Modal>
    </motion.div>
  );
}
