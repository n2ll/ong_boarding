"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Search, ChevronDown, ChevronRight, Bell, Plus, MapPin, FileText, User, Loader2, RefreshCw, Check, Inbox, AlertCircle, MessageSquareWarning } from "lucide-react";
import { useBranchScope } from "@/lib/branch-scope";
import { nextSearchDialogFocusIndex } from "@/lib/admin/search-dialog";
import { topbarCollectionState } from "@/lib/admin/topbar-state";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAdminUnsavedNavigation } from "@/components/AdminUnsavedNavigation";

interface TopbarProps {
  crumb: string;
  pageTitle: string;
  showBranchScope: boolean;
  showCreateJobAction: boolean;
}

interface ApplicantHit { id: number; name: string | null; phone: string | null; status: string | null; branch: string | null }
interface JobHit { id: number; title: string; status: string | null }
interface Notice { id: string; kind?: "bulk-message" | "bulk-message-error"; tone: "red" | "amber" | "slate"; title: string; desc: string; path: string }
interface BranchOpt { id: number; name: string; active: boolean }

export function Topbar({ crumb, pageTitle, showBranchScope, showCreateJobAction }: TopbarProps) {
  const router = useRouter();
  const { requestNavigation } = useAdminUnsavedNavigation();
  const { branch: scopeBranch, setBranch: setScopeBranch } = useBranchScope();

  const [branchOpen, setBranchOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // 검색
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [results, setResults] = useState<{ applicants: ApplicantHit[]; jobs: JobHit[] }>({ applicants: [], jobs: [] });
  const [resultsQuery, setResultsQuery] = useState("");

  const searchDialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const openSearch = useCallback(() => {
    if (!searchOpen) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    setSearchOpen(true);
  }, [searchOpen]);

  const closeSearch = useCallback(() => {
    const returnTarget = returnFocusRef.current;
    setSearchOpen(false);
    setQuery("");
    setResults({ applicants: [], jobs: [] });
    setResultsQuery("");
    setSearchError(false);
    requestAnimationFrame(() => returnTarget?.focus());
  }, []);

  const navigate = useCallback((href: string, beforeNavigation?: () => void) => {
    void requestNavigation(() => {
      beforeNavigation?.();
      router.push(href);
    });
  }, [requestNavigation, router]);

  // 스크롤 에지 — 콘텐츠가 유리 밑을 지나가기 시작하면 그림자를 한 단 올려 분리감을 준다.
  // (Apple scroll edge effect의 최소 구현 — 유리 자체는 정지, 그림자만 변한다)
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = document.getElementById("app-content");
    if (!el) return;
    const onScroll = () => setScrolled(el.scrollTop > 0);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // ⌘K 단축키
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openSearch();
      }
      if (e.key === "Escape" && searchOpen) closeSearch();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeSearch, openSearch, searchOpen]);

  useEffect(() => {
    if (!showBranchScope) setBranchOpen(false);
  }, [showBranchScope]);

  // 지점 목록 — 다른 화면도 같은 키로 부르므로 useSWR로 캐시를 공유한다(중복 호출 제거).
  const { data: branchRes, error: branchError, mutate: mutateBranches } = useSWR<{ data?: BranchOpt[] }>(
    showBranchScope ? "/api/admin/branches" : null,
  );
  const branches = useMemo(() => (branchRes?.data ?? []).filter((b) => b.active), [branchRes]);
  const branchState = topbarCollectionState({ items: branchRes?.data, error: branchError });

  // 알림 — 사이드바 배지와 같은 키. useSWR로 묶어 같은 요청이 두 번 나가지 않게 한다.
  const { data: notiRes, error: notifError, isLoading: notifLoading, mutate: mutateNotices } = useSWR<{ items?: Notice[] }>(
    "/api/admin/notifications",
    { refreshInterval: 60_000 }
  );
  const notices = useMemo(() => {
    // 패널은 '요약 + 가장 급한 것부터' 문법 — 붉은 것(사람이 막힌 것)이 항상 위로.
    const rank = { red: 0, amber: 1, slate: 2 } as const;
    return [...(notiRes?.items ?? [])].sort((a, b) => rank[a.tone] - rank[b.tone]);
  }, [notiRes]);
  const noticeState = topbarCollectionState({ items: notiRes?.items, error: notifError });
  const loadNotices = useCallback(() => { void mutateNotices(); }, [mutateNotices]);

  // 검색 디바운스
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults({ applicants: [], jobs: [] });
      setResultsQuery("");
      setSearching(false);
      setSearchError(false);
      return;
    }
    setSearching(true);
    setSearchError(false);
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("search failed");
        const json = await res.json();
        setResults({ applicants: json.applicants ?? [], jobs: json.jobs ?? [] });
        setResultsQuery(q);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSearchError(true);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query, searchAttempt]);

  const trapSearchFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusables = Array.from(
      searchDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => element.getAttribute("aria-hidden") !== "true");
    const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
    const nextIndex = nextSearchDialogFocusIndex(
      currentIndex,
      focusables.length,
      event.shiftKey ? "backward" : "forward",
    );
    if (nextIndex < 0) return;
    event.preventDefault();
    focusables[nextIndex]?.focus();
  };

  const goApplicant = (a: ApplicantHit) => {
    navigate(`/pipeline?q=${encodeURIComponent(a.name || a.phone || "")}`, closeSearch);
  };
  const goJob = (j: JobHit) => {
    navigate(`/jobs?q=${encodeURIComponent(j.title)}`, closeSearch);
  };

  const pickBranch = (name: string | null) => {
    setScopeBranch(name);
    setBranchOpen(false);
  };

  const resultsAreCurrent = resultsQuery === query.trim();
  const hasResults = resultsAreCurrent && (results.applicants.length > 0 || results.jobs.length > 0);

  return (
    <>
      {/*
        떠 있는 글래스 헤더 (Ongboarding UI System 셸).
        Glass 컴포넌트가 아니라 .glass 유틸리티를 쓴다 — Glass는 overflow-hidden이라
        안에 있는 지점 필터·알림 드롭다운(absolute)이 잘린다.
      */}
      <header className="relative z-40 mb-3 mt-3 shrink-0 lg:mb-4 lg:mt-4">
        <div className={`glass backdrop-blur-lg backdrop-saturate-150 flex min-h-16 items-center gap-[18px] rounded-2xl px-4 transition-shadow duration-200 lg:px-8 ${scrolled ? "shadow-glass-md" : "shadow-glass-sm"}`}>
        <div className="min-w-0">
          {/* 375px에선 두 줄이 헤더를 밀어내므로 브레드크럼을 접는다 */}
          <div className="hidden truncate text-[12px] text-muted-foreground font-semibold tracking-wide sm:block">{crumb}</div>
          <div className="truncate text-[16px] font-extrabold tracking-tight text-foreground leading-snug lg:whitespace-nowrap lg:text-[20px]">
            {pageTitle}
          </div>
        </div>

        <div className="flex-1" />

        {/* Search Button — 좁은 화면에서는 감춘다(⌘K로 계속 열 수 있다) */}
        <button
          onClick={openSearch}
          aria-haspopup="dialog"
          className="hidden items-center gap-2 bg-muted hover:bg-muted border border-transparent rounded-md min-h-11 py-[9px] px-[13px] w-[300px] min-w-[150px] shrink cursor-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:flex"
        >
          <Search size={17} className="text-muted-foreground" />
          <span className="flex-1 text-left text-sm text-muted-foreground">지원자·공고 검색</span>
          <span className="text-xs font-bold text-muted-foreground bg-white border border-border-strong rounded-md px-1.5 py-0.5 tracking-wide">
            ⌘K
          </span>
        </button>

        {/* Branch Filter (전역 스코프) */}
        {showBranchScope && (
          <Popover open={branchOpen} onOpenChange={(open) => {
            setBranchOpen(open);
            if (open) setNotifOpen(false);
          }}>
            <PopoverTrigger asChild>
              <button
                // sm 미만에서는 라벨을 감추므로 아이콘만 남는다 — 이름을 여기서 보장한다.
                aria-label={`지점 필터 — 현재 ${scopeBranch ?? "전체 지점"}`}
                className={`flex min-h-11 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border bg-white px-[14px] py-[9px] text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${scopeBranch ? "border-brand-yellow bg-yellow-50 text-foreground" : "border-border-strong text-gray-800 hover:border-gray-400"}`}
              >
                <MapPin size={16} className={scopeBranch ? "text-warning-strong" : "text-muted-foreground"} />
                <span className="hidden max-w-[140px] truncate sm:inline">{scopeBranch ?? "전체 지점"}</span>
                <ChevronDown size={14} className="text-muted-foreground" />
              </button>
            </PopoverTrigger>

            <PopoverContent
              align="end"
              sideOffset={6}
              aria-label="지점 필터"
              className="max-h-[360px] w-[220px] overflow-y-auto rounded-2xl border-border-glass bg-glass-3 p-1.5 shadow-glass-xl backdrop-blur-xl backdrop-saturate-150 scrollbar-custom"
            >
              <div className="text-xs font-bold text-muted-foreground tracking-wide px-2.5 pt-2 pb-1.5">지점 필터 — 대시보드·파이프라인에 적용</div>
              <button
                onClick={() => pickBranch(null)}
                className={`w-full flex items-center justify-between gap-2 border-0 rounded-lg py-2 px-3 text-sm cursor-pointer text-left focus-visible:outline-none focus-visible:bg-muted ${!scopeBranch ? "bg-muted font-bold text-gray-800" : "bg-transparent font-medium text-gray-700 hover:bg-muted"}`}
              >
                전체 지점 {!scopeBranch && <Check size={14} className="text-warning-strong" />}
              </button>
              {branchState === "loading" && (
                <div role="status" className="flex items-center gap-2 px-3 py-3 text-[13px] font-bold text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> 지점 불러오는 중
                </div>
              )}
              {branchState === "error" && (
                <div role="alert" className="m-1 rounded-xl border border-error/25 bg-error-soft p-3 text-xs font-bold text-error-strong">
                  <div className="flex items-start gap-2"><AlertCircle size={14} className="mt-0.5 shrink-0" /> 지점 목록을 불러오지 못했어요.</div>
                  <Button variant="secondary" size="sm" className="mt-2 w-full" onClick={() => void mutateBranches()}>다시 시도</Button>
                </div>
              )}
              {branchState === "empty" && (
                <div className="px-3 py-2 text-[13px] text-muted-foreground">등록된 지점이 없어요.</div>
              )}
              {branchState === "ready" && branches.length === 0 && (
                <div className="px-3 py-2 text-[13px] text-muted-foreground">운영 중인 지점이 없어요.</div>
              )}
              {branchState === "ready" && branches.map((b) => (
                <button
                  key={b.id}
                  onClick={() => pickBranch(b.name)}
                  className={`w-full flex items-center justify-between gap-2 border-0 rounded-lg py-2 px-3 text-sm cursor-pointer text-left focus-visible:outline-none focus-visible:bg-muted ${scopeBranch === b.name ? "bg-muted font-bold text-gray-800" : "bg-transparent font-medium text-gray-700 hover:bg-muted"}`}
                >
                  <span className="truncate">{b.name}</span>
                  {scopeBranch === b.name && <Check size={14} className="text-warning-strong shrink-0" />}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}

        {/* Notifications */}
        <Popover open={notifOpen} onOpenChange={(open) => {
          setNotifOpen(open);
          if (open) {
            setBranchOpen(false);
            loadNotices();
          }
        }}>
          <PopoverTrigger asChild>
            <button
              aria-label={notices.length > 0 ? `알림 ${notices.length}건 열기` : "알림 열기"}
              className="relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border-strong bg-white transition-colors hover:border-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Bell size={19} className="text-gray-700" />
              {notices.length > 0 && (
                <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-white bg-error px-1 text-xs font-extrabold text-white">
                  {notices.length}
                </span>
              )}
            </button>
          </PopoverTrigger>

          <PopoverContent
            align="end"
            sideOffset={6}
            aria-label="알림"
            className="w-[340px] overflow-hidden rounded-2xl border-border-glass bg-glass-3 p-0 shadow-glass-xl backdrop-blur-xl backdrop-saturate-150"
          >
              <div className="flex items-center justify-between px-4 py-3.5 border-b border-muted">
                <span className="text-sm font-bold text-foreground">알림 {notices.length > 0 && <span className="text-error">{notices.length}</span>}</span>
                <button
                  onClick={loadNotices}
                  className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RefreshCw size={12} className={notifLoading ? "animate-spin" : ""} /> 새로고침
                </button>
              </div>
              <div className="max-h-[360px] overflow-y-auto scrollbar-custom">
                {noticeState === "loading" ? (
                  <div role="status" className="flex items-center justify-center gap-2 px-4 py-10 text-[13px] font-bold text-muted-foreground">
                    <Loader2 size={16} className="animate-spin" /> 알림 불러오는 중
                  </div>
                ) : noticeState === "error" ? (
                  <div role="alert" className="flex flex-col items-center px-4 py-8 text-center">
                    <AlertCircle size={24} className="mb-2 text-error-strong" />
                    <div className="text-[13px] font-bold text-error-strong">알림을 불러오지 못했어요</div>
                    <Button variant="secondary" size="sm" className="mt-3" onClick={loadNotices}>다시 시도</Button>
                  </div>
                ) : notices.length === 0 ? (
                  <div className="flex flex-col items-center justify-center text-center py-10 px-4 text-muted-foreground">
                    <Check size={26} className="text-success mb-2" />
                    <div className="text-[13px] font-bold text-gray-700">새 알림이 없어요</div>
                    <div className="text-[12px] mt-0.5">분류·사람 확인·대량 문자 발송 확인·AI 중단이 생기면 표시됩니다.</div>
                  </div>
                ) : (
                  // 한 줄 요약만 — 설명문은 대시보드 '오늘의 할 일' 몫(같은 말을 두 번 하지 않는다)
                  notices.map((n) => {
                    const NoticeIcon = n.kind === "bulk-message" || n.kind === "bulk-message-error"
                      ? MessageSquareWarning
                      : Inbox;
                    return (
                    <button
                      key={n.id}
                      onClick={() => {
                        navigate(n.path, () => setNotifOpen(false));
                      }}
                      className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full flex items-center gap-3 px-3.5 py-2.5 border-b border-background hover:bg-background transition-colors text-left"
                    >
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${n.kind === "bulk-message-error" ? "bg-error-soft text-error-strong" : n.kind === "bulk-message" && n.tone === "red" ? "bg-priority-critical-soft text-priority-critical-ink" : n.kind === "bulk-message" ? "bg-priority-attention-soft text-priority-attention-ink" : n.tone === "red" ? "bg-error-soft text-error-strong" : n.tone === "amber" ? "bg-warning-soft text-warning-strong" : "bg-muted text-gray-700"}`}>
                        <NoticeIcon aria-hidden="true" size={14} />
                      </div>
                      <div className="flex-1 min-w-0 truncate text-[13px] font-bold text-gray-800">{n.title}</div>
                      <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
                    </button>
                    );
                  })
                )}
              </div>
              {notices.length > 0 && (
                <div className="border-t border-border-glass bg-white/45 p-2">
                  <button
                    onClick={() => {
                      navigate(notices[0].path, () => setNotifOpen(false));
                    }}
                    className="w-full flex items-center justify-center gap-1.5 rounded-2xl bg-foreground px-3 py-2 text-[13px] font-bold text-white transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    가장 급한 것부터 처리하기 <ChevronRight size={14} />
                  </button>
                </div>
              )}
          </PopoverContent>
        </Popover>

        {showCreateJobAction && <Button variant="brand" className="shrink-0 rounded-full" aria-label="공고 등록" onClick={() => navigate("/jobs?new=1")}>
          <Plus size={18} strokeWidth={2.5} />
          <span className="hidden sm:inline">공고 등록</span>
        </Button>}
        </div>
      </header>

      {/* ⌘K Global Search Modal */}
      {searchOpen && (
        <div className="fixed inset-0 bg-scrim z-50 flex items-start justify-center pt-[10vh] px-4 backdrop-blur-[3px]" onClick={closeSearch}>
          <div
            ref={searchDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="global-search-title"
            className="bg-glass-3 backdrop-blur-xl backdrop-saturate-150 border border-border-glass w-full max-w-[640px] rounded-2xl shadow-glass-xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={trapSearchFocus}
          >
            <h2 id="global-search-title" className="sr-only">지원자·공고 검색</h2>
            <div className="flex items-center gap-3 px-5 py-4 border-b border-border-strong">
              <Search size={22} className="text-muted-foreground" />
              <input
                autoFocus
                type="text"
                aria-label="검색어"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="지원자 이름·연락처 또는 공고 제목을 검색"
                className="flex-1 bg-transparent border-none outline-none text-[18px] text-foreground placeholder:text-muted-foreground font-medium"
              />
              {searching && <Loader2 size={18} className="text-muted-foreground animate-spin" />}
              <button
                onClick={closeSearch}
                className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background bg-muted hover:bg-muted text-muted-foreground text-[12px] font-bold px-2.5 py-1.5 rounded-lg transition-colors"
              >
                ESC
              </button>
            </div>
            <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {query.trim() && searching
                ? "검색 중"
                : query.trim() && !searchError
                  ? `검색 결과 ${hasResults ? results.applicants.length + results.jobs.length : 0}건`
                  : ""}
            </div>
            <div className="p-3 bg-background max-h-[50vh] overflow-y-auto scrollbar-custom">
              {!query.trim() && (
                <div className="text-center py-10 text-muted-foreground">
                  <div className="text-[13px] font-bold text-muted-foreground">지원자·공고를 검색하세요</div>
                  <div className="text-[12px] mt-1">이름, 휴대폰 번호, 공고 제목으로 찾을 수 있어요.</div>
                </div>
              )}
              {query.trim() && !searching && searchError && (
                <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center text-muted-foreground">
                  <div className="text-[13px] font-bold text-error-strong">검색 결과를 불러오지 못했어요</div>
                  <Button variant="secondary" size="sm" onClick={() => setSearchAttempt((attempt) => attempt + 1)}>다시 시도</Button>
                </div>
              )}
              {query.trim() && !searching && !searchError && !hasResults && (
                <div className="text-center py-10 text-muted-foreground">
                  <div className="text-[13px] font-bold text-muted-foreground">‘{query.trim()}’ 검색 결과가 없어요</div>
                </div>
              )}
              {resultsAreCurrent && results.applicants.length > 0 && (
                <>
                  <div className="text-[12px] font-bold text-muted-foreground px-3 pb-2 pt-1">지원자</div>
                  <div className="flex flex-col mb-2">
                    {results.applicants.map((a) => (
                      <button
                        key={`a-${a.id}`}
                        onClick={() => goApplicant(a)}
                        className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex items-center gap-3 px-3 py-2.5 hover:bg-muted rounded-2xl text-left transition-colors"
                      >
                        <div className="w-8 h-8 rounded-full bg-info-soft flex items-center justify-center shrink-0">
                          <User size={14} className="text-info-strong" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-bold text-foreground truncate">{a.name || "이름 미상"}</div>
                          <div className="text-[12px] text-muted-foreground truncate">
                            {[a.phone, a.branch, a.status].filter(Boolean).join(" · ") || "지원자"}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {resultsAreCurrent && results.jobs.length > 0 && (
                <>
                  <div className="text-[12px] font-bold text-muted-foreground px-3 pb-2 pt-1">채용공고</div>
                  <div className="flex flex-col">
                    {results.jobs.map((j) => (
                      <button
                        key={`j-${j.id}`}
                        onClick={() => goJob(j)}
                        className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex items-center gap-3 px-3 py-2.5 hover:bg-muted rounded-2xl text-left transition-colors"
                      >
                        <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
                          <FileText size={14} className="text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[14px] font-bold text-foreground truncate">{j.title}</div>
                          <div className="text-[12px] text-muted-foreground">채용공고 · {j.status === "closed" ? "마감" : "진행 중"}</div>
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
