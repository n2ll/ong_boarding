import { useState } from "react";
import useSWR from "swr";
import { Inbox as InboxIcon, RefreshCw, Phone, Check, Ban, Loader2, MessageSquareWarning, ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "./ConfirmDialog";

interface PendingMessage {
  id: string;
  applicant_phone: string;
  body: string;
  created_at: string;
  sent_by: string | null;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60000);
  if (diffMin < 1) return "방금 전";
  if (diffMin < 60) return `${diffMin}분 전`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}시간 전`;
  return d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" }) +
    " " + d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

interface ActiveJob { id: number; title: string; recruit_mode: string | null; status: string | null; closes_at: string | null; }

export function Inbox() {
  const { data, isLoading, isValidating, mutate } = useSWR<{ data?: PendingMessage[] }>("/api/admin/inbox/pending");
  const messages = data?.data ?? [];
  const loading = isLoading && messages.length === 0;
  const [busyId, setBusyId] = useState<string | null>(null);
  const confirm = useConfirm();

  // 등록 대상 공고 — 진행 중 실공고(시스템 더미·마감 제외). '지원자로 등록' 시 라인 선택용.
  const { data: jobsData } = useSWR<{ data?: ActiveJob[] }>("/api/admin/jobs?status=active");
  const activeJobs = (jobsData?.data ?? []).filter(
    (j) => typeof j.title === "string" && !j.title.startsWith("__") &&
      !(j.closes_at && new Date(j.closes_at).getTime() <= Date.now())
  );

  const classify = async (
    msg: PendingMessage,
    action: "baemin" | "job" | "other" | "ongmanaging",
    opts?: { jobId?: number; jobLabel?: string }
  ) => {
    if (busyId) return;
    // 지원자 등록(배민·공고)은 등록 즉시 AI 스크리닝 문자가 나가므로 발송 사실을 확인받는다.
    if (action === "baemin") {
      if (!(await confirm({
        title: `${msg.applicant_phone} — 배민 커넥트로 등록할까요?`,
        description: "지원자로 등록되고 AI 스크리닝 문자가 즉시 발송됩니다. 계속할까요?",
        confirmText: "등록하고 발송",
      }))) return;
    } else if (action === "job") {
      if (!(await confirm({
        title: `${msg.applicant_phone} — '${opts?.jobLabel ?? "선택 공고"}'로 등록할까요?`,
        description: "이 공고 지원자로 등록되고 라인에 맞는 AI 스크리닝 문자가 즉시 발송됩니다. 계속할까요?",
        confirmText: "등록하고 발송",
      }))) return;
    } else if (action === "ongmanaging") {
      if (!(await confirm({
        title: "기존 계약자 문의로 분류할까요?",
        description: "옹고잉 재직자·기존 계약자 문의로 표시할까요? AI 응대 대상에서 제외돼요.",
        confirmText: "분류",
      }))) return;
    } else {
      if (!(await confirm({
        title: "기타로 분류할까요?",
        description: "응대 대상에서 제외 처리됩니다.",
      }))) return;
    }
    setBusyId(msg.id);
    try {
      const res = await fetch(`/api/admin/inbox/${msg.id}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "job" ? { action, job_id: opts?.jobId } : { action }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "분류에 실패했어요");
        return;
      }
      if (action === "baemin" || action === "job") {
        const where = action === "job" ? (opts?.jobLabel ?? "선택 공고") : "배민 커넥트";
        toast.success(
          json.agent_invoked
            ? `${where}로 등록하고 AI 응대를 시작했어요.`
            : `${where}로 등록했어요.`
        );
      } else if (action === "ongmanaging") {
        toast.success("기존 계약자 문의로 분류했어요.");
      } else {
        toast.success("기타로 분류해 종결했어요.");
      }
      // 처리 완료 항목을 캐시에서 즉시 제거(낙관적). 재검증은 다음 진입/새로고침에서.
      void mutate(
        (cur) => ({ data: (cur?.data ?? []).filter((m) => m.id !== msg.id) }),
        { revalidate: false }
      );
    } catch {
      toast.error("분류에 실패했어요");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-[#FFCB3C] rounded-2xl flex items-center justify-center shadow-sm">
            <InboxIcon size={24} className="text-[#1A202C]" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">분류 대기 문자함</h1>
            <p className="text-[14px] text-[#718096]">어느 지원자의 문자인지 자동으로 연결하지 못한 수신 문자입니다. 아래 버튼으로 직접 분류해주세요.</p>
          </div>
        </div>
        <button
          onClick={() => mutate()}
          className="flex items-center gap-2 bg-white border border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC] px-4 py-2.5 rounded-xl font-bold transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
        >
          <RefreshCw size={16} className={isValidating ? "animate-spin" : ""} /> 새로고침
        </button>
      </div>

      <div className="flex items-center gap-2 mb-5 text-[13px] text-[#718096]">
        <MessageSquareWarning size={16} className="text-[#D69E2E]" />
        처리 대기 <b className="text-[#1A202C]">{messages.length}</b>건
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-[13px] text-[#A0AEC0] py-10">
          <Loader2 size={16} className="animate-spin" /> 불러오는 중…
        </div>
      )}

      {!loading && messages.length === 0 && (
        <div className="flex flex-col items-center justify-center text-center py-20 text-[#A0AEC0]">
          <div className="w-16 h-16 rounded-full bg-[#F0FFF4] flex items-center justify-center mb-4">
            <Check size={30} className="text-[#38A169]" />
          </div>
          <div className="text-[15px] font-bold text-[#4A5568] mb-1">모두 처리했어요</div>
          <div className="text-[13px]">분류가 필요한 문자가 새로 오면 여기에 표시됩니다.</div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {messages.map((msg) => {
          const busy = busyId === msg.id;
          return (
            <div key={msg.id} className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[13px] font-bold text-[#4A5568]">
                  <Phone size={13} className="text-[#A0AEC0]" /> {msg.applicant_phone}
                </div>
                <span className="text-[12px] text-[#A0AEC0]">{formatTime(msg.created_at)}</span>
              </div>
              <div className="text-[14px] leading-relaxed text-[#2D3748] bg-[#F7FAFC] border border-[#EDF2F7] rounded-xl px-4 py-3 whitespace-pre-wrap">
                {msg.body}
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => classify(msg, "other")}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-bold text-[#718096] hover:bg-[#F7FAFC] border border-[#E2E8F0] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                >
                  <Ban size={15} /> 기타로 분류
                </button>
                <button
                  onClick={() => classify(msg, "ongmanaging")}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-bold text-[#718096] hover:bg-[#F7FAFC] border border-[#E2E8F0] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                >
                  <ArrowRightLeft size={15} /> 기존 계약자 문의
                </button>
                {/* 지원자로 등록 — 어느 라인/공고로 보낼지 선택(도시락 등 실공고 or 배민 커넥트 자동). */}
                <div className="relative flex items-center">
                  {busy && <Loader2 size={15} className="animate-spin text-[#A0AEC0] mr-2" />}
                  <select
                    disabled={busy}
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "baemin") classify(msg, "baemin");
                      else if (v) {
                        const j = activeJobs.find((x) => String(x.id) === v);
                        classify(msg, "job", { jobId: Number(v), jobLabel: j?.title });
                      }
                    }}
                    className="appearance-none px-5 py-2 pr-9 rounded-xl text-[13px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] disabled:opacity-60 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                    title="이 문의를 지원자로 등록할 공고(라인)를 선택하세요"
                  >
                    <option value="">＋ 지원자로 등록…</option>
                    {activeJobs.length > 0 && (
                      <optgroup label="공고로 등록">
                        {activeJobs.map((j) => (
                          <option key={j.id} value={String(j.id)}>{j.title.replace(/\s*\([^)]*원\)\s*$/, "")}</option>
                        ))}
                      </optgroup>
                    )}
                    <option value="baemin">배민 커넥트(자동 분류)</option>
                  </select>
                  <Check size={14} className="absolute right-3 text-[#FFCB3C] pointer-events-none" />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
