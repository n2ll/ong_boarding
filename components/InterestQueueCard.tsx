import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { motion } from "motion/react";
import { Heart, Zap, Phone, Loader2, ExternalLink, Check, XCircle, Send, X } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";
import { ApplicantDetailPanel } from "./ApplicantDetailPanel";

/**
 * 관심 표시 처리 대기 카드 (내부 매니저용).
 * pull 채널에서 '관심 있어요'를 누른 후보(agent_stage IS NULL, 미컨택)를 큐로 보여준다.
 * 매니저가 상세 확인 → 빠른 컨택(문자 발송+처리) / 컨택 완료(발송 없이 처리) / 보류로 처리하며,
 * 상세에서 확정·부적합 처리하면 자동으로 큐에서 빠진다.
 * 카드 톤·마크업은 SosLedgerCard와 일관되게 맞춘다.
 *
 * ⚠️ 확정 뉘앙스 금지: 컨택 문구는 "담당 매니저가 곧 연락드릴게요" 수준의 정보성만.
 * 근무 확정/배정을 암시하는 표현은 두지 않는다(확정은 매니저).
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

/**
 * 빠른 컨택 프리필 문구. 정보성 안내만 — 근무 확정/배정 뉘앙스 금지(확정은 매니저).
 * 매니저가 발송 전 편집 가능(오발송 방지). 이름/공고명이 없으면 자연스럽게 대체.
 */
function prefillContactBody(name: string | null, jobTitle: string): string {
  const n = (name || "").trim() || "안녕하세요";
  const job = (jobTitle || "").trim();
  const jobPart = job ? `'${job}' ` : "";
  return `[옹고잉] ${n}님, ${jobPart}관심 주셔서 감사합니다. 담당 매니저가 곧 연락드릴게요. 통화 편하신 시간대 있으면 이 번호로 답장 주세요!`;
}

