import { useState, useEffect } from "react";
import { Search, ChevronDown, Bell, Plus, MapPin, X, Calendar, Map, CheckCircle, FileText } from "lucide-react";

interface TopbarProps {
  crumb: string;
  pageTitle: string;
}

export function Topbar({ crumb, pageTitle }: TopbarProps) {
  const [branchOpen, setBranchOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newJobOpen, setNewJobOpen] = useState(false);

  // Keyboard shortcut for Cmd+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <>
      <header className="h-[68px] shrink-0 bg-white border-b border-[#E2E8F0] flex items-center px-7 gap-[18px] z-10 relative">
      <div className="min-w-0">
        <div className="text-[12px] text-[#718096] font-semibold tracking-wide whitespace-nowrap">{crumb}</div>
        <div className="text-[21px] font-extrabold tracking-tight text-[#1A202C] leading-snug whitespace-nowrap">
          {pageTitle}
        </div>
      </div>
      
      <div className="flex-1" />
      
      {/* Search Button */}
      {/* Accessibility Improvement (A): Added focus-visible classes */}
      <button 
        onClick={() => setSearchOpen(true)}
        className="flex items-center gap-2 bg-[#F1F4F8] hover:bg-[#EAEFF5] border border-transparent rounded-[10px] py-[9px] px-[13px] w-[300px] min-w-[150px] shrink cursor-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
      >
        <Search size={17} className="text-[#A0AEC0]" />
        <span className="flex-1 text-left text-sm text-[#A0AEC0]">지원자·공고·메뉴 검색</span>
        <span className="text-[11px] font-bold text-[#718096] bg-white border border-[#E2E8F0] rounded-md px-1.5 py-0.5 tracking-wide">
          ⌘K
        </span>
      </button>

      {/* Branch Filter */}
      <div className="relative shrink-0">
        <button 
          onClick={() => {
            setBranchOpen(!branchOpen);
            setNotifOpen(false);
          }}
          className="flex items-center gap-2 bg-white border border-[#E2E8F0] hover:border-[#A0AEC0] rounded-[10px] py-[9px] px-[14px] text-sm font-semibold text-[#2D3748] cursor-pointer whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
        >
          <MapPin size={16} className="text-[#718096]" />
          전체 지점
          <ChevronDown size={14} className="text-[#A0AEC0]" />
        </button>
        
        {branchOpen && (
          <div className="absolute top-[50px] right-0 w-[188px] bg-white border border-[#E2E8F0] rounded-xl shadow-lg p-1.5 z-40 animate-in fade-in slide-in-from-top-2">
            <div className="text-[11px] font-bold text-[#A0AEC0] tracking-wide px-2.5 pt-2 pb-1.5">지점 필터</div>
            {["전체 지점", "비마트 강남점", "비마트 송파점", "스타벅스 성수점"].map((b, i) => (
              <button 
                key={i} 
                className={`w-full flex items-center justify-between gap-2 border-0 rounded-lg py-2 px-3 text-sm cursor-pointer text-left focus-visible:outline-none focus-visible:bg-[#F1F4F8] ${i === 0 ? "bg-[#F1F4F8] font-bold text-[#2D3748]" : "bg-transparent font-medium text-[#4A5568] hover:bg-[#F1F4F8]"}`}
              >
                {b}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Notifications */}
      <div className="relative shrink-0">
        <button 
          onClick={() => {
            setNotifOpen(!notifOpen);
            setBranchOpen(false);
          }}
          className="relative w-[42px] h-[42px] rounded-[10px] border border-[#E2E8F0] hover:border-[#A0AEC0] bg-white flex items-center justify-center cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
        >
          <Bell size={19} className="text-[#4A5568]" />
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#E53E3E] border-2 border-white text-white text-[10px] font-extrabold flex items-center justify-center">
            3
          </span>
        </button>

        {notifOpen && (
          <div className="absolute top-[50px] right-0 w-[330px] bg-white border border-[#E2E8F0] rounded-2xl shadow-xl z-40 overflow-hidden animate-in fade-in slide-in-from-top-2">
            <div className="flex items-center justify-between px-4 py-3.5 border-b border-[#F1F4F8]">
              <span className="text-sm font-bold text-[#1A202C]">알림</span>
              <span className="text-xs font-semibold text-[#D69E2E] cursor-pointer hover:underline">모두 읽음</span>
            </div>
            <div className="max-h-[340px] overflow-y-auto">
              <div className="flex gap-3 p-3 border-b border-[#F7FAFC] bg-[#F7FAFC]">
                <div className="w-8 h-8 rounded-lg bg-[#EBF8FF] flex items-center justify-center shrink-0">
                  <span className="text-[#3182CE] font-bold text-sm">A</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-[#2D3748] leading-snug">김철수 지원자가 면접을 확정했습니다.</div>
                  <div className="text-[11.5px] text-[#A0AEC0] mt-1">방금 전</div>
                </div>
                <span className="w-2 h-2 rounded-full bg-[#D69E2E] shrink-0 mt-1.5" />
              </div>
            </div>
          </div>
        )}
      </div>

      <button 
        onClick={() => setNewJobOpen(true)}
        className="flex items-center gap-2 bg-[#FFCB3C] hover:bg-[#E0B500] rounded-[10px] py-[10px] px-[16px] text-sm font-bold text-[#1A202C] tracking-tight cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#FFCB3C]"
      >
        <Plus size={18} strokeWidth={2.5} />
        공고 등록
      </button>
    </header>

      {/* Cmd+K Global Search Modal */}
      {searchOpen && (
        <div className="fixed inset-0 bg-[#00000080] z-50 flex items-start justify-center pt-[10vh] px-4 backdrop-blur-sm">
          <div className="bg-white w-full max-w-[640px] rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 px-5 py-4 border-b border-[#E2E8F0]">
              <Search size={22} className="text-[#A0AEC0]" />
              <input 
                autoFocus
                type="text" 
                placeholder="지원자, 공고, 메뉴를 검색해보세요" 
                className="flex-1 bg-transparent border-none outline-none text-[18px] text-[#1A202C] placeholder:text-[#A0AEC0] font-medium"
              />
              <button 
                onClick={() => setSearchOpen(false)}
                className="bg-[#F1F4F8] hover:bg-[#EAEFF5] text-[#718096] text-[12px] font-bold px-2.5 py-1.5 rounded-lg transition-colors"
              >
                ESC
              </button>
            </div>
            <div className="p-3 bg-[#F7FAFC]">
              <div className="text-[12px] font-bold text-[#A0AEC0] px-3 pb-2 pt-1">최근 검색어</div>
              <div className="flex flex-col">
                <button className="flex items-center gap-3 px-3 py-2.5 hover:bg-[#EDF2F7] rounded-xl text-left transition-colors">
                  <div className="w-8 h-8 rounded-full bg-[#E2E8F0] flex items-center justify-center shrink-0">
                    <Search size={14} className="text-[#718096]" />
                  </div>
                  <div className="flex-1">
                    <div className="text-[14px] font-bold text-[#1A202C]">마케팅 매니저</div>
                    <div className="text-[12px] text-[#718096]">채용공고</div>
                  </div>
                </button>
                <button className="flex items-center gap-3 px-3 py-2.5 hover:bg-[#EDF2F7] rounded-xl text-left transition-colors">
                  <div className="w-8 h-8 rounded-full bg-[#EBF8FF] flex items-center justify-center shrink-0">
                    <FileText size={14} className="text-[#3182CE]" />
                  </div>
                  <div className="flex-1">
                    <div className="text-[14px] font-bold text-[#1A202C]">이수진</div>
                    <div className="text-[12px] text-[#718096]">지원자 · 마케팅 매니저 (합격)</div>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* New Job Modal */}
      {newJobOpen && (
        <div className="fixed inset-0 bg-[#00000080] z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white w-full max-w-[800px] rounded-[20px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-7 py-5 border-b border-[#E2E8F0]">
              <div>
                <h2 className="text-[20px] font-extrabold text-[#1A202C]">새 채용공고 등록</h2>
                <p className="text-[14px] text-[#718096] mt-1">AI 옹봇이 공고 내용 작성을 도와드릴 수 있습니다.</p>
              </div>
              <button 
                onClick={() => setNewJobOpen(false)}
                className="w-10 h-10 rounded-full hover:bg-[#F1F4F8] flex items-center justify-center text-[#A0AEC0] transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-7 flex flex-col gap-6 bg-[#F7FAFC]">
              <div className="flex gap-4">
                <button className="flex-1 bg-[#FFFBEB] border-2 border-[#FFCB3C] rounded-2xl p-5 text-left relative overflow-hidden transition-all shadow-sm">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-[#FFCB3C] opacity-10 rounded-bl-full"></div>
                  <div className="font-extrabold text-[#1A202C] text-[18px] mb-1">AI 자동 작성 시작</div>
                  <div className="text-[#718096] text-[14px] leading-relaxed">직무와 화주사 정보만 입력하면<br/>AI가 상세 내용을 초안으로 작성합니다.</div>
                  <div className="mt-4 flex items-center gap-1.5 text-[#D69E2E] font-bold text-[14px]">
                    <CheckCircle size={16} /> 추천
                  </div>
                </button>
                <button className="flex-1 bg-white border-2 border-[#E2E8F0] hover:border-[#CBD5E0] rounded-2xl p-5 text-left transition-all shadow-sm">
                  <div className="font-extrabold text-[#1A202C] text-[18px] mb-1">직접 작성하기</div>
                  <div className="text-[#718096] text-[14px] leading-relaxed">기존 템플릿을 활용하거나<br/>처음부터 직접 모든 내용을 입력합니다.</div>
                </button>
              </div>

              <div className="bg-white border border-[#E2E8F0] rounded-2xl p-6 shadow-sm">
                <h3 className="font-bold text-[#1A202C] mb-4 text-[16px]">기본 정보</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-1.5">화주사 (고객사) <span className="text-[#E53E3E]">*</span></label>
                    <select className="w-full bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3 text-[14px] text-[#1A202C] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] appearance-none">
                      <option value="">화주사를 선택하세요</option>
                      <option value="1">비마트</option>
                      <option value="2">스타벅스</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-1.5">공고 제목 <span className="text-[#E53E3E]">*</span></label>
                    <input type="text" placeholder="예: [비마트] 강남점 물류센터 피킹/패킹 사원 모집" className="w-full bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3 text-[14px] text-[#1A202C] placeholder:text-[#A0AEC0] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[13px] font-bold text-[#4A5568] mb-1.5">근무 형태 <span className="text-[#E53E3E]">*</span></label>
                      <select className="w-full bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3 text-[14px] text-[#1A202C] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] appearance-none">
                        <option value="">선택</option>
                        <option value="contract">계약직</option>
                        <option value="parttime">아르바이트</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[13px] font-bold text-[#4A5568] mb-1.5">급여 <span className="text-[#E53E3E]">*</span></label>
                      <input type="text" placeholder="예: 시급 12,000원" className="w-full bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3 text-[14px] text-[#1A202C] placeholder:text-[#A0AEC0] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="flex items-center justify-end gap-3 px-7 py-5 border-t border-[#E2E8F0] bg-white">
              <button 
                onClick={() => setNewJobOpen(false)}
                className="px-5 py-2.5 rounded-xl text-[14px] font-bold text-[#4A5568] hover:bg-[#F1F4F8] transition-colors"
              >
                취소
              </button>
              <button className="px-6 py-2.5 rounded-xl text-[14px] font-bold text-[#1A202C] bg-[#FFCB3C] hover:bg-[#E0B500] transition-colors shadow-sm">
                다음 단계
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
