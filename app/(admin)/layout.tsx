"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { Toaster } from "@/components/ui/sonner";
import { ChatWidget } from "@/components/ChatWidget";

function resolveHeader(pathname: string): { pageTitle: string; crumb: string } {
  if (pathname.startsWith("/automation")) return { pageTitle: "자동화 현황", crumb: "개요 > 자동화 현황" };
  if (pathname.startsWith("/reports")) return { pageTitle: "리포트 · 분석", crumb: "개요 > 리포트 · 분석" };
  if (pathname.startsWith("/live")) return { pageTitle: "실시간 응대", crumb: "AI 에이전트 > 실시간 응대" };
  if (pathname.startsWith("/brain")) return { pageTitle: "에이전트 두뇌", crumb: "AI 에이전트 > 에이전트 두뇌" };
  if (pathname.startsWith("/sourcing")) return { pageTitle: "인력 소싱", crumb: "인재 관리 > 인력 소싱" };
  if (pathname.startsWith("/pipeline")) return { pageTitle: "인재풀 · 파이프라인", crumb: "인재 관리 > 인재풀 · 파이프라인" };
  if (pathname.startsWith("/recommendations")) return { pageTitle: "AI 인재 추천", crumb: "인재 관리 > AI 인재 추천" };
  if (pathname.startsWith("/jobs")) return { pageTitle: "채용공고 관리", crumb: "채용 운영 > 채용공고 관리" };
  if (pathname.startsWith("/clients")) return { pageTitle: "화주사 관리", crumb: "채용 운영 > 화주사 관리" };
  if (pathname.startsWith("/branches")) return { pageTitle: "지점 관리", crumb: "채용 운영 > 지점 관리" };
  if (pathname.startsWith("/team")) return { pageTitle: "팀 · 권한", crumb: "채용 운영 > 팀 · 권한" };
  if (pathname.startsWith("/settings")) return { pageTitle: "설정", crumb: "설정 > 환경설정" };
  return { pageTitle: "대시보드", crumb: "개요 > 대시보드" };
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { pageTitle, crumb } = resolveHeader(pathname);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#EEF1F5] font-sans">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <Topbar crumb={crumb} pageTitle={pageTitle} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden relative scrollbar-custom">
          {children}
        </main>
      </div>
      <Toaster position="bottom-right" richColors />
      <ChatWidget />
    </div>
  );
}
