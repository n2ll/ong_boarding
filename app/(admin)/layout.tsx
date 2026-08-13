"use client";

import { usePathname } from "next/navigation";
import { SWRConfig } from "swr";
import { Sidebar, MobileNav } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { Toaster } from "@/components/ui/sonner";
import { BranchScopeProvider } from "@/lib/branch-scope";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { jsonFetcher } from "@/lib/swr";

function resolveHeader(pathname: string): { pageTitle: string; crumb: string } {
  if (pathname.startsWith("/automation")) return { pageTitle: "자동화 현황", crumb: "개요 > 자동화 현황" };
  if (pathname.startsWith("/reports")) return { pageTitle: "리포트 · 분석", crumb: "개요 > 리포트 · 분석" };
  if (pathname.startsWith("/live")) return { pageTitle: "실시간 응대", crumb: "AI 에이전트 > 실시간 응대" };
  if (pathname.startsWith("/inbox")) return { pageTitle: "분류 대기 문자함", crumb: "AI 에이전트 > 분류 대기 문자함" };
  if (pathname.startsWith("/brain")) return { pageTitle: "에이전트 두뇌", crumb: "AI 에이전트 > 에이전트 두뇌" };
  if (pathname.startsWith("/sourcing")) return { pageTitle: "인력 소싱", crumb: "인재 관리 > 인력 소싱" };
  if (pathname.startsWith("/pipeline")) return { pageTitle: "인재풀 · 파이프라인", crumb: "인재 관리 > 인재풀 · 파이프라인" };
  if (pathname.startsWith("/recommendations")) return { pageTitle: "AI 인재 추천", crumb: "인재 관리 > AI 인재 추천" };
  if (pathname.startsWith("/jobs")) return { pageTitle: "채용공고 관리", crumb: "채용 운영 > 채용공고 관리" };
  // /shippers = 합쳐진 화주사 화면(공고용 목록 + 계약 원본). 매핑이 없어 상단 제목이 '대시보드'로 뜨던 문제.
  if (pathname.startsWith("/shippers")) return { pageTitle: "화주사", crumb: "채용 운영 > 화주사" };
  if (pathname.startsWith("/clients")) return { pageTitle: "화주사", crumb: "채용 운영 > 화주사" };
  if (pathname.startsWith("/branches")) return { pageTitle: "지점 관리", crumb: "채용 운영 > 지점 관리" };
  if (pathname.startsWith("/slots")) return { pageTitle: "확정/희망 슬롯", crumb: "채용 운영 > 확정/희망 슬롯" };
  if (pathname.startsWith("/team")) return { pageTitle: "팀 · 권한", crumb: "채용 운영 > 팀 · 권한" };
  if (pathname.startsWith("/settings")) return { pageTitle: "설정", crumb: "설정 > 환경설정" };
  return { pageTitle: "대시보드", crumb: "개요 > 대시보드" };
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { pageTitle, crumb } = resolveHeader(pathname);

  return (
    <SWRConfig
      value={{
        fetcher: jsonFetcher,
        // 탭 재방문 시 이전 데이터를 즉시 보여주고 백그라운드에서 갱신
        keepPreviousData: true,
        // 짧은 시간 내 동일 키 요청은 1회로 병합 (대시보드/파이프라인 동시 호출 dedup)
        dedupingInterval: 5000,
        revalidateOnFocus: false,
      }}
    >
      <BranchScopeProvider>
        <ConfirmProvider>
        {/*
          Ongboarding UI System 셸 — 종이 배경 위에 도크·헤더·본문이 떠 있다.
          도크는 fixed라 본문이 lg:ml-[92px]로 자리를 비켜준다.
          모바일(lg 미만)은 하단 내비가 가리므로 본문 아래에 safe-area만큼 여백을 준다.
        */}
        <div className="relative flex h-[100dvh] w-full overflow-hidden bg-background font-sans">
          <a
            href="#app-content"
            className="fixed left-4 top-3 z-[200] -translate-y-20 rounded-xl bg-foreground px-4 py-3 text-sm font-bold text-white shadow-[var(--shadow-xl)] transition-transform focus:translate-y-0"
          >
            본문으로 건너뛰기
          </a>

          <Sidebar />

          <div className="flex h-[100dvh] w-full min-w-0 flex-col px-3 pb-[calc(5.25rem+env(safe-area-inset-bottom))] lg:ml-[92px] lg:w-[calc(100%-92px)] lg:px-0 lg:pb-4 lg:pr-4">
            <Topbar crumb={crumb} pageTitle={pageTitle} />
            <main
              id="app-content"
              tabIndex={-1}
              className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden rounded-[24px] scrollbar-custom"
            >
              {children}
            </main>
          </div>

          <MobileNav />
          <Toaster position="bottom-right" richColors />
        </div>
        </ConfirmProvider>
      </BranchScopeProvider>
    </SWRConfig>
  );
}
