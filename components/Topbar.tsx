"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, ChevronDown, Bell, Plus, MapPin, FileText, User, Loader2, RefreshCw, Check, Inbox } from "lucide-react";
import { useBranchScope } from "@/lib/branch-scope";

interface TopbarProps {
  crumb: string;
  pageTitle: string;
}

interface ApplicantHit { id: number; name: string | null; phone: string | null; status: string | null; branch: string | null }
interface JobHit { id: number; title: string; status: string | null }
interface Notice { id: string; tone: "red" | "amber" | "slate"; title: string; desc: string; path: string }
interface BranchOpt { id: number; name: string; active: boolean }

export function Topbar({ crumb, pageTitle }: TopbarProps) {
  const router = useRouter();
  const { branch: scopeBranch, setBranch: setScopeBranch } = useBranchScope();

  const [branchOpen, setBranchOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // 검색
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<{ applicants: ApplicantHit[]; jobs: JobHit[] }>({ applicants: [], jobs: [] });

  // 알림
  const [notices, setNotices] = useState<Notice[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);

  // 지점
  const [branches, setBranches] = useState<BranchOpt[]>([]);

  const branchRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  // ⌘K 단축키
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) setBranchOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  // 지점 목록 로드
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/branches");
        const json = await res.json();
        setBranches(((json.data ?? []) as BranchOpt[]).filter((b) => b.active));
      } catch {
        /* 무시 */
      }
    })();
  }, []);

  // 알림 로드 + 60초 폴링
  const loadNotices = useCallback(async () => {
    setNotifLoading(true);
    try {
      const res = await fetch("/api/admin/notifications");
      const json = await res.json();
      setNotices((json.items ?? []) as Notice[]);
    } catch {
      /* 무시 */
    } finally {
      setNotifLoading(false);
    }
  }, []);
  useEffect(() => {
    loadNotices();
    const t = setInterval(loadNotices, 60_000);
    return () => clearInterval(t);
  }, [loadNotices]);

  // 검색 디바운스
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults({ applicants: [], jobs: [] });
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/search?q=${encodeURIComponent(q)}`);
        const json = await res.json();
        setResults({ applicants: json.applicants ?? [], jobs: json.jobs ?? [] });
      } catch {
        setResults({ applicants: [], jobs: [] });
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setResults({ applicants: [], jobs: [] });
  };

  const goApplicant = (a: ApplicantHit) => {
    closeSearch();
    router.push(`/pipeline?q=${encodeURIComponent(a.name || a.phone || "")}`);
  };
  const goJob = (j: JobHit) => {
    closeSearch();
    router.push(`/jobs?q=${encodeURIComponent(j.title)}`);
  };

  const pickBranch = (name: string | null) => {
    setScopeBranch(name);
    setBranchOpen(false);
  };

  const hasResults = results.applicants.length > 0 || results.jobs.length > 0;

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
        <button
          onClick={() => setSearchOpen(true)}
          className="flex items-center gap-2 bg-[#F1F4F8] hover:bg-[#EAEFF5] border border-transparent rounded-[10px] py-[9px] px-[13px] w-[300px] min-w-[150px] shrink cursor-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
        >
          <Search size={17} className="text-[#A0AEC0]" />
          <span className="flex-1 text-left text-sm text-[#A0AEC0]">지원자·공고 검색</span>
          <span className="text-[11px] font-bold text-[#718096] bg-white border border-[#E2E8F0] rounded-md px-1.5 py-0.5 tracking-wide">
            ⌘K
          </span>
        </button>

        {/* Branch Filter (전역 스코프) */}
        <div className="relative shrink-0" ref={branchRef}>
          <button
            onClick={() => {
              setBranchOpen(!branchOpen);
              setNotifOpen(false);
            }}
            className={`flex items-center gap-2 bg-white border rounded-[10px] py-[9px] px-[14px] text-sm font-semibold cursor-pointer whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] ${scopeBranch ? "border-[#FFCB3C] text-[#1A202C] bg-[#FFFBEB]" : "border-[#E2E8F0] text-[#2D3748] hover:border-[#A0AEC0]"}`}
          >
            <MapPin size={16} className={scopeBranch ? "text-[#D69E2E]" : "text-[#718096]"} />
            <span className="max-w-[140px] truncate">{scopeBranch ?? "전체 지점"}</span>
            <ChevronDown size={14} className="text-[#A0AEC0]" />
          </button>

          {branchOpen && (
            <div className="absolute top-[50px] right-0 w-[220px] bg-white border border-[#E2E8F0] rounded-xl shadow-lg p-1.5 z-40 animate-in fade-in slide-in-from-top-2 max-h-[360px] overflow-y-auto scrollbar-custom">
              <div className="text-[11px] font-bold text-[#A0AEC0] tracking-wide px-2.5 pt-2 pb-1.5">지점 스코프 (대시보드·파이프라인)</div>
              <button
                onClick={() => pickBranch(null)}
                className={`w-full flex items-center justify-between gap-2 border-0 rounded-lg py-2 px-3 text-sm cursor-pointer text-left focus-visible:outline-none focus-visible:bg-[#F1F4F8] ${!scopeBranch ? "bg-[#F1F4F8] font-bold text-[#2D3748]" : "bg-transparent font-medium text-[#4A5568] hover:bg-[#F1F4F8]"}`}
              >
                전체 지점 {!scopeBranch && <Check size={14} className="text-[#D69E2E]" />}
              </button>
              {branches.length === 0 && (
                <div className="px-3 py-2 text-[12.5px] text-[#A0AEC0]">등록된 지점이 없어요.</div>
              )}
              {branches.map((b) => (
                <button
                  key={b.id}
                  onClick={() => pickBranch(b.name)}
                  className={`w-full flex items-center justify-between gap-2 border-0 rounded-lg py-2 px-3 text-sm cursor-pointer text-left focus-visible:outline-none focus-visible:bg-[#F1F4F8] ${scopeBranch === b.name ? "bg-[#F1F4F8] font-bold text-[#2D3748]" : "bg-transparent font-medium text-[#4A5568] hover:bg-[#F1F4F8]"}`}
                >
                  <span className="truncate">{b.name}</span>
                  {scopeBranch === b.name && <Check size={14} className="text-[#D69E2E] shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Notifications */}
        <div className="relative shrink-0" ref={notifRef}>
          <button
            onClick={() => {
              setNotifOpen(!notifOpen);
              setBranchOpen(false);
              if (!notifOpen) loadNotices();
            }}
            className="relative w-[42px] h-[42px] rounded-[10px] border border-[#E2E8F0] hover:border-[#A0AEC0] bg-white flex items-center justify-center cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
          >
            <Bell size={19} className="text-[#4A5568]" />
            {notices.length > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#E53E3E] border-2 border-white text-white text-[10px] font-extrabold flex items-center justify-center">
                {notices.length}
              </span>
            )}
          </button>

          {notifOpen && (
            <div className="absolute top-[50px] right-0 w-[340px] bg-white border border-[#E2E8F0] rounded-2xl shadow-xl z-40 overflow-hidden animate-in fade-in slide-in-from-top-2">
              <div className="flex items-center justify-between px-4 py-3.5 border-b border-[#F1F4F8]">
                <span className="text-sm font-bold text-[#1A202C]">알림 {notices.length > 0 && <span className="text-[#E53E3E]">{notices.length}</span>}</span>
                <button
                  onClick={loadNotices}
                  className="flex items-center gap-1 text-xs font-semibold text-[#718096] hover:text-[#1A202C] transition-colors"
                >
                  <RefreshCw size={12} className={notifLoading ? "animate-spin" : ""} /> 새로고침
                </button>
              </div>
              <div className="max-h-[360px] overflow-y-auto scrollbar-custom">
                {notices.length === 0 ? (
                  <div className="flex flex-col items-center justify-center text-center py-10 px-4 text-[#A0AEC0]">
                    <Check size={26} className="text-[#38A169] mb-2" />
                    <div className="text-[13px] font-bold text-[#4A5568]">새 알림이 없어요</div>
                    <div className="text-[12px] mt-0.5">미분류 인박스·미답장·AI 중단이 발생하면 표시됩니다.</div>
                  </div>
                ) : (
                  notices.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => {
                        setNotifOpen(false);
                        router.push(n.path);
                      }}
                      className="w-full flex gap-3 p-3.5 border-b border-[#F7FAFC] hover:bg-[#F7FAFC] transition-colors text-left"
                    >
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${n.tone === "red" ? "bg-[#FFF5F5] text-[#E53E3E]" : n.tone === "amber" ? "bg-[#FFFAF0] text-[#D69E2E]" : "bg-[#EDF2F7] text-[#4A5568]"}`}>
                        <Inbox size={16} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-bold text-[#2D3748] leading-snug">{n.title}</div>
                        <div className="text-[12px] text-[#718096] mt-0.5 leading-snug">{n.desc}</div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => router.push("/jobs?new=1")}
          className="flex items-center gap-2 bg-[#FFCB3C] hover:bg-[#E0B500] rounded-[10px] py-[10px] px-[16px] text-sm font-bold text-[#1A202C] tracking-tight cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#FFCB3C]"
        >
          <Plus size={18} strokeWidth={2.5} />
          공고 등록
        </button>
      </header>

      {/* ⌘K Global Search Modal */}
      {searchOpen && (
        <div className="fixed inset-0 bg-[#00000080] z-50 flex items-start justify-center pt-[10vh] px-4 backdrop-blur-sm" onClick={closeSearch}>
          <div
            className="bg-white w-full max-w-[640px] rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-5 py-4 border-b border-[#E2E8F0]">
              <Search size={22} className="text-[#A0AEC0]" />
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="지원자 이름·연락처 또는 공고 제목을 검색"
                className="flex-1 bg-transparent border-none outline-none text-[18px] text-[#1A202C] placeholder:text-[#A0AEC0] font-medium"
              />
              {searching && <Loader2 size={18} className="text-[#A0AEC0] animate-spin" />}
              <button
                onClick={closeSearch}
                className="bg-[#F1F4F8] hover:bg-[#EAEFF5] text-[#718096] text-[12px] font-bold px-2.5 py-1.5 rounded-lg transition-colors"
              >
                ESC
              </button>
            </div>
            <div className="p-3 bg-[#F7FAFC] max-h-[50vh] overflow-y-auto scrollbar-custom">
              {!query.trim() && (
                <div className="text-center py-10 text-[#A0AEC0]">
                  <div className="text-[13px] font-bold text-[#718096]">지원자·공고를 검색하세요</div>
                  <div className="text-[12px] mt-1">이름, 휴대폰 번호, 공고 제목으로 찾을 수 있어요.</div>
                </div>
              )}
              {query.trim() && !searching && !hasResults && (
                <div className="text-center py-10 text-[#A0AEC0]">
                  <div className="text-[13px] font-bold text-[#718096]">‘{query.trim()}’ 검색 결과가 없어요</div>
                </div>
              )}
              {results.applicants.length > 0 && (
                <>
                  <div className="text-[12px] font-bold text-[#A0AEC0] px-3 pb-2 pt-1">지원자</div>
                  <div className="flex flex-col mb-2">
                    {results.applicants.map((a) => (
                      <button
                        key={`a-${a.id}`}
                        onClick={() => goApplicant(a)}
                        className="flex items-center gap-3 px-3 py-2.5 hover:bg-[#EDF2F7] rounded-xl text-left transition-colors"
                      >
                        <div className="w-8 h-8 rounded-full bg-[#EBF8FF] flex items-center justify-center shrink-0">
                          <User size={14} className="text-[#3182CE]" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-bold text-[#1A202C] truncate">{a.name || "이름 미상"}</div>
                          <div className="text-[12px] text-[#718096] truncate">
                            {[a.phone, a.branch, a.status].filter(Boolean).join(" · ") || "지원자"}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {results.jobs.length > 0 && (
                <>
                  <div className="text-[12px] font-bold text-[#A0AEC0] px-3 pb-2 pt-1">채용공고</div>
                  <div className="flex flex-col">
                    {results.jobs.map((j) => (
                      <button
                        key={`j-${j.id}`}
                        onClick={() => goJob(j)}
                        className="flex items-center gap-3 px-3 py-2.5 hover:bg-[#EDF2F7] rounded-xl text-left transition-colors"
                      >
                        <div className="w-8 h-8 rounded-full bg-[#E2E8F0] flex items-center justify-center shrink-0">
                          <FileText size={14} className="text-[#718096]" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-bold text-[#1A202C] truncate">{j.title}</div>
                          <div className="text-[12px] text-[#718096]">채용공고 · {j.status === "closed" ? "마감" : "진행 중"}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
