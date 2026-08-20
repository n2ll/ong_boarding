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

  // 문자 응대·사람 확인·확정 검토·미분류 인입을 한 작업대에서 처리한다.
  // /inbox와 기존 ?tab= 딥링크는 유지하되 주요 메뉴에는 업무 목적지 하나만 노출한다.
  { path: "/live", pageTitle: "지원자 운영", crumb: "채용 운영 > 지원자 운영", nav: { label: "지원자 운영", icon: MessageSquare, dividerBefore: true } },
  { path: "/inbox", pageTitle: "지원자 운영", crumb: "채용 운영 > 지원자 운영" },
  // 자동 응대(auto) 가동으로 재노출 (2026-07-12) — AI 모드 전환·일반 라인 FAQ 편집 진입점
  { path: "/brain", pageTitle: "에이전트 두뇌", crumb: "AI 에이전트 > 에이전트 두뇌", nav: { label: "에이전트 두뇌", icon: Brain } },

  { path: "/sourcing", pageTitle: "인력 소싱", crumb: "인재 관리 > 인력 소싱" },
  { path: "/pipeline", pageTitle: "인재풀", crumb: "인재 관리 > 인재풀", nav: { label: "인재풀", icon: Users, dividerBefore: true } },
  { path: "/reengagement", pageTitle: "다시 부르기 (외부 인력)", crumb: "인재 관리 > 다시 부르기", nav: { label: "다시 부르기 (외부 인력)", icon: RefreshCw } },
  { path: "/recommendations", pageTitle: "AI 인재 추천", crumb: "인재 관리 > AI 인재 추천", nav: { label: "AI 인재 추천", icon: CheckCircle, hidden: true } },

  { path: "/jobs", pageTitle: "채용공고", crumb: "채용 운영 > 채용공고", nav: { label: "채용공고", icon: Briefcase, dividerBefore: true } },
  { path: "/shippers", pageTitle: "화주사", crumb: "채용 운영 > 화주사", nav: { label: "화주사", icon: Building2 } },
  { path: "/clients", pageTitle: "화주사", crumb: "채용 운영 > 화주사", nav: { label: "화주사 관리", icon: Building2, hidden: true } },
  { path: "/branches", pageTitle: "지점 관리", crumb: "채용 운영 > 지점 관리", nav: { label: "지점 관리", icon: MapPin, hidden: true } },
  { path: "/slots", pageTitle: "확정/희망 슬롯", crumb: "채용 운영 > 확정/희망 슬롯", nav: { label: "확정/희망 슬롯", icon: LayoutGrid, hidden: true } },
  { path: "/team", pageTitle: "팀 · 권한", crumb: "채용 운영 > 팀 · 권한", nav: { label: "팀 · 권한", icon: Shield, hidden: true } },

  { path: "/settings", pageTitle: "설정", crumb: "설정 > 환경설정" },
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

/**
 * 작업 큐가 갱신됐을 때 현재 대상을 유지하거나 다음 대상으로 이동한다.
 * 사용자가 큐 밖에서 열어 둔 상세는 건드리지 않고, 방금 큐에서 빠진 대상만 자동 진행한다.
 */
export function nextQueueApplicantId(
  previousIds: number[],
  currentIds: number[],
  selectedId: number | null,
): number | null {
  if (selectedId == null || !previousIds.includes(selectedId)) return selectedId;
  if (currentIds.includes(selectedId)) return selectedId;
  return currentIds[0] ?? null;
}
