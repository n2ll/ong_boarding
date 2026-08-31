import { ArrowRight, Users, MousePointerClick, CheckCircle2, Activity, PhoneCall, ClipboardCheck, Smartphone, TrendingUp, ChevronRight, ChevronDown, MapPin, AlertTriangle, RefreshCw, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { motion } from "motion/react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from "recharts";
import { useBranchScope, matchesBranchScope } from "@/lib/branch-scope";
import { Skeleton } from "@/components/ui/skeleton";
import { SosLedgerCard } from "@/components/SosLedgerCard";
import { InterestQueueCard } from "@/components/InterestQueueCard";
import { ReplyQueueCard, type ReplyQueueCounts } from "@/components/ReplyQueueCard";
import { CampaignStatsCard } from "@/components/CampaignStatsCard";
import { PageShell } from "@/components/ui/page-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { remoteSourcesState } from "@/lib/admin/remote-data-state";
import { dashboardGatewayPresentation, dashboardUrgencyLabel, isDashboardPrimaryPriority, orderDashboardUrgentItems, type DashboardUrgency } from "@/lib/admin/dashboard-priority";
import { dashboardQueueStatus } from "@/lib/admin/dashboard-queue-status";
import {
  dashboardMetricTiles,
  dashboardMetricsState,
  type DashboardMetricTile,
  type DashboardMetricTone,
} from "@/lib/admin/dashboard-metrics";
import {
  agentModePresentation,
  agentModeView,
  type AdminAgentModeResponse,
} from "@/lib/admin/agent-mode-view";

interface UrgentItem {
  id: string;
  urgency: DashboardUrgency;
  ageMinutes?: number | null;
  priorityLabel?: string;
  title: string;
  desc: string;
  cta: string;
  path?: string;
  action?: "retry-heartbeat";
}

interface AppRow {
  status: string;
  created_at: string;
  branch?: string | null;
  branch1?: string | null;
  confirmed_branch?: string | null;
  agent_stage?: string | null;
  guide_sent?: boolean | null;
  baemin_id?: string | null;
  uses_bmart_flow?: boolean;
  onboarding_call_status?: string | null;
  sigungu?: string | null;
  sido?: string | null;
  airtable_record_id?: string | null;
}

interface SosOpenRow {
  id: number;
  created_at: string;
}

interface HeartbeatRow {
  device_id: string;
  last_seen_at: string | null;
  pending_count: number;
}

const METRIC_ICONS: Record<DashboardMetricTile["id"], LucideIcon> = {
  today: Users,
  screening: MousePointerClick,
  screeningComplete: ClipboardCheck,
  confirmed: CheckCircle2,
};

const METRIC_TONE_STYLES: Record<DashboardMetricTone, {
  surface: string;
  border: string;
  ink: string;
}> = {
  exploration: {
    surface: "bg-stage-exploration-soft",
    border: "border-stage-exploration-ink/15",
    ink: "text-stage-exploration-ink",
  },
  screening: {
    surface: "bg-stage-screening-soft",
    border: "border-stage-screening-ink/15",
    ink: "text-stage-screening-ink",
  },
  onboarding: {
    surface: "bg-stage-onboarding-soft",
    border: "border-stage-onboarding-ink/15",
    ink: "text-stage-onboarding-ink",
  },
  active: {
    surface: "bg-stage-active-soft",
    border: "border-stage-active-ink/15",
    ink: "text-stage-active-ink",
  },
};

function DashboardMetricTileView({ metric }: { metric: DashboardMetricTile }) {
  const Icon = METRIC_ICONS[metric.id];
  const tone = METRIC_TONE_STYLES[metric.tone];

  return (
    <div className={`flex min-h-[132px] min-w-0 flex-col rounded-2xl border p-4 ${tone.surface} ${tone.border}`}>
      <dt className="flex items-start justify-between gap-3 text-[13px] font-semibold leading-5 text-muted-foreground">
        <span>{metric.label}</span>
        <Icon aria-hidden="true" size={17} className={`mt-0.5 shrink-0 ${tone.ink}`} />
      </dt>
      <dd className="mt-4 flex flex-1 flex-col">
        <span className="flex items-baseline gap-1">
          <span className={`text-[30px] font-bold leading-none tabular-nums tracking-tight ${tone.ink}`}>
            {metric.value.toLocaleString()}
          </span>
          <span className="text-[13px] font-semibold text-muted-foreground">{metric.unit}</span>
        </span>
        <span className="mt-auto pt-2 text-[12px] leading-4 text-muted-foreground">{metric.description}</span>
      </dd>
    </div>
  );
}

export function Dashboard() {
  const router = useRouter();
  const { branch: scopeBranch } = useBranchScope();
  // 지원자 목록은 파이프라인과 동일 키라 SWR이 중복 호출을 dedup하고, 탭 재방문 시 캐시를 즉시 보여준다.
  // scope=dashboard — 이 화면과 답장 큐(ReplyQueueCard)가 읽는 17컬럼+조립 2개만 받는 응답
  // (gzip 67KB → 29KB, 랜딩 화면 + 60초 폴링이라 절감이 반복된다). ReplyQueueCard와
  // **반드시 같은 키**여야 한다 — 키가 갈라지면 그쪽이 기본 응답을 또 받고, 답장 큐의
  // mutate()가 이 화면 통계를 같이 갱신하는 동작(같은 캐시)도 깨진다.
  const { data: appsRes, isLoading, isValidating: isAppsValidating, error: appsError, mutate: mutateApps } = useSWR<{ data?: AppRow[] }>("/api/admin/applicants?scope=dashboard", { refreshInterval: 60_000 }); // 살아있는 갱신
  const { data: inboxRes, error: inboxError, mutate: mutateInbox } = useSWR<{ data?: { created_at?: string | null }[] }>("/api/admin/inbox/pending", { refreshInterval: 60_000 });
  // 헤더 벨·사이드바 배지와 동일 소스 — 사람 확인 필요(paused)·AI 전역 중단 카운트
  const { data: notiRes, error: notiError, mutate: mutateNoti } = useSWR<{ counts?: { inbox: number; interventions: number; aiDisabled: boolean; inbox_oldest_days?: number | null; interventions_oldest_days?: number | null } }>("/api/admin/notifications");
  // 확정 대기 큐(스크리닝 완료·미확정) — 사이드바 배지·LiveConsole '확정 대기' 탭과 동일 소스. '오늘의 할 일'에 합류(주제 C1 발견성).
  const { data: confirmRes, error: confirmError, mutate: mutateConfirm } = useSWR<{ total?: number; pending?: { created_at?: string | null }[] }>("/api/admin/confirm/pending", { refreshInterval: 60_000 });
  // SosLedgerCard와 동일 키라 SWR이 중복 호출을 dedup — 진행 중 긴급 건을 '오늘의 할 일'에 합류
  const { data: sosRes, error: sosError, mutate: mutateSos } = useSWR<{ open?: SosOpenRow[] }>("/api/admin/sos");
  // SMS 게이트웨이(법인폰) 하트비트 — last_seen_at 내림차순 응답이라 [0]이 최신 기기
  const { data: hbRes, error: hbError, isValidating: heartbeatValidating, mutate: mutateHeartbeat } = useSWR<{ data?: HeartbeatRow[] }>("/api/admin/heartbeat", { refreshInterval: 60_000 });
  // InterestQueueCard와 동일 키라 SWR이 dedup — 관심 표시 처리 대기 건수를 '오늘의 할 일'에 합류
  const { data: interestRes, error: interestError, mutate: mutateInterest } = useSWR<{ count?: number; immediate_count?: number; items?: { interested_at?: string | null }[] }>("/api/admin/interest-queue", { refreshInterval: 30_000 });
  // AI 응답 모드(자동/코파일럿/완전 중지) — LiveConsole·에이전트 두뇌와 동일 키라 SWR이 dedup.
  // 처음 보는 매니저도 '지금 AI가 답하고 있는지'를 헤더 한 줄로 알 수 있게 상시 노출한다.
  const {
    data: killRes,
    error: killError,
    isValidating: killValidating,
    mutate: mutateKillMode,
  } = useSWR<AdminAgentModeResponse>("/api/admin/agent/kill-switch", { refreshInterval: 30_000 });
  const globalAgentMode = agentModeView({ data: killRes, error: killError });
  const agentModeCopy = agentModePresentation(globalAgentMode);
  // 답장 큐는 마지막 메시지 방향까지 확인돼야 건수가 확정된다. 로딩/실패를 0건으로
  // 축약하지 않고 '오늘의 할 일' 전체 readiness에 포함한다.
  const [replyCounts, setReplyCounts] = useState<ReplyQueueCounts>({
    state: "loading",
    total: 0,
    untouched: 0,
    oldestDays: null,
  });
  const [replyRetrySignal, setReplyRetrySignal] = useState(0);
  const handleReplyCounts = useCallback((next: ReplyQueueCounts) => {
    setReplyCounts((previous) => (
      previous.state === next.state
      && previous.total === next.total
      && previous.untouched === next.untouched
      && previous.oldestDays === next.oldestDays
        ? previous
        : next
    ));
  }, []);
  const urgentSourcesState = remoteSourcesState({
    applicants: { data: appsRes?.data, error: appsError },
    inbox: { data: inboxRes?.data, error: inboxError },
    notifications: { data: notiRes?.counts, error: notiError },
    confirmations: { data: confirmRes, error: confirmError },
    sos: { data: sosRes?.open, error: sosError },
    interest: { data: interestRes, error: interestError },
    heartbeat: { data: hbRes, error: hbError },
    replies: {
      data: replyCounts.state === "ready" ? replyCounts : undefined,
      error: replyCounts.state === "error" ? true : undefined,
    },
  });
  const queueStatus = dashboardQueueStatus(urgentSourcesState);
  const queueStatusTone = {
    success: { dot: "bg-success", text: "text-white/65" },
    warning: { dot: "bg-warning", text: "text-warning-on-dark" },
    error: { dot: "bg-error", text: "text-error-on-dark" },
  }[queueStatus.tone];
  const urgentSourceLabels: Record<string, string> = {
    applicants: "지원자 목록",
    inbox: "문자 분류",
    notifications: "사람 확인 필요",
    confirmations: "확정 검토",
    sos: "긴급 건",
    interest: "관심 표시",
    heartbeat: "문자 발송폰",
    replies: "답장 대기",
  };
  const retryUrgentSources = () => {
    setReplyRetrySignal((signal) => signal + 1);
    void Promise.all([mutateApps(), mutateInbox(), mutateNoti(), mutateConfirm(), mutateSos(), mutateInterest(), mutateHeartbeat()]);
  };
  const rawApps = appsRes?.data ?? [];
  const hasAppsSnapshot = appsRes?.data !== undefined;
  const metricsState = dashboardMetricsState({
    hasSnapshot: hasAppsSnapshot,
    hasError: Boolean(appsError),
  });
  const inboxCount = inboxRes?.data?.length ?? 0;
  // 캐시된 이전 데이터 없이 첫 로딩 중일 때만 스켈레톤 노출
  const showSkeleton = isLoading && rawApps.length === 0;

  // 최근 동기화 — SWR 응답을 받은 시각을 기록해 하드코딩('방금 전') 대신 실제 상대시간을 표시한다.
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  useEffect(() => {
    if (appsRes) setSyncedAt(Date.now());
  }, [appsRes]);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const syncLabel = useMemo(() => {
    if (!syncedAt) return "대기 중";
    const min = Math.floor(Math.max(0, nowTick - syncedAt) / 60_000);
    if (min < 1) return "방금 전";
    if (min < 60) return `${min}분 전`;
    return `${Math.floor(min / 60)}시간 전`;
  }, [syncedAt, nowTick]);

  const branchOf = (a: AppRow) => a.confirmed_branch || a.branch1 || a.branch || null;
  const apps = useMemo(
    () => rawApps.filter((a) => matchesBranchScope(branchOf(a), scopeBranch)),
    [rawApps, scopeBranch]
  );

  // Airtable 일괄 임포트분(airtable_record_id 보유)은 유입 시점이 인입 시각이 아니라
  // 임포트 시각이므로 '신규 유입(금일)'·14일 추이 집계를 오염시킨다 → 유입 지표에서만 제외
  const liveApps = useMemo(() => apps.filter((a) => !a.airtable_record_id), [apps]);

  const stats = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const by = (s: string) => apps.filter((a) => a.status === s).length;
    return {
      today: liveApps.filter((a) => (a.created_at ?? "").slice(0, 10) === todayStr).length,
      screening: by("스크리닝 중"),
      interview: by("스크리닝 완료"),
      passed: by("확정인력"),
      total: apps.length,
    };
  }, [apps, liveApps]);
  const metricTiles = dashboardMetricTiles({
    today: stats.today,
    screening: stats.screening,
    screeningComplete: stats.interview,
    confirmed: stats.passed,
  });

  // 최근 14일 일별 신규 유입 추이 (created_at 기준, stats.today와 동일하게 UTC 일자 슬라이스 · 임포트 제외)
  const trend = useMemo(() => {
    const days: { key: string; label: string; 유입: number }[] = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, 유입: 0 });
    }
    const idx = new Map(days.map((d, i) => [d.key, i]));
    for (const a of liveApps) {
      const i = idx.get((a.created_at ?? "").slice(0, 10));
      if (i !== undefined) days[i].유입 += 1;
    }
    return days;
  }, [liveApps]);

  const trend7Sum = useMemo(() => trend.slice(7).reduce((s, d) => s + d.유입, 0), [trend]);

  // 단계 간 전환율을 강조한 가로형 단계별 현황
  const funnel = useMemo(() => {
    const screened = stats.screening + stats.interview + stats.passed;
    const passed1 = stats.interview + stats.passed;
    const rows = [
      { step: "다채널 유입", val: stats.total, color: "var(--stage-exploration-ink)" },
      { step: "AI 스크리닝", val: screened, color: "var(--stage-screening-ink)" },
      { step: "1차 요건 통과", val: passed1, color: "var(--stage-onboarding-ink)" },
      { step: "확정 인력", val: stats.passed, color: "var(--stage-active-ink)" },
    ];
    return rows.map((r, i) => {
      const prev = i === 0 ? r.val : rows[i - 1].val;
      return {
        ...r,
        pctTotal: stats.total ? Math.round((r.val / stats.total) * 100) : 0,
        conv: i === 0 ? null : prev ? Math.round((r.val / prev) * 100) : 0,
      };
    });
  }, [stats]);

  // 스크리닝·온보딩 현황 요약
  const flow = useMemo(() => {
    const stage = (s: string) => apps.filter((a) => a.agent_stage === s).length;
    // 온보딩 대상 = 온보딩/활성 단계이거나 확정인력
    const onboardingTargets = apps.filter(
      (a) => a.agent_stage === "onboarding" || a.agent_stage === "active" || a.status === "확정인력"
    );
    const t = onboardingTargets.length || 1;
    // 배민 ID는 배민 커넥트 라인 전용 단계 — 실제 화주사 유형 또는 시스템 공고가 비마트 흐름인 대상만 센다.
    const baeminTargets = onboardingTargets.filter((a) => a.uses_bmart_flow === true);
    const bt = baeminTargets.length || 1;
    return {
      exploration: stage("exploration"),
      screening: stage("screening"),
      onboarding: stage("onboarding"),
      active: stage("active"),
      targets: onboardingTargets.length,
      guideSent: onboardingTargets.filter((a) => a.guide_sent).length,
      baeminId: baeminTargets.filter((a) => (a.baemin_id ?? "").trim()).length,
      baeminTargets: baeminTargets.length,
      called: onboardingTargets.filter((a) => (a.onboarding_call_status ?? "").includes("완료")).length,
      pct: (n: number) => Math.round((n / t) * 100),
      pctBaemin: (n: number) => Math.round((n / bt) * 100),
    };
  }, [apps]);

  // 지역(시/군/구)별 인재풀 분포 Top 5. 시군구가 없으면 시도(구 미상)로, 둘 다 없으면 '주소 미입력'으로 집계.
  // 깊은 탐색은 파이프라인 지도 뷰에서. (PipelineMap의 분포 계산과 동일 규칙)
  const regionDist = useMemo(() => {
    const counts = new Map<string, number>();
    let unknown = 0;
    for (const a of apps) {
      const sig = a.sigungu?.trim();
      const sido = a.sido?.trim();
      if (sig) counts.set(sig, (counts.get(sig) ?? 0) + 1);
      else if (sido) {
        const k = `${sido} (구 미상)`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      } else unknown++;
    }
    const top = Array.from(counts.entries())
      .map(([region, count]) => ({ region, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    return { top, unknownCount: unknown, max: top[0]?.count ?? 1 };
  }, [apps]);

  // /notifications counts(사람 확인 필요·AI 중단)와 /sos open(진행 중 긴급 건) 기반
  const notiCounts = notiRes?.counts;
  const sosOpen = sosRes?.open ?? [];
  // '내가 답할 차례' 건수는 아래 ReplyQueueCard가 계산해 올려준다.
  // (예전엔 여기서 unread_count>0으로 셌다. 그 값은 '스레드를 아직 열지 않았다'는 뜻이라 열람만으로 0이 되고,
  //  실데이터에서도 전원 0이어서 이 항목이 뜬 적이 없다. 판정은 '마지막 메시지가 inbound' 한 가지로 통일하고,
  //  공식을 두 곳에 두면 어긋나므로 큐 카드 한 곳에서만 계산한다.)
  const poolReplies = replyCounts.state === "ready" ? replyCounts.untouched : 0;
  const interestCount = interestRes?.count ?? 0;
  const interestImmediate = interestRes?.immediate_count ?? 0;
  const confirmPendingCount = confirmRes?.total ?? confirmRes?.pending?.length ?? 0;
  const gateway = useMemo(
    () => dashboardGatewayPresentation({ response: hbRes, error: hbError, now: nowTick }),
    [hbError, hbRes, nowTick],
  );
  const urgent = useMemo(() => {
    const u: UrgentItem[] = [];
    const elapsedMinutes = (iso: string | null | undefined) =>
      iso ? Math.max(0, Math.floor((nowTick - new Date(iso).getTime()) / 60_000)) : null;
    const dayCount = (minutes: number | null) => minutes === null ? null : Math.floor(minutes / 1_440);
    const AGE_CRITICAL_MINUTES = 7 * 1_440;
    const urgencyFor = (minutes: number | null): DashboardUrgency =>
      (minutes ?? 0) >= AGE_CRITICAL_MINUTES ? "critical" : "attention";
    const suffix = (minutes: number | null) => {
      const days = dayCount(minutes);
      return (days ?? 0) >= 1 ? ` · 최장 ${days}일` : "";
    };
    if (notiCounts?.aiDisabled) {
      u.push({ id: "ai-off", urgency: "blocker", ageMinutes: null, title: "AI 자동응대가 중단된 상태예요", desc: "전역 응답 스위치가 꺼져 있어 신규 인입에 자동 응대하지 않습니다.", cta: "자동화 현황으로", path: "/automation" });
    }
    if (gateway?.urgent) {
      u.push({
        id: "sms-gateway",
        urgency: gateway.urgent.urgency,
        ageMinutes: gateway.urgent.ageMinutes,
        title: gateway.urgent.title,
        desc: gateway.urgent.desc,
        cta: "상태 다시 확인",
        action: "retry-heartbeat",
      });
    }
    if (sosOpen.length > 0) {
      const oldest = Math.min(...sosOpen.map((s) => new Date(s.created_at).getTime()));
      const min = Math.max(0, Math.floor((nowTick - oldest) / 60_000));
      const elapsed = min < 60 ? `${min}분` : `${Math.floor(min / 60)}시간`;
      u.push({ id: "sos", urgency: "blocker", ageMinutes: min, title: `진행 중 긴급 건 ${sosOpen.length}건 · 최장 ${elapsed} 경과`, desc: "결원·증차 긴급 건이 해결 대기 중이에요.", cta: "긴급 건 기록으로", path: "#sos-ledger" });
    }
    if (interestCount > 0) {
      const oldest = elapsedMinutes(
        (interestRes?.items ?? []).reduce<string | null>((min, it) => {
          const t = it.interested_at ?? null;
          return t && (!min || t < min) ? t : min;
        }, null)
      );
      u.push({
        id: "interest-queue",
        urgency: interestImmediate > 0 ? "critical" : urgencyFor(oldest),
        ageMinutes: oldest,
        priorityLabel: interestImmediate > 0 ? "우선 처리" : undefined,
        title: `관심 표시 처리 대기 ${interestCount}건${interestImmediate > 0 ? ` (바로가능 ${interestImmediate}건)` : ""}${suffix(oldest)}`,
        desc: "맞춤 공고 링크에서 관심을 누른 후보가 연락을 기다리고 있어요.",
        cta: "관심 표시 처리로",
        path: "#interest-queue",
      });
    }
    if (inboxCount > 0) {
      const oldest = elapsedMinutes(
        (inboxRes?.data ?? []).reduce<string | null>((min, it) => {
          const t = it.created_at ?? null;
          return t && (!min || t < min) ? t : min;
        }, null)
      ) ?? (notiCounts?.inbox_oldest_days === null || notiCounts?.inbox_oldest_days === undefined ? null : notiCounts.inbox_oldest_days * 1_440);
      u.push({ id: "inbox", urgency: urgencyFor(oldest), ageMinutes: oldest, title: `분류가 필요한 문자 ${inboxCount}건${suffix(oldest)}`, desc: "지원자·기존 계약자 문의·기타 메시지로 정리해야 하는 수신 문자가 있어요.", cta: "지원자 운영에서 분류", path: "/live?tab=inbox" });
    }
    if ((notiCounts?.interventions ?? 0) > 0) {
      const oldest = notiCounts?.interventions_oldest_days === null || notiCounts?.interventions_oldest_days === undefined ? null : notiCounts.interventions_oldest_days * 1_440;
      // 목적 탭으로 딥링크 — 예전엔 둘 다 '전체' 탭으로 떨어져 매니저가 탭을 다시 찾아야 했다.
      u.push({ id: "live", urgency: urgencyFor(oldest), ageMinutes: oldest, title: `사람 확인 필요 ${notiCounts!.interventions}건${suffix(oldest)}`, desc: "AI가 답을 멈추고 넘긴 대화예요. 매니저가 직접 확인해 답해야 합니다.", cta: "지원자 운영으로", path: "/live?tab=intervention" });
    }
    if (confirmPendingCount > 0) {
      const oldest = elapsedMinutes(confirmRes?.pending?.[0]?.created_at ?? null); // 라우트가 오래된 순 정렬
      u.push({ id: "confirm-pending", urgency: urgencyFor(oldest), ageMinutes: oldest, title: `확정 검토 ${confirmPendingCount}명${suffix(oldest)}`, desc: "스크리닝을 마친 인력이에요. 매니저가 투입 여부와 조건을 검토해야 합니다.", cta: "확정 검토로", path: "/live?tab=confirm" });
    }
    if (poolReplies > 0) {
      const oldest = replyCounts.oldestDays === null || replyCounts.oldestDays === undefined ? null : replyCounts.oldestDays * 1_440;
      u.push({ id: "pool-reply", urgency: urgencyFor(oldest), ageMinutes: oldest, title: `내가 답할 차례 ${poolReplies}건${suffix(oldest)}`, desc: "문자 답장이 왔는데 아직 아무도 답하지 않았어요. AI가 넘긴 대화('사람 확인 필요')와는 별개예요.", cta: "답장 큐로", path: "#reply-queue" });
    }
    return orderDashboardUrgentItems(u);
  }, [notiCounts, gateway, sosOpen, inboxRes, inboxCount, poolReplies, replyCounts.oldestDays, interestRes, interestCount, interestImmediate, confirmRes, confirmPendingCount, nowTick]);

  const openUrgentItem = (item: UrgentItem) => {
    if (item.action === "retry-heartbeat") {
      void mutateHeartbeat();
      return;
    }
    if (!item.path) return;
    if (item.path.startsWith("#")) {
      document.getElementById(item.path.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      router.push(item.path);
    }
  };

  const aiModeTone = agentModeCopy.kind === "error" || agentModeCopy.kind === "off"
    ? "text-error-on-dark"
    : agentModeCopy.kind === "stale"
      ? "text-warning-on-dark"
      : agentModeCopy.kind === "draft"
        ? "text-copilot-on-dark"
        : agentModeCopy.kind === "auto"
          ? "text-success-on-dark"
          : "text-white/65";
  const aiModeDot = agentModeCopy.kind === "off"
    ? "bg-error"
    : agentModeCopy.kind === "draft"
      ? "bg-copilot"
      : agentModeCopy.kind === "auto"
        ? "bg-success"
        : agentModeCopy.kind === "stale"
          ? "bg-warning"
          : "bg-muted-foreground";

  // '지표 · 분석' 접이식 섹션 — 기본 접힘. 첫 화면은 '지금 할 일'이 스크롤 없이 보이는 게 목표.
  const [metricsOpen, setMetricsOpen] = useState(false);

  if (showSkeleton) return <DashboardSkeleton />;

  // [&>*]:shrink-0 — flex 세로 스택에서 내용이 화면보다 길어지면 flex가 자식의 높이를
  // 뺏어 눌러버린다. overflow-hidden인 카드는 눌린 만큼 내용이 그냥 사라진다.
  // 실제로 아래 다크 히어로가 352px 잘려 제목 한 줄만 남아 있었고(운영 상태·문자
  // 발송폰 표시가 전부 안 보였다), '지표 · 분석' 카드도 53px 잘렸다.
  // 배경색도 여기서 칠하지 않는다 — body의 종이 질감을 덮는다.
  return (
    <PageShell className="min-h-full">
      {/* 상단 헤더 — 제목 + 운영 상태 한 줄(동기화·AI 응답 모드·문자 발송폰). KPI 숫자는 아래 '지표 · 분석'으로 이동 */}
      <motion.div initial={{ opacity: 0, scale: 0.99 }} animate={{ opacity: 1, scale: 1 }} className="relative overflow-hidden rounded-panel border border-white/10 bg-foreground px-5 py-5 text-white sm:px-6 lg:px-8 lg:py-6">
        <div className="pointer-events-none absolute inset-y-0 right-0 w-40 bg-gradient-to-l from-brand-yellow/10 to-transparent" />

        <div className="relative z-10 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="mb-1 text-[20px] font-bold tracking-tight">
              {scopeBranch ? `${scopeBranch} · 오늘의 채용 운영` : "오늘의 채용 운영"}
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-white/65">
              {/* 지원자 한 소스가 아니라 오늘의 업무 큐 전체 상태. 색상과 문구를 함께 바꾼다. */}
              <span
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className={`flex items-center gap-1.5 ${queueStatusTone.text}`}
              >
                <span aria-hidden="true" className={`h-2 w-2 rounded-full ${queueStatusTone.dot}`} />
                {queueStatus.label}
              </span>
              <span>지원자 목록 갱신: {syncLabel}</span>
              <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                title="AI 응답 모드 — 변경은 지원자 운영 화면 상단 배너 또는 에이전트 두뇌에서"
                className={`flex min-w-0 items-center gap-1.5 ${aiModeTone}`}
              >
                {agentModeCopy.kind === "loading" ? (
                  <RefreshCw aria-hidden="true" size={12} className="shrink-0 animate-spin motion-reduce:animate-none" />
                ) : agentModeCopy.kind === "error" || agentModeCopy.kind === "stale" ? (
                  <AlertTriangle aria-hidden="true" size={12} className="shrink-0" />
                ) : (
                  <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${aiModeDot}`} />
                )}
                <span className="min-w-0">
                  {agentModeCopy.label}{agentModeCopy.detail ? ` · ${agentModeCopy.detail}` : ""}
                </span>
                {agentModeCopy.canRetry && (
                  <button
                    type="button"
                    onClick={() => void mutateKillMode()}
                    disabled={killValidating}
                    className="-my-1 flex min-h-8 shrink-0 items-center rounded px-2 font-bold underline underline-offset-2 outline-none disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-white/50"
                  >
                    {killValidating ? "확인 중" : "다시 시도"}
                  </button>
                )}
              </div>
              {gateway && (
                <span
                  title="문자를 실제로 보내고 받는 법인폰 상태예요. 신호가 10분 이상 없으면 문자 수·발신이 멈췄을 수 있어요."
                  className={`flex items-center gap-1.5 ${gateway.tone === "blocker" ? "text-error-on-dark" : gateway.tone === "attention" ? "text-warning-on-dark" : "text-white/75"}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${gateway.tone === "blocker" ? "bg-error animate-pulse" : gateway.tone === "attention" ? "bg-warning" : "bg-success"}`}></span>
                  {gateway.label}
                </span>
              )}
            </div>
          </div>
          <button type="button" onClick={() => router.push('/pipeline')} className="flex min-h-10 items-center gap-2 whitespace-nowrap rounded-lg border border-white/15 bg-white/10 px-3.5 text-[13px] font-semibold transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
            인재풀 보기 <ArrowRight size={14} />
          </button>
        </div>
      </motion.div>

      {/* 오늘의 할 일 — 첫 화면 최상단(전폭). 유입 추이 차트는 아래 '지표 · 분석'으로 이동 */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="flex flex-col rounded-panel border border-border-strong bg-card p-5 lg:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <h2 className="text-[16px] font-bold text-foreground flex items-center gap-2">
              오늘의 할 일
              {urgentSourcesState.state === "ready" && urgent.length > 0 && <Badge className="tabular-nums">업무 유형 {urgent.length}개</Badge>}
              {urgentSourcesState.state !== "ready" && <Badge>{urgentSourcesState.state === "error" ? "일부 확인 불가" : "확인 중"}</Badge>}
            </h2>
            {/* 목록과 동일한 우선순위 정렬의 첫 항목을 연다. 차단 상태 우선, 같은 단계는 최장 대기 순. */}
            {urgent.length > 0 && isDashboardPrimaryPriority(urgentSourcesState.state, 0) && (
              <Button
                size="sm"
                variant="primary"
                className="rounded-lg shadow-none hover:translate-y-0"
                title={urgent[0].action === "retry-heartbeat" ? "문자 발송폰 연결 상태를 다시 확인합니다" : "운영 차단을 먼저, 같은 단계에서는 가장 오래 기다린 업무를 엽니다"}
                isLoading={urgent[0].action === "retry-heartbeat" && heartbeatValidating}
                onClick={() => {
                  const t = urgent[0];
                  openUrgentItem(t);
                }}
              >
                {urgent[0].action === "retry-heartbeat" ? "문자폰 상태 다시 확인" : <>우선순위 1번 열기 <ChevronRight size={15} /></>}
              </Button>
            )}
          </div>

          <div className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3 [&>*]:shrink-0">
            {urgentSourcesState.state === "loading" && (
              <div className="flex items-center gap-2 rounded-lg border border-border-strong bg-background p-4 text-[13px] font-medium text-muted-foreground lg:col-span-2 xl:col-span-3">
                <RefreshCw size={15} className="animate-spin" /> 업무 큐를 모두 확인하는 중이에요…
              </div>
            )}
            {urgentSourcesState.state === "error" && (
              <div role="alert" className="rounded-lg border border-error/30 bg-error-soft p-4 text-error-strong lg:col-span-2 xl:col-span-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-1.5 text-[14px] font-bold"><AlertTriangle size={15} /> 일부 업무 큐를 확인하지 못했어요</div>
                    <div className="mt-1 text-[12px]">확인 불가: {urgentSourcesState.failed.map((source) => urgentSourceLabels[source] ?? source).join(" · ")}. 긴급 항목이 0건이라는 뜻이 아닙니다.</div>
                  </div>
                  <Button variant="ghost" size="chip" onClick={retryUrgentSources} className="border border-error/30 bg-card text-error-strong hover:bg-error-soft">
                    <RefreshCw size={14} /> 다시 시도
                  </Button>
                </div>
              </div>
            )}
            {urgentSourcesState.state === "ready" && urgent.length === 0 && (
              <div className="flex flex-1 flex-col items-center justify-center py-4 text-center lg:col-span-2 xl:col-span-3">
                <CheckCircle2 size={28} className="text-success mb-2" />
                <div className="text-[13px] font-bold text-gray-700">지금 처리할 긴급 항목이 없어요</div>
                <div className="text-[12px] mt-0.5 text-muted-foreground">분류가 필요한 문자, 사람 확인이 필요한 대화, 긴급 건이 생기면 여기에 표시됩니다.</div>
                <div className="w-full max-w-[420px] mt-5 flex flex-col gap-2">
                  {[
                    { label: "인재풀 · 파이프라인 점검", path: "/pipeline" },
                    { label: "지원자 운영 열기", path: "/live" },
                  ].map((s) => (
                    <button
                      key={s.path}
                      onClick={() => router.push(s.path)}
                      className="flex min-h-11 w-full items-center justify-between rounded-lg border border-border-strong bg-background px-4 py-2.5 text-[13px] font-semibold text-gray-700 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {s.label} <ChevronRight size={15} className="text-muted-foreground" />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {urgent.map((item, index) => {
              const isPrimary = isDashboardPrimaryPriority(urgentSourcesState.state, index);
              const isCritical = item.urgency !== "attention";
              const surface = isPrimary
                ? isCritical
                  ? "border-priority-critical/25 bg-priority-critical-soft"
                  : "border-transparent bg-priority-attention-soft"
                : "border-border-strong bg-card hover:bg-background";
              const accent = isCritical ? "text-priority-critical-ink" : "text-priority-attention-ink";
              const priorityLabel = dashboardUrgencyLabel(item);

              return (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => openUrgentItem(item)}
                  className={`group flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-[148px] ${surface}`}
                >
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-current/15 bg-card/70 ${accent}`}>
                    {isCritical ? <Activity size={16} /> : <PhoneCall size={16} />}
                  </span>
                  <span className="min-w-0 flex-1 lg:flex lg:h-full lg:flex-col lg:items-stretch lg:gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant={isCritical ? "priority-critical" : "priority-attention"}>{priorityLabel}</Badge>
                        {isPrimary && <span className="text-[12px] font-medium text-muted-foreground">우선순위 1</span>}
                        <span className="text-[13px] font-bold text-foreground">{item.title}</span>
                      </span>
                      <span className="mt-1 block text-[12px] leading-relaxed text-muted-foreground">{item.desc}</span>
                    </span>
                    <span className={`mt-2.5 inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold lg:mt-auto lg:self-start ${accent}`}>
                      {item.cta} <ChevronRight size={14} className="transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none" />
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
      </motion.div>

      {/* 진행 중 긴급 건은 운영 차단이므로 큐보다 먼저 전폭 노출한다. 0건 기록 카드는 우측 보조 열로 내린다. */}
      {sosOpen.length > 0 && (
        <div id="sos-ledger" className="scroll-mt-6">
          <SosLedgerCard />
        </div>
      )}

      {/* 실제 응대 큐가 홈의 주 작업이다. 본문 폭이 충분한 xl(1280+)부터 2:1로 나누고 1024에서는 우선순위대로 쌓는다. */}
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <ReplyQueueCard onCountsChange={handleReplyCounts} retrySignal={replyRetrySignal} />
        <div className="flex min-w-0 flex-col gap-6">
          <InterestQueueCard />
          {sosOpen.length === 0 && (
            <div id="sos-ledger" className="scroll-mt-6">
              <SosLedgerCard />
            </div>
          )}
        </div>
      </div>

      {/* 다시 연락 캠페인 현황 — 발송 묶음의 열람/관심/답장 단계별 현황. 발송 이력 없으면 카드 스스로 숨김. */}
      <CampaignStatsCard />

      {/* 지표 · 분석 — 접이식 섹션(기본 접힘). KPI 4칸·유입 추이·단계별 전환율·스크리닝 현황·지역 분포를 한곳에 모음.
          접힌 상태에서도 헤더에 핵심 숫자(총 풀·확정·오늘 유입)는 보인다. */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="overflow-hidden rounded-panel border border-border-strong bg-card">
        <div className="flex flex-col sm:flex-row sm:items-stretch">
          <button
            onClick={() => setMetricsOpen((v) => !v)}
            aria-expanded={metricsOpen}
            disabled={metricsState === "loading" || metricsState === "error"}
            className="flex min-w-0 flex-1 items-center justify-between gap-3 px-6 py-4 text-left transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <h2 className="flex items-center gap-1.5 text-[16px] font-bold text-foreground">
                <TrendingUp size={15} className="text-muted-foreground" /> 지표 · 분석
              </h2>
              <span className="text-[13px] text-muted-foreground">
                {metricsState === "loading" && "지원자 지표를 불러오는 중이에요"}
                {metricsState === "error" && "지원자 지표를 불러오지 못했어요"}
                {hasAppsSnapshot && (
                  <>
                    총 인재풀 <b className="tabular-nums text-foreground">{stats.total.toLocaleString()}</b>명
                    {!metricsOpen && (
                      <>
                        <span> · </span>확정 <b className="tabular-nums text-foreground">{stats.passed.toLocaleString()}</b>명
                        <span> · </span>오늘 유입 <b className="tabular-nums text-foreground">{stats.today.toLocaleString()}</b>명
                      </>
                    )}
                    {metricsState === "stale" && <span className="font-semibold text-warning-strong"> · 이전 집계 · 갱신 실패</span>}
                  </>
                )}
              </span>
            </div>
            <span className="flex shrink-0 items-center gap-1 text-[12px] font-bold text-muted-foreground">
              {metricsState === "loading" ? "불러오는 중" : metricsState === "error" ? "확인 불가" : metricsOpen ? "접기" : "펼치기"}
              {hasAppsSnapshot && (
                <ChevronDown size={15} className={`transition-transform ${metricsOpen ? "rotate-180" : ""}`} />
              )}
            </span>
          </button>
          {(metricsState === "error" || metricsState === "stale") && (
            <div className="flex items-center px-6 pb-4 sm:py-2 sm:pl-0">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                isLoading={isAppsValidating}
                onClick={() => void mutateApps()}
              >
                <RefreshCw aria-hidden="true" /> 다시 시도
              </Button>
            </div>
          )}
        </div>

        {metricsOpen && hasAppsSnapshot && (
          <div className="px-6 pb-6 pt-5 border-t border-muted flex flex-col gap-6">
            <div>
              <div className="mb-3">
                <h3 className="text-[13px] font-bold text-foreground">지원자 상태</h3>
                <p className="mt-0.5 text-[12px] text-muted-foreground">현재 지원자 상태를 채용 흐름 순서로 보여드려요.</p>
              </div>
              <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                {metricTiles.map((metric) => <DashboardMetricTileView key={metric.id} metric={metric} />)}
              </dl>
            </div>

            {/* 유입 추이(2/3) + 스크리닝·온보딩 현황(1/3) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 items-stretch">
              {/* 최근 14일 신규 유입 추이 */}
              <div className="col-span-2 border border-border-strong rounded-lg p-6 flex flex-col">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[16px] font-bold text-foreground flex items-center gap-1.5"><TrendingUp size={15} className="text-info" /> 최근 14일 신규 유입 추이</h3>
                    <div className="text-[12px] text-muted-foreground mt-0.5">새로 들어온 지원자의 일별 흐름 · 실시간 인입 기준(일괄 임포트 제외)</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[12px] font-bold text-muted-foreground">최근 7일 합계</div>
                    <div className="text-[20px] font-extrabold text-foreground leading-none tracking-tight mt-0.5">{trend7Sum}<span className="text-[12px] text-muted-foreground font-bold ml-0.5">명</span></div>
                  </div>
                </div>
                <div className="flex-1 min-h-[200px]">
                  <ResponsiveContainer width="100%" height="100%" minHeight={180} minWidth={1}>
                    <AreaChart data={trend} margin={{ top: 10, right: 8, left: -22, bottom: 0 }}>
                      <defs key="defs-dashboard">
                        <linearGradient key="grad-inflow" id="dashInflow" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--stage-screening-ink)" stopOpacity={0.16} />
                          <stop offset="95%" stopColor="var(--stage-screening-ink)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid key="grid" strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                      <XAxis key="xaxis" dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} interval={1} dy={8} />
                      <YAxis key="yaxis" allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} width={36} />
                      <RechartsTooltip
                        key="tooltip"
                        contentStyle={{ borderRadius: '12px', border: '1px solid var(--border-strong)', background: 'var(--surface-raised)', boxShadow: 'var(--shadow-md)', fontSize: '12px' }}
                        labelStyle={{ fontWeight: 'bold', color: 'var(--foreground)', marginBottom: '2px' }}
                      />
                      <Area key="area-inflow" type="monotone" dataKey="유입" stroke="var(--stage-screening-ink)" strokeWidth={2} fillOpacity={1} fill="url(#dashInflow)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* 스크리닝 · 온보딩 현황 (실데이터) */}
              <div className="border border-border-strong rounded-lg p-5 flex flex-col">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                  <h3 className="text-[14px] font-bold text-foreground flex items-center gap-1.5"><ClipboardCheck size={15} className="text-muted-foreground" /> AI 대화 단계 · 온보딩</h3>
                  <button onClick={() => router.push('/live')} className="text-[12px] font-bold text-info hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">지원자 운영으로</button>
                </div>

                {/* 단계별 — 라벨은 실무 언어, 뜻은 툴팁으로 */}
                <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[
                    { label: "초기 대화", value: flow.exploration, color: "text-stage-exploration-ink", bg: "bg-stage-exploration-soft", hint: "AI가 조건을 안내하며 첫 대화를 나누는 단계" },
                    { label: "스크리닝", value: flow.screening, color: "text-stage-screening-ink", bg: "bg-stage-screening-soft", hint: "지역·차량·가능 시간 등 요건을 확인하는 단계" },
                    { label: "온보딩", value: flow.onboarding, color: "text-stage-onboarding-ink", bg: "bg-stage-onboarding-soft", hint: "확정 후 첫 근무 준비(가이드·서류·통화)를 챙기는 단계" },
                    { label: "활동 중", value: flow.active, color: "text-stage-active-ink", bg: "bg-stage-active-soft", hint: "온보딩을 마치고 실제 근무 중인 단계" },
                  ].map((s) => (
                    <div key={s.label} className={`rounded-xl px-4 py-3 ${s.bg}`} title={s.hint}>
                      <div className="text-[13px] font-semibold text-muted-foreground">{s.label}</div>
                      <div className={`mt-1 text-[20px] font-bold tabular-nums tracking-tight ${s.color}`}>{s.value}<span className="ml-0.5 text-[13px] font-medium text-muted-foreground">건</span></div>
                    </div>
                  ))}
                </div>

                {/* 온보딩 체크 진행도 */}
                <div className="border-t border-muted pt-3 space-y-2.5">
                  <div className="text-[12px] font-bold text-muted-foreground flex items-center justify-between">온보딩 진행 <span className="text-muted-foreground font-medium">대상 {flow.targets}명</span></div>
                  {[
                    { label: "가이드 전달", value: flow.guideSent, total: flow.targets, pct: flow.pct(flow.guideSent), icon: ClipboardCheck, color: "var(--stage-onboarding-ink)" },
                    // 배민 ID는 배민 라인 전용 — 분모를 배민 대상으로. 배민 대상이 없으면(도시락만) 숨김.
                    ...(flow.baeminTargets > 0 ? [{ label: "배민 ID 수신", value: flow.baeminId, total: flow.baeminTargets, pct: flow.pctBaemin(flow.baeminId), icon: Smartphone, color: "var(--stage-screening-ink)" }] : []),
                    { label: "온보딩 통화", value: flow.called, total: flow.targets, pct: flow.pct(flow.called), icon: PhoneCall, color: "var(--stage-active-ink)" },
                  ].map((m) => (
                    <div key={m.label}>
                      <div className="flex items-center justify-between text-[12px] mb-1">
                        <span className="flex items-center gap-1.5 font-semibold text-gray-700"><m.icon size={12} style={{ color: m.color }} /> {m.label}</span>
                        <span className="font-bold text-foreground">{m.value}/{m.total}</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${m.pct}%`, backgroundColor: m.color }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 단계별 전환율 (가로형 · 단계 간 전환율 강조) */}
            <div className="border border-border-strong rounded-lg p-6 flex flex-col">
              <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
                <div>
                  <h3 className="text-[16px] font-bold text-foreground">파이프라인 단계별 현황</h3>
                  <div className="text-[12px] text-muted-foreground mt-0.5">유입부터 확정 인력까지 단계별 전환율</div>
                </div>
                <button onClick={() => router.push('/pipeline')} className="text-[12px] font-bold text-info-strong bg-info-soft hover:bg-info/25 px-3 py-1.5 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  상세 보기
                </button>
              </div>

              <div className="flex flex-col gap-3 flex-1 justify-center">
                {funnel.map((f, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-[88px] shrink-0 text-[13px] font-bold text-gray-700 text-right">{f.step}</div>
                    <div className="flex-1 h-9 bg-background rounded-lg overflow-hidden relative">
                      <div
                        className="h-full rounded-lg transition-all duration-500 flex items-center px-3"
                        style={{ width: `${Math.max(f.pctTotal, 6)}%`, backgroundColor: f.color }}
                      >
                        <span className="text-[13px] font-extrabold text-white">{f.val.toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="w-[92px] shrink-0 flex items-center justify-end gap-1.5">
                      <span className="text-[12px] font-bold text-foreground">{f.pctTotal}%</span>
                      {f.conv !== null && (
                        <span className="text-[12px] font-bold text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">전환 {f.conv}%</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 지역별 인재풀 분포 Top 5 (지도 SDK 없는 경량 요약 · 클릭 시 파이프라인 지도로) */}
            <div className="border border-border-strong rounded-lg p-6 flex flex-col">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h3 className="text-[16px] font-bold text-foreground flex items-center gap-1.5"><MapPin size={15} className="text-info-strong" /> 지역별 인재풀 분포</h3>
                  <div className="text-[12px] text-muted-foreground mt-0.5">거주지(시/군/구) 기준 상위 5개 지역</div>
                </div>
                <button onClick={() => router.push('/pipeline?view=map')} className="text-[12px] font-bold text-info-strong bg-info-soft hover:bg-info/25 px-3 py-1.5 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  지도에서 보기
                </button>
              </div>

              {regionDist.top.length === 0 ? (
                <div className="py-6 text-center text-[13px] text-muted-foreground">아직 집계할 지역 데이터가 없어요. 지원자의 주소가 입력되면 자동으로 채워집니다.</div>
              ) : (
                <div className="flex flex-col gap-3">
                  {regionDist.top.map((r) => (
                    <div key={r.region} className="flex items-center gap-3">
                      <div className="w-[120px] shrink-0 text-[13px] font-bold text-gray-700 text-right truncate" title={r.region}>{r.region}</div>
                      <div className="flex-1 h-8 bg-background rounded-lg overflow-hidden relative">
                        <div
                          className="flex h-full items-center rounded-lg bg-stage-active-ink px-3 transition-all duration-500"
                          style={{ width: `${Math.max(Math.round((r.count / regionDist.max) * 100), 8)}%` }}
                        >
                          <span className="text-[13px] font-extrabold text-white">{r.count.toLocaleString()}</span>
                        </div>
                      </div>
                      <div className="w-[40px] shrink-0 text-[12px] font-bold text-muted-foreground text-right">명</div>
                    </div>
                  ))}
                  {regionDist.unknownCount > 0 && (
                    <div className="text-[12px] text-muted-foreground mt-1">주소 미입력 {regionDist.unknownCount.toLocaleString()}명 (지도/분포 집계 제외)</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </motion.div>
    </PageShell>
  );
}

// 첫 진입(캐시 없음) 로딩 중 0값 깜빡임을 막는 스켈레톤. 실제 레이아웃 골격(헤더→할 일→주 큐+보조 열→접이식 헤더)과 동일.
function DashboardSkeleton() {
  return (
    <PageShell className="min-h-full">
      <div className="bg-foreground rounded-2xl px-8 py-6 shadow-md">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-5 w-64 bg-white/10" />
            <Skeleton className="h-3 w-96 bg-white/10" />
          </div>
          <Skeleton className="h-9 w-36 rounded-2xl bg-white/10" />
        </div>
      </div>
      <Skeleton className="h-[420px] rounded-lg xl:h-[270px]" />
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <Skeleton className="h-[520px] rounded-lg" />
        <div className="flex flex-col gap-6">
          <Skeleton className="h-[160px] rounded-lg" />
          <Skeleton className="h-[260px] rounded-lg" />
        </div>
      </div>
      <Skeleton className="h-[56px] rounded-lg" />
    </PageShell>
  );
}
