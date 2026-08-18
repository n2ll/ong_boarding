"use client";

import Link from "next/link";
import useSWR from "swr";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  // 파일럿 기간 숨김 메뉴의 아이콘 — NAV_ITEMS 복원 시 함께 주석 해제
  // Activity,
  // BarChart2,
  MessageSquare,
  Inbox,
  Brain,
  Users,
  UserCheck,
  // CheckCircle,
  Briefcase,
  Building2,
  RefreshCw,
  // MapPin,
  // LayoutGrid,
  // Shield,
  Settings,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { LogoMark } from "./Logo";

/**
 * 앱 도크 — Ongboarding UI System의 셸.
 *
 * 종이 배경 위에 떠 있는 어두운 알약. 기본은 아이콘만 보이는 72px이고
 * 마우스를 올리거나 토글을 누르면 240px로 펼쳐져 라벨이 나온다.
 * MASTER.md §3 Navigation: 도크가 축소되어도 버튼의 접근 가능한 이름은
 * 유지한다(aria-label + 접힘 상태 툴팁), 현재 항목은 aria-current="page".
 */

interface NavItem {
  label: string;
  icon: LucideIcon;
  path: string;
  /** 이 항목 위에 구분선을 넣는다 (접힌 도크에서는 그룹 제목을 쓸 수 없다) */
  dividerBefore?: boolean;
}

