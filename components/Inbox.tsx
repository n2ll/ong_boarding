import { useState } from "react";
import useSWR from "swr";
import { Inbox as InboxIcon, RefreshCw, Phone, Check, Ban, Loader2, MessageSquareWarning } from "lucide-react";
import { toast } from "sonner";

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

export function Inbox() {
  const { data, isLoading, isValidating, mutate } = useSWR<{ data?: PendingMessage[] }>("/api/admin/inbox/pending");
  const messages = data?.data ?? [];
  const loading = isLoading && messages.length === 0;
  const [busyId, setBusyId] = useState<string | null>(null);

  const classify = async (msg: PendingMessage, action: "baemin" | "other") => {
    if (busyId) return;
    setBusyId(msg.id);
    try {
      const res = await fetch(`/api/admin/inbox/${msg.id}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "분류에 실패했어요");
        return;
      }
      if (action === "baemin") {
        toast.success(
          json.agent_invoked
            ? "배민 지원자로 등록하고 AI 응대를 시작했어요."
            : "배민 지원자로 등록했어요."
        );
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
            <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">미분류 인박스</h1>
            <p className="text-[14px] text-[#718096]">어떤 지원자와도 매칭되지 않은 인입 문자입니다. 매니저가 직접 분류해주세요.</p>
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
          <div className="text-[13px]">미분류 상태로 남은 메시지가 없습니다.</div>
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
                  onClick={() => classify(msg, "baemin")}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-[13px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                >
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} className="text-[#FFCB3C]" />}
                  배민 지원자로 분류
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
