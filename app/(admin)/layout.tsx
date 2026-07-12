"use client";

import { usePathname } from "next/navigation";
import { SWRConfig } from "swr";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { Toaster } from "@/components/ui/sonner";
import { BranchScopeProvider } from "@/lib/branch-scope";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { jsonFetcher } from "@/lib/swr";

function resolveHeader(pathname: string): { pageTitle: string; crumb: string } {
  if (pathname.startsWith("/automation")) return { pageTitle: "자동화 현황", crumb: "개요 > 자동화 현황" };
  if (pathname.startsWith("/reports")) return { pageTitle: "리포트 · 분석", crumb: "개요 > 리포트 · 분석" };
  if (pathname.startsWith("/live")) return { pageTitle: "실시간 응대", crumb: "AI 에이전트 > 실시간 응대" };
  if (pathname.startsWith("/inbox")) return { pageTitle: "미분류 문자함", crumb: "AI 에이전트 > 미분류 문자함" };
  if (pathname.startsWith("/brain")) return { pageTitle: "에이전트 두뇌", crumb: "AI 에이전트 > 에이전트 두뇌" };
  if (pathname.startsWith("/sourcing")) return { pageTitle: "인력 소싱", crumb: "인재 관리 > 인력 소싱" };
  if (pathname.startsWith("/pipeline")) return { pageTitle: "인재풀 · 파이프라인", crumb: "인재 관리 > 인재풀 · 파이프라인" };
  if (pathname.startsWith("/recommendations")) return { pageTitle: "AI 인재 추천", crumb: "인재 관리 > AI 인재 추천" };
  if (pathname.startsWith("/jobs")) return { pageTitle: "채용공고 관리", crumb: "채용 운영 > 채용공고 관리" };
  if (pathname.startsWith("/clients")) return { pageTitle: "화주사 관리", crumb: "채용 운영 > 화주사 관리" };
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
        <div className="flex h-screen w-full overflow-hidden bg-[#EEF1F5] font-sans">
          <Sidebar />
          <div className="flex flex-col flex-1 min-w-0">
            <Topbar crumb={crumb} pageTitle={pageTitle} />
            <main className="flex-1 overflow-y-auto overflow-x-hidden relative scrollbar-custom bg-[#F7FAFC]">
              {children}
            </main>
          </div>
          <Toaster position="bottom-right" richColors />
        </div>
        </ConfirmProvider>
      </BranchScopeProvider>
    </SWRConfig>
  );
}
