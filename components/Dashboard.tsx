import { ArrowRight, TrendingUp, Users, MousePointerClick, MessageSquare, CheckCircle2, Activity, PhoneCall, ClipboardCheck, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
import { motion } from "motion/react";
import { useBranchScope, matchesBranchScope } from "@/lib/branch-scope";

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
}

export function Dashboard() {
  const router = useRouter();
  const { branch: scopeBranch } = useBranchScope();
  const [rawApps, setRawApps] = useState<AppRow[]>([]);
  const [inboxCount, setInboxCount] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const [aRes, iRes] = await Promise.all([
          fetch("/api/admin/applicants"),
          fetch("/api/admin/inbox/pending"),
        ]);
        setRawApps(((await aRes.json()).data ?? []) as AppRow[]);
        setInboxCount((((await iRes.json()).data ?? []) as unknown[]).length);
      } catch {
        /* 대시보드 통계는 실패해도 화면은 유지 */
      }
    })();
  }, []);

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

  return (
    <div className="p-8 pb-12 flex flex-col gap-6 bg-[#F7FAFC] min-h-full">
      {/* Top Section: Overview */}
      <div className="grid grid-cols-[1.8fr_1fr] gap-6">
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="bg-[#1A202C] rounded-[20px] p-8 relative overflow-hidden shadow-md text-white flex flex-col justify-between">
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
            <button onClick={() => router.push('/pipeline')} className="px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/10 rounded-xl text-[13px] font-bold transition-all flex items-center gap-2 shadow-sm outline-none">
              파이프라인 상세 보기 <ArrowRight size={14} />
            </button>
          </div>

          <div className="relative z-10 grid grid-cols-4 gap-4">
            {[
              { label: "신규 유입 (금일)", value: String(stats.today), sub: "명", icon: Users, color: "text-[#63B3ED]" },
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

        {/* Actionable To-Do List (Urgent) */}
        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }} className="bg-white border border-[#E2E8F0] rounded-[20px] p-6 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-[15px] font-bold text-[#1A202C] flex items-center gap-2">
              실무자 긴급 확인 사항
              {urgent.length > 0 && <span className="bg-[#E53E3E] text-white text-[11px] px-2 py-0.5 rounded-full font-bold">{urgent.length}</span>}
            </h2>
          </div>

          <div className="flex flex-col gap-3 flex-1 overflow-y-auto">
            {urgent.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-8 text-[#A0AEC0]">
                <CheckCircle2 size={28} className="text-[#38A169] mb-2" />
                <div className="text-[13px] font-bold text-[#4A5568]">지금 처리할 긴급 항목이 없어요</div>
                <div className="text-[12px] mt-0.5">미분류 인박스·미답장 개입이 발생하면 여기 표시됩니다.</div>
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

      <div className="grid grid-cols-[1fr_1.8fr_1fr] gap-6">
        {/* KPI List */}
        <div className="flex flex-col gap-4">
          {[
            { label: "총 누적 인재풀 DB", value: stats.total.toLocaleString(), unit: "명", up: true, bg: "bg-white" },
            { label: "확정 인력", value: stats.passed.toLocaleString(), unit: "명", up: true, bg: "bg-white" },
            { label: "스크리닝 진행 중", value: stats.screening.toLocaleString(), unit: "명", up: true, bg: "bg-white" },
          ].map((k, i) => (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 + i * 0.05 }} key={i} className={`border border-[#E2E8F0] rounded-[16px] p-5 shadow-sm flex items-center justify-between flex-1 ${k.bg}`}>
              <div>
                <div className="text-[12px] font-bold text-[#718096] mb-1">{k.label}</div>
                <div className="flex items-baseline gap-1">
                  <span className="text-[22px] font-extrabold text-[#1A202C] leading-none tracking-tight">{k.value}</span>
                  <span className="text-[13px] font-bold text-[#A0AEC0]">{k.unit}</span>
                </div>
              </div>
              <div className="w-10 h-10 rounded-full bg-[#F0FFF4] flex items-center justify-center text-[#38A169]">
                <TrendingUp size={18} />
              </div>
            </motion.div>
          ))}
        </div>

        {/* Funnel Visualizer */}
        <div className="bg-white border border-[#E2E8F0] rounded-[16px] p-6 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-[15px] font-bold text-[#1A202C]">파이프라인 전환 퍼널</h2>
              <div className="text-[12px] text-[#718096] mt-0.5">다채널 소싱부터 캘린더 면접 예약까지의 전환율</div>
            </div>
            <button onClick={() => router.push('/pipeline')} className="text-[12px] font-bold text-[#3182CE] bg-[#EBF8FF] hover:bg-[#BEE3F8] px-3 py-1.5 rounded-lg transition-colors outline-none">
              상세 보기
            </button>
          </div>
          
          <div className="flex justify-between items-end flex-1 px-2 pb-2">
            {[
              { step: "다채널 유입", val: stats.total, pct: "100%", color: "#E2E8F0" },
              { step: "AI 스크리닝", val: stats.screening + stats.interview + stats.passed, pct: `${stats.total ? Math.round(((stats.screening + stats.interview + stats.passed) / stats.total) * 100) : 0}%`, color: "#CBD5E0" },
              { step: "1차 요건 통과", val: stats.interview + stats.passed, pct: `${stats.total ? Math.round(((stats.interview + stats.passed) / stats.total) * 100) : 0}%`, color: "#A0AEC0" },
              { step: "최종 합격", val: stats.passed, pct: `${stats.total ? Math.round((stats.passed / stats.total) * 100) : 0}%`, color: "#3182CE" },
            ].map((f, i) => (
              <div key={i} className="flex flex-col items-center flex-1 group relative">
                <div className="text-[13px] font-extrabold text-[#1A202C] mb-1.5">{f.val}</div>
                <div className="w-full px-2">
                  <div className="w-full rounded-t-md transition-all duration-300 group-hover:opacity-80" style={{ height: `${parseInt(f.pct)}px`, backgroundColor: f.color, minHeight: '20px' }}></div>
                </div>
                <div className="text-[11.5px] font-bold text-[#4A5568] mt-2.5 text-center">{f.step}</div>
                <div className="text-[10px] font-bold text-[#A0AEC0]">{f.pct}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 스크리닝 · 온보딩 현황 (실데이터) */}
        <div className="bg-white border border-[#E2E8F0] rounded-[16px] p-5 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[14px] font-bold text-[#1A202C] flex items-center gap-1.5"><ClipboardCheck size={15} className="text-[#3182CE]" /> 스크리닝 · 온보딩 현황</h2>
            <button onClick={() => router.push('/live')} className="text-[11.5px] font-bold text-[#3182CE] hover:underline outline-none">응대로</button>
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
        </div>
      </div>
    </div>
  );
}