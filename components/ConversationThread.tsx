"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bot, User, Send, AlertTriangle, MessageSquare, Loader2, Wand2, Check, X } from "lucide-react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Switch } from "./ui/switch";

interface PendingDraft {
  id: string;
  draft_text: string | null;
  reasoning: string | null;
  status: string;
  missing_info: string | null;
}

interface ApiMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string | null;
  created_at: string;
  sent_by?: string | null;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function fmtDateLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return "";
  }
}

function getByteLength(str: string) {
  let b = 0;
  for (let i = 0; i < str.length; i++) {
    const c = escape(str.charAt(i));
    if (c.length === 1) b++;
    else if (c.indexOf("%u") !== -1) b += 2;
    else if (c.indexOf("%") !== -1) b += c.length / 3;
  }
  return b;
}

interface ConversationThreadProps {
  applicantId: number;
  applicantName: string;
  phone: string | null;
  /** 공고별 대화 분리 — 지정 시 해당 공고 컨텍스트의 메시지/단계만 표시 */
  jobId?: number | null;
  /** 발송·상태변경 후 부모(목록 등) 갱신용 */
  onChanged?: () => void;
  /** 폴링 주기(ms). 0이면 폴링 안 함 */
  pollMs?: number;
  /** 헤더(상태배지·AI토글) 표시 여부 — 패널 안에 임베드할 땐 끌 수 있음 */
  showHeader?: boolean;
  className?: string;
}

/**
 * 지원자별 SMS 대화 스레드(말풍선 + AI 초안 검수 + 입력창)를 self-contained하게 렌더.
 * LiveConsole·지원자 상세 패널 등 어디서든 applicantId만 주면 재사용 가능.
 */
