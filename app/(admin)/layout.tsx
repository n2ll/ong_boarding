"use client";

import { usePathname } from "next/navigation";
import { SWRConfig } from "swr";
import { Sidebar, MobileNav } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { Toaster } from "@/components/ui/sonner";
import { BranchScopeProvider } from "@/lib/branch-scope";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { jsonFetcher } from "@/lib/swr";
import { resolveHeader } from "@/lib/admin/nav";


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
          도크는 fixed라 본문이 LG에서 104px, XL에서 272px 자리를 비켜준다.
          모바일(lg 미만)은 하단 내비가 가리므로 본문 아래에 safe-area만큼 여백을 준다.
        */}
        {/*
          여기에 bg-background(불투명)를 두면 안 된다. body에 이식해 둔 종이 질감
          — 좌상단 옐로 워시 · 우하단 코랄 워시 · 32px 흰 격자 — 을 통째로 덮어서
          제품 어디서도 보이지 않았다. 유리 면(도크·헤더·모달·패널)이 흐릴 대상이
          없으니 블러도 효과가 없었고, "라이브러리를 흉내만 냈다"는 인상의 원인이었다.
          배경색은 body가 칠한다.
        */}
        <div className="relative flex h-[100dvh] w-full overflow-hidden font-sans">
          <a
            href="#app-content"
            className="fixed left-4 top-3 z-[200] -translate-y-20 rounded-2xl bg-foreground px-4 py-3 text-sm font-bold text-white shadow-xl transition-transform focus:translate-y-0"
          >
            본문으로 건너뛰기
          </a>

          <Sidebar />

          <div className="flex h-[100dvh] w-full min-w-0 flex-col px-3 pb-[calc(5.25rem+env(safe-area-inset-bottom))] lg:ml-[104px] lg:w-[calc(100%-104px)] lg:px-0 lg:pb-4 lg:pr-4 xl:ml-[272px] xl:w-[calc(100%-272px)]">
            <Topbar crumb={crumb} pageTitle={pageTitle} />
            <main
              id="app-content"
              tabIndex={-1}
              className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden rounded-2xl scrollbar-custom"
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
