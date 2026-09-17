import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart2,
  Brain,
  Briefcase,
  Building2,
  CheckCircle,
  LayoutDashboard,
  LayoutGrid,
  MapPin,
  MessageSquare,
  RefreshCw,
  Shield,
  Settings,
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
 * - nav가 없으면 메뉴에 안 뜨는 화면(제목 매핑만). hidden은 기존 숨김 경로를 유지한다.
 * - group: management는 보조 관리 메뉴. 주 메뉴는 모집 흐름 순으로 4개만 노출한다.
 * - navOnly는 독 전용 바로가기(쿼리 포함 href) — 헤더 매칭에서 제외된다.
 */
export interface ScreenDef {
  path: string;
  pageTitle: string;
  crumb: string;
  navOnly?: boolean;
  nav?: { label: string; shortLabel?: string; icon: LucideIcon; group?: "management"; dividerBefore?: boolean; hidden?: boolean };
}

export const SCREENS: ScreenDef[] = [
  { path: "/", pageTitle: "오늘 할 일", crumb: "개요 > 오늘 할 일", nav: { label: "오늘 할 일", shortLabel: "오늘", icon: LayoutDashboard } },
  { path: "/jobs", pageTitle: "모집", crumb: "채용 운영 > 모집", nav: { label: "모집", shortLabel: "모집", icon: Briefcase } },
  { path: "/automation", pageTitle: "자동화 현황", crumb: "개요 > 자동화 현황", nav: { label: "자동화 현황", icon: Activity, hidden: true } },
  { path: "/reports", pageTitle: "리포트 · 분석", crumb: "개요 > 리포트 · 분석", nav: { label: "리포트 · 분석", icon: BarChart2, hidden: true } },

  // 문자 응대·사람 확인·확정 검토·미분류 인입을 한 작업대에서 처리한다.
  // /inbox와 기존 ?tab= 딥링크는 유지하되 주요 메뉴에는 업무 목적지 하나만 노출한다.
  { path: "/live", pageTitle: "지원자 대화", crumb: "채용 운영 > 지원자 대화", nav: { label: "지원자 대화", shortLabel: "대화", icon: MessageSquare } },
  { path: "/inbox", pageTitle: "지원자 대화", crumb: "채용 운영 > 지원자 대화" },
  // 자동 응대(auto) 가동으로 재노출 (2026-07-12) — AI 모드 전환·일반 라인 FAQ 편집 진입점
  { path: "/brain", pageTitle: "AI 응대 설정", crumb: "관리 > AI 응대 설정", nav: { label: "AI 응대 설정", icon: Brain, group: "management" } },

  { path: "/sourcing", pageTitle: "인력 소싱", crumb: "인재 관리 > 인력 소싱" },
  { path: "/pipeline", pageTitle: "인력풀", crumb: "인재 관리 > 인력풀", nav: { label: "인력풀", shortLabel: "인력풀", icon: Users } },
  { path: "/reengagement", pageTitle: "다시 부르기 (외부 인력)", crumb: "인재 관리 > 다시 부르기", nav: { label: "외부 인력 다시 연락", icon: RefreshCw, group: "management" } },
  { path: "/recommendations", pageTitle: "AI 인재 추천", crumb: "인재 관리 > AI 인재 추천", nav: { label: "AI 인재 추천", icon: CheckCircle, hidden: true } },

  { path: "/shippers", pageTitle: "화주사", crumb: "채용 운영 > 화주사", nav: { label: "화주사", icon: Building2, group: "management" } },
  { path: "/clients", pageTitle: "화주사", crumb: "채용 운영 > 화주사", nav: { label: "화주사 관리", icon: Building2, hidden: true } },
  { path: "/branches", pageTitle: "지점 관리", crumb: "채용 운영 > 지점 관리", nav: { label: "지점 관리", icon: MapPin, hidden: true } },
  { path: "/slots", pageTitle: "확정/희망 슬롯", crumb: "채용 운영 > 확정/희망 슬롯", nav: { label: "확정/희망 슬롯", icon: LayoutGrid, hidden: true } },
  { path: "/team", pageTitle: "팀 · 권한", crumb: "채용 운영 > 팀 · 권한", nav: { label: "팀 · 권한", icon: Shield, hidden: true } },

  { path: "/settings", pageTitle: "설정", crumb: "설정 > 환경설정", nav: { label: "환경설정", icon: Settings, group: "management" } },
];

