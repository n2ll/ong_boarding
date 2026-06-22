import { useState, useEffect } from "react";
import { Filter, Search, MoreHorizontal, MessageCircle, Calendar, Check, X, UserX, Download, LayoutGrid, List as ListIcon, Columns, ArrowRight, UserPlus, FileDown, Tags, Mail, Loader2 } from "lucide-react";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { toast } from "sonner";
import { CandidateDrawer, type DrawerCandidate } from "./CandidateDrawer";
import { motion, AnimatePresence } from "motion/react";
import { Applicant, calcAge, shortWorkHours } from "@/lib/admin/types";

// Types
interface CardData {
  id: string;
  name: string;
  age: number;
  gender: string;
  channel: string;
  branch: string;
  slot: string;
  tag: string;
  region: string;
  exp: string;
  lastActive: string;
  phone: string | null;
}

const CHANNEL_LABEL: Record<string, string> = {
  danggeun: "당근",
  baemin: "배민",
  manual: "수기 등록",
  direct: "직접 지원",
  danggeun_practice: "연습",
};

function channelLabel(source: string | null | undefined): string {
  if (!source) return "기타";
  return CHANNEL_LABEL[source] ?? source;
}

const DEFAULT_BULK_BODY =
  "[비마트 옹보딩] #{이름}님, 안녕하세요!\n현재 거주하고 계신 인근에 야간 배달 파트너를 긴급 모집 중입니다.\n\n이번 주말(금,토,일) 근무 시 기본 단가의 1.5배를 지급합니다. 관심 있으시다면 본 문자에 답장 주세요!";

interface ColumnData {
  id: string;
  title: string;
  count: number;
  color: string;
  cards: CardData[];
}

const ITEM_TYPE = "CANDIDATE_CARD";

// 실제 운영 단계: 스크리닝 전 → 스크리닝 중 → 스크리닝 완료(온보딩·배민ID) → 확정인력.
// 면접/캘린더 단계는 이 제품에 존재하지 않는다(SMS 스크리닝 후 매니저 확정).
const COLUMN_DEFS: { id: string; title: string; color: string }[] = [
  { id: "applied", title: "지원 접수 / 대기", color: "bg-[#CBD5E0]" },
  { id: "screening", title: "AI 스크리닝 중", color: "bg-[#F6E05E]" },
  { id: "interview", title: "스크리닝 완료", color: "bg-[#48BB78]" },
  { id: "passed", title: "확정 인력", color: "bg-[#3182CE]" },
];

// recruitment status → 칸반 컬럼. 부적합/이탈/기타는 보드에서 제외한다.
const STATUS_TO_COLUMN: Record<string, string> = {
  "스크리닝 전": "applied",
  대기자: "applied",
  "스크리닝 중": "screening",
  "스크리닝 완료": "interview",
  확정인력: "passed",
};

// 컬럼 → status. 드래그/일괄 변경은 매니저 행위이므로 수동 상태(확정인력) 설정을 허용한다.
const COLUMN_TO_STATUS: Record<string, string> = {
  applied: "스크리닝 전",
  screening: "스크리닝 중",
  interview: "스크리닝 완료",
  passed: "확정인력",
};

const BULK_LABEL_TO_STATUS: Record<string, string> = {
  "지원 접수 / 대기": "스크리닝 전",
  "AI 스크리닝 중": "스크리닝 중",
  "스크리닝 완료": "스크리닝 완료",
  "확정 인력": "확정인력",
  부적합: "부적합",
};

function relTime(iso: string | null): string {
  if (!iso) return "-";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금 전";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function vehicleTag(a: Applicant): string {
  if (a.vehicle_type && a.vehicle_type.trim()) return a.vehicle_type.trim();
  if (a.own_vehicle === "있음") return "차량 보유";
  return "도보";
}

function toCard(a: Applicant): CardData {
  const branch = a.confirmed_branch?.trim() || a.branch1?.trim() || a.branch?.trim() || "-";
  const slot = shortWorkHours(a.confirmed_slot || a.work_hours) || "-";
  return {
    id: String(a.id),
    name: a.name ?? "-",
    age: calcAge(a.birth_date) ?? 0,
    gender: "",
    channel: channelLabel(a.source),
    branch,
    slot,
    tag: vehicleTag(a),
    region: a.sigungu ?? a.location ?? "-",
    exp: a.experience?.trim() ? a.experience.trim() : "신입",
    lastActive: relTime(a.last_message_at ?? a.created_at),
    phone: a.phone ?? null,
  };
}

