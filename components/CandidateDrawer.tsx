import { useState } from "react";
import { X, Phone, MessageSquare, MapPin, Briefcase, Clock, Building2, Ban, ArrowRight, Loader2, CalendarClock } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";

export interface DrawerCandidate {
  id: string;
  name: string;
  age: number;
  channel: string;
  branch: string;
  slot: string;
  tag: string;
  region: string;
  exp: string;
  lastActive: string;
  phone: string | null;
  stage?: string;
  stageId?: string;
}

interface CandidateDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  candidate: DrawerCandidate | null;
  onStatusChange?: () => void;
}

// 현재 단계 → 다음 단계(상태). 면접 단계는 이 제품에 없다.
const NEXT_STAGE: Record<string, { status: string; label: string }> = {
  applied: { status: "스크리닝 중", label: "AI 스크리닝 시작" },
  screening: { status: "스크리닝 완료", label: "스크리닝 완료로 이동" },
  interview: { status: "확정인력", label: "확정 인력으로 이동" },
};

function InfoRow({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="flex border-b border-[#E2E8F0] last:border-0">
      <div className="w-[120px] bg-[#EDF2F7] p-3 text-[12px] font-bold text-[#4A5568] flex items-center gap-1.5">{icon} {label}</div>
      <div className="flex-1 p-3 text-[13px] text-[#1A202C] font-medium">{value || "-"}</div>
    </div>
  );
}

export function CandidateDrawer({ isOpen, onClose, candidate, onStatusChange }: CandidateDrawerProps) {
  const [busy, setBusy] = useState(false);
  if (!isOpen || !candidate) return null;

  const c = candidate;
  const next = c.stageId ? NEXT_STAGE[c.stageId] : undefined;

  const patchStatus = async (status: string, msg: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/applicants/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error || "상태 변경에 실패했어요");
        return;
      }
      toast.success(msg);
      onClose();
      onStatusChange?.();
    } catch {
      toast.error("상태 변경에 실패했어요");
    } finally {
      setBusy(false);
    }
  };

  const telHref = c.phone ? `tel:${c.phone.replace(/[^0-9+]/g, "")}` : undefined;
  const smsHref = c.phone ? `sms:${c.phone.replace(/[^0-9+]/g, "")}` : undefined;

  return (
    <>
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/30 z-40 backdrop-blur-[2px]"
        />
      </AnimatePresence>

      <AnimatePresence>
        <motion.div
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
          className="fixed top-0 right-0 w-[480px] h-full bg-white shadow-[-10px_0_30px_rgba(0,0,0,0.1)] z-50 flex flex-col border-l border-[#E2E8F0]"
        >
          {/* Header */}
          <div className="p-6 border-b border-[#E2E8F0] flex justify-between items-start bg-[#F7FAFC]">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-[#EDF2F7] text-[#4A5568] flex items-center justify-center font-bold text-[20px] shadow-inner">
                {c.name.charAt(0)}
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-[20px] font-extrabold text-[#1A202C]">{c.name}</h2>
                  {c.age > 0 && (
                    <span className="text-[13px] font-medium text-[#718096] bg-white px-2 py-0.5 rounded-md border border-[#E2E8F0]">
                      {c.age}세
                    </span>
                  )}
                  {c.stage && (
                    <span className="text-[12px] font-bold text-[#3182CE] bg-[#EBF8FF] px-2 py-0.5 rounded-md">{c.stage}</span>
                  )}
                </div>
                <div className="text-[13px] text-[#A0AEC0] font-mono">#{c.id} · {c.region}</div>
              </div>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-[#E2E8F0] rounded-lg transition-colors text-[#A0AEC0] hover:text-[#1A202C] outline-none">
              <X size={20} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-white">

            {/* Action Bar — 실제 연락 수단 (디바이스 기본 앱 연결) */}
            <div className="flex gap-2">
              <a
                href={telHref}
                onClick={(e) => { if (!telHref) { e.preventDefault(); toast.error("연락처가 없어요."); } }}
                className="flex-1 bg-[#F7FAFC] hover:bg-[#EDF2F7] border border-[#E2E8F0] text-[#1A202C] py-2.5 rounded-xl text-[13px] font-bold flex justify-center items-center gap-2 transition-colors"
              >
                <Phone size={16} className="text-[#4A5568]" /> 전화 걸기
              </a>
              <a
                href={smsHref}
                onClick={(e) => { if (!smsHref) { e.preventDefault(); toast.error("연락처가 없어요."); } }}
                className="flex-1 bg-[#1A202C] hover:bg-[#2D3748] text-white py-2.5 rounded-xl text-[13px] font-bold flex justify-center items-center gap-2 transition-colors"
              >
                <MessageSquare size={16} /> 문자 보내기
              </a>
            </div>
            {c.phone && (
              <div className="text-[12px] text-[#A0AEC0] -mt-3">연락처 {c.phone}</div>
            )}

            {/* Detail Info — 실데이터 */}
            <div>
              <h3 className="text-[14px] font-bold text-[#1A202C] mb-3">지원 정보</h3>
              <div className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl overflow-hidden">
                <InfoRow label="지원 채널" value={c.channel} icon={<Building2 size={13} className="text-[#A0AEC0]" />} />
                <InfoRow label="희망 지점" value={c.branch} icon={<MapPin size={13} className="text-[#A0AEC0]" />} />
                <InfoRow label="희망 근무" value={c.slot} icon={<CalendarClock size={13} className="text-[#A0AEC0]" />} />
                <InfoRow label="차량 / 조건" value={c.tag} icon={<Briefcase size={13} className="text-[#A0AEC0]" />} />
                <InfoRow label="경력" value={c.exp} icon={<Briefcase size={13} className="text-[#A0AEC0]" />} />
                <InfoRow label="거주 지역" value={c.region} icon={<MapPin size={13} className="text-[#A0AEC0]" />} />
              </div>
            </div>

            {/* 최근 활동 */}
            <div className="flex items-center gap-2 text-[13px] text-[#718096]">
              <Clock size={15} className="text-[#A0AEC0]" />
              마지막 활동 <b className="text-[#4A5568]">{c.lastActive}</b>
            </div>
          </div>

          {/* Footer Actions — 실제 상태 변경 */}
          <div className="p-5 border-t border-[#E2E8F0] bg-[#F7FAFC] flex gap-2">
            <button
              onClick={() => patchStatus("부적합", `${c.name}님을 부적합 처리했어요.`)}
              disabled={busy}
              className="flex-1 bg-white border border-[#E53E3E] text-[#E53E3E] py-2.5 rounded-xl text-[13px] font-bold hover:bg-[#FFF5F5] transition-colors disabled:opacity-50 flex justify-center items-center gap-1.5"
            >
              <Ban size={15} /> 부적합 처리
            </button>
            {next ? (
              <button
                onClick={() => patchStatus(next.status, `${c.name}님을 ${next.status}(으)로 이동했어요.`)}
                disabled={busy}
                className="flex-[2] bg-[#FFCB3C] text-[#1A202C] py-2.5 rounded-xl text-[13px] font-bold hover:bg-[#E0B500] transition-colors shadow-sm disabled:opacity-50 flex justify-center items-center gap-1.5"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />} {next.label}
              </button>
            ) : (
              <div className="flex-[2] flex items-center justify-center text-[12.5px] font-bold text-[#718096] bg-[#EDF2F7] rounded-xl">
                확정 단계 — 슬롯/지점은 지점 관리에서
              </div>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </>
  );
}