export function resolveHeader(pathname: string): { pageTitle: string; crumb: string } {
  const hit = SCREENS.find((s) => !s.navOnly && s.path !== "/" && pathname.startsWith(s.path));
  const screen = hit ?? SCREENS[0];
  return { pageTitle: screen.pageTitle, crumb: screen.crumb };
}

export type PipelineView = "list" | "kanban" | "map" | "funnel";

export const PIPELINE_STATUS_FILTERS = ["스크리닝 전", "대기자", "스크리닝 중", "스크리닝 완료", "확정인력"] as const;
export const PIPELINE_AVAILABILITY_FILTERS = ["즉시가능", "이번주가능", "휴면", "미확인"] as const;

export function pipelineCoreFiltersFromSearch(currentSearch = ""): {
  statuses: string[];
  availability: string[];
} {
  const params = new URLSearchParams(currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch);
  const allowedStatuses = new Set<string>(PIPELINE_STATUS_FILTERS);
  const allowedAvailability = new Set<string>(PIPELINE_AVAILABILITY_FILTERS);
  const read = (key: string, allowed: Set<string>) => [
    ...new Set((params.get(key) ?? "").split(",").map((value) => value.trim()).filter((value) => allowed.has(value))),
  ];
  return {
    statuses: read("status", allowedStatuses),
    availability: read("availability", allowedAvailability),
  };
}

export function pipelineCoreFilterHref(
  currentSearch: string,
  statuses: string[],
  availability: string[],
): string {
  const params = new URLSearchParams(currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch);
  if (statuses.length > 0) params.set("status", statuses.join(","));
  else params.delete("status");
  if (availability.length > 0) params.set("availability", availability.join(","));
  else params.delete("availability");
  const query = params.toString();
  return query ? `/pipeline?${query}` : "/pipeline";
}

export function pipelineCoreFilterPatchHref(
  currentSearch: string,
  patch: { statuses?: string[]; availability?: string[] },
): string {
  const current = pipelineCoreFiltersFromSearch(currentSearch);
  return pipelineCoreFilterHref(
    currentSearch,
    patch.statuses ?? current.statuses,
    patch.availability ?? current.availability,
  );
}

export function pipelineViewFromSearch(currentSearch = ""): PipelineView {
  const params = new URLSearchParams(currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch);
  const view = params.get("view");
  return view === "kanban" || view === "map" || view === "funnel" ? view : "list";
}

/** 인재풀 보기 전환을 공유·새로고침 가능한 URL로 만든다. 기본 목록은 불필요한 쿼리를 남기지 않는다. */
export function pipelineViewHref(view: PipelineView, currentSearch = ""): string {
  const params = new URLSearchParams(currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch);
  if (view === "list") params.delete("view");
  else params.set("view", view);
  const query = params.toString();
  return query ? `/pipeline?${query}` : "/pipeline";
}

export interface NavItem {
  label: string;
  shortLabel?: string;
  icon: LucideIcon;
  path: string;
  dividerBefore?: boolean;
}

/** 데스크톱·모바일 공통: 일상 업무 4개, 드물게 사용하는 관리 화면은 별도 메뉴. */
function navigationItems(group?: "management"): NavItem[] {
  return SCREENS.filter((screen) => screen.nav && !screen.nav.hidden && screen.nav.group === group)
    .map((screen) => ({ ...screen.nav!, path: screen.path }));
}
export const NAV_ITEMS = navigationItems();
export const MANAGEMENT_NAV_ITEMS = navigationItems("management");

/**
 * 작업 큐가 갱신됐을 때 현재 대상을 유지하거나 다음 대상으로 이동한다.
 * 사용자가 큐 밖에서 열어 둔 상세는 건드리지 않고, 방금 큐에서 빠진 대상만 자동 진행한다.
 */
export function nextQueueApplicantId(
  previousIds: number[],
  currentIds: number[],
  selectedId: number | null,
): number | null {
  if (selectedId == null) return selectedId;
  const selectedIndex = previousIds.indexOf(selectedId);
  if (selectedIndex < 0) return selectedId;
  if (currentIds.includes(selectedId)) return selectedId;

  const currentSet = new Set(currentIds);
  for (let index = selectedIndex + 1; index < previousIds.length; index += 1) {
    if (currentSet.has(previousIds[index])) return previousIds[index];
  }
  for (let index = selectedIndex - 1; index >= 0; index -= 1) {
    if (currentSet.has(previousIds[index])) return previousIds[index];
  }
  return currentIds[0] ?? null;
}