export function Sidebar() {
  const pathname = usePathname();
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const expanded = pinned || hovered;
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

  // 파일럿 기간 숨김: 실사용 5탭(대시보드·인재풀/파이프라인·채용공고·실시간 응대·미분류 인박스)+설정만 노출.
  // 삭제 아님 — 파일럿 종료 후 복원 대비 주석 보존 (아이콘 import·aiDisabled 상태도 함께 복원)
  const NAV_ITEMS: NavItem[] = [
    { label: "대시보드", icon: LayoutDashboard, path: "/" },
    // { label: "자동화 현황", icon: Activity, path: "/automation" }, // 파일럿 기간 숨김
    // { label: "리포트 · 분석", icon: BarChart2, path: "/reports" }, // 파일럿 기간 숨김

    { label: "실시간 응대", icon: MessageSquare, path: "/live", dividerBefore: true },
    // 확정은 매니저만 하는 핵심 업무인데 '실시간 응대' 안 탭에 숨어 가장 먼 액션이었다 → 전용 진입점으로 승격.
    // 확정 대기 배지는 이 행에만 둔다(예전엔 '실시간 응대' 행에 초록 배지로 붙어, 전용 행을 만들면 같은 숫자가
    // 두 번 보였다). 색은 확정 계열 초록(confirmCount 경로) — 빨강은 이 레포에서 '미처리 경고' 색이다.
    // path에 쿼리가 있어 isActive(pathname 정확일치)에는 걸리지 않는다 — /live에선 위 '실시간 응대'가 활성 표시된다.
    { label: "확정할 지원자", icon: UserCheck, path: "/live?tab=confirm" },
    { label: "분류 대기 문자함", icon: Inbox, path: "/inbox" },
    // 자동 응대(auto) 가동으로 재노출 (2026-07-12) — AI 모드 전환·일반 라인 FAQ 편집 진입점
    { label: "에이전트 두뇌", icon: Brain, path: "/brain" },

    { label: "인재풀 · 파이프라인", icon: Users, path: "/pipeline", dividerBefore: true },
    { label: "다시 부르기 (외부 인력)", icon: RefreshCw, path: "/reengagement" },
    // { label: "AI 인재 추천", icon: CheckCircle, path: "/recommendations" }, // 파일럿 기간 숨김

    { label: "채용공고 관리", icon: Briefcase, path: "/jobs", dividerBefore: true },
    { label: "화주사", icon: Building2, path: "/shippers" },
    // { label: "화주사 관리", icon: Building2, path: "/clients" }, // 파일럿 기간 숨김
    // { label: "지점 관리", icon: MapPin, path: "/branches" }, // 파일럿 기간 숨김
    // { label: "확정/희망 슬롯", icon: LayoutGrid, path: "/slots" }, // 파일럿 기간 숨김
    // { label: "팀 · 권한", icon: Shield, path: "/team" }, // 파일럿 기간 숨김
  ];

  const badgeFor = (path: string): { count: number; tone: "error" | "success" } | null => {
    if (path === "/live" && interventions > 0) return { count: interventions, tone: "error" };
    if (path === "/inbox" && inbox > 0) return { count: inbox, tone: "error" };
    if (path === "/live?tab=confirm" && confirmPending > 0) return { count: confirmPending, tone: "success" };
    return null;
  };

  const signOut = async () => {
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

  return (
    /*
      폭 전환을 CSS transition으로 한다(예전엔 framer-motion spring).
      이 파일이 motion을 import하는 유일한 레이아웃 컴포넌트였고, 그 때문에 framer-motion
      123KB가 **레이아웃 청크**에 들려 모든 어드민 화면의 첫 로드를 막았다. 대시보드·
      파이프라인·공고는 자기 파일에서 motion을 직접 쓰므로 그대로지만, 실시간 응대는
      쓰지 않아 이 화면에서 통째로 빠진다(가장 무거웠던 화면이다).

      느낌 차이: spring의 미세한 오버슈트가 없어지고 200ms 감속 곡선으로 펼쳐진다.
      motion-reduce에서는 즉시 전환한다.
    */
    <nav
      aria-label="주요 메뉴"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`fixed bottom-4 left-4 top-4 z-50 hidden overflow-hidden rounded-[32px] glass-dark backdrop-blur-xl backdrop-saturate-150 shadow-[var(--shadow-glass-dark)] transition-[width] duration-200 ease-out motion-reduce:transition-none lg:flex ${
        expanded ? "w-60" : "w-[72px]"
      }`}
    >
      <div className="flex h-full w-full flex-col gap-2 p-3 text-white">
        <button
          type="button"
          aria-label={pinned ? "메뉴 접기" : "메뉴 펼치기"}
          aria-expanded={expanded}
          onClick={() => setPinned((v) => !v)}
          className="mb-1 flex min-h-11 shrink-0 items-center gap-3 rounded-2xl px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white">
            <LogoMark size={26} />
          </span>
          {expanded && (
            <span className="min-w-0 animate-in fade-in duration-200 motion-reduce:animate-none">
              <span className="block whitespace-nowrap text-[16px] font-extrabold leading-none tracking-tight">옹보딩</span>
              <span className="mt-[3px] block whitespace-nowrap text-[11px] font-medium tracking-wide text-white/50">시니어 채용 운영</span>
            </span>
          )}
        </button>

        <div className="no-scrollbar flex-1 space-y-1.5 overflow-y-auto pb-2 pr-1">
          {NAV_ITEMS.map((item) => (
            <div key={item.path}>
              {item.dividerBefore && <div aria-hidden="true" className="my-3 h-px w-full bg-white/10" />}
              <DockItem
                item={item}
                expanded={expanded}
                active={pathname === item.path}
                badge={badgeFor(item.path)}
              />
            </div>
          ))}
        </div>

        <div className="mt-auto shrink-0 space-y-1.5 border-t border-white/10 pt-2">
          <DockItem
            item={{ label: "설정", icon: Settings, path: "/settings" }}
            expanded={expanded}
            active={pathname === "/settings"}
            badge={null}
          />

          {/* 중립 표기 프로필 — 특정 개인 하드코딩 대신 팀 계정. 로그아웃(I-2 Supabase Auth) */}
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-dark text-[16px] font-bold text-brand-yellow">
              옹
            </span>
            {expanded && (
              <div className="flex min-w-0 flex-1 items-center gap-1 animate-in fade-in duration-200 motion-reduce:animate-none">
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
            )}
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
  { label: "응대", icon: MessageSquare, path: "/live" },
  { label: "인재풀", icon: Users, path: "/pipeline" },
  { label: "공고", icon: Briefcase, path: "/jobs" },
  { label: "설정", icon: Settings, path: "/settings" },
];

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="모바일 주요 메뉴"
      className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 right-3 z-50 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 rounded-xl glass-dark backdrop-blur-xl backdrop-saturate-150 p-2 shadow-[var(--shadow-glass-dark)] lg:hidden"
    >
      {MOBILE_NAV.map(({ label, icon: Icon, path }) => {
        const active = pathname === path;
        return (
          <Link
            key={path}
            href={path}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-2xl px-1 text-[11px] font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
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
  expanded,
  active,
  badge,
}: {
  item: NavItem;
  expanded: boolean;
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
          active ? "bg-white text-gray-900 shadow-[var(--shadow-md)]" : "text-white/60 hover:bg-white/10 hover:text-white"
        }`}
      >
        <span className="relative flex h-11 w-11 shrink-0 items-center justify-center">
          <Icon aria-hidden="true" size={18} strokeWidth={active ? 2.5 : 2} />
          {/* 접힌 도크에는 라벨이 없으므로 배지를 아이콘 위에 얹는다.
              숫자를 글자로 같이 보여 색만으로 전달하지 않는다(MASTER.md §1). */}
          {badge && !expanded && (
            <span
              className={`absolute right-0 top-0 min-w-[17px] rounded-full px-[4px] text-[11px] font-extrabold leading-[17px] text-white ${
                badge.tone === "error" ? "bg-error" : "bg-success-strong"
              }`}
            >
              {badge.count}
            </span>
          )}
        </span>

        {expanded && (
          <span className="flex min-w-0 flex-1 items-center gap-2 animate-in fade-in slide-in-from-left-1 duration-200 motion-reduce:animate-none">
            <span className="min-w-0 flex-1 truncate text-left text-[14px] font-bold">{item.label}</span>
            {badge && (
              <span
                className={`shrink-0 rounded-full px-[7px] py-[1px] text-[11px] font-extrabold tracking-tight text-white ${
                  badge.tone === "error" ? "bg-error" : "bg-success-strong"
                }`}
              >
                {badge.count}
              </span>
            )}
          </span>
        )}
      </Link>

      {!expanded && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-[58px] top-1/2 z-50 -translate-x-2 -translate-y-1/2 whitespace-nowrap rounded-xl border border-white/10 bg-gray-900 px-3 py-2 text-xs font-bold text-white opacity-0 shadow-[var(--shadow-md)] transition-all group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100"
        >
          {item.label}
        </span>
      )}
    </div>
  );
}
