import { ArrowRight, Users, MousePointerClick, MessageSquare, CheckCircle2, Activity, PhoneCall, ClipboardCheck, Smartphone, Database, TrendingUp, ChevronRight, MapPin } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import useSWR from "swr";
import { motion } from "motion/react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from "recharts";
import { useBranchScope, matchesBranchScope } from "@/lib/branch-scope";
import { Skeleton } from "@/components/ui/skeleton";

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
  unread_count?: number | null;
  branch?: string | null;
  branch1?: string | null;
  confirmed_branch?: string | null;
  agent_stage?: string | null;
  guide_sent?: boolean | null;
  baemin_id?: string | null;
  onboarding_call_status?: string | null;
  sigungu?: string | null;
  sido?: string | null;
}

export function Dashboard() {
  const router = useRouter();
  const { branch: scopeBranch } = useBranchScope();
  // 지원자 목록은 파이프라인과 동일 키라 SWR이 중복 호출을 dedup하고, 탭 재방문 시 캐시를 즉시 보여준다.
  const { data: appsRes, isLoading } = useSWR<{ data?: AppRow[] }>("/api/admin/applicants");
  const { data: inboxRes } = useSWR<{ data?: unknown[] }>("/api/admin/inbox/pending");
  const rawApps = appsRes?.data ?? [];
  const inboxCount = inboxRes?.data?.length ?? 0;
  // 캐시된 이전 데이터 없이 첫 로딩 중일 때만 스켈레톤 노출
  const showSkeleton = isLoading && rawApps.length === 0;

  const branchOf = (a: AppRow) => a.confirmed_branch || a.branch1 || a.branch || null;
  const apps = useMemo(
    () => rawApps.filter((a) => matchesBranchScope(branchOf(a), scopeBranch)),
    [rawApps, scopeBranch]
  );

  const stats = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const by = (s: string) => apps.filter((a) => a.status === s).length;
    return {
      today: apps.filter((a) => (a.created_at ?? "").slice(0, 10) === todayStr).length,
      screening: by("스크리닝 중"),
      interview: by("스크리닝 완료"),
      passed: by("확정인력"),
      total: apps.length,
    };
  }, [apps]);

  // 최근 14일 일별 신규 유입 추이 (created_at 기준, stats.today와 동일하게 UTC 일자 슬라이스)
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
    for (const a of apps) {
      const i = idx.get((a.created_at ?? "").slice(0, 10));
      if (i !== undefined) days[i].유입 += 1;
    }
    return days;
  }, [apps]);

  const trend7Sum = useMemo(() => trend.slice(7).reduce((s, d) => s + d.유입, 0), [trend]);

  // 단계 간 전환율을 강조한 가로형 퍼널
  const funnel = useMemo(() => {
    const screened = stats.screening + stats.interview + stats.passed;
    const passed1 = stats.interview + stats.passed;
    const rows = [
      { step: "다채널 유입", val: stats.total, color: "#CBD5E0" },
      { step: "AI 스크리닝", val: screened, color: "#90CDF4" },
      { step: "1차 요건 통과", val: passed1, color: "#63B3ED" },
      { step: "확정 인력", val: stats.passed, color: "#3182CE" },
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
    return {
      exploration: stage("exploration"),
      screening: stage("screening"),
      onboarding: stage("onboarding"),
      active: stage("active"),
      targets: onboardingTargets.length,
      guideSent: onboardingTargets.filter((a) => a.guide_sent).length,
      baeminId: onboardingTargets.filter((a) => (a.baemin_id ?? "").trim()).length,
      called: onboardingTargets.filter((a) => (a.onboarding_call_status ?? "").includes("완료")).length,
      pct: (n: number) => Math.round((n / t) * 100),
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

  const urgent = useMemo(() => {
    const interventions = apps.filter((a) => (a.unread_count ?? 0) > 0).length;
    const u: UrgentItem[] = [];
    if (inboxCount > 0) {
      u.push({ id: "inbox", tone: "red", title: `미분류 인박스 ${inboxCount}건`, desc: "배민 지원자/기타 분류가 필요한 인입 메시지가 있어요.", cta: "분류하러 가기", path: "/inbox" });
    }
    if (interventions > 0) {
      u.push({ id: "live", tone: "amber", title: `수동 개입 필요 ${interventions}건`, desc: "미답장 상태인 지원자 대화가 있어요. 직접 응대가 필요합니다.", cta: "실시간 응대로", path: "/live" });
    }
    return u;
  }, [apps, inboxCount]);

  if (showSkeleton) return <DashboardSkeleton />;

  return (
    <div className="p-8 pb-12 flex flex-col gap-6 bg-[#F7FAFC] min-h-full">
      {/* Hero: 헤드라인 KPI를 한 곳에 모은 전폭 다크 카드 */}
      <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="bg-[#1A202C] rounded-[20px] p-8 relative overflow-hidden shadow-md text-white">
        <div className="absolute right-0 top-0 w-[400px] h-[400px] bg-[#3182CE] rounded-full blur-[120px] opacity-20 pointer-events-none"></div>

        <div className="relative z-10 flex items-center justify-between mb-8">
          <div>
            <h1 className="text-[20px] font-extrabold tracking-tight mb-1">
              {scopeBranch ? `${scopeBranch} 파이프라인 오버뷰` : "전사 채용 파이프라인 오버뷰"}
            </h1>
            <div className="flex items-center gap-2 text-[13px] text-white/70">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#48BB78] animate-pulse"></span> 통합 시스템 정상 가동 중</span>
              <span className="text-white/30">|</span>
              <span>최근 동기화: 방금 전</span>
            </div>
          </div>
          <button onClick={() => router.push('/pipeline')} className="px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/10 rounded-xl text-[13px] font-bold transition-all flex items-center gap-2 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
            파이프라인 상세 보기 <ArrowRight size={14} />
          </button>
        </div>

        <div className="relative z-10 grid grid-cols-5 gap-4">
          {[
            { label: "신규 유입 (금일)", value: String(stats.today), sub: "명", icon: Users, color: "text-[#63B3ED]" },
            { label: "총 누적 인재풀", value: stats.total.toLocaleString(), sub: "명", icon: Database, color: "text-[#76E4F7]" },
            { label: "AI 스크리닝 진행", value: String(stats.screening), sub: "건", icon: MousePointerClick, color: "text-[#F6E05E]" },
            { label: "스크리닝 완료", value: String(stats.interview), sub: "명", icon: MessageSquare, color: "text-[#9F7AEA]" },
            { label: "확정 인력", value: String(stats.passed), sub: "건", icon: CheckCircle2, color: "text-[#68D391]" },
          ].map((k, i) => (
            <div key={i} className="bg-white/5 border border-white/10 rounded-[12px] p-4 hover:bg-white/10 transition-colors cursor-pointer" onClick={() => router.push('/pipeline')}>
              <div className="flex items-center gap-2 mb-2">
                <k.icon size={16} className={`${k.color}`} />
                <span className="text-[12px] text-white/70 font-medium">{k.label}</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-[26px] font-extrabold leading-none tracking-tight">{k.value}</span>
                <span className="text-[12px] text-white/50 font-medium">{k.sub}</span>
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* 2행: 유입 추이(2/3) + 오늘의 할 일(1/3) */}
      <div className="grid grid-cols-3 gap-6 items-stretch">
        {/* 최근 14일 신규 유입 추이 */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="col-span-2 bg-white border border-[#E2E8F0] rounded-[16px] p-6 shadow-sm flex flex-col">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-[15px] font-bold text-[#1A202C] flex items-center gap-1.5"><TrendingUp size={15} className="text-[#3182CE]" /> 최근 14일 신규 유입 추이</h2>
              <div className="text-[12px] text-[#718096] mt-0.5">다채널 인입 지원자의 일별 흐름</div>
            </div>
            <div className="text-right">
              <div className="text-[11px] font-bold text-[#A0AEC0]">최근 7일 합계</div>
              <div className="text-[20px] font-extrabold text-[#1A202C] leading-none tracking-tight mt-0.5">{trend7Sum}<span className="text-[12px] text-[#A0AEC0] font-bold ml-0.5">명</span></div>
            </div>
          </div>
          <div className="flex-1 min-h-[200px]">
            <ResponsiveContainer width="100%" height="100%" minHeight={180} minWidth={1}>
              <AreaChart data={trend} margin={{ top: 10, right: 8, left: -22, bottom: 0 }}>
                <defs key="defs-dashboard">
                  <linearGradient key="grad-inflow" id="dashInflow" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3182CE" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3182CE" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid key="grid" strokeDasharray="3 3" vertical={false} stroke="#EDF2F7" />
                <XAxis key="xaxis" dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#A0AEC0' }} interval={1} dy={8} />
                <YAxis key="yaxis" allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#A0AEC0' }} width={36} />
                <RechartsTooltip
                  key="tooltip"
                  contentStyle={{ borderRadius: '12px', border: '1px solid #E2E8F0', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)', fontSize: '12px' }}
                  labelStyle={{ fontWeight: 'bold', color: '#1A202C', marginBottom: '2px' }}
                />
                <Area key="area-inflow" type="monotone" dataKey="유입" stroke="#3182CE" strokeWidth={2.5} fillOpacity={1} fill="url(#dashInflow)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </motion.div>

        {/* 오늘의 할 일 (긴급 + 빈 상태 바로가기) */}
        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 }} className="bg-white border border-[#E2E8F0] rounded-[16px] p-6 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-[15px] font-bold text-[#1A202C] flex items-center gap-2">
              오늘의 할 일
              {urgent.length > 0 && <span className="bg-[#E53E3E] text-white text-[11px] px-2 py-0.5 rounded-full font-bold">{urgent.length}</span>}
            </h2>
          </div>

          <div className="flex flex-col gap-3 flex-1 overflow-y-auto">
            {urgent.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-4">
                <CheckCircle2 size={28} className="text-[#38A169] mb-2" />
                <div className="text-[13px] font-bold text-[#4A5568]">지금 처리할 긴급 항목이 없어요</div>
                <div className="text-[12px] mt-0.5 text-[#A0AEC0]">미분류 인박스·미답장 개입이 발생하면 여기 표시됩니다.</div>
                <div className="w-full mt-5 flex flex-col gap-2">
                  {[
                    { label: "파이프라인 점검", path: "/pipeline" },
                    { label: "실시간 응대 보기", path: "/live" },
                  ].map((s) => (
                    <button
                      key={s.path}
                      onClick={() => router.push(s.path)}
                      className="w-full flex items-center justify-between px-4 py-2.5 rounded-xl border border-[#E2E8F0] bg-[#F7FAFC] hover:bg-[#EDF2F7] text-[12.5px] font-bold text-[#4A5568] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
                    >
                      {s.label} <ChevronRight size={15} className="text-[#A0AEC0]" />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {urgent.map((item) => (
              <div
                key={item.id}
                onClick={() => router.push(item.path)}
                className={`p-4 border rounded-xl flex items-start gap-3 cursor-pointer transition-colors ${item.tone === "red" ? "border-[#FEB2B2] bg-[#FFF5F5] hover:border-[#FC8181]" : "border-[#E2E8F0] bg-white hover:border-[#CBD5E0]"}`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border shadow-sm ${item.tone === "red" ? "bg-white text-[#E53E3E] border-[#FEB2B2]" : "bg-[#F7FAFC] text-[#4A5568] border-[#E2E8F0]"}`}>
                  {item.tone === "red" ? <Activity size={16} /> : <PhoneCall size={16} />}
                </div>
                <div className="flex-1">
                  <div className={`text-[13px] font-bold ${item.tone === "red" ? "text-[#C53030]" : "text-[#1A202C]"}`}>{item.title}</div>
                  <div className={`text-[12px] mt-0.5 mb-2.5 ${item.tone === "red" ? "text-[#9B2C2C]" : "text-[#718096]"}`}>{item.desc}</div>
                  <span className={`text-[11.5px] font-bold px-3 py-1.5 rounded-lg ${item.tone === "red" ? "bg-[#E53E3E] text-white" : "bg-[#F1F4F8] text-[#4A5568]"}`}>
                    {item.cta}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>

      {/* 3행: 전환 퍼널(2/3) + 스크리닝·온보딩 현황(1/3) — 2행과 동일 grid로 컬럼 정렬 */}
      <div className="grid grid-cols-3 gap-6 items-stretch">
        {/* 전환 퍼널 (가로형 · 단계 간 전환율 강조) */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="col-span-2 bg-white border border-[#E2E8F0] rounded-[16px] p-6 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-[15px] font-bold text-[#1A202C]">파이프라인 전환 퍼널</h2>
              <div className="text-[12px] text-[#718096] mt-0.5">유입부터 확정 인력까지 단계별 전환율</div>
            </div>
            <button onClick={() => router.push('/pipeline')} className="text-[12px] font-bold text-[#3182CE] bg-[#EBF8FF] hover:bg-[#BEE3F8] px-3 py-1.5 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40">
              상세 보기
            </button>
          </div>

          <div className="flex flex-col gap-3 flex-1 justify-center">
            {funnel.map((f, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-[88px] shrink-0 text-[12.5px] font-bold text-[#4A5568] text-right">{f.step}</div>
                <div className="flex-1 h-9 bg-[#F7FAFC] rounded-lg overflow-hidden relative">
                  <div
                    className="h-full rounded-lg transition-all duration-500 flex items-center px-3"
                    style={{ width: `${Math.max(f.pctTotal, 6)}%`, backgroundColor: f.color }}
                  >
                    <span className={`text-[13px] font-extrabold ${i === funnel.length - 1 ? "text-white" : "text-[#2D3748]"}`}>{f.val.toLocaleString()}</span>
                  </div>
                </div>
                <div className="w-[92px] shrink-0 flex items-center justify-end gap-1.5">
                  <span className="text-[12px] font-bold text-[#1A202C]">{f.pctTotal}%</span>
                  {f.conv !== null && (
                    <span className="text-[10.5px] font-bold text-[#718096] bg-[#EDF2F7] px-1.5 py-0.5 rounded">전환 {f.conv}%</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* 스크리닝 · 온보딩 현황 (실데이터) */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="bg-white border border-[#E2E8F0] rounded-[16px] p-5 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[14px] font-bold text-[#1A202C] flex items-center gap-1.5"><ClipboardCheck size={15} className="text-[#3182CE]" /> 스크리닝 · 온보딩 현황</h2>
            <button onClick={() => router.push('/live')} className="text-[11.5px] font-bold text-[#3182CE] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40 rounded">응대로</button>
          </div>

          {/* 단계별 */}
          <div className="grid grid-cols-2 gap-2 mb-4">
            {[
              { label: "탐색", value: flow.exploration, color: "text-[#718096]", bg: "bg-[#F7FAFC]" },
              { label: "스크리닝", value: flow.screening, color: "text-[#D69E2E]", bg: "bg-[#FFFBEB]" },
              { label: "온보딩", value: flow.onboarding, color: "text-[#805AD5]", bg: "bg-[#FAF5FF]" },
              { label: "활성", value: flow.active, color: "text-[#38A169]", bg: "bg-[#F0FFF4]" },
            ].map((s) => (
              <div key={s.label} className={`rounded-xl px-3 py-2 ${s.bg}`}>
                <div className="text-[11px] font-bold text-[#718096]">{s.label}</div>
                <div className={`text-[18px] font-extrabold tracking-tight ${s.color}`}>{s.value}<span className="text-[11px] text-[#A0AEC0] ml-0.5">건</span></div>
              </div>
            ))}
          </div>

          {/* 온보딩 체크 진행도 */}
          <div className="border-t border-[#F1F4F8] pt-3 space-y-2.5">
            <div className="text-[11.5px] font-bold text-[#718096] flex items-center justify-between">온보딩 진행 <span className="text-[#A0AEC0] font-medium">대상 {flow.targets}명</span></div>
            {[
              { label: "가이드 전달", value: flow.guideSent, icon: ClipboardCheck, color: "#38A169" },
              { label: "배민 ID 수신", value: flow.baeminId, icon: Smartphone, color: "#3182CE" },
              { label: "온보딩 통화", value: flow.called, icon: PhoneCall, color: "#805AD5" },
            ].map((m) => (
              <div key={m.label}>
                <div className="flex items-center justify-between text-[11.5px] mb-1">
                  <span className="flex items-center gap-1.5 font-semibold text-[#4A5568]"><m.icon size={12} style={{ color: m.color }} /> {m.label}</span>
                  <span className="font-bold text-[#1A202C]">{m.value}/{flow.targets}</span>
                </div>
                <div className="h-1.5 bg-[#EDF2F7] rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${flow.pct(m.value)}%`, backgroundColor: m.color }} />
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>

      {/* 4행: 지역별 인재풀 분포 Top 5 (지도 SDK 없는 경량 요약 · 클릭 시 파이프라인 지도로) */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="bg-white border border-[#E2E8F0] rounded-[16px] p-6 shadow-sm flex flex-col">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-[15px] font-bold text-[#1A202C] flex items-center gap-1.5"><MapPin size={15} className="text-[#3182CE]" /> 지역별 인재풀 분포</h2>
            <div className="text-[12px] text-[#718096] mt-0.5">거주지(시/군/구) 기준 상위 5개 지역</div>
          </div>
          <button onClick={() => router.push('/pipeline?view=map')} className="text-[12px] font-bold text-[#3182CE] bg-[#EBF8FF] hover:bg-[#BEE3F8] px-3 py-1.5 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40">
            지도에서 보기
          </button>
        </div>

        {regionDist.top.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-[#A0AEC0]">집계할 지역 데이터가 없어요.</div>
        ) : (
          <div className="flex flex-col gap-3">
            {regionDist.top.map((r) => (
              <div key={r.region} className="flex items-center gap-3">
                <div className="w-[120px] shrink-0 text-[12.5px] font-bold text-[#4A5568] text-right truncate" title={r.region}>{r.region}</div>
                <div className="flex-1 h-8 bg-[#F7FAFC] rounded-lg overflow-hidden relative">
                  <div
                    className="h-full rounded-lg transition-all duration-500 flex items-center px-3 bg-[#63B3ED]"
                    style={{ width: `${Math.max(Math.round((r.count / regionDist.max) * 100), 8)}%` }}
                  >
                    <span className="text-[12.5px] font-extrabold text-[#2D3748]">{r.count.toLocaleString()}</span>
                  </div>
                </div>
                <div className="w-[40px] shrink-0 text-[12px] font-bold text-[#A0AEC0] text-right">명</div>
              </div>
            ))}
            {regionDist.unknownCount > 0 && (
              <div className="text-[11.5px] text-[#A0AEC0] mt-1">주소 미입력 {regionDist.unknownCount.toLocaleString()}명 (지도/분포 집계 제외)</div>
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
}

// 첫 진입(캐시 없음) 로딩 중 0값 깜빡임을 막는 스켈레톤. 실제 레이아웃 골격과 동일한 그리드 사용.
function DashboardSkeleton() {
  return (
    <div className="p-8 pb-12 flex flex-col gap-6 bg-[#F7FAFC] min-h-full">
      <div className="bg-[#1A202C] rounded-[20px] p-8 shadow-md">
        <div className="flex items-center justify-between mb-8">
          <div className="space-y-2">
            <Skeleton className="h-5 w-64 bg-white/10" />
            <Skeleton className="h-3 w-48 bg-white/10" />
          </div>
          <Skeleton className="h-9 w-36 rounded-xl bg-white/10" />
        </div>
        <div className="grid grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-[12px] bg-white/10" />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-6 items-stretch">
        <Skeleton className="col-span-2 h-[280px] rounded-[16px]" />
        <Skeleton className="h-[280px] rounded-[16px]" />
      </div>
      <div className="grid grid-cols-3 gap-6 items-stretch">
        <Skeleton className="col-span-2 h-[240px] rounded-[16px]" />
        <Skeleton className="h-[240px] rounded-[16px]" />
      </div>
      <Skeleton className="h-[220px] rounded-[16px]" />
    </div>
  );
}