function mapApplicantsToColumns(apps: Applicant[]): ColumnData[] {
  const cols: ColumnData[] = COLUMN_DEFS.map((d) => ({ ...d, count: 0, cards: [] }));
  const byId = new Map(cols.map((c) => [c.id, c]));
  for (const a of apps) {
    const colId = STATUS_TO_COLUMN[a.status];
    if (!colId) continue;
    byId.get(colId)?.cards.push(toCard(a));
  }
  for (const c of cols) c.count = c.cards.length;
  return cols;
}

export function Pipeline() {
  const [columns, setColumns] = useState<ColumnData[]>(() =>
    COLUMN_DEFS.map((d) => ({ ...d, count: 0, cards: [] }))
  );
  const [loading, setLoading] = useState(true);
  const [selectedCandidate, setSelectedCandidate] = useState<DrawerCandidate | null>(null);
  const [view, setView] = useState<"kanban" | "list">("list");
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [query, setQuery] = useState("");
  const [channelFilter, setChannelFilter] = useState<Set<string>>(new Set());
  const [vehicleFilter, setVehicleFilter] = useState<"all" | "vehicle" | "walk">("all");
  const [slotFilter, setSlotFilter] = useState<Set<string>>(new Set());

  // Modals state
  const [bulkMsgModalOpen, setBulkMsgModalOpen] = useState(false);
  const [bulkStageModalOpen, setBulkStageModalOpen] = useState(false);
  const [bulkMsgBody, setBulkMsgBody] = useState(DEFAULT_BULK_BODY);
  const [bulkSending, setBulkSending] = useState(false);

  const loadApplicants = async () => {
    try {
      const res = await fetch("/api/admin/applicants");
      const json = await res.json();
      if (json.data) setColumns(mapApplicantsToColumns(json.data as Applicant[]));
      else toast.error("지원자 목록을 불러오지 못했어요");
    } catch {
      toast.error("지원자 목록을 불러오지 못했어요");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadApplicants();
  }, []);

  const allCards = columns.flatMap(c => c.cards.map(card => ({ ...card, stage: c.title, stageColor: c.color, stageId: c.id })));

  const availableChannels = Array.from(new Set(allCards.map((c) => c.channel))).sort();
  const SLOT_TOKENS = ["평일 오전", "평일 오후", "주말 오전", "주말 오후"];

  const toggleSetValue = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, value: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  const activeFilterCount =
    channelFilter.size + slotFilter.size + (vehicleFilter !== "all" ? 1 : 0);

  const resetFilters = () => {
    setChannelFilter(new Set());
    setVehicleFilter("all");
    setSlotFilter(new Set());
  };

  const q = query.trim().toLowerCase();
  const filteredCards = allCards.filter((c) => {
    if (q && ![c.name, c.phone ?? "", c.branch, c.region, c.channel, c.tag].some((v) => v.toLowerCase().includes(q))) return false;
    if (channelFilter.size && !channelFilter.has(c.channel)) return false;
    if (vehicleFilter === "walk" && c.tag !== "도보") return false;
    if (vehicleFilter === "vehicle" && c.tag === "도보") return false;
    if (slotFilter.size && ![...slotFilter].some((s) => c.slot.includes(s))) return false;
    return true;
  });

  const exportCardsCsv = (cards: CardData[], stageOf: (c: CardData) => string, fileLabel: string) => {
    if (cards.length === 0) return toast.error("내보낼 지원자가 없어요.");
    const headers = ["ID", "이름", "나이", "진행단계", "지원채널", "지점", "희망근무", "차량", "지역", "연락처", "최근활동"];
    const rows = cards.map((c) => [
      c.id, c.name, c.age, stageOf(c), c.channel, c.branch, c.slot, c.tag, c.region, c.phone ?? "", c.lastActive,
    ]);
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileLabel}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${cards.length}명을 CSV로 내보냈어요.`);
  };

  const exportCsv = () => exportCardsCsv(filteredCards, (c) => (c as CardData & { stage?: string }).stage ?? "", "지원자");

  const handleColumnExport = (column: ColumnData) => exportCardsCsv(column.cards, () => column.title, column.title);

  const handleColumnBulkMessage = (column: ColumnData) => {
    if (column.cards.length === 0) return toast.error("이 단계에 지원자가 없어요.");
    setSelectedRows(new Set(column.cards.map((c) => c.id)));
    setBulkMsgModalOpen(true);
  };

  const moveCard = (cardId: string, sourceColId: string, destColId: string) => {
    if (sourceColId === destColId) return;

    setColumns(prev => {
      const sourceCol = prev.find(col => col.id === sourceColId);
      const destCol = prev.find(col => col.id === destColId);
      if (!sourceCol || !destCol) return prev;

      const cardToMove = sourceCol.cards.find(c => c.id === cardId);
      if (!cardToMove) return prev;

      const newColumns = prev.map(col => {
        if (col.id === sourceColId) return { ...col, cards: col.cards.filter(c => c.id !== cardId), count: col.count - 1 };
        if (col.id === destColId) return { ...col, cards: [cardToMove, ...col.cards], count: col.count + 1 };
        return col;
      });

      setTimeout(() => {
        toast.success(`${cardToMove.name}님의 상태가 [${destCol.title}]로 변경되었습니다.`);
      }, 100);

      return newColumns;
    });

    const newStatus = COLUMN_TO_STATUS[destColId];
    if (newStatus) {
      fetch(`/api/admin/applicants/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      })
        .then((r) => {
          if (!r.ok) {
            toast.error("상태 변경 저장에 실패했어요");
            loadApplicants();
          }
        })
        .catch(() => {
          toast.error("상태 변경 저장에 실패했어요");
          loadApplicants();
        });
    }
  };

  const toggleRow = (id: string) => {
    const newSet = new Set(selectedRows);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedRows(newSet);
  };

  const toggleAll = () => {
    if (selectedRows.size === filteredCards.length) setSelectedRows(new Set());
    else setSelectedRows(new Set(filteredCards.map(c => c.id)));
  };

  const handleBulkStageChange = async (stageName: string) => {
    setBulkStageModalOpen(false);
    const status = BULK_LABEL_TO_STATUS[stageName];
    const ids = Array.from(selectedRows);
    if (status && ids.length > 0) {
      try {
        await Promise.all(
          ids.map((id) =>
            fetch(`/api/admin/applicants/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status }),
            })
          )
        );
        await loadApplicants();
      } catch {
        toast.error("일괄 상태 변경에 실패했어요");
      }
    }
    toast.success(`선택한 ${ids.length}명의 지원자가 [${stageName}] 단계로 일괄 이동되었습니다.`);
    setSelectedRows(new Set());
  };

  const handleBulkSend = async () => {
    if (bulkSending) return;
    const text = bulkMsgBody.trim();
    if (!text) return toast.error("메시지 내용을 입력해주세요.");

    const selected = allCards.filter((c) => selectedRows.has(c.id) && c.phone);
    const recipients = selected.map((c) => ({
      phone: c.phone as string,
      applicant_id: Number(c.id),
    }));
    if (recipients.length === 0) return toast.error("발송 가능한 연락처가 없어요.");

    setBulkSending(true);
    try {
      let sent = 0;
      let failed = 0;
      // bulk-send 엔드포인트는 1회 최대 50명 → 50명씩 끊어서 발송
      for (let i = 0; i < recipients.length; i += 50) {
        const chunk = recipients.slice(i, i + 50);
        const res = await fetch("/api/admin/messages/bulk-send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipients: chunk, body: text }),
        });
        const json = await res.json();
        if (!res.ok) {
          toast.error(json.error || "발송에 실패했어요");
          return;
        }
        sent += json.sent ?? 0;
        failed += json.failed ?? 0;
      }
      const skipped = selectedRows.size - recipients.length;
      toast.success(
        `${sent}명 발송 완료` +
          (failed ? `, ${failed}명 실패` : "") +
          (skipped ? `, ${skipped}명 연락처 없어 제외` : "")
      );
      setBulkMsgModalOpen(false);
      setSelectedRows(new Set());
      setBulkMsgBody(DEFAULT_BULK_BODY);
    } catch {
      toast.error("발송에 실패했어요");
    } finally {
      setBulkSending(false);
    }
  };

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="flex flex-col h-full overflow-hidden bg-[#F7FAFC]">
        {/* Top Header */}
        <div className="bg-white px-8 py-6 border-b border-[#E2E8F0] shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">인재풀 및 파이프라인 관리</h1>
              <p className="text-[14px] text-[#718096]">수천 명의 대규모 지원자 DB를 여러 채용 단계와 조건에 따라 직관적으로 필터링하고 일괄 관리합니다.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={exportCsv} className="flex items-center gap-1.5 px-4 py-2 bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] rounded-lg text-[13px] font-bold text-[#4A5568] transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
                <FileDown size={16} /> CSV로 내보내기
              </button>
            </div>
          </div>
        </div>

        {/* Toolbar & Filters */}
        <div className="px-8 py-4 flex items-center gap-3 border-b border-[#E2E8F0] bg-white shrink-0 flex-wrap z-10 shadow-sm">
          <div className="flex bg-[#F1F4F8] rounded-lg p-1 border border-[#E2E8F0]">
            <button onClick={() => setView("list")} className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-bold transition-all ${view === "list" ? "bg-white text-[#1A202C] shadow-sm" : "text-[#718096] hover:text-[#4A5568]"}`}>
              <ListIcon size={16} /> 리스트 뷰 (대량 관리)
            </button>
            <button onClick={() => setView("kanban")} className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-bold transition-all ${view === "kanban" ? "bg-white text-[#1A202C] shadow-sm" : "text-[#718096] hover:text-[#4A5568]"}`}>
              <LayoutGrid size={16} /> 칸반 보드
            </button>
          </div>

          <div className="w-px h-6 bg-[#E2E8F0] mx-2"></div>

          <button onClick={() => setShowFilters(!showFilters)} className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-bold border transition-colors ${showFilters || activeFilterCount > 0 ? 'bg-[#FFFBEC] border-[#FFCB3C] text-[#B8860B]' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC]'}`}>
            <Filter size={16} /> 고급 필터
            {activeFilterCount > 0 && <span className="bg-[#FFCB3C] text-[#1A202C] text-[11px] font-extrabold px-1.5 py-0.5 rounded-full leading-none">{activeFilterCount}</span>}
          </button>

          <div className="flex-1" />

          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} type="text" placeholder="이름, 연락처, 지점, 지역 검색" className="pl-9 pr-4 py-2.5 w-[280px] bg-white border border-[#E2E8F0] rounded-lg text-[13px] outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] shadow-sm" />
          </div>
        </div>

        {/* Advanced Filters Panel */}
        <AnimatePresence>
          {showFilters && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="bg-white border-b border-[#E2E8F0] shrink-0 overflow-hidden">
              <div className="px-8 py-5 bg-[#F7FAFC] flex flex-col gap-4">
                <div className="flex flex-wrap gap-8">
                  {/* 지원 채널 */}
                  <div>
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2">지원 채널</label>
                    <div className="flex flex-wrap gap-1.5">
                      {availableChannels.length === 0 && <span className="text-[12px] text-[#A0AEC0]">채널 없음</span>}
                      {availableChannels.map((ch) => {
                        const on = channelFilter.has(ch);
                        return (
                          <button key={ch} onClick={() => toggleSetValue(setChannelFilter, ch)} className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${on ? 'bg-[#1A202C] border-[#1A202C] text-white' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}>
                            {ch}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 이동수단 */}
                  <div>
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2">이동수단</label>
                    <div className="flex bg-white border border-[#E2E8F0] rounded-lg p-1">
                      {([["all", "전체"], ["vehicle", "차량 보유"], ["walk", "도보"]] as const).map(([val, label]) => (
                        <button key={val} onClick={() => setVehicleFilter(val)} className={`px-3 py-1.5 rounded-md text-[12.5px] font-bold transition-colors ${vehicleFilter === val ? 'bg-[#1A202C] text-white' : 'text-[#718096] hover:text-[#4A5568]'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 희망 슬롯 */}
                  <div>
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2">희망 근무(슬롯)</label>
                    <div className="flex flex-wrap gap-1.5">
                      {SLOT_TOKENS.map((s) => {
                        const on = slotFilter.has(s);
                        return (
                          <button key={s} onClick={() => toggleSetValue(setSlotFilter, s)} className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${on ? 'bg-[#FFCB3C] border-[#FFCB3C] text-[#1A202C]' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}>
                            {s}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-1">
                  <span className="text-[12.5px] font-bold text-[#4A5568]">{filteredCards.length}명 표시 중</span>
                  {activeFilterCount > 0 && (
                    <button onClick={resetFilters} className="text-[12.5px] font-bold text-[#E53E3E] hover:underline">필터 초기화</button>
                  )}
                  <div className="flex-1" />
                  <button onClick={() => setShowFilters(false)} className="text-[13px] font-bold text-[#3182CE] hover:underline px-3 py-1.5 outline-none">닫기</button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main Content Area */}
        <div className="flex-1 overflow-hidden relative">
          {loading && (
            <div className="px-8 py-3 text-[13px] text-[#718096] bg-[#F7FAFC]">지원자 목록 불러오는 중…</div>
          )}
          {view === "kanban" && (
            <div className="flex gap-6 h-full overflow-x-auto p-8">
              {columns.map((column, idx) => (
                <KanbanColumn key={column.id} column={column} moveCard={moveCard} onCardClick={(card) => setSelectedCandidate(card)} columnIndex={idx} onExport={handleColumnExport} onBulkMessage={handleColumnBulkMessage} />
              ))}
            </div>
          )}

          {view === "list" && (
            <div className="h-full overflow-y-auto p-8 relative bg-white">
              {/* Floating Bulk Actions Toolbar */}
              <AnimatePresence>
                {selectedRows.size > 0 && (
                  <motion.div initial={{ y: -50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -50, opacity: 0 }} className="sticky top-0 z-20 flex items-center gap-3 bg-gradient-to-r from-[#1A202C] to-[#2D3748] rounded-2xl px-6 py-4 mb-6 shadow-2xl border border-[#4A5568]">
                    <span className="text-[15px] font-extrabold text-white">
                      <span className="text-[#FFCB3C] text-[18px]">{selectedRows.size}명</span> 선택됨
                    </span>
                    <div className="w-px h-6 bg-white/20 mx-2"></div>

                    <button onClick={() => setBulkStageModalOpen(true)} className="bg-white/10 hover:bg-white/20 text-white border-0 rounded-xl px-4 py-2.5 text-[13px] font-bold flex items-center gap-2 transition-all backdrop-blur-sm">
                      <Columns size={16} /> 일괄 상태 변경
                    </button>
                    <button onClick={() => setBulkMsgModalOpen(true)} className="bg-[#FFCB3C] hover:bg-[#E0B500] text-[#1A202C] border-0 rounded-xl px-4 py-2.5 text-[13px] font-bold flex items-center gap-2 transition-all shadow-md">
                      <MessageCircle size={16} /> 알림톡/문자 캠페인 발송
                    </button>

                    <div className="flex-1" />

                    <button className="bg-transparent hover:bg-white/10 text-white/70 hover:text-white rounded-lg p-2 transition-colors" onClick={() => setSelectedRows(new Set())}>
                      <X size={20} />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Data Table */}
              <div className="border border-[#E2E8F0] rounded-[16px] overflow-hidden shadow-sm">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[#F7FAFC] border-b border-[#E2E8F0]">
                      <th className="px-5 py-4 w-[50px]">
                        <button onClick={toggleAll} className={`w-5 h-5 rounded-[6px] border-2 flex items-center justify-center transition-colors ${selectedRows.size === filteredCards.length && filteredCards.length > 0 ? 'bg-[#FFCB3C] border-[#FFCB3C]' : 'border-[#CBD5E0] bg-white'}`}>
                          {selectedRows.size === filteredCards.length && filteredCards.length > 0 && <Check size={14} strokeWidth={4} className="text-[#1A202C]" />}
                        </button>
                      </th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">지원자 정보</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">진행 단계</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">지원 채널 / 지점</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">보유 차량 / 조건</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">거주 지역 / 희망 근무</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">최근 활동</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCards.map(c => {
                      const isSelected = selectedRows.has(c.id);
                      return (
                        <tr
                          key={c.id}
                          onClick={() => setSelectedCandidate(c)}
                          className={`border-b border-[#F1F4F8] last:border-0 transition-colors hover:bg-[#F7FAFC] cursor-pointer group ${isSelected ? 'bg-[#FFFBEC] hover:bg-[#FFFBEC]' : 'bg-white'}`}
                        >
                          <td className="px-5 py-4">
                            <button onClick={(e) => { e.stopPropagation(); toggleRow(c.id); }} className={`w-5 h-5 rounded-[6px] border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-[#FFCB3C] border-[#FFCB3C]' : 'border-[#CBD5E0] bg-white'}`}>
                              {isSelected && <Check size={14} strokeWidth={4} className="text-[#1A202C]" />}
                            </button>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-[12px] bg-[#EDF2F7] text-[#4A5568] flex items-center justify-center font-bold text-[15px] shrink-0">
                                {c.name.charAt(0)}
                              </div>
                              <div>
                                <div className="text-[14px] font-bold text-[#1A202C]">{c.name} <span className="text-[13px] font-medium text-[#718096] ml-1">{c.age}세 · {c.gender}</span></div>
                                <div className="text-[11.5px] text-[#A0AEC0] font-mono tracking-tighter mt-0.5">{c.id}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <span className={`inline-flex items-center gap-1.5 text-[12.5px] font-bold px-3 py-1.5 rounded-lg border bg-white ${c.stageId === 'applied' ? 'border-[#E2E8F0] text-[#4A5568]' : c.stageId === 'screening' ? 'border-[#F6E05E] text-[#D69E2E] bg-[#FEFCBF]' : c.stageId === 'interview' ? 'border-[#9AE6B4] text-[#38A169] bg-[#F0FFF4]' : 'border-[#90CDF4] text-[#3182CE] bg-[#EBF8FF]'}`}>
                              <div className={`w-1.5 h-1.5 rounded-full ${c.stageColor}`} />
                              {c.stage}
                            </span>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1">
                              <span className="inline-flex w-fit items-center text-[12px] font-bold px-2 py-0.5 rounded-md bg-[#EDF2F7] text-[#4A5568]">{c.channel}</span>
                              <span className="text-[12px] font-medium text-[#718096]">{c.branch}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1">
                              <span className="text-[13px] font-bold text-[#4A5568]">{c.tag}</span>
                              <span className="text-[11.5px] text-[#718096]">{c.exp}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1">
                              <span className="text-[13px] font-medium text-[#4A5568]">{c.region}</span>
                              <span className="text-[11.5px] text-[#718096]">{c.slot}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4 text-[12.5px] text-[#A0AEC0]">
                            {c.lastActive}
                          </td>
                        </tr>
                      );
                    })}
                    {!loading && filteredCards.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-12 text-center text-[13px] text-[#A0AEC0]">
                          {query ? `'${query}' 검색 결과가 없어요.` : "표시할 지원자가 없어요."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <CandidateDrawer isOpen={!!selectedCandidate} onClose={() => setSelectedCandidate(null)} candidate={selectedCandidate} onStatusChange={loadApplicants} />

      {/* Modals for Bulk Actions */}
      {/* 1. Bulk Stage Change Modal */}
      {bulkStageModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white w-[500px] rounded-2xl shadow-xl flex flex-col overflow-hidden">
            <div className="p-5 border-b border-[#E2E8F0] bg-[#F7FAFC] flex justify-between items-center">
              <div>
                <h2 className="text-[16px] font-bold text-[#1A202C]">일괄 상태(파이프라인) 변경</h2>
                <div className="text-[12.5px] text-[#718096] mt-0.5">선택된 {selectedRows.size}명의 지원자를 어떤 단계로 이동시킬까요?</div>
              </div>
              <button onClick={() => setBulkStageModalOpen(false)} className="text-[#A0AEC0] hover:text-[#4A5568]"><X size={20} /></button>
            </div>
            <div className="p-6 grid grid-cols-2 gap-3">
              {[
                { id: "applied", label: "지원 접수 / 대기", desc: "스크리닝 전" },
                { id: "screening", label: "AI 스크리닝 중", desc: "체크리스트 진행" },
                { id: "interview", label: "스크리닝 완료", desc: "온보딩 · 배민ID 수집" },
                { id: "passed", label: "확정 인력", desc: "슬롯 확정" },
                { id: "rejected", label: "부적합", desc: "진행 중단" }
              ].map(stage => (
                <button key={stage.id} onClick={() => handleBulkStageChange(stage.label)} className="p-4 border border-[#E2E8F0] rounded-xl text-left hover:border-[#FFCB3C] hover:bg-[#FFFBEC] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
                  <div className="text-[14px] font-bold text-[#1A202C] mb-1">{stage.label}</div>
                  <div className="text-[12px] text-[#718096]">{stage.desc}</div>
                </button>
              ))}
            </div>
          </motion.div>
        </div>
      )}

      {/* 2. Bulk Message/Campaign Modal */}
      {bulkMsgModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white w-[600px] rounded-2xl shadow-xl flex flex-col overflow-hidden">
            <div className="p-5 border-b border-[#E2E8F0] bg-[#F7FAFC] flex justify-between items-center">
              <div>
                <h2 className="text-[16px] font-bold text-[#1A202C]">선택 인원 대상 문자(SMS) 캠페인 발송</h2>
                <div className="text-[12.5px] text-[#718096] mt-0.5">총 {selectedRows.size}명에게 일괄 발송됩니다. (연락처 없는 인원은 자동 제외)</div>
              </div>
              <button onClick={() => setBulkMsgModalOpen(false)} className="text-[#A0AEC0] hover:text-[#4A5568]"><X size={20} /></button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="text-[13px] font-bold text-[#4A5568] block mb-2">메시지 템플릿</label>
                <select
                  onChange={(e) => { if (e.target.value) setBulkMsgBody(e.target.value); }}
                  className="w-full border border-[#E2E8F0] rounded-xl px-4 py-3 text-[14px] outline-none focus:border-[#FFCB3C] bg-white"
                >
                  <option value="">직접 입력하기</option>
                  <option value={DEFAULT_BULK_BODY}>[긴급] 야간 파트너 충원 (단가 1.5배)</option>
                  <option value="안녕하세요, 지원해주셔서 감사합니다! 근무 시작 안내를 위해 본 문자에 답장 부탁드립니다.">근무 시작 안내</option>
                  <option value="지원해주신 내용 중 일부 확인이 필요합니다. 본 문자에 답장 주시면 안내드리겠습니다.">추가 정보 확인 요청</option>
                </select>
              </div>
              <div>
                <label className="text-[13px] font-bold text-[#4A5568] block mb-2">메시지 본문</label>
                <textarea
                  value={bulkMsgBody}
                  onChange={(e) => setBulkMsgBody(e.target.value)}
                  className="w-full h-[150px] border border-[#E2E8F0] rounded-xl p-4 text-[14px] outline-none focus:border-[#FFCB3C] resize-none leading-relaxed text-[#2D3748] bg-[#F7FAFC]"
                />
              </div>
            </div>
            <div className="p-5 border-t border-[#E2E8F0] bg-white flex justify-between items-center">
              <span className="text-[13px] font-bold text-[#718096]">예상 소요 비용: ₩ {selectedRows.size * 15}</span>
              <div className="flex gap-2">
                <button onClick={() => setBulkMsgModalOpen(false)} className="px-5 py-2.5 rounded-xl text-[14px] font-bold text-[#718096] hover:bg-[#F7FAFC] border border-[#E2E8F0]">취소</button>
                <button onClick={handleBulkSend} disabled={bulkSending} className="px-6 py-2.5 rounded-xl text-[14px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
                  {bulkSending ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
                  {bulkSending ? "발송 중..." : "캠페인 발송"}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}

    </DndProvider>
  );
}

// Kanban Column Component
interface KanbanColumnProps {
  column: ColumnData;
  moveCard: (cardId: string, sourceColId: string, destColId: string) => void;
  onCardClick: (card: DrawerCandidate) => void;
  columnIndex: number;
  onExport: (column: ColumnData) => void;
  onBulkMessage: (column: ColumnData) => void;
}

function KanbanColumn({ column, moveCard, onCardClick, columnIndex, onExport, onBulkMessage }: KanbanColumnProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [{ isOver }, drop] = useDrop(() => ({
    accept: ITEM_TYPE,
    drop: (item: { id: string; sourceColId: string }) => {
      moveCard(item.id, item.sourceColId, column.id);
    },
    collect: (monitor) => ({
      isOver: !!monitor.isOver()
    })
  }));

  return (
    <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: columnIndex * 0.05 }} ref={drop as any} className={`flex flex-col w-[320px] shrink-0 bg-[#F4F6F9] rounded-[16px] p-4 transition-colors duration-200 border border-[#E2E8F0] shadow-sm ${isOver ? 'ring-2 ring-[#FFCB3C] bg-[#FFFBEB]/50' : ''}`}>
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${column.color}`} />
          <h2 className="text-[15px] font-extrabold text-[#1A202C]">{column.title}</h2>
          <span className="text-[12px] font-bold text-[#718096] bg-[#E2E8F0] px-2.5 py-0.5 rounded-full">{column.count}</span>
        </div>
        <div className="relative">
          <button onClick={() => setMenuOpen((v) => !v)} className="text-[#A0AEC0] hover:text-[#4A5568] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] rounded-md"><MoreHorizontal size={18} /></button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-7 z-30 w-[200px] bg-white border border-[#E2E8F0] rounded-xl shadow-lg py-1.5">
                <button
                  onClick={() => { setMenuOpen(false); onExport(column); }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] font-bold text-[#4A5568] hover:bg-[#F7FAFC] text-left"
                >
                  <FileDown size={15} className="text-[#718096]" /> 이 단계 CSV 내보내기
                </button>
                <button
                  onClick={() => { setMenuOpen(false); onBulkMessage(column); }}
                  disabled={column.count === 0}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] font-bold text-[#4A5568] hover:bg-[#F7FAFC] text-left disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Mail size={15} className="text-[#718096]" /> 이 단계 일괄 문자
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 pr-1 pb-2 scrollbar-custom">
        {column.cards.map((card, idx) => (
          <KanbanCard key={card.id} card={card} columnId={column.id} onClick={() => onCardClick({ ...card, stage: column.title, stageId: column.id })} cardIndex={idx} />
        ))}
        {column.cards.length === 0 && (
          <div className="h-[120px] bg-white/40 border-2 border-dashed border-[#CBD5E0] rounded-xl flex flex-col items-center justify-center text-[#A0AEC0] gap-2">
            <div className="text-[13px] font-bold text-[#718096]">대기 중인 지원자 없음</div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// Kanban Card Component
interface KanbanCardProps {
  card: CardData;
  columnId: string;
  onClick: () => void;
  cardIndex: number;
}

function KanbanCard({ card, columnId, onClick, cardIndex }: KanbanCardProps) {
  const [{ isDragging }, drag] = useDrag(() => ({
    type: ITEM_TYPE,
    item: { id: card.id, sourceColId: columnId },
    collect: (monitor) => ({ isDragging: !!monitor.isDragging() })
  }));

  return (
    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.2, delay: cardIndex * 0.05 + 0.1 }} ref={drag as any} onClick={onClick} className={`bg-white border border-[#E2E8F0] rounded-xl p-4 cursor-grab active:cursor-grabbing hover:border-[#FFCB3C] hover:shadow-md transition-all ${isDragging ? 'opacity-50 ring-2 ring-[#FFCB3C]' : 'shadow-sm'}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[14px] font-bold text-[#1A202C]">{card.name} <span className="text-[12px] text-[#718096] font-medium ml-1">{card.age}세</span></div>
        <div className="text-[11px] font-bold px-2 py-0.5 rounded bg-[#EDF2F7] text-[#4A5568]">{card.channel}</div>
      </div>
      <div className="flex flex-col gap-1.5 mb-3">
        <div className="text-[12.5px] text-[#4A5568] flex items-center gap-1.5"><span className="text-[#A0AEC0]">지점:</span> <b>{card.branch}</b></div>
        <div className="text-[12.5px] text-[#4A5568] flex items-center gap-1.5"><span className="text-[#A0AEC0]">수단:</span> {card.tag}</div>
        <div className="text-[12.5px] text-[#4A5568] flex items-center gap-1.5"><span className="text-[#A0AEC0]">희망:</span> {card.slot}</div>
      </div>
      <div className="border-t border-[#F1F4F8] pt-3 flex justify-between items-center">
        <span className="text-[11px] text-[#A0AEC0]">{card.exp}</span>
        <span className="text-[11px] font-medium text-[#718096] bg-[#F7FAFC] px-2 py-1 rounded-md">{card.lastActive}</span>
      </div>
    </motion.div>
  );
}