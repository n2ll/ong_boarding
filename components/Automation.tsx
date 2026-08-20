import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import useSWR from "swr";
import { AlertTriangle, ArrowRight, CheckCircle2, Users, Briefcase, Activity, Play, Power, Inbox, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { automationOverview, type AutomationAiMetric, type AutomationMetric } from "@/lib/admin/automation-view";
import { saveAutomationConfig } from "@/lib/admin/automation-config-action";

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

function metricValue(metric: AutomationMetric | AutomationAiMetric, suffix = "") {
  if (metric.state === "loading") return "확인 중";
  if (metric.state === "error") return "확인 실패";
  return typeof metric.value === "number" ? `${metric.value}${suffix}` : metric.value;
}

export function Automation() {
  // 자동 점검 규칙 (실동작) — 정의는 SWR로, 설정은 로컬에서 편집/저장하므로 첫 로드 시 시드.
  const {
    data: rulesApi,
    error: rulesError,
    isLoading: rulesLoading,
    isValidating: rulesValidating,
    mutate: mutateRules,
  } = useSWR<{ rules?: RuleDef[]; config?: Record<string, RuleConfig> }>("/api/admin/automation/rules", { revalidateOnFocus: false });
  const ruleDefs = useMemo(() => rulesApi?.rules ?? [], [rulesApi]);
  const [ruleConfig, setRuleConfig] = useState<Record<string, RuleConfig>>({});
  const [persistedRuleConfig, setPersistedRuleConfig] = useState<Record<string, RuleConfig>>({});
  const [ruleResults, setRuleResults] = useState<Record<string, RuleResult>>({});
  const [ruleRunning, setRuleRunning] = useState(false);
  const [ruleRanAt, setRuleRanAt] = useState<string | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaveState, setConfigSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (rulesApi?.config) {
      setRuleConfig(rulesApi.config);
      setPersistedRuleConfig(rulesApi.config);
    }
  }, [rulesApi]);

  const persistConfig = async (next: Record<string, RuleConfig>) => {
    setConfigSaving(true);
    setConfigSaveState("saving");
    const result = await saveAutomationConfig(next);
    setConfigSaving(false);
    if (!result.ok) {
      setConfigSaveState("error");
      toast.error(result.error);
      return false;
    }
    setRuleConfig(result.config);
    setPersistedRuleConfig(result.config);
    setConfigSaveState("saved");
    return true;
  };

  const toggleRule = async (id: string) => {
    if (configSaving) return;
    const previous = ruleConfig;
    const next = { ...ruleConfig, [id]: { ...ruleConfig[id], enabled: !ruleConfig[id]?.enabled } };
    setRuleConfig(next);
    if (!(await persistConfig(next))) setRuleConfig(previous);
  };

  const setThreshold = (id: string, value: number) => {
    const next = { ...ruleConfig, [id]: { ...ruleConfig[id], threshold: Math.max(0, value) } };
    setRuleConfig(next);
    setConfigSaveState("idle");
  };

  const saveThreshold = async () => {
    if (!(await persistConfig(ruleConfig))) setRuleConfig(persistedRuleConfig);
  };

  const runEvaluate = async () => {
    if (ruleRunning) return;
    setRuleRunning(true);
    try {
      if (!(await persistConfig(ruleConfig))) return; // 최신 임계값 저장 실패 시 이전 기준으로 점검하지 않는다.
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
  // scope=rollup — 이 화면은 지원자를 나열하지 않고 숫자만 그린다. 이름·전화·주소를 받지 않는
  // 10컬럼 응답(gzip 85KB → 16KB)이고, 조립 조회 3개도 서버가 건너뛴다.
  // 리포트·슬롯보드·지점·자동화가 **같은 키**를 써야 SWR dedup이 유지된다.
  const {
    data: appsRes,
    error: appsError,
    isValidating: appsValidating,
    mutate: mutateApps,
  } = useSWR<{ data?: { status: string }[] }>("/api/admin/applicants?scope=rollup", { refreshInterval: 60_000 });
  const {
    data: killRes,
    error: killError,
    isValidating: killValidating,
    mutate: mutateKill,
  } = useSWR<{ disabled?: boolean; env_forced?: boolean }>("/api/admin/agent/kill-switch", { refreshInterval: 60_000 });
  const {
    data: inboxRes,
    error: inboxError,
    isValidating: inboxValidating,
    mutate: mutateInbox,
  } = useSWR<{ data?: unknown[] }>("/api/admin/inbox/pending", { refreshInterval: 60_000 });
  const {
    data: activeJobsRes,
    error: activeJobsError,
    isValidating: activeJobsValidating,
    mutate: mutateActiveJobs,
  } = useSWR<{ jobs?: { title: string }[] }>("/api/admin/jobs?status=active", { refreshInterval: 60_000 });
  const stats = useMemo(() => automationOverview({
    applicants: appsRes?.data,
    applicantsError: Boolean(appsError),
    killSwitch: killRes,
    killSwitchError: Boolean(killError),
    inbox: inboxRes?.data,
    inboxError: Boolean(inboxError),
    activeJobs: activeJobsRes?.jobs,
    activeJobsError: Boolean(activeJobsError),
  }), [appsRes, appsError, killRes, killError, inboxRes, inboxError, activeJobsRes, activeJobsError]);

  const hasOverviewError = Object.values(stats).some((metric) => metric.state === "error");
  const overviewRefreshing = appsValidating || killValidating || inboxValidating || activeJobsValidating;
  const refreshOverview = () => {
    void Promise.all([mutateApps(), mutateKill(), mutateInbox(), mutateActiveJobs()]);
  };

  const kpis = [
    {
      label: "AI 자동응답",
      value: metricValue(stats.ai),
      icon: Power,
      tone: stats.ai.state === "error" || stats.ai.disabled ? "text-error" : stats.ai.state === "ready" ? "text-success" : "text-muted-foreground",
      live: stats.ai.state === "ready" && stats.ai.disabled === false,
      href: "/brain",
      action: "에이전트 설정",
    },
    { label: "스크리닝 진행 중", value: metricValue(stats.screening, "명"), icon: Activity, tone: stats.screening.state === "error" ? "text-error" : "text-warning-strong", href: "/live", action: "라이브 보기" },
    { label: "확정 인력", value: metricValue(stats.confirmed, "명"), icon: CheckCircle2, tone: stats.confirmed.state === "error" ? "text-error" : "text-info", href: "/pipeline?status=확정인력", action: "인력풀 보기" },
    { label: "대기자", value: metricValue(stats.waiting, "명"), icon: Users, tone: stats.waiting.state === "error" ? "text-error" : "text-muted-foreground", href: "/pipeline?status=대기자", action: "대기자 보기" },
    { label: "분류 필요한 문자", value: metricValue(stats.inbox, "건"), icon: Inbox, tone: stats.inbox.state === "error" || (stats.inbox.value ?? 0) > 0 ? "text-error" : "text-muted-foreground", href: "/live?tab=inbox", action: "문자 분류" },
    { label: "진행 중 공고", value: metricValue(stats.activeJobs, "건"), icon: Briefcase, tone: stats.activeJobs.state === "error" ? "text-error" : "text-foreground", href: "/jobs", action: "공고 운영" },
  ];

  return (
    // 워크벤치 명문화: bg-background 바닥 위에 밴드가 bg-card 표면으로 놓인다.
    <div className="flex min-h-full flex-col bg-background">
      {/* 자동화 운영 현황 (실데이터) */}
      <div className="shrink-0 bg-card border-b border-border-strong px-8 py-4">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-[13px] font-extrabold tracking-wide text-foreground">자동화 운영 상태</h1>
              <span className="rounded-full border border-border-strong bg-muted px-2 py-0.5 text-[12px] font-bold text-muted-foreground">60초마다 갱신</span>
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">상태를 확인하고, 조치가 필요한 업무 화면으로 바로 이동하세요.</p>
          </div>
          <button
            type="button"
            onClick={refreshOverview}
            disabled={overviewRefreshing}
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border-strong bg-card px-3 text-[12px] font-bold text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <RotateCw size={14} className={overviewRefreshing ? "animate-spin" : ""} />
            {overviewRefreshing ? "확인 중" : "새로고침"}
          </button>
        </div>
        {hasOverviewError && (
          <div role="alert" className="mb-3 flex items-center gap-2 rounded-xl border border-error/30 bg-error-soft px-3 py-2 text-[12px] font-bold text-error-strong">
            <AlertTriangle size={15} className="shrink-0" />
            일부 상태를 확인하지 못했습니다. 실패한 항목은 숫자로 표시하지 않습니다.
          </div>
        )}
        {stats.ai.disabled === true && (
          <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-error/30 bg-error-soft px-3 py-2">
            <div className="flex items-center gap-2 text-[12px] font-bold text-error-strong">
              <AlertTriangle size={15} className="shrink-0" />
              AI 자동응답이 중단되어 있습니다. 지원자 응대가 쌓이기 전에 설정을 확인하세요.
            </div>
            <Link href="/brain" className="shrink-0 rounded-lg px-2 py-1.5 text-[12px] font-extrabold text-error-strong outline-none hover:bg-error/10 focus-visible:ring-2 focus-visible:ring-ring">
              설정 확인
            </Link>
          </div>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {kpis.map((k) => (
            <Link
              key={k.label}
              href={k.href}
              aria-label={`${k.label} ${k.value} · ${k.action}`}
              className="group min-w-0 rounded-2xl border border-border-strong bg-surface-raised px-3.5 py-2.5 outline-none transition-[border-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex items-center gap-1.5 text-[12px] font-bold text-muted-foreground mb-1">
                <k.icon size={13} className={k.tone} /> {k.label}
              </div>
              <div className={`flex items-center gap-1.5 text-[18px] font-extrabold tracking-tight ${k.tone}`}>
                <span className="truncate">{k.value}</span>
                {k.live && <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />}
              </div>
              <div className="mt-1.5 flex items-center gap-1 text-[12px] font-bold text-muted-foreground transition-colors group-hover:text-foreground">
                {k.action} <ArrowRight size={11} />
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* 자동 점검 규칙 (실동작) */}
      <div className="shrink-0 bg-card border-b border-border-strong px-8 py-4">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[13px] font-extrabold tracking-wide text-foreground">자동 점검 규칙</h2>
              <span className="rounded-full border border-success/25 bg-success-soft px-2 py-0.5 text-[12px] font-bold text-success-strong">실제 데이터 점검</span>
              {ruleRanAt && <span className="text-[12px] text-muted-foreground">최근 점검: {new Date(ruleRanAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span>}
              {configSaveState !== "idle" && (
                <span
                  role="status"
                  className={`text-[12px] font-bold ${configSaveState === "error" ? "text-error" : configSaveState === "saved" ? "text-success-strong" : "text-muted-foreground"}`}
                >
                  {configSaveState === "saving" ? "설정 저장 중…" : configSaveState === "saved" ? "설정 저장됨" : "설정 저장 실패"}
                </span>
              )}
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">점검에서 조치 필요 항목이 발견되면 Slack 알림을 1회 전송합니다.</p>
          </div>
          <button
            onClick={runEvaluate}
            disabled={ruleRunning || configSaving || rulesLoading || Boolean(rulesError) || ruleDefs.length === 0}
            className="min-h-11 flex items-center gap-1.5 bg-foreground hover:bg-gray-800 text-white px-3.5 py-1.5 rounded-lg text-[13px] font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <Play size={13} /> {ruleRunning ? "점검 중…" : "지금 점검 실행"}
          </button>
        </div>
        {rulesError && (
          <div role="alert" className="flex min-h-[112px] items-center justify-between gap-4 rounded-2xl border border-error/30 bg-error-soft px-4 py-3">
            <div>
              <div className="flex items-center gap-2 text-[13px] font-extrabold text-error-strong"><AlertTriangle size={15} /> 규칙을 불러오지 못했습니다</div>
              <p className="mt-1 text-[12px] text-error-strong/80">점검과 설정 변경을 잠시 중단했습니다.</p>
            </div>
            <button
              type="button"
              onClick={() => void mutateRules()}
              disabled={rulesValidating}
              className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-error/30 bg-card px-3 text-[12px] font-bold text-error-strong outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <RotateCw size={14} className={rulesValidating ? "animate-spin" : ""} /> 다시 시도
            </button>
          </div>
        )}
        {rulesLoading && !rulesError && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-label="자동 점검 규칙 불러오는 중">
            {[0, 1, 2, 3].map((item) => <div key={item} className="h-[112px] animate-pulse rounded-2xl border border-border bg-muted/60" />)}
          </div>
        )}
        {!rulesLoading && !rulesError && ruleDefs.length === 0 && (
          <div className="flex min-h-[112px] items-center justify-center rounded-2xl border border-dashed border-border-strong bg-background text-[12px] font-bold text-muted-foreground">사용 가능한 점검 규칙이 없습니다.</div>
        )}
        {!rulesLoading && !rulesError && ruleDefs.length > 0 && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {ruleDefs.map((rule) => {
            const cfg = ruleConfig[rule.id] ?? { enabled: false };
            const result = ruleResults[rule.id];
            return (
              <div key={rule.id} className={`border rounded-2xl px-3.5 py-2.5 ${cfg.enabled ? "border-border-strong bg-surface-raised" : "border-muted bg-background opacity-70"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold text-foreground truncate">{rule.label}</div>
                    <div className="text-[12px] text-muted-foreground leading-tight mt-0.5 line-clamp-2">{rule.desc}</div>
                  </div>
                  <button type="button" aria-label={`${rule.label} 규칙 ${cfg.enabled ? "끄기" : "켜기"}`} aria-checked={cfg.enabled} aria-busy={configSaving} role="switch"
                    onClick={() => void toggleRule(rule.id)}
                    disabled={configSaving}
                    className={`after:absolute after:-inset-3 after:content-[''] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background shrink-0 w-9 h-5 rounded-full transition-colors relative disabled:cursor-wait disabled:opacity-60 ${cfg.enabled ? "bg-success" : "bg-switch-background"}`}
                    title={cfg.enabled ? "켜짐" : "꺼짐"}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${cfg.enabled ? "left-[18px]" : "left-0.5"}`} />
                  </button>
                </div>
                <div className="flex items-center justify-between mt-2 gap-2">
                  {rule.hasThreshold ? (
                    <label className="flex items-center gap-1.5 text-[12px] font-bold text-muted-foreground">
                      기준
                      <input
                        type="number"
                        min={0}
                        value={cfg.threshold ?? rule.defaultThreshold ?? 0}
                        onChange={(e) => setThreshold(rule.id, Number(e.target.value))}
                        onBlur={() => void saveThreshold()}
                        disabled={!cfg.enabled || configSaving}
                        className="h-9 w-16 rounded-lg border border-border-strong bg-input-background px-2 text-[12px] text-foreground outline-none focus:border-info focus-visible:ring-2 focus-visible:ring-ring disabled:bg-muted"
                      />
                      {rule.unit}
                    </label>
                  ) : (
                    <span className="text-[12px] text-muted-foreground" title="숫자 기준 없이 조건 충족 여부만 검사하는 규칙">기준값 없음</span>
                  )}
                  {result ? (
                    <span className={`text-[12px] font-bold px-2 py-0.5 rounded-full ${result.triggered ? "bg-error-soft text-error-strong border border-error/30" : "bg-success-soft text-success-strong border border-success/25"}`}>
                      {result.triggered ? "조치 필요" : "정상"}
                    </span>
                  ) : (
                    <span className="text-[12px] text-muted-foreground font-bold">미점검</span>
                  )}
                </div>
                {result && <div className="text-[12px] text-muted-foreground mt-1.5">{result.detail}</div>}
              </div>
            );
          })}
        </div>}
      </div>
    </div>
  );
}
