import { useState, useEffect, useCallback } from "react";
import { Search, Bot, User, Send, AlertTriangle, Sparkles, MessageSquare, Plus, X, Loader2, Wand2, Check } from "lucide-react";
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

interface Applicant {
  id: number;
  name: string;
  phone: string | null;
  status: string;
  unread_count?: number | null;
  agent_stage?: string | null;
  birth_date?: string | null;
  own_vehicle?: string | null;
  license_type?: string | null;
  experience?: string | null;
  work_hours?: string | null;
  location?: string | null;
  created_at?: string | null;
}

interface ApiMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string | null;
  created_at: string;
  sent_by?: string | null;
}

const AVATAR_PALETTE = [
  { bg: "#EBF8FF", fg: "#3182CE" },
  { bg: "#FEFCBF", fg: "#D69E2E" },
  { bg: "#F0FFF4", fg: "#38A169" },
  { bg: "#FAF5FF", fg: "#805AD5" },
  { bg: "#FFF5F5", fg: "#E53E3E" },
];

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

function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금 전";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

const ACTIVE_STATUSES = new Set(["스크리닝 중", "스크리닝 완료"]);

export function LiveConsole() {
  const [activeTab, setActiveTab] = useState<"all" | "intervention">("all");
  const [chats, setChats] = useState<Applicant[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [agentStage, setAgentStage] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sending, setSending] = useState(false);
  const [newMsgModalOpen, setNewMsgModalOpen] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);

  const loadChats = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/applicants");
      const json = await res.json();
      const all = (json.data ?? []) as Applicant[];
      const active = all.filter(
        (a) => (a.agent_stage && a.agent_stage !== "abort") || ACTIVE_STATUSES.has(a.status)
      );
      setChats(active);
      setSelectedChatId((prev) => prev ?? (active[0]?.id ?? null));
    } catch {
      toast.error("대화 목록을 불러오지 못했어요");
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  const loadMessages = useCallback(async (id: number) => {
    setLoadingMsgs(true);
    try {
      const res = await fetch(`/api/admin/messages/${id}`);
      const json = await res.json();
      setMessages((json.messages ?? []) as ApiMessage[]);
      setAgentStage(json.agent_stage ?? null);
    } catch {
      toast.error("대화 내역을 불러오지 못했어요");
    } finally {
      setLoadingMsgs(false);
    }
  }, []);

  const loadDraft = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/admin/drafts/pending?applicant_id=${id}`);
      const json = await res.json();
      const d = (json.data as PendingDraft | null) ?? null;
      setPendingDraft(d);
      setDraftText(d?.draft_text ?? "");
    } catch {
      // 네트워크 문제로 못 불러와도 화면은 유지 (초안 카드만 미표시)
      setPendingDraft(null);
      setDraftText("");
    }
  }, []);

  useEffect(() => {
    if (selectedChatId != null) {
      loadMessages(selectedChatId);
      loadDraft(selectedChatId);
    }
  }, [selectedChatId, loadMessages, loadDraft]);

  const activeChat = chats.find((c) => c.id === selectedChatId) ?? null;
  const isPaused = agentStage === "paused";
  const hasActiveFlow = agentStage != null && agentStage !== "abort";
  const isAiEnabled = hasActiveFlow && !isPaused;
  const canSend = !isAiEnabled; // 수동(paused) 또는 활성 흐름 없음 → 매니저 직접 발송

  const interventionChats = chats.filter((c) => (c.unread_count ?? 0) > 0);

  const handleToggleAi = async (checked: boolean) => {
    if (!activeChat) return;
    if (!hasActiveFlow) {
      toast.info("이 지원자는 활성 AI 대화 흐름이 없어요. 매니저가 직접 응대합니다.");
      return;
    }
    const endpoint = checked ? "/api/admin/agent/resume" : "/api/admin/agent/pause";
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_id: activeChat.id }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "상태 변경에 실패했어요");
        return;
      }
      setAgentStage(checked ? json.restored_stage ?? "exploration" : "paused");
      toast.success(checked ? `${activeChat.name}님 AI 자동 응대를 재개했어요.` : `${activeChat.name}님 AI를 끄고 매니저 수동 응대로 전환했어요.`);
    } catch {
      toast.error("상태 변경에 실패했어요");
    }
  };

  const handleTakeover = () => handleToggleAi(false);

  const handleSendMessage = async () => {
    if (!inputValue.trim() || !activeChat || sending) return;
    if (!activeChat.phone) {
      toast.error("이 지원자는 전화번호가 없어 발송할 수 없어요");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/admin/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicant_id: activeChat.id,
          phone: activeChat.phone,
          body: inputValue.trim(),
          sent_by: "관리자",
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "문자 발송에 실패했어요");
        return;
      }
      toast.success("문자(SMS)를 발송했어요");
      setInputValue("");
      await loadMessages(activeChat.id);
      setAgentStage("paused"); // 매니저 발송 시 서버가 paused로 전이
    } catch {
      toast.error("문자 발송에 실패했어요");
    } finally {
      setSending(false);
    }
  };

  const handleSendDraft = async () => {
    if (!pendingDraft || !activeChat || draftBusy) return;
    if (!activeChat.phone) {
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
          applicant_id: activeChat.id,
          phone: activeChat.phone,
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
      await loadMessages(activeChat.id);
      setAgentStage("paused");
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

  const getByteLength = (str: string) => {
    let b = 0;
    for (let i = 0; i < str.length; i++) {
      const c = escape(str.charAt(i));
      if (c.length === 1) b++;
      else if (c.indexOf("%u") !== -1) b += 2;
      else if (c.indexOf("%") !== -1) b += c.length / 3;
    }
    return b;
  };

  const currentBytes = getByteLength(inputValue);
  const isLMS = currentBytes > 90;

  const visibleChats = activeTab === "all" ? chats : interventionChats;

  const summary = activeChat
    ? {
      이동수단: activeChat.own_vehicle || "확인 필요",
      면허증: activeChat.license_type || "확인 필요",
      경력: activeChat.experience || "확인 필요",
      근무희망: activeChat.work_hours || "확인 필요",
      지역: activeChat.location || "확인 필요",
      상태: activeChat.status,
    }
    : {};

  return (
    <div className="flex h-full overflow-hidden bg-white">
      {/* Left Sidebar */}
      <div className="w-[320px] flex-shrink-0 border-r border-[#E2E8F0] flex flex-col bg-[#F7FAFC]">
        <div className="p-5 border-b border-[#E2E8F0] bg-white flex flex-col gap-4">
          <button onClick={() => setNewMsgModalOpen(true)} className="w-full bg-[#1A202C] hover:bg-[#2D3748] text-white py-2.5 rounded-xl text-[13px] font-bold transition-colors flex items-center justify-center gap-2">
            <Plus size={16} /> 전체 DB에서 새 문자 보내기
          </button>

          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
            <input type="text" placeholder="지원자명 검색" className="w-full pl-9 pr-4 py-2 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] bg-[#F1F4F8]" />
          </div>
          <div className="flex gap-1.5">
            <button onClick={() => setActiveTab('all')} className={`px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${activeTab === 'all' ? 'bg-[#1A202C] text-white' : 'bg-white border border-[#E2E8F0] text-[#718096]'}`}>전체 <span className="opacity-60 ml-1">{chats.length}</span></button>
            <button onClick={() => setActiveTab('intervention')} className={`px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${activeTab === 'intervention' ? 'bg-[#E53E3E] text-white' : 'bg-white border border-[#E2E8F0] text-[#718096]'}`}>개입 필요 <span className="opacity-60 ml-1">{interventionChats.length}</span></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          {loadingList && <div className="text-[13px] text-[#A0AEC0] p-4 text-center">대화 목록 불러오는 중…</div>}
          {!loadingList && visibleChats.length === 0 && <div className="text-[13px] text-[#A0AEC0] p-4 text-center">진행 중인 대화가 없어요</div>}
          {visibleChats.map((chat, idx) => {
            const pal = AVATAR_PALETTE[idx % AVATAR_PALETTE.length];
            const unread = chat.unread_count ?? 0;
            const intervention = unread > 0;
            return (
              <button
                key={chat.id}
                onClick={() => setSelectedChatId(chat.id)}
                className={`w-full text-left p-3.5 rounded-xl transition-all ${selectedChatId === chat.id ? 'bg-white border border-[#FFCB3C] shadow-sm ring-1 ring-[#FFCB3C]' : 'bg-white border border-transparent hover:border-[#E2E8F0]'}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm" style={{ backgroundColor: pal.bg, color: pal.fg }}>{chat.name.charAt(0)}</div>
                    <div>
                      <div className="text-[14px] font-bold text-[#1A202C] flex items-center gap-1.5">{chat.name} {unread > 0 && <span className="w-4 h-4 rounded-full bg-[#E53E3E] text-white text-[10px] flex items-center justify-center">{unread}</span>}</div>
                    </div>
                  </div>
                  <div className="text-[11px] font-semibold text-[#A0AEC0]">{relTime(chat.created_at)}</div>
                </div>
                <div className="text-[13px] text-[#4A5568] line-clamp-1 mb-2.5">{chat.status} {chat.agent_stage ? `· ${chat.agent_stage}` : ""}</div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {chat.agent_stage === 'paused' && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#EDF2F7] text-[#4A5568]">수동(OFF)</span>}
                  {intervention && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#FFF5F5] text-[#E53E3E]">개입 필요</span>}
                  {chat.agent_stage && chat.agent_stage !== 'paused' && chat.agent_stage !== 'abort' && !intervention && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#EBF8FF] text-[#3182CE]">AI 응대 중</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Middle Chat Window */}
      {activeChat && (
        <div className="flex-1 flex flex-col bg-[#EEF1F5] min-w-0">
          <div className="h-[76px] shrink-0 bg-white border-b border-[#E2E8F0] px-6 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="text-lg font-bold text-[#1A202C]">{activeChat.name} <span className="text-[15px] text-[#718096]">지원자</span></div>
              <div className="h-4 w-px bg-[#E2E8F0]"></div>
              {!hasActiveFlow ? (
                <span className="flex items-center gap-1.5 text-xs font-bold text-[#4A5568] bg-[#EDF2F7] px-3 py-1.5 rounded-lg border border-[#CBD5E0]"><MessageSquare size={14} /> 수동 문자 모드</span>
              ) : isPaused ? (
                <span className="flex items-center gap-1.5 text-xs font-bold text-[#D69E2E] bg-[#FEFCBF] px-3 py-1.5 rounded-lg border border-[#F6E05E]"><User size={14} /> 수동 개입 중</span>
              ) : (activeChat.unread_count ?? 0) > 0 ? (
                <span className="flex items-center gap-1.5 text-xs font-bold text-[#E53E3E] bg-[#FFF5F5] px-3 py-1.5 rounded-lg border border-[#FEB2B2]"><AlertTriangle size={14} /> 매니저 개입 필요</span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs font-bold text-[#3182CE] bg-[#EBF8FF] px-3 py-1.5 rounded-lg border border-[#BEE3F8]"><Bot size={14} /> 옹봇 자동 응대 중</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-3 px-3 py-1.5 rounded-xl border transition-colors ${isAiEnabled ? 'bg-[#F0FFF4] border-[#9AE6B4]' : 'bg-[#FFF5F5] border-[#FEB2B2]'}`}>
                <div className="flex flex-col items-end">
                  <span className={`text-[12px] font-extrabold ${isAiEnabled ? 'text-[#2F855A]' : 'text-[#C53030]'}`}>{isAiEnabled ? 'AI 자동 응대 ON' : 'AI 응대 OFF'}</span>
                </div>
                <Switch checked={isAiEnabled} onCheckedChange={handleToggleAi} disabled={!hasActiveFlow} className="data-[state=checked]:bg-[#38A169] data-[state=unchecked]:bg-[#E53E3E]" />
              </div>
              {isAiEnabled && (
                <button onClick={handleTakeover} className="ml-2 bg-[#1A202C] text-white px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-1.5"><User size={16} /> 개입하기</button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-5">
            {loadingMsgs && <div className="text-[13px] text-[#A0AEC0] text-center py-8">대화 내역 불러오는 중…</div>}
            {!loadingMsgs && messages.length === 0 && <div className="text-[13px] text-[#A0AEC0] text-center py-8">아직 주고받은 메시지가 없어요</div>}
            {!loadingMsgs && messages.length > 0 && (
              <div className="flex justify-center mb-2"><div className="bg-[#E2E8F0] text-[#718096] text-[11px] font-bold px-3 py-1 rounded-full">{fmtDateLabel(messages[0].created_at)}</div></div>
            )}

            {messages.map((msg, idx) => {
              const isInbound = msg.direction === "inbound";
              const sender = isInbound ? "user" : "ai";
              return (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(idx * 0.03, 0.3) }} key={msg.id} className={`flex gap-3 ${sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {sender === 'ai' && <div className="w-9 h-9 rounded-full bg-[#FFCB3C] flex items-center justify-center shrink-0 border border-[#E0B500]"><Bot size={18} className="text-[#1A202C]" /></div>}
                  <div className={`flex flex-col gap-1 max-w-[70%] ${sender === 'user' ? 'items-end' : 'items-start'}`}>
                    {sender === 'ai' && <span className="text-[11.5px] font-bold text-[#718096] ml-1">{msg.sent_by === '관리자' ? '매니저' : '옹봇 에이전트'}</span>}
                    <div className={`p-3.5 rounded-2xl text-[14px] leading-relaxed shadow-sm whitespace-pre-wrap ${sender === 'user' ? 'bg-[#1A202C] text-white rounded-tr-sm' : 'bg-white border border-[#E2E8F0] text-[#2D3748] rounded-tl-sm'}`}>
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
                  <button
                    onClick={handleIgnoreDraft}
                    disabled={draftBusy}
                    className="px-4 py-2 rounded-xl text-[13px] font-bold text-[#718096] hover:bg-white border border-[#E2E8F0] disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <X size={15} /> 무시
                  </button>
                  <button
                    onClick={handleSendDraft}
                    disabled={draftBusy}
                    className="px-5 py-2 rounded-xl text-[13px] font-bold text-white bg-[#6B46C1] hover:bg-[#553C9A] disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {draftBusy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                    검수 후 발송
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Input Area */}
          <div className="p-5 bg-white border-t border-[#E2E8F0]">
            {canSend ? (
              <div className="flex items-end gap-3">
                <div className={`flex-1 border-2 rounded-2xl overflow-hidden bg-[#F7FAFC] focus-within:bg-white ${isLMS ? 'border-[#FC8181]' : 'border-[#E2E8F0] focus-within:border-[#FFCB3C]'}`}>
                  <textarea value={inputValue} onChange={(e) => setInputValue(e.target.value)} placeholder="지원자에게 발송될 문자를 입력하세요..." className="w-full bg-transparent outline-none p-3.5 text-[14px] min-h-[60px]" rows={2} />
                  <div className={`flex justify-between items-center px-3.5 pb-2.5 pt-1.5 border-t ${isLMS ? 'border-[#FEB2B2] bg-[#FFF5F5]' : 'border-[#EDF2F7]'}`}>
                    <div className="flex gap-2 items-center text-[12px] font-bold">
                      <span className={isLMS ? 'text-[#E53E3E]' : 'text-[#3182CE]'}>{isLMS ? 'LMS' : 'SMS'}</span>
                      <span className="text-[#718096]">{currentBytes} bytes</span>
                    </div>
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
                    <div className="text-[12px] text-[#718096] mt-0.5">[개입하기]를 누르면 자동 응대가 중지됩니다.</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Right Sidebar */}
      {activeChat && (
        <div className="w-[300px] shrink-0 bg-white border-l border-[#E2E8F0] flex flex-col">
          <div className="h-[76px] border-b border-[#E2E8F0] px-5 flex items-center">
            <h2 className="text-[15px] font-extrabold text-[#1A202C] flex items-center gap-2"><Sparkles size={16} className="text-[#FFCB3C]" /> 지원자 정보 요약</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-5">
            <div className="flex flex-col gap-4">
              {Object.entries(summary).map(([k, v], i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-bold text-[#718096]">{k}</span>
                  <div className={`text-[14px] font-semibold px-3 py-2 rounded-lg border ${String(v).includes('확인 필요') ? 'bg-[#FFF5F5] border-[#FEB2B2] text-[#E53E3E]' : 'bg-white border-[#E2E8F0] text-[#1A202C]'}`}>{String(v)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* New Message Modal */}
      {newMsgModalOpen && (
        <div className="fixed inset-0 bg-[#00000080] z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white w-[500px] rounded-2xl shadow-xl flex flex-col overflow-hidden">
            <div className="p-5 border-b border-[#E2E8F0] flex justify-between items-center bg-[#F7FAFC]">
              <h2 className="text-[16px] font-bold text-[#1A202C]">전체 DB 대상 문자 발송</h2>
              <button onClick={() => setNewMsgModalOpen(false)}><X size={20} className="text-[#A0AEC0]" /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="text-[13px] text-[#718096]">대량 발송은 별도 일괄 발송 화면에서 진행됩니다. 개별 발송은 좌측 대화방을 선택해 사용하세요.</div>
            </div>
            <div className="p-4 border-t border-[#E2E8F0] bg-white flex justify-end">
              <button onClick={() => setNewMsgModalOpen(false)} className="bg-[#1A202C] text-white px-5 py-2 rounded-lg text-sm font-bold">닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
