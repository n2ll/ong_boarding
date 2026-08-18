import { ArrowRight, Users, MousePointerClick, MessageSquare, CheckCircle2, Activity, PhoneCall, ClipboardCheck, Smartphone, Database, TrendingUp, ChevronRight, ChevronDown, MapPin } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { motion } from "motion/react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from "recharts";
import { useBranchScope, matchesBranchScope } from "@/lib/branch-scope";
import { Skeleton } from "@/components/ui/skeleton";
import { SosLedgerCard } from "@/components/SosLedgerCard";
import { InterestQueueCard } from "@/components/InterestQueueCard";
import { ReplyQueueCard } from "@/components/ReplyQueueCard";
import { CampaignStatsCard } from "@/components/CampaignStatsCard";

interface UrgentItem {
  id: string;
  tone: "red" | "amber";
  title: string;
  desc: string;
  cta: string;
  path: string;
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
  current_recruit_mode?: string | null;
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
  last_seen_at: string;
  pending_count: number;
}

export function Dashboard() {
  const router = useRouter();
  const { branch: scopeBranch } = useBranchScope();
  // 지원자 목록은 파이프라인과 동일 키라 SWR이 중복 호출을 dedup하고, 탭 재방문 시 캐시를 즉시 보여준다.
  // scope=dashboard — 이 화면과 답장 큐(ReplyQueueCard)가 읽는 17컬럼+조립 2개만 받는 응답
  // (gzip 67KB → 29KB, 랜딩 화면 + 60초 폴링이라 절감이 반복된다). ReplyQueueCard와
  // **반드시 같은 키**여야 한다 — 키가 갈라지면 그쪽이 기본 응답을 또 받고, 답장 큐의
  // mutate()가 이 화면 통계를 같이 갱신하는 동작(같은 캐시)도 깨진다.
  const { data: appsRes, isLoading, error: appsError } = useSWR<{ data?: AppRow[] }>("/api/admin/applicants?scope=dashboard", { refreshInterval: 60_000 }); // 살아있는 갱신
  const { data: inboxRes } = useSWR<{ data?: { created_at?: string | null }[] }>("/api/admin/inbox/pending", { refreshInterval: 60_000 });
  // 헤더 벨·사이드바 배지와 동일 소스 — 사람 확인 필요(paused)·AI 전역 중단 카운트
  const { data: notiRes } = useSWR<{ counts?: { inbox: number; interventions: number; aiDisabled: boolean; inbox_oldest_days?: number | null; interventions_oldest_days?: number | null } }>("/api/admin/notifications");
  // 확정 대기 큐(스크리닝 완료·미확정) — 사이드바 배지·LiveConsole '확정 대기' 탭과 동일 소스. '오늘의 할 일'에 합류(주제 C1 발견성).
  const { data: confirmRes } = useSWR<{ total?: number; pending?: { created_at?: string | null }[] }>("/api/admin/confirm/pending", { refreshInterval: 60_000 });
  // SosLedgerCard와 동일 키라 SWR이 중복 호출을 dedup — 진행 중 긴급 건을 '오늘의 할 일'에 합류
  const { data: sosRes } = useSWR<{ open?: SosOpenRow[] }>("/api/admin/sos");
  // SMS 게이트웨이(법인폰) 하트비트 — last_seen_at 내림차순 응답이라 [0]이 최신 기기
  const { data: hbRes } = useSWR<{ data?: HeartbeatRow[] }>("/api/admin/heartbeat", { refreshInterval: 60_000 });
  // InterestQueueCard와 동일 키라 SWR이 dedup — 관심 표시 처리 대기 건수를 '오늘의 할 일'에 합류
  const { data: interestRes } = useSWR<{ count?: number; immediate_count?: number; items?: { interested_at?: string | null }[] }>("/api/admin/interest-queue", { refreshInterval: 30_000 });
  // AI 응답 모드(자동/코파일럿/완전 중지) — LiveConsole·에이전트 두뇌와 동일 키라 SWR이 dedup.
  // 처음 보는 매니저도 '지금 AI가 답하고 있는지'를 헤더 한 줄로 알 수 있게 상시 노출한다.
  const { data: killRes } = useSWR<{ mode?: "auto" | "draft" | "off"; disabled?: boolean; env_forced?: boolean }>("/api/admin/agent/kill-switch");
  const rawApps = appsRes?.data ?? [];
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
      { step: "다채널 유입", val: stats.total, color: "var(--chart-step-1)" },
      { step: "AI 스크리닝", val: screened, color: "var(--chart-step-2)" },
      { step: "1차 요건 통과", val: passed1, color: "var(--chart-step-3)" },
      { step: "확정 인력", val: stats.passed, color: "var(--chart-step-4)" },
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
    // 배민 ID는 배민 커넥트 라인 전용 단계 — internal(도시락 등) 대상은 배민 ID가 없어 분모/분자 모두에서 제외.
    // (예전엔 internal 대상까지 분모에 들어가 '배민 ID 수신'이 영영 낮게 왜곡됐다)
    const baeminTargets = onboardingTargets.filter((a) => a.current_recruit_mode !== "internal");
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
  const [replyCounts, setReplyCounts] = useState<{ total: number; untouched: number; oldestDays?: number | null }>({ total: 0, untouched: 0, oldestDays: null });
  const handleReplyCounts = useCallback((c: { total: number; untouched: number; oldestDays?: number | null }) => {
    setReplyCounts((prev) => (prev.total === c.total && prev.untouched === c.untouched && prev.oldestDays === c.oldestDays ? prev : c));
  }, []);
  const poolReplies = replyCounts.untouched;
  const interestCount = interestRes?.count ?? 0;
  const interestImmediate = interestRes?.immediate_count ?? 0;
  const confirmPendingCount = confirmRes?.total ?? confirmRes?.pending?.length ?? 0;
  const urgent = useMemo(() => {
    const u: UrgentItem[] = [];
    // '오늘의 할 일'이 건수만 말하고 시간을 말하지 않던 문제 — 7개 항목 중 경과 시간이
    // 붙은 것은 긴급 건 하나뿐이라, 1일이든 32일이든 같은 노란 줄이었다. 32일 방치가
    // 빨갛게 뜨면 그날 처리된다(안쪽 인계 큐에는 이미 빨간 ⏱ 배지가 있었는데 홈까지
    // 올라오지 않았다). 색은 항목 종류가 아니라 '얼마나 오래됐나'를 말한다.
    const days = (iso: string | null | undefined) =>
      iso ? Math.max(0, Math.floor((nowTick - new Date(iso).getTime()) / 86400000)) : null;
    const AGE_RED = 7; // 이 이상 방치되면 무엇이든 빨간색
    const esc = (base: "red" | "amber", d: number | null): "red" | "amber" => ((d ?? 0) >= AGE_RED ? "red" : base);
    const suffix = (d: number | null) => ((d ?? 0) >= 1 ? ` · 최장 ${d}일` : "");
    if (notiCounts?.aiDisabled) {
      u.push({ id: "ai-off", tone: "red", title: "AI 자동응대가 중단된 상태예요", desc: "전역 응답 스위치가 꺼져 있어 신규 인입에 자동 응대하지 않습니다.", cta: "자동화 현황으로", path: "/automation" });
    }
    if (sosOpen.length > 0) {
      const oldest = Math.min(...sosOpen.map((s) => new Date(s.created_at).getTime()));
      const min = Math.max(0, Math.floor((nowTick - oldest) / 60_000));
      const elapsed = min < 60 ? `${min}분` : `${Math.floor(min / 60)}시간`;
      u.push({ id: "sos", tone: "red", title: `진행 중 긴급 건 ${sosOpen.length}건 · 최장 ${elapsed} 경과`, desc: "결원·증차 긴급 건이 해결 대기 중이에요.", cta: "긴급 건 기록으로", path: "#sos-ledger" });
    }
    if (interestCount > 0) {
      const oldest = days(
        (interestRes?.items ?? []).reduce<string | null>((min, it) => {
          const t = it.interested_at ?? null;
          return t && (!min || t < min) ? t : min;
        }, null)
      );
      u.push({
        id: "interest-queue",
        tone: interestImmediate > 0 ? "red" : esc("amber", oldest),
        title: `관심 표시 처리 대기 ${interestCount}건${interestImmediate > 0 ? ` (바로가능 ${interestImmediate}건)` : ""}${suffix(oldest)}`,
        desc: "맞춤 공고 링크에서 관심을 누른 후보가 연락을 기다리고 있어요.",
        cta: "관심 표시 처리로",
        path: "#interest-queue",
      });
    }
    if (inboxCount > 0) {
      // 기본은 amber — 스팸이 섞이는 분류함이 항상 최상단 빨강이면, 32일째 답을 기다리는
      // 사람보다 "스팸 분류하러 가기"가 더 급해 보인다. 오래 묵으면(7일+) 빨강으로 올라온다.
      const oldest = days(
        (inboxRes?.data ?? []).reduce<string | null>((min, it) => {
          const t = it.created_at ?? null;
          return t && (!min || t < min) ? t : min;
        }, null)
      ) ?? notiCounts?.inbox_oldest_days ?? null;
      u.push({ id: "inbox", tone: esc("amber", oldest), title: `분류 대기 문자함 ${inboxCount}건${suffix(oldest)}`, desc: "어느 지원자의 문자인지 분류가 필요한 수신 문자가 있어요.", cta: "분류하러 가기", path: "/inbox" });
    }
    if ((notiCounts?.interventions ?? 0) > 0) {
      const oldest = notiCounts?.interventions_oldest_days ?? null;
      // 목적 탭으로 딥링크 — 예전엔 둘 다 '전체' 탭으로 떨어져 매니저가 탭을 다시 찾아야 했다.
      u.push({ id: "live", tone: esc("amber", oldest), title: `사람 확인 필요 ${notiCounts!.interventions}건${suffix(oldest)}`, desc: "AI가 답을 멈추고 넘긴 대화예요. 매니저가 직접 확인해 답해야 합니다.", cta: "실시간 응대로", path: "/live?tab=intervention" });
    }
    if (confirmPendingCount > 0) {
      const oldest = days(confirmRes?.pending?.[0]?.created_at ?? null); // 라우트가 오래된 순 정렬
      u.push({ id: "confirm-pending", tone: esc("amber", oldest), title: `확정 대기 ${confirmPendingCount}명${suffix(oldest)}`, desc: "스크리닝을 마친 인력이에요. 확정하고 만남장소·첫날 규칙을 발송하세요.", cta: "확정 대기로", path: "/live?tab=confirm" });
    }
    if (poolReplies > 0) {
      const oldest = replyCounts.oldestDays ?? null;
      u.push({ id: "pool-reply", tone: esc("amber", oldest), title: `내가 답할 차례 ${poolReplies}건${suffix(oldest)}`, desc: "문자 답장이 왔는데 아직 아무도 답하지 않았어요. AI가 넘긴 대화('사람 확인 필요')와는 별개예요.", cta: "답장 큐로", path: "#reply-queue" });
    }
    return u;
  }, [notiCounts, sosOpen, inboxRes, inboxCount, poolReplies, replyCounts.oldestDays, interestRes, interestCount, interestImmediate, confirmRes, confirmPendingCount, nowTick]);

  // 문자 발송폰(법인폰) 상태 칩 — 최신 기기 1건 기준. 10분 무신호 또는 발송 대기 적체 시 경고색.
  const gateway = useMemo(() => {
    if (!hbRes) return null; // 첫 로딩 전엔 칩 미노출(깜빡임 방지)
    const latest = hbRes.data?.[0];
    if (!latest) return { label: "문자 발송폰 신호 없음", bad: true };
    const min = Math.floor(Math.max(0, nowTick - new Date(latest.last_seen_at).getTime()) / 60_000);
    const ago = min < 1 ? "방금" : min < 60 ? `${min}분 전` : `${Math.floor(min / 60)}시간 전`;
    const pending = latest.pending_count ?? 0;
    return { label: `문자 발송폰 ${ago} · 발송 대기 ${pending}건`, bad: min > 10 || pending > 0 };
  }, [hbRes, nowTick]);

  // 운영 모드 한 줄 — 킬스위치 3단(auto/draft/off)을 매니저 언어로. 로딩 전엔 미노출(깜빡임 방지).
  const aiMode = useMemo(() => {
    if (!killRes) return null;
    const mode = killRes.env_forced || killRes.disabled ? "off" : killRes.mode ?? "auto";
    if (mode === "off")
      return { label: "AI 응답 완전 중지 — 답장은 수동 응대 중", cls: "bg-error/15 border-error/40 text-error-on-dark", dot: "bg-error" };
    if (mode === "draft")
      return { label: "AI 코파일럿 — 초안만 작성, 발송은 매니저 승인 후", cls: "bg-copilot/15 border-copilot/40 text-copilot-on-dark", dot: "bg-copilot" };
    return { label: "AI 자동 응대 중", cls: "bg-success/10 border-success/30 text-success-on-dark", dot: "bg-success" };
  }, [killRes]);

  // '지표 · 분석' 접이식 섹션 — 기본 접힘. 첫 화면은 '지금 할 일'이 스크롤 없이 보이는 게 목표.
  const [metricsOpen, setMetricsOpen] = useState(false);

  if (showSkeleton) return <DashboardSkeleton />;

  // [&>*]:shrink-0 — flex 세로 스택에서 내용이 화면보다 길어지면 flex가 자식의 높이를
  // 뺏어 눌러버린다. overflow-hidden인 카드는 눌린 만큼 내용이 그냥 사라진다.
  // 실제로 아래 다크 히어로가 352px 잘려 제목 한 줄만 남아 있었고(운영 상태·문자
  // 발송폰 표시가 전부 안 보였다), '지표 · 분석' 카드도 53px 잘렸다.
  // 배경색도 여기서 칠하지 않는다 — body의 종이 질감을 덮는다.
  return (
    <div className="p-8 pb-12 flex min-h-full flex-col gap-6 [&>*]:shrink-0">
      {/* 상단 헤더 — 제목 + 운영 상태 한 줄(동기화·AI 응답 모드·문자 발송폰). KPI 숫자는 아래 '지표 · 분석'으로 이동 */}
      <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="bg-foreground rounded-xl px-8 py-6 relative overflow-hidden shadow-md text-white">
        <div className="absolute right-0 top-0 w-[400px] h-[400px] bg-info rounded-full blur-[120px] opacity-20 pointer-events-none"></div>

        <div className="relative z-10 flex items-center justify-between">
          <div>
            <h1 className="text-[20px] font-extrabold tracking-tight mb-1">
              {scopeBranch ? `${scopeBranch} · 오늘의 채용 운영` : "오늘의 채용 운영"}
            </h1>
            <div className="flex items-center gap-2 text-[13px] text-white/70 flex-wrap">
              {/* 상태 dot·문구는 SWR 로딩/에러와 연동 — 하드코딩 '정상 가동' 아님 */}
              <span className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded-full ${appsError ? "bg-error" : isLoading ? "bg-yellow-400" : "bg-success animate-pulse"}`}></span>
                {appsError ? "불러오기 오류 — 데이터가 최신이 아닐 수 있어요" : isLoading ? "불러오는 중…" : "데이터 최신 상태"}
              </span>
              <span className="text-white/30">|</span>
              <span>마지막 갱신: {syncLabel}</span>
              {aiMode && (
                <>
                  <span className="text-white/30">|</span>
                  {/* 운영 모드 한 줄 — 지금 AI가 답하고 있는지(자동/코파일럿/완전 중지)를 상시 표시 */}
                  <span
                    title="AI 응답 모드 — 변경은 실시간 응대 화면 상단 배너 또는 에이전트 두뇌에서"
                    className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[12px] font-semibold ${aiMode.cls}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${aiMode.dot}`}></span>
                    {aiMode.label}
                  </span>
                </>
              )}
              {gateway && (
                <>
                  <span className="text-white/30">|</span>
                  {/* 문자 발송폰(법인폰) 하트비트 칩 — 인입이 조용한 게 평화인지 장애인지 구분 */}
                  <span
                    title="문자를 실제로 보내고 받는 법인폰 상태예요. 신호가 10분 이상 없으면 문자 수·발신이 멈췄을 수 있어요."
                    className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[12px] font-semibold ${gateway.bad ? "bg-error/15 border-error/40 text-error-on-dark" : "bg-success/10 border-success/30 text-success-on-dark"}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${gateway.bad ? "bg-error animate-pulse" : "bg-success"}`}></span>
                    {gateway.label}
                  </span>
                </>
              )}
            </div>
          </div>
          <button onClick={() => router.push('/pipeline')} className="px-4 py-2 bg-white/70 backdrop-blur-xl/10 hover:bg-white/70 backdrop-blur-xl/20 border border-white/10 rounded-xl text-[13px] font-bold transition-all flex items-center gap-2 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
            인재풀 · 파이프라인 <ArrowRight size={14} />
          </button>
        </div>
      </motion.div>

      {/* 오늘의 할 일 — 첫 화면 최상단(전폭). 유입 추이 차트는 아래 '지표 · 분석'으로 이동 */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="bg-white border border-border-strong rounded-lg p-6 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-[15px] font-bold text-foreground flex items-center gap-2">
              오늘의 할 일
              {urgent.length > 0 && <span className="bg-error text-white text-[11px] px-2 py-0.5 rounded-full font-bold">{urgent.length}</span>}
            </h2>
          </div>

          <div className="flex flex-col gap-3 flex-1 overflow-y-auto [&>*]:shrink-0">
            {urgent.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-4">
                <CheckCircle2 size={28} className="text-success mb-2" />
                <div className="text-[13px] font-bold text-gray-700">지금 처리할 긴급 항목이 없어요</div>
                <div className="text-[12px] mt-0.5 text-muted-foreground">분류 대기 문자함, 사람 확인이 필요한 대화, 긴급 건이 생기면 여기에 표시됩니다.</div>
                <div className="w-full max-w-[420px] mt-5 flex flex-col gap-2">
                  {[
                    { label: "인재풀 · 파이프라인 점검", path: "/pipeline" },
                    { label: "실시간 응대 보기", path: "/live" },
                  ].map((s) => (
                    <button
                      key={s.path}
                      onClick={() => router.push(s.path)}
                      className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl border border-border-strong bg-background hover:bg-muted text-[12.5px] font-bold text-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {s.label} <ChevronRight size={15} className="text-muted-foreground" />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {urgent.map((item) => (
              <div
                key={item.id}
                // '#앵커' 경로는 라우팅 대신 같은 화면의 카드로 스크롤 (긴급 건 → SosLedgerCard)
                onClick={() =>
                  item.path.startsWith("#")
                    ? document.getElementById(item.path.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" })
                    : router.push(item.path)
                }
                className={`p-4 border rounded-xl flex items-start gap-3 cursor-pointer transition-colors ${item.tone === "red" ? "border-error/30 bg-error-soft hover:border-error" : "border-border-strong bg-white hover:border-gray-300"}`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border shadow-sm ${item.tone === "red" ? "bg-white text-error border-error/30" : "bg-background text-gray-700 border-border-strong"}`}>
                  {item.tone === "red" ? <Activity size={16} /> : <PhoneCall size={16} />}
                </div>
                <div className="flex-1">
                  <div className={`text-[13px] font-bold ${item.tone === "red" ? "text-error-strong" : "text-foreground"}`}>{item.title}</div>
                  <div className={`text-[12px] mt-0.5 mb-2.5 ${item.tone === "red" ? "text-error-strong" : "text-muted-foreground"}`}>{item.desc}</div>
                  <span className={`text-[11.5px] font-bold px-3 py-1.5 rounded-lg ${item.tone === "red" ? "bg-error text-white" : "bg-muted text-gray-700"}`}>
                    {item.cta}
                  </span>
                </div>
              </div>
            ))}
          </div>
      </motion.div>

      {/* 다시 연락 응답 큐 — 관심 표시(맞춤 공고 링크 클릭)와 내가 답할 차례(문자 답장)를 대칭 병렬 배치.
          '오늘의 할 일' 바로 아래, 긴급 건 기록 위. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 items-start">
        <InterestQueueCard />
        <ReplyQueueCard onCountsChange={handleReplyCounts} />
      </div>

      {/* 다시 연락 캠페인 현황 — 발송 묶음의 열람/관심/답장 단계별 현황. 발송 이력 없으면 카드 스스로 숨김.
          관심/답장 큐 아래·긴급 건 기록 위 배치(단계별 현황에서 처리 큐로 앵커 이동). */}
      <CampaignStatsCard />

      {/* 4행: 긴급 건 기록 (결원·증차 발생~해결 로그 + 월 운영비) — 긴급도상 '오늘의 할 일' 바로 아래로 승격 */}
      <div id="sos-ledger" className="scroll-mt-6">
        <SosLedgerCard />
      </div>

      {/* 지표 · 분석 — 접이식 섹션(기본 접힘). KPI 5칸·유입 추이·단계별 전환율·스크리닝 현황·지역 분포를 한곳에 모음.
          접힌 상태에서도 헤더에 핵심 숫자(총 풀·확정·오늘 유입)는 보인다. */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="bg-white border border-border-strong rounded-lg shadow-sm overflow-hidden">
        <button
          onClick={() => setMetricsOpen((v) => !v)}
          aria-expanded={metricsOpen}
          className="w-full flex items-center justify-between gap-3 px-6 py-4 text-left hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-[15px] font-bold text-foreground flex items-center gap-1.5"><TrendingUp size={15} className="text-info" /> 지표 · 분석</h2>
            <span className="text-[12.5px] text-muted-foreground">
              총 인재풀 <b className="text-foreground">{stats.total.toLocaleString()}</b>명
              <span className="text-muted-foreground"> · </span>확정 <b className="text-foreground">{stats.passed}</b>명
              <span className="text-muted-foreground"> · </span>오늘 유입 <b className="text-foreground">{stats.today}</b>명
            </span>
          </div>
          <span className="flex items-center gap-1 text-[12px] font-bold text-muted-foreground shrink-0">
            {metricsOpen ? "접기" : "펼치기"}
            <ChevronDown size={15} className={`transition-transform ${metricsOpen ? "rotate-180" : ""}`} />
          </span>
        </button>

        {metricsOpen && (
          <div className="px-6 pb-6 pt-5 border-t border-muted flex flex-col gap-6">
            {/* 핵심 지표 5칸 — 클릭 시 파이프라인으로 */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
              {[
                { label: "신규 유입 (금일)", value: String(stats.today), sub: "명", icon: Users, color: "text-info" },
                { label: "총 누적 인재풀", value: stats.total.toLocaleString(), sub: "명", icon: Database, color: "text-chart-3" },
                { label: "AI 스크리닝 진행", value: String(stats.screening), sub: "건", icon: MousePointerClick, color: "text-warning-strong" },
                { label: "스크리닝 완료", value: String(stats.interview), sub: "명", icon: MessageSquare, color: "text-copilot" },
                { label: "확정 인력", value: String(stats.passed), sub: "건", icon: CheckCircle2, color: "text-success" },
              ].map((k, i) => (
                <div key={i} className="bg-surface-raised border border-border-strong rounded-md p-4 hover:bg-background transition-colors cursor-pointer" onClick={() => router.push('/pipeline')}>
                  <div className="flex items-center gap-2 mb-2">
                    <k.icon size={16} className={`${k.color}`} />
                    <span className="text-[12px] text-muted-foreground font-medium">{k.label}</span>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-[26px] font-extrabold leading-none tracking-tight text-foreground">{k.value}</span>
                    <span className="text-[12px] text-muted-foreground font-medium">{k.sub}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* 유입 추이(2/3) + 스크리닝·온보딩 현황(1/3) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 items-stretch">
              {/* 최근 14일 신규 유입 추이 */}
              <div className="col-span-2 border border-border-strong rounded-lg p-6 flex flex-col">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[15px] font-bold text-foreground flex items-center gap-1.5"><TrendingUp size={15} className="text-info" /> 최근 14일 신규 유입 추이</h3>
                    <div className="text-[12px] text-muted-foreground mt-0.5">새로 들어온 지원자의 일별 흐름 · 실시간 인입 기준(일괄 임포트 제외)</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] font-bold text-muted-foreground">최근 7일 합계</div>
                    <div className="text-[20px] font-extrabold text-foreground leading-none tracking-tight mt-0.5">{trend7Sum}<span className="text-[12px] text-muted-foreground font-bold ml-0.5">명</span></div>
                  </div>
                </div>
                <div className="flex-1 min-h-[200px]">
                  <ResponsiveContainer width="100%" height="100%" minHeight={180} minWidth={1}>
                    <AreaChart data={trend} margin={{ top: 10, right: 8, left: -22, bottom: 0 }}>
                      <defs key="defs-dashboard">
                        <linearGradient key="grad-inflow" id="dashInflow" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0} />
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
                      <Area key="area-inflow" type="monotone" dataKey="유입" stroke="var(--chart-1)" strokeWidth={2} fillOpacity={1} fill="url(#dashInflow)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* 스크리닝 · 온보딩 현황 (실데이터) */}
              <div className="border border-border-strong rounded-lg p-5 flex flex-col">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                  <h3 className="text-[14px] font-bold text-foreground flex items-center gap-1.5"><ClipboardCheck size={15} className="text-info" /> 스크리닝 · 온보딩 현황</h3>
                  <button onClick={() => router.push('/live')} className="text-[11.5px] font-bold text-info hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">응대로</button>
                </div>

                {/* 단계별 — 라벨은 실무 언어, 뜻은 툴팁으로 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
                  {[
                    { label: "초기 대화", value: flow.exploration, color: "text-muted-foreground", bg: "bg-background", hint: "AI가 조건을 안내하며 첫 대화를 나누는 단계" },
                    { label: "스크리닝", value: flow.screening, color: "text-warning-strong", bg: "bg-yellow-50", hint: "지역·차량·가능 시간 등 요건을 확인하는 단계" },
                    { label: "온보딩", value: flow.onboarding, color: "text-copilot-strong", bg: "bg-copilot-soft", hint: "확정 후 첫 근무 준비(가이드·서류·통화)를 챙기는 단계" },
                    { label: "활동 중", value: flow.active, color: "text-success-strong", bg: "bg-success-soft", hint: "온보딩을 마치고 실제 근무 중인 단계" },
                  ].map((s) => (
                    <div key={s.label} className={`rounded-xl px-3 py-2 ${s.bg}`} title={s.hint}>
                      <div className="text-[11px] font-bold text-muted-foreground">{s.label}</div>
                      <div className={`text-[18px] font-extrabold tracking-tight ${s.color}`}>{s.value}<span className="text-[11px] text-muted-foreground ml-0.5">건</span></div>
                    </div>
                  ))}
                </div>

                {/* 온보딩 체크 진행도 */}
                <div className="border-t border-muted pt-3 space-y-2.5">
                  <div className="text-[11.5px] font-bold text-muted-foreground flex items-center justify-between">온보딩 진행 <span className="text-muted-foreground font-medium">대상 {flow.targets}명</span></div>
                  {[
                    { label: "가이드 전달", value: flow.guideSent, total: flow.targets, pct: flow.pct(flow.guideSent), icon: ClipboardCheck, color: "var(--chart-1)" },
                    // 배민 ID는 배민 라인 전용 — 분모를 배민 대상으로. 배민 대상이 없으면(도시락만) 숨김.
                    ...(flow.baeminTargets > 0 ? [{ label: "배민 ID 수신", value: flow.baeminId, total: flow.baeminTargets, pct: flow.pctBaemin(flow.baeminId), icon: Smartphone, color: "var(--chart-2)" }] : []),
                    { label: "온보딩 통화", value: flow.called, total: flow.targets, pct: flow.pct(flow.called), icon: PhoneCall, color: "var(--chart-3)" },
                  ].map((m) => (
                    <div key={m.label}>
                      <div className="flex items-center justify-between text-[11.5px] mb-1">
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
                  <h3 className="text-[15px] font-bold text-foreground">파이프라인 단계별 현황</h3>
                  <div className="text-[12px] text-muted-foreground mt-0.5">유입부터 확정 인력까지 단계별 전환율</div>
                </div>
                <button onClick={() => router.push('/pipeline')} className="text-[12px] font-bold text-info-strong bg-info-soft hover:bg-info/25 px-3 py-1.5 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  상세 보기
                </button>
              </div>

              <div className="flex flex-col gap-3 flex-1 justify-center">
                {funnel.map((f, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-[88px] shrink-0 text-[12.5px] font-bold text-gray-700 text-right">{f.step}</div>
                    <div className="flex-1 h-9 bg-background rounded-lg overflow-hidden relative">
                      <div
                        className="h-full rounded-lg transition-all duration-500 flex items-center px-3"
                        style={{ width: `${Math.max(f.pctTotal, 6)}%`, backgroundColor: f.color }}
                      >
                        <span className={`text-[13px] font-extrabold ${i === funnel.length - 1 ? "text-white" : "text-gray-800"}`}>{f.val.toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="w-[92px] shrink-0 flex items-center justify-end gap-1.5">
                      <span className="text-[12px] font-bold text-foreground">{f.pctTotal}%</span>
                      {f.conv !== null && (
                        <span className="text-[10.5px] font-bold text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">전환 {f.conv}%</span>
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
                  <h3 className="text-[15px] font-bold text-foreground flex items-center gap-1.5"><MapPin size={15} className="text-info-strong" /> 지역별 인재풀 분포</h3>
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
                      <div className="w-[120px] shrink-0 text-[12.5px] font-bold text-gray-700 text-right truncate" title={r.region}>{r.region}</div>
                      <div className="flex-1 h-8 bg-background rounded-lg overflow-hidden relative">
                        <div
                          className="h-full rounded-lg transition-all duration-500 flex items-center px-3 bg-info"
                          style={{ width: `${Math.max(Math.round((r.count / regionDist.max) * 100), 8)}%` }}
                        >
                          <span className="text-[12.5px] font-extrabold text-gray-800">{r.count.toLocaleString()}</span>
                        </div>
                      </div>
                      <div className="w-[40px] shrink-0 text-[12px] font-bold text-muted-foreground text-right">명</div>
                    </div>
                  ))}
                  {regionDist.unknownCount > 0 && (
                    <div className="text-[11.5px] text-muted-foreground mt-1">주소 미입력 {regionDist.unknownCount.toLocaleString()}명 (지도/분포 집계 제외)</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

// 첫 진입(캐시 없음) 로딩 중 0값 깜빡임을 막는 스켈레톤. 실제 레이아웃 골격(헤더→할 일→큐 2칸→접이식 헤더)과 동일.
function DashboardSkeleton() {
  return (
    <div className="p-8 pb-12 flex min-h-full flex-col gap-6 [&>*]:shrink-0">
      <div className="bg-foreground rounded-xl px-8 py-6 shadow-md">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-5 w-64 bg-white/10" />
            <Skeleton className="h-3 w-96 bg-white/10" />
          </div>
          <Skeleton className="h-9 w-36 rounded-xl bg-white/10" />
        </div>
      </div>
      <Skeleton className="h-[220px] rounded-lg" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 items-stretch">
        <Skeleton className="h-[260px] rounded-lg" />
        <Skeleton className="h-[260px] rounded-lg" />
      </div>
      <Skeleton className="h-[180px] rounded-lg" />
      <Skeleton className="h-[56px] rounded-lg" />
    </div>
  );
}
