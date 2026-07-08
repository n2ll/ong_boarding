import { useEffect, useState } from "react";
import useSWR from "swr";
import { motion } from "motion/react";
import { Heart, Zap, Phone, Loader2, ExternalLink, Check, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";
import { ApplicantDetailPanel } from "./ApplicantDetailPanel";

/**
 * 관심 표시 처리 대기 카드 (내부 매니저용).
 * pull 채널에서 '관심 있어요'를 누른 후보(agent_stage IS NULL, 미컨택)를 큐로 보여준다.
 * 매니저가 상세 확인 → 컨택 완료/보류로 처리하며, 상세에서 확정·부적합 처리하면 자동으로 큐에서 빠진다.
 * 카드 톤·마크업은 SosLedgerCard와 일관되게 맞춘다.
 */

interface QueueItem {
  candidate_id: number;
  applicant_id: number;
  name: string | null;
  phone: string | null;
  availability: string | null;
  sms_opt_out_at: string | null;
  job_id: number;
  job_title: string;
  interested_at: string | null;
  immediate: boolean;
}

interface QueueRes {
  items?: QueueItem[];
  count?: number;
  immediate_count?: number;
}

function agoLabel(iso: string | null, now: number): string {
  if (!iso) return "-";
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** 가용성 배지 톤 — 즉시가능/바로가능 초록 강조, 이번주가능 연녹, 그 외/미확인 회색. */
function availabilityBadge(availability: string | null, immediate: boolean) {
  if (immediate || availability === "즉시가능")
    return { label: "즉시가능", cls: "bg-[#F0FFF4] text-[#276749] border-[#9AE6B4]" };
  if (availability === "이번주가능")
    return { label: "이번주가능", cls: "bg-[#F0FFF4] text-[#38A169] border-[#C6F6D5]" };
  if (availability === "휴면")
    return { label: "휴면", cls: "bg-[#F7FAFC] text-[#A0AEC0] border-[#E2E8F0]" };
  return { label: "미확인", cls: "bg-[#F7FAFC] text-[#A0AEC0] border-[#E2E8F0]" };
}

export function InterestQueueCard() {
  const confirm = useConfirm();
  const { data, mutate, error } = useSWR<QueueRes>("/api/admin/interest-queue");

  const items = data?.items ?? [];
  const count = data?.count ?? 0;
  const immediateCount = data?.immediate_count ?? 0;

  // '관심 표시 상대시각'이 화면에 머무는 동안 갱신되도록 1분 틱 (SosLedgerCard 경과 라벨과 동일 패턴)
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const handleAction = async (candidateId: number, action: "contacted" | "dismiss") => {
    if (action === "dismiss") {
      if (!(await confirm({ title: "이 관심 표시를 보류할까요?", description: "목록에서 제외됩니다.", confirmText: "보류", destructive: true }))) return;
    }
    setBusyId(candidateId);
    try {
      const res = await fetch("/api/admin/interest-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_id: candidateId, action }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "처리에 실패했어요");
        return;
      }
      toast.success(action === "contacted" ? "컨택 대상으로 표시했어요" : "관심 표시를 보류했어요");
      await mutate();
    } catch {
      toast.error("처리에 실패했어요");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <motion.div
      id="interest-queue"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.32 }}
      className="scroll-mt-6 bg-white border border-[#E2E8F0] rounded-[16px] p-6 shadow-sm flex flex-col"
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-[15px] font-bold text-[#1A202C] flex items-center gap-1.5">
            <Heart size={15} className="text-[#E53E3E]" /> 관심 표시 처리 대기
          </h2>
          <div className="text-[12px] text-[#718096] mt-0.5">맞춤 공고에 관심을 누른 후보 · 상세 확인 후 컨택/보류로 처리</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {immediateCount > 0 && (
            <span className="flex items-center gap-1 text-[12px] font-bold text-[#276749] bg-[#F0FFF4] border border-[#9AE6B4] px-2.5 py-1 rounded-full">
              <Zap size={12} /> 바로가능 {immediateCount}건
            </span>
          )}
          <span className="text-[12px] font-bold text-[#4A5568] bg-[#F7FAFC] border border-[#E2E8F0] px-2.5 py-1 rounded-full">
            총 {count}건
          </span>
        </div>
      </div>

      {error ? (
        <div className="py-4 text-center text-[13px] text-[#E53E3E]">큐를 불러오지 못했어요.</div>
      ) : !data ? (
        <div className="py-4 flex items-center justify-center text-[13px] text-[#A0AEC0]">
          <Loader2 size={15} className="animate-spin mr-1.5" /> 불러오는 중…
        </div>
      ) : items.length === 0 ? (
        <div className="py-4 text-center text-[13px] text-[#A0AEC0]">처리 대기 중인 관심 표시가 없어요.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((it) => {
            const badge = availabilityBadge(it.availability, it.immediate);
            const busy = busyId === it.candidate_id;
            const optOut = !!it.sms_opt_out_at;
            return (
              <div
                key={it.candidate_id}
                className={`flex items-center gap-3 p-3 border rounded-xl ${it.immediate ? "border-[#9AE6B4] bg-[#F0FFF4]" : "border-[#E2E8F0] bg-white"}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[13px] font-bold text-[#1A202C]">{it.name || "이름 미상"}</span>
                    {it.immediate && (
                      <span className="flex items-center gap-0.5 text-[10.5px] font-bold text-[#276749]">
                        <Zap size={11} /> 바로 가능
                      </span>
                    )}
                    <span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded border ${badge.cls}`}>{badge.label}</span>
                    {optOut && (
                      <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded border bg-[#FFF5F5] text-[#C53030] border-[#FEB2B2]">수신거부</span>
                    )}
                  </div>
                  <div className="text-[11.5px] text-[#718096] truncate mt-0.5">
                    <span className="font-semibold text-[#4A5568]">{it.job_title}</span>
                    <span className="text-[#CBD5E0]"> · </span>
                    관심 {agoLabel(it.interested_at, nowTick)}
                    {it.phone && (
                      <>
                        <span className="text-[#CBD5E0]"> · </span>
                        <a
                          href={`tel:${it.phone}`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-0.5 text-[#3182CE] hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
                        >
                          <Phone size={11} /> {it.phone}
                        </a>
                      </>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => setDetailId(it.applicant_id)}
                  className="flex items-center gap-1 text-[11.5px] font-bold text-[#4A5568] bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] px-3 py-1.5 rounded-lg shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
                >
                  <ExternalLink size={13} /> 상세
                </button>
                <button
                  onClick={() => handleAction(it.candidate_id, "contacted")}
                  disabled={busy}
                  className="flex items-center gap-1 text-[11.5px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] px-3 py-1.5 rounded-lg shrink-0 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} 컨택 완료
                </button>
                <button
                  onClick={() => handleAction(it.candidate_id, "dismiss")}
                  disabled={busy}
                  title="보류"
                  className="flex items-center gap-1 text-[11.5px] font-bold text-[#718096] bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] hover:text-[#E53E3E] px-2.5 py-1.5 rounded-lg shrink-0 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E53E3E]/40"
                >
                  <XCircle size={13} /> 보류
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* 상세 드로어 — 닫힐 때 큐 갱신(상세에서 확정/부적합 처리하면 자동으로 큐에서 빠짐) */}
      <ApplicantDetailPanel
        isOpen={detailId != null}
        onClose={() => {
          setDetailId(null);
          void mutate();
        }}
        applicantId={detailId}
        onChanged={() => void mutate()}
      />
    </motion.div>
  );
}
