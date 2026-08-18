import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart2,
  Brain,
  Briefcase,
  Building2,
  CheckCircle,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  MapPin,
  MessageSquare,
  RefreshCw,
  Shield,
  UserCheck,
  Users,
} from "lucide-react";

/**
 * 화면 등록부 — 탑바 제목·크럼(resolveHeader)과 독 메뉴(NAV_ITEMS)의 단일 소스.
 *
 * 예전엔 layout.tsx의 헤더 맵과 Sidebar.tsx의 NAV_ITEMS가 별개 목록이라, 화면을
 * 추가할 때 한쪽을 빠뜨리면 상단 제목이 조용히 '대시보드'로 떨어졌다(/shippers,
 * /reengagement에서 같은 버그가 두 번). 이제 화면 추가는 여기 한 줄이다.
 *
 * - 배열 순서 = 독 메뉴 순서. 경로가 서로 prefix 관계가 아니므로 매칭 순서와도 안전.
 * - nav가 없으면 독에 안 뜨는 화면(제목 매핑만). hidden = 파일럿 기간 숨김: 실사용 5탭+설정만
 *   노출(2026-07 탭 다이어트). 삭제 아님 — 복원은 플래그 제거 한 줄.
 * - navOnly는 독 전용 바로가기(쿼리 포함 href) — 헤더 매칭에서 제외된다.
 */
export interface ScreenDef {
  path: string;
  pageTitle: string;
  crumb: string;
  navOnly?: boolean;
  nav?: { label: string; icon: LucideIcon; dividerBefore?: boolean; hidden?: boolean };
}

export const SCREENS: ScreenDef[] = [
  { path: "/", pageTitle: "대시보드", crumb: "개요 > 대시보드", nav: { label: "대시보드", icon: LayoutDashboard } },
  { path: "/automation", pageTitle: "자동화 현황", crumb: "개요 > 자동화 현황", nav: { label: "자동화 현황", icon: Activity, hidden: true } },
  { path: "/reports", pageTitle: "리포트 · 분석", crumb: "개요 > 리포트 · 분석", nav: { label: "리포트 · 분석", icon: BarChart2, hidden: true } },

  { path: "/live", pageTitle: "실시간 응대", crumb: "AI 에이전트 > 실시간 응대", nav: { label: "실시간 응대", icon: MessageSquare, dividerBefore: true } },
  // 확정은 매니저만 하는 핵심 업무인데 '실시간 응대' 안 탭에 숨어 가장 먼 액션이었다 → 전용 진입점으로 승격.
  // path에 쿼리가 있어 활성 표시(pathname 정확일치)에는 걸리지 않는다 — /live에선 위 행이 활성.
  { path: "/live?tab=confirm", pageTitle: "실시간 응대", crumb: "AI 에이전트 > 실시간 응대", navOnly: true, nav: { label: "확정할 지원자", icon: UserCheck } },
  { path: "/inbox", pageTitle: "분류 대기 문자함", crumb: "AI 에이전트 > 분류 대기 문자함", nav: { label: "분류 대기 문자함", icon: Inbox } },
  // 자동 응대(auto) 가동으로 재노출 (2026-07-12) — AI 모드 전환·일반 라인 FAQ 편집 진입점
  { path: "/brain", pageTitle: "에이전트 두뇌", crumb: "AI 에이전트 > 에이전트 두뇌", nav: { label: "에이전트 두뇌", icon: Brain } },

  { path: "/sourcing", pageTitle: "인력 소싱", crumb: "인재 관리 > 인력 소싱" },
  { path: "/pipeline", pageTitle: "인재풀 · 파이프라인", crumb: "인재 관리 > 인재풀 · 파이프라인", nav: { label: "인재풀 · 파이프라인", icon: Users, dividerBefore: true } },
  { path: "/reengagement", pageTitle: "다시 부르기 (외부 인력)", crumb: "인재 관리 > 다시 부르기", nav: { label: "다시 부르기 (외부 인력)", icon: RefreshCw } },
  { path: "/recommendations", pageTitle: "AI 인재 추천", crumb: "인재 관리 > AI 인재 추천", nav: { label: "AI 인재 추천", icon: CheckCircle, hidden: true } },

  { path: "/jobs", pageTitle: "채용공고 관리", crumb: "채용 운영 > 채용공고 관리", nav: { label: "채용공고 관리", icon: Briefcase, dividerBefore: true } },
  { path: "/shippers", pageTitle: "화주사", crumb: "채용 운영 > 화주사", nav: { label: "화주사", icon: Building2 } },
  { path: "/clients", pageTitle: "화주사", crumb: "채용 운영 > 화주사", nav: { label: "화주사 관리", icon: Building2, hidden: true } },
  { path: "/branches", pageTitle: "지점 관리", crumb: "채용 운영 > 지점 관리", nav: { label: "지점 관리", icon: MapPin, hidden: true } },
  { path: "/slots", pageTitle: "확정/희망 슬롯", crumb: "채용 운영 > 확정/희망 슬롯", nav: { label: "확정/희망 슬롯", icon: LayoutGrid, hidden: true } },
  { path: "/team", pageTitle: "팀 · 권한", crumb: "채용 운영 > 팀 · 권한", nav: { label: "팀 · 권한", icon: Shield, hidden: true } },

  { path: "/settings", pageTitle: "설정", crumb: "설정 > 환경설정" },
];

export function resolveHeader(pathname: string): { pageTitle: string; crumb: string } {
  const hit = SCREENS.find((s) => !s.navOnly && s.path !== "/" && pathname.startsWith(s.path));
  return hit ?? SCREENS[0];
}

export interface NavItem {
  label: string;
  icon: LucideIcon;
  path: string;
  dividerBefore?: boolean;
}

/** 독 메뉴 — SCREENS에서 파생(hidden 제외). 순서는 SCREENS 배열 그대로. */
export const NAV_ITEMS: NavItem[] = SCREENS.filter((s) => s.nav && !s.nav.hidden).map((s) => ({
  label: s.nav!.label,
  icon: s.nav!.icon,
  path: s.path,
  dividerBefore: s.nav!.dividerBefore,
}));
