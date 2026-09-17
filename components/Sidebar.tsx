"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { usePathname } from "next/navigation";
import { Settings, LogOut } from "lucide-react";
import { NAV_ITEMS, MANAGEMENT_NAV_ITEMS, type NavItem } from "@/lib/admin/nav";
import { mobileNavigationGridClass } from "@/lib/admin/mobile-navigation";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LogoMark } from "./Logo";
import { useAdminUnsavedNavigation } from "./AdminUnsavedNavigation";

/** 네 업무 목적지는 항상 이름을 표시한다. 좁은 데스크톱은 폭을 보존해 대화 작업대를 확보한다. */
export function Sidebar() {
  const pathname = usePathname();
  // Dashboard·LiveConsole과 같은 SWR 키를 사용해 중복 요청을 피한다.
  const { data: cpData } = useSWR<{ total?: number; pending?: unknown[] }>("/api/admin/confirm/pending", { refreshInterval: 60_000 });
  const { data: notiRes } = useSWR<{ counts?: { inbox?: number; interventions?: number } }>(
    "/api/admin/notifications", { refreshInterval: 60_000 },
  );
  const confirmPending = cpData?.total ?? cpData?.pending?.length ?? 0;
  const interventions = notiRes?.counts?.interventions ?? 0;
  const inbox = notiRes?.counts?.inbox ?? 0;
  const operationsCount = interventions + inbox + confirmPending;

  return (
    <nav aria-label="주요 메뉴" className="fixed bottom-4 left-4 top-4 z-50 hidden w-[72px] overflow-hidden rounded-[32px] glass-dark backdrop-blur-xl backdrop-saturate-150 shadow-glass-dark lg:flex wide:w-60">
      <div className="flex h-full w-full flex-col gap-4 p-2 text-white wide:p-3">
        <Link href="/" aria-label="오늘 할 일로" className="flex min-h-11 shrink-0 items-center justify-center gap-3 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring wide:justify-start">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white"><LogoMark size={26} /></span>
          <span className="hidden min-w-0 wide:block">
            <span className="block text-[16px] font-extrabold leading-none tracking-tight">옹보딩</span>
            <span className="mt-1 block text-xs text-white/60">배송 인력 운영</span>
          </span>
        </Link>
        <div className="no-scrollbar flex-1 space-y-2 overflow-y-auto py-1">
          {NAV_ITEMS.map((item) => (
            <DockItem key={item.path} item={item} active={pathname === item.path || (item.path === "/live" && pathname === "/inbox")}
              badge={item.path === "/live" && operationsCount > 0 ? { count: operationsCount, tone: interventions + inbox > 0 ? "error" : "success" } : null} />
          ))}
        </div>
        <div className="shrink-0 space-y-3 border-t border-white/10 pt-3">
          <ManagementMenu />
          <div className="hidden px-3 pb-2 text-xs text-white/60 wide:block">옹고잉 채용팀</div>
        </div>
      </div>
    </nav>
  );
}

/** 데스크톱과 같은 순서·목적지. 관리 메뉴를 포함해 5개를 유지한다. */
export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="모바일 주요 메뉴" className={`fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 right-3 z-50 grid ${mobileNavigationGridClass(NAV_ITEMS.length + 1)} rounded-2xl glass-dark backdrop-blur-xl backdrop-saturate-150 p-2 shadow-glass-dark lg:hidden`}>
      {NAV_ITEMS.map(({ label, shortLabel, icon: Icon, path }) => {
        const active = pathname === path || (path === "/live" && pathname === "/inbox");
        return (
          <Link key={path} href={path} aria-label={label} aria-current={active ? "page" : undefined}
            className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-xs font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-white text-gray-900" : "text-white/75 hover:bg-white/10 hover:text-white"}`}>
            <Icon aria-hidden="true" size={18} />
            <span className="w-full truncate text-center">{shortLabel}</span>
          </Link>
        );
      })}
      <ManagementMenu mobile />
    </nav>
  );
}

function ManagementMenu({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  const { requestNavigation } = useAdminUnsavedNavigation();
  const [open, setOpen] = useState(false);
  const firstLinkRef = useRef<HTMLAnchorElement>(null);
  const active = MANAGEMENT_NAV_ITEMS.some((item) => pathname === item.path);
  const performSignOut = async () => {
    try {
      const { getAuthBrowserClient } = await import("@/lib/supabase");
      await getAuthBrowserClient().auth.signOut();
    } catch {
      // 세션 정리에 실패해도 로그인 화면에서 다시 검증한다.
    }
    window.location.href = "/login";
  };
  const signOut = () => { void requestNavigation(performSignOut); };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="관리 메뉴" className={`flex w-full min-w-0 flex-col items-center justify-center gap-1 rounded-xl text-xs font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${mobile ? "min-h-14" : "min-h-16 wide:min-h-12 wide:flex-row wide:justify-start wide:gap-3 wide:px-3 wide:text-sm"} ${active || open ? "bg-white text-gray-900" : "text-white/75 hover:bg-white/10 hover:text-white"}`}>
          <Settings aria-hidden="true" size={18} />
          <span>관리</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side={mobile ? "top" : "right"} align="end" sideOffset={12} aria-label="관리 메뉴" onOpenAutoFocus={(event) => { event.preventDefault(); firstLinkRef.current?.focus(); }} className="w-64 rounded-2xl p-2">
        <p className="px-3 py-2 text-xs font-semibold text-muted-foreground">관리 · 설정</p>
        {MANAGEMENT_NAV_ITEMS.map(({ path, label, icon: Icon }, index) => (
          <Link key={path} ref={index === 0 ? firstLinkRef : undefined} href={path} onClick={() => setOpen(false)} aria-current={pathname === path ? "page" : undefined}
            className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring ${pathname === path ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
            <Icon aria-hidden="true" size={17} />{label}
          </Link>
        ))}
        <div className="mt-2 border-t border-border pt-2">
          <button type="button" onClick={signOut} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><LogOut aria-hidden="true" size={17} />로그아웃</button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DockItem({ item, active, badge }: {
  item: NavItem;
  active: boolean;
  badge: { count: number; tone: "error" | "success" } | null;
}) {
  const Icon = item.icon;
  return (
    <Link href={item.path} aria-label={item.label} aria-current={active ? "page" : undefined}
      className={`relative flex min-h-16 w-full min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring wide:min-h-12 wide:flex-row wide:justify-start wide:gap-3 wide:px-3 ${active ? "bg-white text-gray-900 shadow-sm" : "text-white/75 hover:bg-white/10 hover:text-white"}`}>
      <span className="relative shrink-0"><Icon aria-hidden="true" size={19} strokeWidth={active ? 2.5 : 2} /></span>
      <span className="text-xs font-bold wide:hidden">{item.shortLabel}</span>
      <span className="hidden min-w-0 flex-1 truncate text-sm font-bold wide:block">{item.label}</span>
      {badge && <span className={`absolute right-0 top-0 min-w-[17px] rounded-full px-1 text-center text-xs font-extrabold leading-[17px] text-white wide:static ${badge.tone === "error" ? "bg-error" : "bg-success-strong"}`}>{badge.count}</span>}
    </Link>
  );
}