export function ConversationThread({
  applicantId,
  applicantName,
  phone,
  jobId = null,
  onChanged,
  pollMs = 12000,
  showHeader = true,
  className = "",
}: ConversationThreadProps) {
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [agentStage, setAgentStage] = useState<string | null>(null);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sending, setSending] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const jobQS = jobId != null ? `?job_id=${jobId}` : "";

  const loadMessages = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoadingMsgs(true);
      try {
        const res = await fetch(`/api/admin/messages/${applicantId}${jobQS}`);
        const json = await res.json();
        setMessages((json.messages ?? []) as ApiMessage[]);
        setAgentStage(json.agent_stage ?? null);
      } catch {
        if (!opts?.silent) toast.error("대화 내역을 불러오지 못했어요");
      } finally {
        if (!opts?.silent) setLoadingMsgs(false);
      }
    },
    [applicantId, jobQS]
  );

  const loadDraft = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/drafts/pending?applicant_id=${applicantId}`);
      const json = await res.json();
      const d = (json.data as PendingDraft | null) ?? null;
      setPendingDraft(d);
      setDraftText(d?.draft_text ?? "");
    } catch {
      setPendingDraft(null);
      setDraftText("");
    }
  }, [applicantId]);

  useEffect(() => {
    loadMessages();
    loadDraft();
  }, [loadMessages, loadDraft]);

  // 가벼운 폴링 — 화면을 보고 있는 동안 새 메시지/초안 자동 반영
  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => {
      loadMessages({ silent: true });
      loadDraft();
    }, pollMs);
    return () => clearInterval(t);
  }, [pollMs, loadMessages, loadDraft]);

  // 새 메시지 도착 시 맨 아래로 스크롤
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const isPaused = agentStage === "paused";
  const hasActiveFlow = agentStage != null && agentStage !== "abort";
  const isAiEnabled = hasActiveFlow && !isPaused;
  const canSend = !isAiEnabled;

  const handleToggleAi = async (checked: boolean) => {
    if (!hasActiveFlow) {
      toast.info("이 지원자는 활성 AI 대화 흐름이 없어요. 매니저가 직접 응대합니다.");
      return;
    }
    const endpoint = checked ? "/api/admin/agent/resume" : "/api/admin/agent/pause";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: applicantId }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "상태 변경에 실패했어요");
        return;
      }
      setAgentStage(checked ? json.restored_stage ?? "exploration" : "paused");
      toast.success(
        checked
          ? `${applicantName}님 AI 자동 응대를 재개했어요.`
          : `${applicantName}님 AI를 끄고 매니저 수동 응대로 전환했어요.`
      );
      onChanged?.();
    } catch {
      toast.error("상태 변경에 실패했어요");
    }
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || sending) return;
    if (!phone) {
      toast.error("이 지원자는 전화번호가 없어 발송할 수 없어요");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/admin/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: applicantId, phone, body: inputValue.trim(), sent_by: "관리자" }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "문자 발송에 실패했어요");
        return;
      }
      toast.success("문자(SMS)를 발송했어요");
      setInputValue("");
      await loadMessages({ silent: true });
      setAgentStage("paused");
      onChanged?.();
    } catch {
      toast.error("문자 발송에 실패했어요");
    } finally {
      setSending(false);
    }
  };

  const handleSendDraft = async () => {
    if (!pendingDraft || draftBusy) return;
    if (!phone) {
      toast.error("이 지원자는 전화번호가 없어 발송할 수 없어요");
      return;
    }
    const body = draftText.trim();
    if (!body) {
      toast.error("초안 내용이 비어 있어요. 직접 입력 후 발송해주세요.");
      return;
    }
    setDraftBusy(true);
    try {
      const res = await fetch("/api/admin/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicant_id: applicantId,
          phone,
          body,
          sent_by: "관리자",
          draft_id: pendingDraft.id,
          draft_was_edited: body !== (pendingDraft.draft_text ?? ""),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "발송에 실패했어요");
        return;
      }
      toast.success("AI 초안을 검수해 발송했어요.");
      setPendingDraft(null);
      setDraftText("");
      await loadMessages({ silent: true });
      setAgentStage("paused");
      onChanged?.();
    } catch {
      toast.error("발송에 실패했어요");
    } finally {
      setDraftBusy(false);
    }
  };

  const handleIgnoreDraft = async () => {
    if (!pendingDraft || draftBusy) return;
    setDraftBusy(true);
    try {
      const res = await fetch(`/api/admin/drafts/${pendingDraft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ignored" }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error || "처리에 실패했어요");
        return;
      }
      toast.info("AI 초안을 무시했어요.");
      setPendingDraft(null);
      setDraftText("");
    } catch {
      toast.error("처리에 실패했어요");
    } finally {
      setDraftBusy(false);
    }
  };

  const currentBytes = getByteLength(inputValue);
  const isLMS = currentBytes > 90;

  return (
    <div className={`flex flex-col bg-[#EEF1F5] min-w-0 min-h-0 ${className}`}>
      {/* 상태 헤더 + AI 토글 */}
      {showHeader && (
        <div className="shrink-0 bg-white border-b border-[#E2E8F0] px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            {!hasActiveFlow ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-[#4A5568] bg-[#EDF2F7] px-3 py-1.5 rounded-lg border border-[#CBD5E0]"><MessageSquare size={14} /> 수동 문자 모드</span>
            ) : isPaused ? (
              <span className="flex items-center gap-1.5 text-xs font-bold text-[#D69E2E] bg-[#FEFCBF] px-3 py-1.5 rounded-lg border border-[#F6E05E]"><User size={14} /> 수동 개입 중</span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-bold text-[#3182CE] bg-[#EBF8FF] px-3 py-1.5 rounded-lg border border-[#BEE3F8]"><Bot size={14} /> 옹봇 자동 응대 중</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-2.5 px-3 py-1.5 rounded-xl border transition-colors ${isAiEnabled ? "bg-[#F0FFF4] border-[#9AE6B4]" : "bg-[#FFF5F5] border-[#FEB2B2]"}`}>
              <span className={`text-[12px] font-extrabold ${isAiEnabled ? "text-[#2F855A]" : "text-[#C53030]"}`}>{isAiEnabled ? "AI ON" : "AI OFF"}</span>
              <Switch checked={isAiEnabled} onCheckedChange={handleToggleAi} disabled={!hasActiveFlow} className="data-[state=checked]:bg-[#38A169] data-[state=unchecked]:bg-[#E53E3E]" />
            </div>
            {isAiEnabled && (
              <button onClick={() => handleToggleAi(false)} className="bg-[#1A202C] text-white px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5"><User size={15} /> 개입</button>
            )}
          </div>
        </div>
      )}

      {/* 메시지 영역 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 flex flex-col gap-5 min-h-0">
        {loadingMsgs && <div className="text-[13px] text-[#A0AEC0] text-center py-8">대화 내역 불러오는 중…</div>}
        {!loadingMsgs && messages.length === 0 && <div className="text-[13px] text-[#A0AEC0] text-center py-8">아직 주고받은 메시지가 없어요</div>}
        {!loadingMsgs && messages.length > 0 && (
          <div className="flex justify-center mb-2"><div className="bg-[#E2E8F0] text-[#718096] text-[11px] font-bold px-3 py-1 rounded-full">{fmtDateLabel(messages[0].created_at)}</div></div>
        )}

        {messages.map((msg, idx) => {
          const isInbound = msg.direction === "inbound";
          const sender = isInbound ? "user" : "ai";
          return (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(idx * 0.02, 0.2) }} key={msg.id} className={`flex gap-3 ${sender === "user" ? "justify-end" : "justify-start"}`}>
              {sender === "ai" && <div className="w-9 h-9 rounded-full bg-[#FFCB3C] flex items-center justify-center shrink-0 border border-[#E0B500]"><Bot size={18} className="text-[#1A202C]" /></div>}
              <div className={`flex flex-col gap-1 max-w-[78%] ${sender === "user" ? "items-end" : "items-start"}`}>
                {sender === "ai" && <span className="text-[11.5px] font-bold text-[#718096] ml-1">{msg.sent_by === "관리자" ? "매니저" : "옹봇 에이전트"}</span>}
                <div className={`p-3.5 rounded-2xl text-[14px] leading-relaxed shadow-sm whitespace-pre-wrap ${sender === "user" ? "bg-[#1A202C] text-white rounded-tr-sm" : "bg-white border border-[#E2E8F0] text-[#2D3748] rounded-tl-sm"}`}>
                  {msg.body}
                </div>
                <span className="text-[11px] text-[#A0AEC0] mx-1">{fmtTime(msg.created_at)}</span>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* AI 초안 검수 카드 */}
      {pendingDraft && (
        <div className="px-5 pt-4 bg-white border-t border-[#E2E8F0]">
          <div className="border border-[#9F7AEA] bg-[#FAF5FF] rounded-2xl p-4">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2 text-[13px] font-extrabold text-[#6B46C1]">
                <Wand2 size={16} /> 옹봇이 제안한 답변 초안
                {pendingDraft.status === "need_info" && (
                  <span className="text-[11px] font-bold bg-[#FFFAF0] text-[#C05621] border border-[#FBD38D] px-2 py-0.5 rounded-md">정보 부족 · 매니저 확인</span>
                )}
              </div>
              <span className="text-[11px] font-bold text-[#805AD5]">검수 후 발송됩니다</span>
            </div>
            {pendingDraft.status === "need_info" && pendingDraft.missing_info && (
              <div className="mb-2.5 text-[12px] text-[#7B341E] bg-white border border-[#FBD38D] rounded-lg px-3 py-2 leading-relaxed">
                <b>부족한 정보:</b> {pendingDraft.missing_info}
              </div>
            )}
            <textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              placeholder={pendingDraft.status === "need_info" ? "AI가 답변을 보류했어요. 매니저가 직접 답변을 입력해 발송하세요." : "초안을 수정한 뒤 발송할 수 있어요."}
              rows={3}
              className="w-full bg-white border border-[#E2E8F0] rounded-xl p-3 text-[14px] leading-relaxed text-[#2D3748] focus:outline-none focus:border-[#9F7AEA] focus:ring-1 focus:ring-[#9F7AEA] resize-none"
            />
            {pendingDraft.reasoning && (
              <div className="mt-2 text-[11.5px] text-[#718096] leading-relaxed">
                <b className="text-[#805AD5]">판단 근거:</b> {pendingDraft.reasoning}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 mt-3">
              <button onClick={handleIgnoreDraft} disabled={draftBusy} className="px-4 py-2 rounded-xl text-[13px] font-bold text-[#718096] hover:bg-white border border-[#E2E8F0] disabled:opacity-50 flex items-center gap-1.5"><X size={15} /> 무시</button>
              <button onClick={handleSendDraft} disabled={draftBusy} className="px-5 py-2 rounded-xl text-[13px] font-bold text-white bg-[#6B46C1] hover:bg-[#553C9A] disabled:opacity-50 flex items-center gap-1.5">
                {draftBusy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} 검수 후 발송
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 입력 영역 */}
      <div className="p-5 bg-white border-t border-[#E2E8F0] shrink-0">
        {canSend ? (
          <div className="flex items-end gap-3">
            <div className={`flex-1 border-2 rounded-2xl overflow-hidden bg-[#F7FAFC] focus-within:bg-white ${isLMS ? "border-[#FC8181]" : "border-[#E2E8F0] focus-within:border-[#FFCB3C]"}`}>
              <textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSendMessage(); } }}
                placeholder="지원자에게 발송될 문자를 입력하세요..."
                className="w-full bg-transparent outline-none p-3.5 text-[14px] min-h-[56px]"
                rows={2}
              />
              <div className={`flex justify-between items-center px-3.5 pb-2.5 pt-1.5 border-t ${isLMS ? "border-[#FEB2B2] bg-[#FFF5F5]" : "border-[#EDF2F7]"}`}>
                <div className="flex gap-2 items-center text-[12px] font-bold">
                  <span className={isLMS ? "text-[#E53E3E]" : "text-[#3182CE]"}>{isLMS ? "LMS" : "SMS"}</span>
                  <span className="text-[#718096]">{currentBytes} bytes</span>
                </div>
                <span className="text-[11px] text-[#A0AEC0]">⌘+Enter 발송</span>
              </div>
            </div>
            <button onClick={handleSendMessage} disabled={sending} className="w-[54px] h-[54px] rounded-[14px] bg-[#FFCB3C] hover:bg-[#E0B500] disabled:opacity-50 flex items-center justify-center shrink-0">{sending ? <Loader2 size={22} className="text-[#1A202C] animate-spin" /> : <Send size={22} className="text-[#1A202C]" />}</button>
          </div>
        ) : (
          <div className="flex items-center justify-between bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#EBF8FF] flex items-center justify-center border border-[#BEE3F8]"><Bot size={20} className="text-[#3182CE]" /></div>
              <div>
                <div className="text-[14px] font-bold text-[#1A202C]">AI가 대화형 스크리닝을 진행 중입니다.</div>
                <div className="text-[12px] text-[#718096] mt-0.5">[개입]을 누르면 자동 응대가 중지됩니다.</div>
              </div>
            </div>
            <AlertTriangle size={18} className="text-[#A0AEC0]" />
          </div>
        )}
      </div>
    </div>
  );
}