// initialJobId — 대시보드 긴급 건 등에서 특정 공고 소속만 보도록 진입 시 자동 선택(선택).
export function InterestQueueCard({ initialJobId }: { initialJobId?: number | null } = {}) {
  const confirm = useConfirm();
  const { data, mutate, error } = useSWR<QueueRes>("/api/admin/interest-queue", { refreshInterval: 30_000 }); // 살아있는 갱신

  const allItems = data?.items ?? [];

  // 공고별 필터 — 여러 급구 동시 진행 시 어느 공고 소속인지 구분. 큐에 등장하는 공고들로 옵션 구성.
  const [jobFilter, setJobFilter] = useState<number | "all">(initialJobId ?? "all");
  useEffect(() => {
    if (initialJobId != null) setJobFilter(initialJobId);
  }, [initialJobId]);
  const jobOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const it of allItems) if (!m.has(it.job_id)) m.set(it.job_id, it.job_title || `공고 #${it.job_id}`);
    return Array.from(m, ([id, title]) => ({ id, title }));
  }, [allItems]);
  // 선택한 공고가 큐에서 사라지면(모두 처리됨) 자동으로 전체로 되돌린다.
  useEffect(() => {
    if (jobFilter !== "all" && !jobOptions.some((o) => o.id === jobFilter)) setJobFilter("all");
  }, [jobFilter, jobOptions]);

  const items = jobFilter === "all" ? allItems : allItems.filter((it) => it.job_id === jobFilter);
  const count = items.length;
  const immediateCount = items.filter((it) => it.immediate).length;

  // '관심 표시 상대시각'이 화면에 머무는 동안 갱신되도록 1분 틱 (SosLedgerCard 경과 라벨과 동일 패턴)
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // 빠른 컨택 모달 — 발송 전 편집 가능한 확인 모달(오발송 방지). 외부 발송이라 반드시 확인을 거친다.
  const [quick, setQuick] = useState<QueueItem | null>(null);
  const [quickBody, setQuickBody] = useState("");
  const [quickSending, setQuickSending] = useState(false);

  const openQuick = (it: QueueItem) => {
    setQuick(it);
    setQuickBody(prefillContactBody(it.name, it.job_title));
  };

  // 발송(성공) → 이어서 contacted 스탬프. contacted_at은 발송 성공 후에만 찍는다.
  const handleQuickSend = async () => {
    if (!quick || quickSending) return;
    if (!quick.phone) {
      toast.error("이 후보는 전화번호가 없어 발송할 수 없어요.");
      return;
    }
    const body = quickBody.trim();
    if (!body) {
      toast.error("보낼 문구가 비어 있어요.");
      return;
    }
    setQuickSending(true);
    try {
      const sendRes = await fetch("/api/admin/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: quick.applicant_id, phone: quick.phone, body, sent_by: "manager" }),
      });
      const sendJson = await sendRes.json().catch(() => ({}));
      if (!sendRes.ok) {
        toast.error(sendJson.error || "문자 발송에 실패했어요");
        return;
      }
      // 발송은 이미 성공한 시점 — contacted 처리 실패가 '발송 실패'로 오표시되지 않게 분리 처리.
      try {
        const markRes = await fetch("/api/admin/interest-queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidate_id: quick.candidate_id, action: "contacted" }),
        });
        if (!markRes.ok) {
          const mj = await markRes.json().catch(() => ({}));
          toast.error(mj.error || "문자는 보냈지만 큐 처리에 실패했어요. [컨택 완료]로 다시 처리해주세요.");
        } else {
          toast.success("문자를 보내고 컨택 완료로 처리했어요.");
        }
      } catch {
        toast.error("문자는 보냈지만 큐 처리에 실패했어요. [컨택 완료]로 다시 처리해주세요.");
      }
      setQuick(null);
      await mutate();
    } catch {
      toast.error("문자 발송에 실패했어요");
    } finally {
      setQuickSending(false);
    }
  };

  const handleAction = async (candidateId: number, action: "contacted" | "dismiss") => {
    if (action === "contacted") {
      if (!(await confirm({
        title: "발송 없이 컨택 완료로 처리할까요?",
        description: "문자를 보내지 않고 처리만 합니다(직접 전화 등으로 이미 연락한 경우). 문자를 보내려면 [빠른 컨택]을 쓰세요.",
        confirmText: "발송 없이 처리",
      }))) return;
    } else {
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
      toast.success(action === "contacted" ? "발송 없이 컨택 완료로 처리했어요" : "관심 표시를 보류했어요");
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
          {/* 공고별 필터 — 큐에 2개 이상 공고가 섞였을 때만 노출(컨텍스트 연결) */}
          {jobOptions.length > 1 && (
            <select
              value={jobFilter === "all" ? "all" : String(jobFilter)}
              onChange={(e) => setJobFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
              className="max-w-[180px] text-[12px] font-bold text-[#4A5568] bg-white border border-[#E2E8F0] rounded-lg px-2.5 py-1 outline-none focus:border-[#FFCB3C] focus-visible:ring-2 focus-visible:ring-[#FFCB3C]/40"
              title="공고별로 관심 표시를 필터링합니다"
            >
              <option value="all">전체 공고</option>
              {jobOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.title}</option>
              ))}
            </select>
          )}
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
        <div className="py-4 text-center text-[13px] text-[#E53E3E]">목록을 불러오지 못했어요. 잠시 후 페이지를 새로고침해 주세요.</div>
      ) : !data ? (
        <div className="py-4 flex items-center justify-center text-[13px] text-[#A0AEC0]">
          <Loader2 size={15} className="animate-spin mr-1.5" /> 불러오는 중…
        </div>
      ) : items.length === 0 ? (
        <div className="py-4 text-center text-[13px] text-[#A0AEC0]">처리 대기 중인 관심 표시가 없어요. 재컨택 문자를 받은 후보가 공고에 관심을 누르면 여기에 표시됩니다.</div>
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
                  onClick={() => openQuick(it)}
                  disabled={busy || !it.phone}
                  title={it.phone ? "공고 맥락 문자를 보내고 컨택 완료로 처리" : "전화번호가 없어 문자 발송 불가"}
                  className="flex items-center gap-1 text-[11.5px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] px-3 py-1.5 rounded-lg shrink-0 transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
                >
                  <Send size={13} /> 빠른 컨택
                </button>
                <button
                  onClick={() => handleAction(it.candidate_id, "contacted")}
                  disabled={busy}
                  title="문자 발송 없이 처리 (직접 전화 등으로 이미 연락한 경우)"
                  className="flex items-center gap-1 text-[11.5px] font-bold text-[#4A5568] bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] px-3 py-1.5 rounded-lg shrink-0 transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} 발송 없이 처리
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

      {/* 빠른 컨택 모달 — 실제 문자 발송 전 편집·확인(오발송 방지). 발송 성공 후 컨택 완료 스탬프. */}
      {quick && (
        <div
          className="fixed inset-0 bg-[#00000080] z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          onClick={() => !quickSending && setQuick(null)}
        >
          <div className="bg-white w-full max-w-[500px] rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2E8F0]">
              <h2 className="text-[16px] font-extrabold text-[#1A202C] flex items-center gap-2"><Send size={16} className="text-[#3182CE]" /> 빠른 컨택</h2>
              <button onClick={() => setQuick(null)} disabled={quickSending} className="text-[#A0AEC0] hover:text-[#4A5568] disabled:opacity-50 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"><X size={20} /></button>
            </div>
            <div className="p-6 flex flex-col gap-3">
              <div className="text-[12.5px] text-[#718096] leading-relaxed">
                <b className="text-[#4A5568]">{quick.name || "이름 미상"}</b>님({quick.phone})에게 <b className="text-[#E53E3E]">실제 문자</b>가 발송됩니다. 아래 내용을 확인·편집한 뒤 보내세요.
                {quick.job_title && (
                  <>
                    <br />
                    관심 공고: <b className="text-[#4A5568]">{quick.job_title}</b>
                  </>
                )}
              </div>
              <textarea
                value={quickBody}
                onChange={(e) => setQuickBody(e.target.value)}
                rows={5}
                disabled={quickSending}
                className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-[13.5px] leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none disabled:bg-[#F7FAFC]"
              />
              <div className="text-[11px] text-[#A0AEC0] leading-relaxed">
                발송에 성공하면 자동으로 <b>컨택 완료</b>로 처리돼 큐에서 빠집니다. 근무 확정·배정을 약속하는 문구는 넣지 마세요.
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#E2E8F0]">
              <button onClick={() => setQuick(null)} disabled={quickSending} className="px-4 py-2 rounded-lg text-[13.5px] font-bold text-[#4A5568] hover:bg-[#F1F4F8] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40">취소</button>
              <button onClick={handleQuickSend} disabled={quickSending || !quickBody.trim()} className="px-5 py-2 rounded-lg text-[13.5px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] disabled:opacity-60 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40">
                {quickSending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} 문자 보내고 처리
              </button>
            </div>
          </div>
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
