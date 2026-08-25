"use client";

import Link from "next/link";
import useSWR from "swr";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  Briefcase,
  Settings,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { NAV_ITEMS, type NavItem } from "@/lib/admin/nav";
import { mobileNavigationGridClass } from "@/lib/admin/mobile-navigation";
import { LogoMark } from "./Logo";
import { useAdminUnsavedNavigation } from "./AdminUnsavedNavigation";

/**
 * 앱 도크 — Ongboarding UI System의 셸.
 *
 * 종이 배경 위에 떠 있는 어두운 내비게이션. 1440px 이상은 240px 고정 라벨,
 * 작은 데스크톱(LG~1439px)은 72px 아이콘 레일로 공간을 보존한다. 마우스 호버에 폭이 바뀌지 않아
 * 작업 중인 목록·대화·상세 레이아웃이 흔들리지 않는다.
 */

export function Sidebar() {
  const pathname = usePathname();
  const { requestNavigation } = useAdminUnsavedNavigation();
  // 확정 대기 큐 건수 — useSWR로 Dashboard·LiveConsole과 캐시 공유(중복 폴링 방지). 소스=confirm/pending.
  const { data: cpData } = useSWR<{ total?: number; pending?: unknown[] }>("/api/admin/confirm/pending", { refreshInterval: 60_000 });
  const confirmPending = cpData?.total ?? cpData?.pending?.length ?? 0;
  // const [aiDisabled, setAiDisabled] = useState(false); // 파일럿 기간 숨김('자동화 현황' 배지 전용) — 복원 시 주석 해제

  // 헤더 알림과 동일 소스(/notifications). raw fetch로 따로 폴링하면 SWR dedup을 못 타서
  // 대시보드에서 같은 요청이 3번 나갔다 — 같은 키의 useSWR로 캐시를 공유한다.
  const { data: notiRes } = useSWR<{ counts?: { inbox?: number; interventions?: number; aiDisabled?: boolean } }>(
    "/api/admin/notifications",
    { refreshInterval: 60_000 }
  );
  const inbox = notiRes?.counts?.inbox ?? 0;
  const interventions = notiRes?.counts?.interventions ?? 0;

  // 메뉴 목록·제목 맵의 단일 소스는 lib/admin/nav.ts — 화면 추가는 그 파일 한 줄이다.

  const badgeFor = (path: string): { count: number; tone: "error" | "success" } | null => {
    const operationsCount = interventions + inbox + confirmPending;
    if (path === "/live" && operationsCount > 0) {
      return { count: operationsCount, tone: interventions + inbox > 0 ? "error" : "success" };
    }
    return null;
  };

  const performSignOut = async () => {
    try {
      // Supabase 클라이언트를 누를 때 받아온다.
      // 사이드바는 모든 어드민 화면에 붙어 있는데 정적 import면 로그아웃 버튼 하나 때문에
      // auth·realtime·storage·postgrest(64KB)가 전 화면 첫 로드에 얹힌다.
      // 로그아웃은 하루에 한 번 누르는 버튼이다.
      const { getAuthBrowserClient } = await import("@/lib/supabase");
      await getAuthBrowserClient().auth.signOut();
    } catch {
      /* 세션 정리 실패해도 로그인 페이지로 — 미들웨어가 재검증 */
    }
    window.location.href = "/login";
  };

  const signOut = () => {
    void requestNavigation(performSignOut);
  };

  return (
    /*
      1440px 이상에서는 라벨을 항상 보여 업무 목적지를 바로 읽게 한다. 1024~1439px는
      아이콘 레일을 유지해 3열 작업대 폭을 확보한다. 1280px에서 라벨과 상세패널이 동시에
      확장돼 작업영역이 오히려 좁아지던 단절을 피한다.
    */
    <nav
      aria-label="주요 메뉴"
      className="fixed bottom-4 left-4 top-4 z-50 hidden w-[72px] overflow-hidden rounded-[32px] glass-dark backdrop-blur-xl backdrop-saturate-150 shadow-glass-dark lg:flex wide:w-60"
    >
      <div className="flex h-full w-full flex-col gap-2 p-3 text-white">
        <Link
          href="/"
          aria-label="대시보드로"
          className="mb-1 flex min-h-11 shrink-0 items-center gap-3 rounded-2xl px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white">
            <LogoMark size={26} />
          </span>
          <span className="hidden min-w-0 wide:block">
              <span className="block whitespace-nowrap text-[16px] font-extrabold leading-none tracking-tight">옹보딩</span>
              <span className="mt-[3px] block whitespace-nowrap text-xs font-medium tracking-wide text-white/50">시니어 채용 운영</span>
          </span>
        </Link>

        <div className="no-scrollbar flex-1 space-y-1.5 overflow-y-auto pb-2 pr-1">
          {NAV_ITEMS.map((item) => (
            <div key={item.path}>
              {item.dividerBefore && <div aria-hidden="true" className="my-3 h-px w-full bg-white/10" />}
              <DockItem
                item={item}
                active={pathname === item.path}
                badge={badgeFor(item.path)}
              />
            </div>
          ))}
        </div>

        <div className="mt-auto shrink-0 space-y-1.5 border-t border-white/10 pt-2">
          <DockItem
            item={{ label: "설정", icon: Settings, path: "/settings" }}
            active={pathname === "/settings"}
            badge={null}
          />

          {/* 중립 표기 프로필 — 특정 개인 하드코딩 대신 팀 계정. 로그아웃(I-2 Supabase Auth) */}
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-dark text-[16px] font-bold text-brand-yellow">
              옹
            </span>
            <div className="hidden min-w-0 flex-1 items-center gap-1 wide:flex">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold leading-tight">옹고잉 채용팀</span>
                  <span className="block truncate text-[12px] text-white/50">관리자 콘솔</span>
                </span>
                <button
                  type="button"
                  onClick={signOut}
                  aria-label="로그아웃"
                  title="로그아웃"
                  className="after:absolute after:-inset-2 after:content-[''] relative shrink-0 rounded-lg p-2 text-white/50 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <LogOut size={16} />
                </button>
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}

/**
 * 모바일 하단 내비 — MASTER.md §3: 모바일은 5개 이하.
 * 도크 전체를 좁은 화면에 밀어 넣지 않고, 실사용 빈도 순 5개만 남긴다.
 */
const MOBILE_NAV: { label: string; icon: LucideIcon; path: string }[] = [
  { label: "대시보드", icon: LayoutDashboard, path: "/" },
  { label: "지원자 운영", icon: MessageSquare, path: "/live" },
  { label: "인재풀", icon: Users, path: "/pipeline" },
  { label: "공고", icon: Briefcase, path: "/jobs" },
  { label: "설정", icon: Settings, path: "/settings" },
];

export function MobileNav() {
  const pathname = usePathname();
  const gridClass = mobileNavigationGridClass(MOBILE_NAV.length);
  return (
    <nav
      aria-label="모바일 주요 메뉴"
      className={`fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 right-3 z-50 grid ${gridClass} rounded-2xl glass-dark backdrop-blur-xl backdrop-saturate-150 p-2 shadow-glass-dark lg:hidden`}
    >
      {MOBILE_NAV.map(({ label, icon: Icon, path }) => {
        const active = pathname === path;
        return (
          <Link
            key={path}
            href={path}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-2xl px-1 text-xs font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
              active ? "bg-white text-gray-900" : "text-white/55 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Icon aria-hidden="true" size={18} />
            <span className="w-full truncate text-center">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function DockItem({
  item,
  active,
  badge,
}: {
  item: NavItem;
  active: boolean;
  badge: { count: number; tone: "error" | "success" } | null;
}) {
  const Icon = item.icon;
  return (
    <div className="group relative flex items-center">
      {/* 행 전체가 링크 하나다. 접힘/펼침에 따라 라벨만 붙고 떨어진다 —
          링크를 둘로 쪼개면 같은 목적지가 탭 순서에 두 번 걸린다. */}
      <Link
        href={item.path}
        aria-label={item.label}
        aria-current={active ? "page" : undefined}
        className={`relative z-10 flex min-h-11 w-full min-w-0 items-center gap-3 rounded-2xl pr-2 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring ${
          active ? "bg-white text-gray-900 shadow-md" : "text-white/60 hover:bg-white/10 hover:text-white"
        }`}
      >
        <span className="relative flex h-11 w-11 shrink-0 items-center justify-center">
          <Icon aria-hidden="true" size={18} strokeWidth={active ? 2.5 : 2} />
          {/* 접힌 도크에는 라벨이 없으므로 배지를 아이콘 위에 얹는다.
              숫자를 글자로 같이 보여 색만으로 전달하지 않는다(MASTER.md §1). */}
          {badge && (
            <span
              className={`absolute right-0 top-0 min-w-[17px] rounded-full px-[4px] text-xs font-extrabold leading-[17px] text-white wide:hidden ${
                badge.tone === "error" ? "bg-error" : "bg-success-strong"
              }`}
            >
              {badge.count}
            </span>
          )}
        </span>

        <span className="hidden min-w-0 flex-1 items-center gap-2 wide:flex">
            <span className="min-w-0 flex-1 truncate text-left text-[14px] font-bold">{item.label}</span>
            {badge && (
              <span
                className={`shrink-0 rounded-full px-[7px] py-[1px] text-xs font-extrabold tracking-tight text-white ${
                  badge.tone === "error" ? "bg-error" : "bg-success-strong"
                }`}
              >
                {badge.count}
              </span>
            )}
        </span>
      </Link>

      <span
        role="tooltip"
        className="pointer-events-none absolute left-[58px] top-1/2 z-50 -translate-x-2 -translate-y-1/2 whitespace-nowrap rounded-2xl border border-white/10 bg-gray-900 px-3 py-2 text-xs font-bold text-white opacity-0 shadow-md transition-all group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100 wide:hidden"
      >
        {item.label}
      </span>
    </div>
  );
}
