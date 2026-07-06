import { useState, useEffect, useMemo } from "react";
import useSWR from "swr";
import { CheckCircle2, Users, Briefcase, Activity, Play, Power, Inbox } from "lucide-react";
import { toast } from "sonner";

interface AutoStats {
  aiDisabled: boolean;
  screening: number;
  confirmed: number;
  waiting: number;
  inbox: number;
  activeJobs: number;
  loading: boolean;
}

interface RuleDef {
  id: string;
  label: string;
  desc: string;
  hasThreshold: boolean;
  defaultThreshold?: number;
  unit?: string;
}
interface RuleConfig {
  enabled: boolean;
  threshold?: number;
}
interface RuleResult {
  id: string;
  triggered: boolean;
  detail: string;
}

export function Automation() {
  // 자동 점검 규칙 (실동작) — 정의는 SWR로, 설정은 로컬에서 편집/저장하므로 첫 로드 시 시드.
  const { data: rulesApi } = useSWR<{ rules?: RuleDef[]; config?: Record<string, RuleConfig> }>("/api/admin/automation/rules");
  const ruleDefs = useMemo(() => rulesApi?.rules ?? [], [rulesApi]);
  const [ruleConfig, setRuleConfig] = useState<Record<string, RuleConfig>>({});
  const [ruleResults, setRuleResults] = useState<Record<string, RuleResult>>({});
  const [ruleRunning, setRuleRunning] = useState(false);
  const [ruleRanAt, setRuleRanAt] = useState<string | null>(null);

  useEffect(() => {
    if (rulesApi?.config) setRuleConfig(rulesApi.config);
  }, [rulesApi]);

  const persistConfig = async (next: Record<string, RuleConfig>) => {
    try {
      await fetch("/api/admin/automation/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: next }),
      });
    } catch {
      toast.error("규칙 저장에 실패했어요");
    }
  };

  const toggleRule = (id: string) => {
    const next = { ...ruleConfig, [id]: { ...ruleConfig[id], enabled: !ruleConfig[id]?.enabled } };
    setRuleConfig(next);
    persistConfig(next);
  };

  const setThreshold = (id: string, value: number) => {
    const next = { ...ruleConfig, [id]: { ...ruleConfig[id], threshold: Math.max(0, value) } };
    setRuleConfig(next);
  };

  const runEvaluate = async () => {
    if (ruleRunning) return;
    setRuleRunning(true);
    try {
      await persistConfig(ruleConfig); // 최신 임계값 반영 후 평가
      const res = await fetch("/api/admin/automation/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notify: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "점검 실행에 실패했어요");
        return;
      }
      const map: Record<string, RuleResult> = {};
      for (const r of (json.results ?? []) as RuleResult[]) map[r.id] = r;
      setRuleResults(map);
      setRuleRanAt(json.ran_at ?? new Date().toISOString());
      if (json.triggered_count > 0) {
        toast.warning(`조치 필요 ${json.triggered_count}건 감지${json.notified ? " · 슬랙 발송됨" : " (슬랙 미설정)"}`);
      } else {
        toast.success("점검 완료 — 조치 필요 항목 없음");
      }
    } catch {
      toast.error("점검 실행에 실패했어요");
    } finally {
      setRuleRunning(false);
    }
  };

  // 상단 통계는 여러 엔드포인트 조합 — 모두 SWR로 캐시·dedup(타 탭과 키 공유).
  const { data: appsRes, isLoading: appsLoading } = useSWR<{ data?: { status: string }[] }>("/api/admin/applicants");
  const { data: killRes } = useSWR<{ disabled?: boolean; env_forced?: boolean }>("/api/admin/agent/kill-switch");
  const { data: inboxRes } = useSWR<{ data?: unknown[] }>("/api/admin/inbox/pending");
  const { data: activeJobsRes } = useSWR<{ jobs?: { title: string }[] }>("/api/admin/jobs?status=active");
  const stats = useMemo<AutoStats>(() => {
    const apps = appsRes?.data ?? [];
    const by = (s: string) => apps.filter((a) => a.status === s).length;
    return {
      aiDisabled: !!killRes?.disabled || !!killRes?.env_forced,
      screening: by("스크리닝 중"),
      confirmed: by("확정인력"),
      waiting: by("대기자"),
      inbox: (inboxRes?.data ?? []).length,
      activeJobs: (activeJobsRes?.jobs ?? []).filter((j) => !String(j.title).startsWith("__")).length,
      loading: appsLoading && (appsRes?.data?.length ?? 0) === 0,
    };
  }, [appsRes, killRes, inboxRes, activeJobsRes, appsLoading]);

  const kpis = [
    {
      label: "AI 자동응답",
      value: stats.loading ? "…" : stats.aiDisabled ? "중단됨" : "작동 중",
      icon: Power,
      tone: stats.aiDisabled ? "text-[#E53E3E]" : "text-[#38A169]",
      live: !stats.aiDisabled,
    },
    { label: "스크리닝 진행 중", value: stats.loading ? "…" : `${stats.screening}명`, icon: Activity, tone: "text-[#D69E2E]" },
    { label: "확정 인력", value: stats.loading ? "…" : `${stats.confirmed}명`, icon: CheckCircle2, tone: "text-[#3182CE]" },
    { label: "대기자", value: stats.loading ? "…" : `${stats.waiting}명`, icon: Users, tone: "text-[#718096]" },
    { label: "미분류 인박스", value: stats.loading ? "…" : `${stats.inbox}건`, icon: Inbox, tone: stats.inbox > 0 ? "text-[#E53E3E]" : "text-[#718096]" },
    { label: "진행 중 공고", value: stats.loading ? "…" : `${stats.activeJobs}건`, icon: Briefcase, tone: "text-[#1A202C]" },
  ];

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#F7FAFC]">
      {/* 실시간 자동화 현황 (실데이터) */}
      <div className="shrink-0 bg-white border-b border-[#E2E8F0] px-6 py-3.5">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="text-[12px] font-extrabold tracking-wide text-[#1A202C]">실시간 자동화 현황</span>
          <span className="text-[11px] font-bold text-[#38A169] bg-[#F0FFF4] border border-[#C6F6D5] px-1.5 py-0.5 rounded">LIVE · 실데이터</span>
        </div>
        <div className="grid grid-cols-6 gap-3">
          {kpis.map((k, i) => (
            <div key={i} className="border border-[#E2E8F0] rounded-xl px-3.5 py-2.5 bg-[#FCFDFE]">
              <div className="flex items-center gap-1.5 text-[11.5px] font-bold text-[#718096] mb-1">
                <k.icon size={13} className={k.tone} /> {k.label}
              </div>
              <div className={`text-[18px] font-extrabold tracking-tight flex items-center gap-1.5 ${k.tone}`}>
                {k.value}
                {k.live && <span className="w-1.5 h-1.5 rounded-full bg-[#38A169] animate-pulse" />}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 자동 점검 규칙 (실동작) */}
      <div className="shrink-0 bg-white border-b border-[#E2E8F0] px-6 py-3.5">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-extrabold tracking-wide text-[#1A202C]">자동 점검 규칙</span>
            <span className="text-[11px] font-bold text-[#38A169] bg-[#F0FFF4] border border-[#C6F6D5] px-1.5 py-0.5 rounded">실동작</span>
            {ruleRanAt && <span className="text-[11px] text-[#A0AEC0]">최근 점검: {new Date(ruleRanAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span>}
          </div>
          <button
            onClick={runEvaluate}
            disabled={ruleRunning}
            className="flex items-center gap-1.5 bg-[#1A202C] hover:bg-[#2D3748] text-white px-3.5 py-1.5 rounded-lg text-[12.5px] font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] disabled:opacity-60"
          >
            <Play size={13} /> {ruleRunning ? "점검 중…" : "지금 점검 실행"}
          </button>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {ruleDefs.map((rule) => {
            const cfg = ruleConfig[rule.id] ?? { enabled: false };
            const result = ruleResults[rule.id];
            return (
              <div key={rule.id} className={`border rounded-xl px-3.5 py-2.5 ${cfg.enabled ? "border-[#E2E8F0] bg-[#FCFDFE]" : "border-[#EDF2F7] bg-[#F7FAFC] opacity-70"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-bold text-[#1A202C] truncate">{rule.label}</div>
                    <div className="text-[11px] text-[#718096] leading-tight mt-0.5 line-clamp-2">{rule.desc}</div>
                  </div>
                  <button
                    onClick={() => toggleRule(rule.id)}
                    className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${cfg.enabled ? "bg-[#38A169]" : "bg-[#CBD5E0]"}`}
                    title={cfg.enabled ? "켜짐" : "꺼짐"}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${cfg.enabled ? "left-[18px]" : "left-0.5"}`} />
                  </button>
                </div>
                <div className="flex items-center justify-between mt-2 gap-2">
                  {rule.hasThreshold ? (
                    <label className="flex items-center gap-1.5 text-[11px] font-bold text-[#718096]">
                      기준
                      <input
                        type="number"
                        min={0}
                        value={cfg.threshold ?? rule.defaultThreshold ?? 0}
                        onChange={(e) => setThreshold(rule.id, Number(e.target.value))}
                        onBlur={() => persistConfig(ruleConfig)}
                        disabled={!cfg.enabled}
                        className="w-14 border border-[#E2E8F0] rounded-md px-2 py-1 text-[12px] text-[#1A202C] outline-none focus:border-[#3182CE] disabled:bg-[#EDF2F7]"
                      />
                      {rule.unit}
                    </label>
                  ) : (
                    <span className="text-[11px] text-[#A0AEC0]">조건형</span>
                  )}
                  {result ? (
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${result.triggered ? "bg-[#FFF5F5] text-[#E53E3E] border border-[#FEB2B2]" : "bg-[#F0FFF4] text-[#38A169] border border-[#C6F6D5]"}`}>
                      {result.triggered ? "조치 필요" : "정상"}
                    </span>
                  ) : (
                    <span className="text-[11px] text-[#CBD5E0] font-bold">미점검</span>
                  )}
                </div>
                {result && <div className="text-[11px] text-[#718096] mt-1.5">{result.detail}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}