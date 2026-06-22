import { useState, useEffect } from "react";
import { Filter, Search, MoreHorizontal, MessageCircle, Calendar, Check, X, UserX, Download, LayoutGrid, List as ListIcon, Columns, ArrowRight, UserPlus, FileDown, Tags, Mail } from "lucide-react";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { toast } from "sonner";
import { CandidateDrawer } from "./CandidateDrawer";
import { motion, AnimatePresence } from "motion/react";
import { Applicant, calcAge } from "@/lib/admin/types";

// Types
interface CardData {
  id: string;
  name: string;
  age: number;
  gender: string;
  score: number;
  tag: string;
  region: string;
  exp: string;
  lastActive: string;
}

interface ColumnData {
  id: string;
  title: string;
  count: number;
  color: string;
  cards: CardData[];
}

const ITEM_TYPE = "CANDIDATE_CARD";

const COLUMN_DEFS: { id: string; title: string; color: string }[] = [
  { id: "applied", title: "지원서 접수", color: "bg-[#CBD5E0]" },
  { id: "screening", title: "AI 스크리닝", color: "bg-[#F6E05E]" },
  { id: "interview", title: "면접 제안 (캘린더)", color: "bg-[#48BB78]" },
  { id: "passed", title: "최종 합격", color: "bg-[#3182CE]" },
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
  "지원서 접수": "스크리닝 전",
  "AI 스크리닝": "스크리닝 중",
  "면접 제안": "스크리닝 완료",
  "최종 합격": "확정인력",
  "불합격/보류": "부적합",
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

// AI 적합도 점수 산출 파이프라인이 아직 없어 status 기반 임시 표기값을 쓴다 (실제 스코어링 도입 시 교체).
function derivedScore(status: string): number {
  switch (status) {
    case "확정인력": return 95;
    case "스크리닝 완료": return 88;
    case "스크리닝 중": return 75;
    case "대기자": return 70;
    default: return 62;
  }
}

function vehicleTag(a: Applicant): string {
  if (a.vehicle_type && a.vehicle_type.trim()) return a.vehicle_type.trim();
  if (a.own_vehicle === "있음") return "차량 보유";
  return "도보";
}

function toCard(a: Applicant): CardData {
  return {
    id: String(a.id),
    name: a.name ?? "-",
    age: calcAge(a.birth_date) ?? 0,
    gender: "",
    score: derivedScore(a.status),
    tag: vehicleTag(a),
    region: a.sigungu ?? a.location ?? "-",
    exp: a.experience?.trim() ? a.experience.trim() : "신입",
    lastActive: relTime(a.last_message_at ?? a.created_at),
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
  const [selectedCandidate, setSelectedCandidate] = useState<CardData | null>(null);
  const [view, setView] = useState<"kanban" | "list">("list");
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  
  // Modals state
  const [bulkMsgModalOpen, setBulkMsgModalOpen] = useState(false);
  const [bulkStageModalOpen, setBulkStageModalOpen] = useState(false);

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
    if (selectedRows.size === allCards.length) setSelectedRows(new Set());
    else setSelectedRows(new Set(allCards.map(c => c.id)));
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
              <button onClick={() => toast.success("현재 필터링된 리스트가 CSV로 다운로드 되었습니다.")} className="flex items-center gap-1.5 px-4 py-2 bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] rounded-lg text-[13px] font-bold text-[#4A5568] transition-colors shadow-sm">
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

          <button onClick={() => setShowFilters(!showFilters)} className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-bold border transition-colors ${showFilters ? 'bg-[#FFFBEC] border-[#FFCB3C] text-[#B8860B]' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC]'}`}>
            <Filter size={16} /> 고급 필터
          </button>

          <div className="flex-1" />

          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
            <input type="text" placeholder="지원자명, 연락처, 태그 검색" className="pl-9 pr-4 py-2.5 w-[280px] bg-white border border-[#E2E8F0] rounded-lg text-[13px] outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] shadow-sm" />
          </div>
        </div>

        {/* Advanced Filters Panel */}
        <AnimatePresence>
          {showFilters && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="bg-white border-b border-[#E2E8F0] shrink-0 overflow-hidden">
              <div className="px-8 py-5 flex gap-5 items-end bg-[#F7FAFC]">
                <div>
                  <label className="block text-[12px] font-bold text-[#4A5568] mb-1.5">거주 지역 반경</label>
                  <select className="w-[160px] bg-white border border-[#E2E8F0] rounded-lg px-3 py-2.5 text-[13px] outline-none focus:border-[#FFCB3C]">
                    <option>비마트 송파점 3km 이내</option>
                    <option>비마트 강남점 5km 이내</option>
                    <option>수도권 전체</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#4A5568] mb-1.5">이동 수단</label>
                  <select className="w-[140px] bg-white border border-[#E2E8F0] rounded-lg px-3 py-2.5 text-[13px] outline-none focus:border-[#FFCB3C]">
                    <option>전체 수단</option>
                    <option>오토바이 (면허보유)</option>
                    <option>자전거 / 전기자전거</option>
                    <option>도보</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#4A5568] mb-1.5">AI 적합도 (Screening)</label>
                  <select className="w-[140px] bg-white border border-[#E2E8F0] rounded-lg px-3 py-2.5 text-[13px] outline-none focus:border-[#FFCB3C]">
                    <option>전체 점수</option>
                    <option>90점 이상 (우수)</option>
                    <option>80점 이상</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-bold text-[#4A5568] mb-1.5">최근 활동일</label>
                  <select className="w-[140px] bg-white border border-[#E2E8F0] rounded-lg px-3 py-2.5 text-[13px] outline-none focus:border-[#FFCB3C]">
                    <option>최근 7일</option>
                    <option>최근 30일</option>
                    <option>휴면 상태 (3개월 이상)</option>
                  </select>
                </div>
                <div className="flex-1" />
                <button onClick={() => { setShowFilters(false); toast.info('필터가 초기화되었습니다.'); }} className="text-[13px] font-bold text-[#3182CE] hover:underline px-3 py-2.5 outline-none">필터 초기화</button>
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
                <KanbanColumn key={column.id} column={column} moveCard={moveCard} onCardClick={(card) => setSelectedCandidate(card)} columnIndex={idx} />
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
                        <button onClick={toggleAll} className={`w-5 h-5 rounded-[6px] border-2 flex items-center justify-center transition-colors ${selectedRows.size === allCards.length && allCards.length > 0 ? 'bg-[#FFCB3C] border-[#FFCB3C]' : 'border-[#CBD5E0] bg-white'}`}>
                          {selectedRows.size === allCards.length && allCards.length > 0 && <Check size={14} strokeWidth={4} className="text-[#1A202C]" />}
                        </button>
                      </th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">지원자 정보</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">파이프라인 상태</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">AI 적합도</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">보유 차량 / 조건</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">거주 지역</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">최근 활동</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allCards.map(c => {
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
                            <div className="flex items-center gap-2">
                              <span className={`text-[15px] font-extrabold tracking-tight ${c.score >= 90 ? 'text-[#38A169]' : c.score >= 80 ? 'text-[#3182CE]' : 'text-[#718096]'}`}>{c.score}</span>
                              <div className="w-16 h-1.5 bg-[#F1F4F8] rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${c.score >= 90 ? 'bg-[#38A169]' : c.score >= 80 ? 'bg-[#3182CE]' : 'bg-[#A0AEC0]'}`} style={{ width: `${c.score}%` }} />
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1">
                              <span className="text-[13px] font-bold text-[#4A5568]">{c.tag}</span>
                              <span className="text-[11.5px] text-[#718096]">{c.exp}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4 text-[13px] font-medium text-[#4A5568]">
                            {c.region}
                          </td>
                          <td className="px-4 py-4 text-[12.5px] text-[#A0AEC0]">
                            {c.lastActive}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <CandidateDrawer isOpen={!!selectedCandidate} onClose={() => setSelectedCandidate(null)} candidate={selectedCandidate} />

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
              <button onClick={() => setBulkStageModalOpen(false)} className="text-[#A0AEC0] hover:text-[#4A5568]"><X size={20}/></button>
            </div>
            <div className="p-6 grid grid-cols-2 gap-3">
              {[
                { id: "applied", label: "지원서 접수", desc: "초기 상태" },
                { id: "screening", label: "AI 스크리닝", desc: "대화형 검증" },
                { id: "interview", label: "면접 제안", desc: "캘린더 픽커 발송" },
                { id: "passed", label: "최종 합격", desc: "입사 안내" },
                { id: "rejected", label: "불합격/보류", desc: "DB 장기 보관" }
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
                <h2 className="text-[16px] font-bold text-[#1A202C]">선택 인원 대상 알림톡 캠페인 발송</h2>
                <div className="text-[12.5px] text-[#718096] mt-0.5">총 {selectedRows.size}명에게 일괄 발송됩니다.</div>
              </div>
              <button onClick={() => setBulkMsgModalOpen(false)} className="text-[#A0AEC0] hover:text-[#4A5568]"><X size={20}/></button>
            </div>
            <div className="p-6 space-y-5">
              <div>
                <label className="text-[13px] font-bold text-[#4A5568] block mb-2">메시지 템플릿 선택</label>
                <select className="w-full border border-[#E2E8F0] rounded-xl px-4 py-3 text-[14px] outline-none focus:border-[#FFCB3C] bg-white">
                  <option>[긴급] 비마트 강남/송파권역 야간 파트너 충원 (단가 1.5배)</option>
                  <option>서류 합격 및 면접 일정 선택 안내</option>
                  <option>지원서류 보완 요청</option>
                  <option>직접 입력하기</option>
                </select>
              </div>
              <div>
                <label className="text-[13px] font-bold text-[#4A5568] block mb-2">메시지 본문 (자동 치환 적용)</label>
                <textarea 
                  className="w-full h-[150px] border border-[#E2E8F0] rounded-xl p-4 text-[14px] outline-none focus:border-[#FFCB3C] resize-none leading-relaxed text-[#2D3748] bg-[#F7FAFC]"
                  defaultValue={"[비마트 옹보딩] #{이름}님, 안녕하세요!\n현재 거주하고 계신 #{거주지역} 인근에 야간 배달 파트너를 긴급 모집 중입니다.\n\n이번 주말(금,토,일) 근무 시 기본 단가의 1.5배를 지급합니다. 관심 있으시다면 아래 버튼을 눌러 즉시 지원해주세요!"}
                />
              </div>
            </div>
            <div className="p-5 border-t border-[#E2E8F0] bg-white flex justify-between items-center">
              <span className="text-[13px] font-bold text-[#718096]">예상 소요 비용: ₩ {selectedRows.size * 15}</span>
              <div className="flex gap-2">
                <button onClick={() => setBulkMsgModalOpen(false)} className="px-5 py-2.5 rounded-xl text-[14px] font-bold text-[#718096] hover:bg-[#F7FAFC] border border-[#E2E8F0]">취소</button>
                <button onClick={() => { setBulkMsgModalOpen(false); toast.success(`선택한 ${selectedRows.size}명에게 캠페인 발송이 완료되었습니다.`); setSelectedRows(new Set()); }} className="px-6 py-2.5 rounded-xl text-[14px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] flex items-center gap-2">
                  <Mail size={16}/> 캠페인 발송
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
  onCardClick: (card: CardData) => void;
  columnIndex: number;
}

function KanbanColumn({ column, moveCard, onCardClick, columnIndex }: KanbanColumnProps) {
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
        <button onClick={() => toast.info(`${column.title} 열 설정 메뉴가 열립니다.`)} className="text-[#A0AEC0] hover:text-[#4A5568] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] rounded-md"><MoreHorizontal size={18} /></button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 pr-1 pb-2 scrollbar-custom">
        {column.cards.map((card, idx) => (
          <KanbanCard key={card.id} card={card} columnId={column.id} onClick={() => onCardClick(card)} cardIndex={idx} />
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
        <div className={`text-[12px] font-extrabold px-2 py-0.5 rounded ${card.score >= 90 ? 'bg-[#F0FFF4] text-[#38A169]' : 'bg-[#EBF8FF] text-[#3182CE]'}`}>{card.score}점</div>
      </div>
      <div className="flex flex-col gap-1.5 mb-3">
        <div className="text-[12.5px] text-[#4A5568] flex items-center gap-1.5"><span className="text-[#A0AEC0]">수단:</span> <b>{card.tag}</b></div>
        <div className="text-[12.5px] text-[#4A5568] flex items-center gap-1.5"><span className="text-[#A0AEC0]">지역:</span> {card.region}</div>
      </div>
      <div className="border-t border-[#F1F4F8] pt-3 flex justify-between items-center">
        <span className="text-[11px] text-[#A0AEC0]">{card.exp}</span>
        <span className="text-[11px] font-medium text-[#718096] bg-[#F7FAFC] px-2 py-1 rounded-md">{card.lastActive}</span>
      </div>
    </motion.div>
  );
}