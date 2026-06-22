"use client";

import { useState, useEffect, useCallback } from "react";
import { Search, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { ConversationThread } from "./ConversationThread";
import { ApplicantDetailContent } from "./ApplicantDetailPanel";

interface Applicant {
  id: number;
  name: string;
  phone: string | null;
  status: string;
  unread_count?: number | null;
  agent_stage?: string | null;
  source?: string | null;
  branch?: string | null;
  branch1?: string | null;
  created_at?: string | null;
}

const AVATAR_PALETTE = [
  { bg: "#EBF8FF", fg: "#3182CE" },
  { bg: "#FEFCBF", fg: "#D69E2E" },
  { bg: "#F0FFF4", fg: "#38A169" },
  { bg: "#FAF5FF", fg: "#805AD5" },
  { bg: "#FFF5F5", fg: "#E53E3E" },
];

const SOURCE_LABEL: Record<string, string> = {
  danggeun: "당근",
  baemin: "배민",
  danggeun_practice: "당근(연습)",
  manual: "수기",
  direct: "직접지원",
  facebook: "페이스북",
  naver: "네이버",
};

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
  const [loadingList, setLoadingList] = useState(true);
  const [newMsgModalOpen, setNewMsgModalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<string>("all");

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

  const activeChat = chats.find((c) => c.id === selectedChatId) ?? null;
  const interventionChats = chats.filter((c) => (c.unread_count ?? 0) > 0);

  const baseChats = activeTab === "all" ? chats : interventionChats;
  const visibleChats = baseChats.filter((c) => {
    if (search.trim() && !c.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
    if (stageFilter !== "all") {
      if (stageFilter === "paused") return c.agent_stage === "paused";
      if (stageFilter === "intervention") return (c.unread_count ?? 0) > 0;
      return c.agent_stage === stageFilter;
    }
    return true;
  });

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
            <input value={search} onChange={(e) => setSearch(e.target.value)} type="text" placeholder="지원자명 검색" className="w-full pl-9 pr-4 py-2 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] bg-[#F1F4F8]" />
          </div>
          <div className="flex gap-1.5">
            <button onClick={() => setActiveTab("all")} className={`px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${activeTab === "all" ? "bg-[#1A202C] text-white" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>전체 <span className="opacity-60 ml-1">{chats.length}</span></button>
            <button onClick={() => setActiveTab("intervention")} className={`px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${activeTab === "intervention" ? "bg-[#E53E3E] text-white" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>개입 필요 <span className="opacity-60 ml-1">{interventionChats.length}</span></button>
          </div>
          {/* 스크리닝 단계 필터 */}
          <div className="flex gap-1 flex-wrap">
            {[
              { id: "all", label: "전체" },
              { id: "screening", label: "스크리닝" },
              { id: "onboarding", label: "온보딩" },
              { id: "paused", label: "수동" },
            ].map((f) => (
              <button key={f.id} onClick={() => setStageFilter(f.id)} className={`px-2.5 py-1 rounded-md text-[11.5px] font-bold transition-all ${stageFilter === f.id ? "bg-[#FFCB3C] text-[#1A202C]" : "bg-white border border-[#E2E8F0] text-[#718096]"}`}>{f.label}</button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          {loadingList && <div className="text-[13px] text-[#A0AEC0] p-4 text-center">대화 목록 불러오는 중…</div>}
          {!loadingList && visibleChats.length === 0 && <div className="text-[13px] text-[#A0AEC0] p-4 text-center">진행 중인 대화가 없어요</div>}
          {visibleChats.map((chat, idx) => {
            const pal = AVATAR_PALETTE[idx % AVATAR_PALETTE.length];
            const unread = chat.unread_count ?? 0;
            const intervention = unread > 0;
            const src = chat.source ? SOURCE_LABEL[chat.source] ?? chat.source : null;
            return (
              <button
                key={chat.id}
                onClick={() => setSelectedChatId(chat.id)}
                className={`w-full text-left p-3.5 rounded-xl transition-all ${selectedChatId === chat.id ? "bg-white border border-[#FFCB3C] shadow-sm ring-1 ring-[#FFCB3C]" : "bg-white border border-transparent hover:border-[#E2E8F0]"}`}
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
                  {src && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#F7FAFC] text-[#718096] border border-[#E2E8F0]">{src}</span>}
                  {(chat.branch || chat.branch1) && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#F0FFF4] text-[#2F855A]">{chat.branch || chat.branch1}</span>}
                  {chat.agent_stage === "paused" && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#EDF2F7] text-[#4A5568]">수동(OFF)</span>}
                  {intervention && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#FFF5F5] text-[#E53E3E]">개입 필요</span>}
                  {chat.agent_stage && chat.agent_stage !== "paused" && chat.agent_stage !== "abort" && !intervention && <span className="px-2 py-1 rounded-md text-[11px] font-bold bg-[#EBF8FF] text-[#3182CE]">AI 응대 중</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Middle Chat Window */}
      {activeChat ? (
        <div className="flex-1 flex flex-col bg-[#EEF1F5] min-w-0">
          <div className="h-[60px] shrink-0 bg-white border-b border-[#E2E8F0] px-6 flex items-center">
            <div className="text-lg font-bold text-[#1A202C]">{activeChat.name} <span className="text-[15px] text-[#718096]">지원자</span></div>
          </div>
          <ConversationThread
            key={activeChat.id}
            applicantId={activeChat.id}
            applicantName={activeChat.name}
            phone={activeChat.phone}
            onChanged={loadChats}
            className="flex-1 min-h-0"
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center bg-[#EEF1F5] text-[#A0AEC0] text-sm">대화를 선택하세요</div>
      )}

      {/* Right Sidebar — 통합 지원자 상세(컨텍스트) */}
      {activeChat && (
        <div className="w-[340px] shrink-0 bg-white border-l border-[#E2E8F0] flex flex-col">
          <ApplicantDetailContent
            key={activeChat.id}
            applicantId={activeChat.id}
            variant="panel"
            onChanged={loadChats}
          />
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
