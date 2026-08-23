import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Save, RefreshCw, MessageSquare, Database, Sparkles, SlidersHorizontal, UploadCloud, FileText, CheckCircle2, Loader2, FlaskConical, Bot, PlayCircle, AlertTriangle, Plus, Pencil, Trash2, X, Sprout, Power, Layers, Building2, Briefcase, ExternalLink, TrendingUp, Zap, Lightbulb, Coins } from "lucide-react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useConfirm } from "./ConfirmDialog";
import { AGENT_CATEGORY_IDS, getCategory } from "@/lib/agent/handoff-category";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/ui/page-shell";
import { brainOverview, type BrainCountMetric, type BrainMode } from "@/lib/admin/brain-overview";
import { brainTabFromParam, brainTabHref, type BrainTab } from "@/lib/admin/brain-navigation";

interface OverviewBranch {
  id: number;
  name: string;
  ai_facts: string | null;
}
interface OverviewJob {
  id: number;
  title: string;
  branch: string | null;
  pay_info: string | null;
  policy_notes: string | null;
  status: string;
}

interface PromptExample {
  id: number;
  category: string;
  title: string;
  body: string;
}

type KbCategory = "facts" | "knowledge" | "system_message" | "conversation";

const KB_CATEGORIES: { key: KbCategory; label: string; hint: string }[] = [
  { key: "facts", label: "운영 정보", hint: "지점·시급·정책 등 AI가 사실로 인용하는 정보. 여기 없는 사실은 추측하지 않고 매니저에게 넘깁니다." },
  { key: "knowledge", label: "일반 라인 FAQ", hint: "일반 배송 라인(내부 인재풀 공고) 전용 공식 답변 — 정산·유류비·과태료·선탑·보험 등. 비마트 공고 응대에는 주입되지 않습니다." },
  { key: "system_message", label: "자동 발송 문구", hint: "시스템이 자동 발송하는 고정 문구. 제목(키)은 바꾸지 말고 본문만 다듬으세요. {{이름}} 등 치환자 사용 가능." },
  { key: "conversation", label: "대화 예시", hint: "옹봇의 말투를 잡아주는 대화 예시. 프롬프트에 함께 주입됩니다." },
];

interface KbForm {
  id: number | null;
  category: KbCategory;
  title: string;
  body: string;
}

interface SimDraft {
  status: "reply" | "need_info";
  draft_text: string | null;
  reasoning: string;
  missing_info?: string;
}

interface PersonaForm {
  role: string;
  instructions: string;
  tone: string;
  emoji: number;
}

const TONE_OPTIONS = ["친절하고 따뜻하게", "전문적이고 단호하게", "밝고 활기차게"];

const DEFAULT_PERSONA: PersonaForm = {
  role: "당신은 시니어 배달원 채용을 돕는 친절하고 인내심 많은 전문 채용 매니저 '옹봇'입니다.",
  instructions: `1. 시니어(50~70대) 지원자가 이해하기 쉽도록 전문 용어(예: 파이프라인, 스크리닝 등) 사용을 피하고 쉬운 우리말을 사용하세요.
2. 항상 존댓말을 사용하고, 지원자의 답변이 늦어지더라도 재촉하지 마세요.
3. 지점 위치나 근무 시간에 대한 질문을 받으면 즉시 사내 지식 베이스를 검색하여 정확하게 안내하세요.
4. 면접 일정 조율 시에는 반드시 오전/오후 중 선호하는 시간대를 먼저 물어보세요.`,
  tone: "친절하고 따뜻하게",
  emoji: 40,
};

const CATEGORY_LABEL: Record<string, string> = {
  conversation: "대화 예시",
  facts: "운영 정보",
  knowledge: "일반 라인 FAQ",
  system_message: "자동 발송 문구",
};

// 인계 tone별 배지 색
const TONE_BADGE: Record<string, string> = {
  urgent: "bg-error-soft text-error-strong border-error/30",
  answerable: "bg-yellow-50 text-warning-strong border-yellow-200",
  human: "bg-info-soft text-info-strong border-info/25",
  neutral: "bg-background text-muted-foreground border-border-strong",
};
const TONE_LABEL: Record<string, string> = {
  urgent: "긴급",
  answerable: "정보채우면 자동화 가능",
  human: "사람이 직접",
  neutral: "일반",
};

// 🔁 개선 제안 (R4) — improve API가 반환하는 제안. 서버 저장 없음(즉석 표시).
interface ImproveProposal {
  kind: "knowledge" | "conversation_example" | "system_message_tweak";
  title: string;
  body: string;
  evidence: string;
  confidence: "high" | "medium";
}

const IMPROVE_KIND_LABEL: Record<ImproveProposal["kind"], string> = {
  knowledge: "일반 라인 FAQ",
  conversation_example: "대화 예시",
  system_message_tweak: "자동 발송 문구 제안",
};
const IMPROVE_KIND_BADGE: Record<ImproveProposal["kind"], string> = {
  knowledge: "bg-info-soft text-info-strong border-info/25",
  conversation_example: "bg-success-soft text-success-strong border-success/25",
  system_message_tweak: "bg-yellow-50 text-warning-strong border-warning/35",
};

// AI 사용량 카드 (R4-3) — 모델별 단가 (USD per 1M tokens). 캐시 읽기는 입력 단가의 10%로 추정.
interface UsageMonthModel {
  model: string;
  call_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
}
function modelRates(model: string): { in: number; out: number } {
  return model.includes("haiku") ? { in: 1, out: 5 } : { in: 3, out: 15 };
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function countMetricText(metric: BrainCountMetric, suffix: string) {
  if (metric.state === "loading") return "확인 중";
  if (metric.state === "error") return "확인 실패";
  return `${metric.value}${suffix}`;
}

const MODE_LABEL: Record<BrainMode, string> = {
  auto: "자동 응대",
  draft: "코파일럿",
  off: "완전 중지",
};

const BRAIN_TAB_GROUPS = [
  {
    label: "운영 제어",
    items: [
      { id: "overview" as BrainTab, label: "운영 현황", icon: Layers, activeIcon: "text-warning-strong" },
      { id: "mode" as BrainTab, label: "응답 모드·안전", icon: Power, activeIcon: "text-error-strong" },
      { id: "rules" as BrainTab, label: "사람 개입 규칙", icon: SlidersHorizontal, activeIcon: "text-success" },
    ],
  },
  {
    label: "응답 품질",
    items: [
      { id: "knowledge" as BrainTab, label: "지식 베이스", icon: Database, activeIcon: "text-info" },
      { id: "persona" as BrainTab, label: "말투·성격", icon: MessageSquare, activeIcon: "text-warning-strong" },
      { id: "simulator" as BrainTab, label: "응대 미리보기", icon: FlaskConical, activeIcon: "text-copilot" },
      { id: "improve" as BrainTab, label: "개선 제안", icon: Lightbulb, activeIcon: "text-warning-strong" },
    ],
  },
];

export function AgentBrain() {
  const confirm = useConfirm();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = brainTabFromParam(searchParams.get("tab"));
  // AI 지식 현황(개선1·3): 사실 3계층 집계 + 인계 분포 — 모두 SWR로 캐시·dedup(타 탭과 키 공유).
  const { data: ovBranchesApi, error: ovBranchesError, isValidating: ovBranchesValidating, mutate: mutateOvBranches } = useSWR<{ data?: OverviewBranch[] }>("/api/admin/branches", { refreshInterval: 60_000 });
  const { data: ovJobsApi, error: ovJobsError, isValidating: ovJobsValidating, mutate: mutateOvJobs } = useSWR<{ jobs?: OverviewJob[] }>("/api/admin/jobs?status=active", { refreshInterval: 60_000 });
  const { data: ovHandoffsApi, error: ovHandoffsError, isValidating: ovHandoffsValidating, mutate: mutateOvHandoffs } = useSWR<{ by_category?: Record<string, number>; total?: number }>("/api/admin/agent/handoffs", { refreshInterval: 60_000 });
  const ovJobs = useMemo(() => ((ovJobsApi?.jobs ?? []) as OverviewJob[]).filter((j) => !j.title.startsWith("__")), [ovJobsApi]);
  const ovByCategory = useMemo(() => ovHandoffsApi?.by_category ?? {}, [ovHandoffsApi]);
  const ovHandoffTotal = ovHandoffsApi?.total ?? 0;
  const [isSaving, setIsSaving] = useState(false);
  const { data: examplesApi, error: examplesError, isLoading: examplesLoading, isValidating: examplesValidating, mutate: mutateExamples } = useSWR<{ data?: PromptExample[] }>("/api/admin/prompt-examples", { refreshInterval: 60_000 });
  const examples = useMemo(() => examplesApi?.data ?? [], [examplesApi]);
  const kbLoading = examplesLoading && examplesApi === undefined;
  const kbFailed = Boolean(examplesError);
  const loadExamples = useCallback(async () => { await mutateExamples(); }, [mutateExamples]);
  const [kbCategory, setKbCategory] = useState<KbCategory>("facts");
  const [kbForm, setKbForm] = useState<KbForm | null>(null);
  const [kbBusy, setKbBusy] = useState(false);
  const [kbSeeding, setKbSeeding] = useState(false);

  // 응대 미리보기 상태
  const [simInbound, setSimInbound] = useState("");
  const [simPosting, setSimPosting] = useState("");
  const [simRunning, setSimRunning] = useState(false);
  const [simResult, setSimResult] = useState<SimDraft | null>(null);


  // 🔁 개선 제안 (R4-2) — 최근 7일 재료에서 배울 거리 추출. 반영은 매니저 승인으로만.
  const [improveLoading, setImproveLoading] = useState(false);
  const [improveRan, setImproveRan] = useState(false);
  const [proposals, setProposals] = useState<ImproveProposal[]>([]);
  const [approvingIdx, setApprovingIdx] = useState<number | null>(null);

  // AI 사용량 카드 (R4-3) — 이번 달 ai_usage_daily 모델별 집계 (기존 usage API 재사용).
  const { data: usageApi, isLoading: usageLoading } = useSWR<{
    month?: { models?: UsageMonthModel[] };
    months?: { month: string; ai_cost_krw: number; sms_cost_krw: number; total_cost_krw: number }[];
    projection?: { month: string; mtd_krw: number; projected_krw: number; elapsed_days: number; days_in_month: number };
  }>("/api/admin/usage");
  const monthStats = useMemo(() => {
    const models = usageApi?.month?.models ?? [];
    let calls = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    for (const m of models) {
      calls += m.call_count;
      tokensIn += m.tokens_in;
      tokensOut += m.tokens_out;
      const rate = modelRates(m.model);
      cost += (m.tokens_in / 1e6) * rate.in + (m.tokens_out / 1e6) * rate.out + (m.cache_read / 1e6) * rate.in * 0.1;
    }
    return { calls, tokensIn, tokensOut, cost };
  }, [usageApi]);

  const handleRunImprove = async () => {
    if (improveLoading) return;
    setImproveLoading(true);
    try {
      const res = await fetch("/api/admin/agent/improve", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "개선 제안 생성에 실패했어요");
        return;
      }
      setProposals((json.proposals ?? []) as ImproveProposal[]);
      setImproveRan(true);
    } catch {
      toast.error("개선 제안 생성에 실패했어요");
    } finally {
      setImproveLoading(false);
    }
  };

  // 승인 — knowledge/conversation_example만 기존 prompt-examples POST로 INSERT.
  // system_message_tweak은 자동 반영 금지(지식 오염 방지) — 문구 편집에서 직접 반영 안내만.
  const handleApproveProposal = async (idx: number) => {
    const p = proposals[idx];
    if (!p || p.kind === "system_message_tweak" || approvingIdx !== null) return;
    setApprovingIdx(idx);
    try {
      const res = await fetch("/api/admin/prompt-examples", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: p.kind === "knowledge" ? "knowledge" : "conversation",
          title: p.title,
          body: p.body,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "지식 추가에 실패했어요");
        return;
      }
      toast.success(`'${p.title}' 항목을 지식베이스에 추가했어요. 60초 이내 AI에 반영됩니다.`);
      setProposals((prev) => prev.filter((_, i) => i !== idx));
      await loadExamples();
    } catch {
      toast.error("지식 추가에 실패했어요");
    } finally {
      setApprovingIdx(null);
    }
  };

  const handleDismissProposal = (idx: number) =>
    setProposals((prev) => prev.filter((_, i) => i !== idx));

  // 운영자 페르소나 (시스템 프롬프트에 반영) — SWR로 로드 후 폼에 시드(이후 로컬 편집).
  const { data: personaApi, error: personaError, isLoading: personaLoading, mutate: mutatePersona } = useSWR<{ data?: { role?: string; instructions?: string; tone?: string; emoji?: number } }>("/api/admin/agent/persona");
  const [persona, setPersona] = useState<PersonaForm>(DEFAULT_PERSONA);
  const personaLoaded = personaApi !== undefined && !personaError;
  useEffect(() => {
    const d = personaApi?.data;
    if (d) {
      setPersona({
        role: d.role || DEFAULT_PERSONA.role,
        instructions: d.instructions || DEFAULT_PERSONA.instructions,
        tone: d.tone || DEFAULT_PERSONA.tone,
        emoji: typeof d.emoji === "number" ? d.emoji : DEFAULT_PERSONA.emoji,
      });
    }
  }, [personaApi]);

  const setPersonaField = <K extends keyof PersonaForm>(key: K, value: PersonaForm[K]) =>
    setPersona((prev) => ({ ...prev, [key]: value }));

  // 전역 AI 응답 모드 (kill-switch 3단): auto=자동 응대 / draft=코파일럿(초안만) / off=완전 중지.
  // SWR로 로드 후 로컬 상태에 시드(전환은 로컬 갱신). kill-switch 키는 자동화 탭과 공유.
  const { data: killApi, error: killError, isLoading: killLoading, isValidating: killValidating, mutate: mutateKill } = useSWR<{ mode?: BrainMode; disabled?: boolean; env_forced?: boolean; updated_at?: string | null }>("/api/admin/agent/kill-switch", { refreshInterval: 60_000 });
  const [killMode, setKillMode] = useState<BrainMode>("auto");
  const [killEnvForced, setKillEnvForced] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [killUpdatedAt, setKillUpdatedAt] = useState<string | null>(null);
  useEffect(() => {
    if (killApi) {
      setKillMode(killApi.mode ?? (killApi.disabled ? "off" : "auto"));
      setKillEnvForced(!!killApi.env_forced);
      setKillUpdatedAt(killApi.updated_at ?? null);
    }
  }, [killApi]);
  const overview = useMemo(() => brainOverview({
    examples: examplesApi?.data,
    examplesError: Boolean(examplesError),
    branches: ovBranchesApi?.data,
    branchesError: Boolean(ovBranchesError),
    jobs: ovJobsApi?.jobs,
    jobsError: Boolean(ovJobsError),
    handoffs: ovHandoffsApi,
    handoffsError: Boolean(ovHandoffsError),
    killSwitch: killApi,
    killSwitchError: Boolean(killError),
  }), [examplesApi, examplesError, ovBranchesApi, ovBranchesError, ovJobsApi, ovJobsError, ovHandoffsApi, ovHandoffsError, killApi, killError]);
  const overviewRefreshing = examplesValidating || ovBranchesValidating || ovJobsValidating || ovHandoffsValidating || killValidating;
  const loadOverview = useCallback(() => {
    void Promise.all([mutateExamples(), mutateOvBranches(), mutateOvJobs(), mutateOvHandoffs(), mutateKill()]);
  }, [mutateExamples, mutateOvBranches, mutateOvJobs, mutateOvHandoffs, mutateKill]);
  const killDisabled = killMode === "off";

  const handleChangeKillMode = async (next: BrainMode) => {
    if (killBusy || killEnvForced || next === killMode) return;
    const ok =
      next === "off"
        ? await confirm({ title: "AI 전역 응답을 중단할까요?", description: "이후 들어오는 모든 지원자 메시지에 AI가 자동 응답하지 않습니다. (매니저가 직접 응대해야 합니다)", confirmText: "중단하기", destructive: true })
        : next === "draft"
        ? await confirm({ title: "코파일럿 모드로 전환할까요?", description: "AI가 답장 초안을 만들지만 발송은 매니저 승인 후에만 됩니다. (단계 전이·자동 안내 발송도 함께 멈춥니다)", confirmText: "코파일럿 전환" })
        : await confirm({ title: "AI 전역 응답을 재개할까요?", description: "이후 들어오는 지원자 메시지부터 AI가 다시 자동 응답합니다. (중단 기간에 쌓인 과거 메시지는 자동 소급 응답되지 않습니다)", confirmText: "재개하기" });
    if (!ok) return;
    setKillBusy(true);
    try {
      const res = await fetch("/api/admin/agent/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "변경에 실패했어요");
        return;
      }
      setKillMode(next);
      const updatedAt = new Date().toISOString();
      setKillUpdatedAt(updatedAt);
      void mutateKill({ mode: next, disabled: next === "off", env_forced: false, updated_at: updatedAt }, { revalidate: false });
      toast.success(
        next === "off"
          ? "AI 전역 응답을 중단했어요."
          : next === "draft"
          ? "코파일럿 모드로 전환했어요. AI는 초안만 만들고, 발송은 매니저 승인 후에만 됩니다. (5초 이내 반영)"
          : "AI 전역 응답을 재개했어요. (5초 이내 반영)"
      );
    } catch {
      toast.error("변경에 실패했어요");
    } finally {
      setKillBusy(false);
    }
  };


  const openKbAdd = () =>
    setKbForm({ id: null, category: kbCategory, title: "", body: "" });
  const openKbEdit = (ex: PromptExample) =>
    setKbForm({ id: ex.id, category: ex.category as KbCategory, title: ex.title, body: ex.body });

  const handleKbSave = async () => {
    if (!kbForm) return;
    const title = kbForm.title.trim();
    const body = kbForm.body.trim();
    if (!title || !body) return toast.error("제목과 내용을 모두 입력해주세요.");
    setKbBusy(true);
    try {
      const isEdit = kbForm.id !== null;
      const res = await fetch(
        isEdit ? `/api/admin/prompt-examples/${kbForm.id}` : "/api/admin/prompt-examples",
        {
          method: isEdit ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isEdit ? { title, body } : { category: kbForm.category, title, body }
          ),
        }
      );
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "저장에 실패했어요");
        return;
      }
      toast.success(isEdit ? "수정했어요. 60초 이내 AI에 반영됩니다." : "추가했어요. 60초 이내 AI에 반영됩니다.");
      setKbForm(null);
      await loadExamples();
    } catch {
      toast.error("저장에 실패했어요");
    } finally {
      setKbBusy(false);
    }
  };

  const handleKbDelete = async (ex: PromptExample) => {
    if (!(await confirm({ title: "항목을 삭제할까요?", description: `'${ex.title}' 항목을 삭제합니다. 이 작업은 되돌릴 수 없어요.`, confirmText: "삭제", destructive: true }))) return;
    try {
      const res = await fetch(`/api/admin/prompt-examples/${ex.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "삭제에 실패했어요");
        return;
      }
      toast.success("삭제했어요.");
      if (kbForm?.id === ex.id) setKbForm(null);
      await loadExamples();
    } catch {
      toast.error("삭제에 실패했어요");
    }
  };

  const handleKbSeed = async () => {
    if (kbSeeding) return;
    setKbSeeding(true);
    try {
      const res = await fetch("/api/admin/prompt-examples", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seed" }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "기본값 채우기에 실패했어요");
        return;
      }
      toast.success(json.inserted > 0 ? `${json.inserted}개 기본값을 추가했어요.` : "이미 모든 기본값이 있어요.");
      await loadExamples();
    } catch {
      toast.error("기본값 채우기에 실패했어요");
    } finally {
      setKbSeeding(false);
    }
  };

  // '__' 접두 제목은 내부 설정용 예약 항목(예: __persona__) — KB 목록에 노출하지 않는다.
  const kbItems = examples.filter((e) => e.category === kbCategory && !e.title.startsWith("__"));

  // AI 지식 현황 집계
  const payGapJobs = overview.jobs.state === "ready" ? ovJobs.filter((j) => !(j.pay_info ?? "").trim()) : [];
  const modeSummary = overview.mode.state === "ready" && overview.mode.value
    ? MODE_LABEL[overview.mode.value]
    : overview.mode.state === "loading" ? "확인 중" : "확인 실패";
  const modeSummaryTone = overview.mode.state === "error" || overview.mode.value === "off"
    ? "text-error-strong"
    : overview.mode.value === "draft" ? "text-copilot-strong" : overview.mode.state === "ready" ? "text-success-strong" : "text-muted-foreground";
  const coverageFailed = overview.branches.state === "error" || overview.jobs.state === "error";
  const coverageLoading = overview.branches.state === "loading" || overview.jobs.state === "loading";
  const knowledgeGapCount = overview.branches.state === "ready" && overview.jobs.state === "ready"
    ? (overview.branches.total! - overview.branches.filled!) + (overview.jobs.total! - overview.jobs.filled!)
    : null;
  const knowledgeGapSummary = coverageFailed ? "확인 실패" : coverageLoading ? "확인 중" : `${knowledgeGapCount}곳`;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const res = await fetch("/api/admin/agent/persona", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(persona),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "저장에 실패했어요");
        return;
      }
      toast.success("말투·성격을 저장했어요. 60초 이내 AI 응대에 반영됩니다. (예외 처리 규칙은 별도 데모)");
    } catch {
      toast.error("저장에 실패했어요");
    } finally {
      setIsSaving(false);
    }
  };

  const handleRunSimulation = async () => {
    if (!simInbound.trim()) return toast.error("지원자가 보낸 문자를 입력해주세요.");
    setSimRunning(true);
    setSimResult(null);
    try {
      const res = await fetch("/api/admin/agent/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inbound_text: simInbound.trim(),
          job_posting: simPosting.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "미리보기에 실패했어요");
        return;
      }
      setSimResult(json.draft as SimDraft);
    } catch {
      toast.error("미리보기에 실패했어요");
    } finally {
      setSimRunning(false);
    }
  };

  return (
    <PageShell>
      <h1 className="sr-only">에이전트 두뇌</h1>

      <section aria-labelledby="brain-operations-heading" className="overflow-hidden rounded-2xl border border-border-strong bg-card shadow-sm">
        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="brain-operations-heading" className="text-[14px] font-extrabold text-foreground">AI 운영 상태</h2>
              <span className="rounded-full border border-border-strong bg-muted px-2 py-0.5 text-[12px] font-bold text-muted-foreground">60초마다 갱신</span>
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">AI의 현재 동작, 사람 확인 대기, 지식 빈칸을 먼저 확인하세요.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={loadOverview} isLoading={overviewRefreshing}>
            {!overviewRefreshing && <RefreshCw size={14} />} 새로고침
          </Button>
        </div>
        <div className="grid grid-cols-1 border-t border-border-strong md:grid-cols-3">
          <Link
            href={brainTabHref("mode")}
            scroll={false}
            className="group flex min-h-[104px] items-start gap-3 border-b border-border-strong px-5 py-4 outline-none transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:border-b-0 md:border-r"
          >
            <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${overview.mode.value === "off" || overview.mode.state === "error" ? "bg-error-soft" : overview.mode.state === "loading" ? "bg-muted" : overview.mode.value === "draft" ? "bg-copilot-soft" : "bg-success-soft"}`}>
              <Power size={17} className={modeSummaryTone} />
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-bold text-muted-foreground">전역 응답 모드</div>
              <div className={`mt-0.5 text-[18px] font-extrabold ${modeSummaryTone}`}>{modeSummary}</div>
              <div className="mt-1 flex items-center gap-1 text-[12px] font-bold text-muted-foreground group-hover:text-foreground">모드·안전 설정 <ExternalLink size={11} /></div>
            </div>
          </Link>
          <Link
            href="/live?tab=intervention"
            className="group flex min-h-[104px] items-start gap-3 border-b border-border-strong px-5 py-4 outline-none transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:border-b-0 md:border-r"
          >
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-copilot-soft"><AlertTriangle size={17} className="text-copilot-strong" /></div>
            <div className="min-w-0">
              <div className="text-[12px] font-bold text-muted-foreground">사람 확인 대기</div>
              <div className={`mt-0.5 text-[18px] font-extrabold ${overview.handoffs.state === "error" ? "text-error-strong" : "text-foreground"}`}>{countMetricText(overview.handoffs, "건")}</div>
              <div className="mt-1 flex items-center gap-1 text-[12px] font-bold text-muted-foreground group-hover:text-foreground">지원자 운영에서 처리 <ExternalLink size={11} /></div>
            </div>
          </Link>
          <Link
            href={brainTabHref("overview")}
            scroll={false}
            className="group flex min-h-[104px] items-start gap-3 px-5 py-4 outline-none transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning-soft"><Database size={17} className="text-warning-strong" /></div>
            <div className="min-w-0">
              <div className="text-[12px] font-bold text-muted-foreground">지점·공고 지식 빈칸</div>
              <div className={`mt-0.5 text-[18px] font-extrabold ${coverageFailed ? "text-error-strong" : (knowledgeGapCount ?? 0) > 0 ? "text-warning-strong" : "text-foreground"}`}>{knowledgeGapSummary}</div>
              <div className="mt-1 flex items-center gap-1 text-[12px] font-bold text-muted-foreground group-hover:text-foreground">빈칸 위치 점검 <ExternalLink size={11} /></div>
            </div>
          </Link>
        </div>
      </section>

      <div className="flex gap-6">
        {/* Sidebar Nav */}
        <div role="tablist" aria-label="에이전트 두뇌 설정" className="flex w-[220px] shrink-0 flex-col gap-5">
          {BRAIN_TAB_GROUPS.map((group) => (
            <div key={group.label} role="presentation">
              <div className="mb-1.5 px-3 text-[12px] font-extrabold tracking-[0.12em] text-muted-foreground">{group.label}</div>
              <div className="flex flex-col gap-1">
                {group.items.map((item) => {
                  const selected = activeTab === item.id;
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.id}
                      id={`brain-tab-${item.id}`}
                      href={brainTabHref(item.id)}
                      scroll={false}
                      role="tab"
                      aria-selected={selected}
                      aria-controls={`brain-panel-${item.id}`}
                      className={`flex min-h-11 items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-[13px] font-bold outline-none transition-[background-color,border-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${selected ? "border-foreground bg-card text-foreground shadow-sm" : "border-transparent text-muted-foreground hover:border-border-strong hover:bg-card hover:text-foreground"}`}
                    >
                      <Icon size={17} className={selected ? item.activeIcon : ""} />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Content Area */}
        <div id={`brain-panel-${activeTab}`} role="tabpanel" aria-labelledby={`brain-tab-${activeTab}`} tabIndex={0} className="min-w-0 flex-1 rounded-2xl border border-border-strong bg-card p-7 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {activeTab === 'overview' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                  <Layers size={20} className="text-warning-strong" /> AI가 참고하는 사실 — 한눈에
                </h2>
              </div>
              <p className="text-sm text-muted-foreground mb-6">옹봇은 응대할 때 <b>① 공통 운영정보 · ② 지점별 정보 · ③ 공고별 단가·정책</b> 세 곳의 사실만 인용합니다. 비어 있는 곳은 인용할 수 없어 매니저가 직접 답해야 하는 일이 늘어납니다. 빈칸을 채우면 그만큼 줄어요.</p>

              {/* 3계층 커버리지 카드 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                <Link href={brainTabHref("knowledge")} scroll={false} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-left p-4 border border-border-strong rounded-2xl bg-card hover:border-info transition-colors">
                  <div className="flex items-center gap-2 text-info mb-2"><Database size={16} /><span className="text-[12px] font-bold">① 공통 운영정보</span></div>
                  <div className={`font-extrabold ${overview.facts.state === "ready" ? "text-[26px] text-foreground" : overview.facts.state === "error" ? "text-[16px] text-error-strong" : "text-[16px] text-muted-foreground"}`}>
                    {overview.facts.state === "ready" ? <>{overview.facts.value}<span className="ml-0.5 text-[13px] text-muted-foreground">개 항목</span></> : countMetricText(overview.facts, "개 항목")}
                  </div>
                  <div className="text-[12px] text-muted-foreground mt-1 flex items-center gap-1">두뇌 &gt; 사내 지식 베이스 <ExternalLink size={11} /></div>
                </Link>
                <button onClick={() => router.push("/branches")} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-left p-4 border border-border-strong rounded-2xl bg-card hover:border-success transition-colors">
                  <div className="flex items-center gap-2 text-success mb-2"><Building2 size={16} /><span className="text-[12px] font-bold">② 지점별 정보</span></div>
                  <div className={`font-extrabold ${overview.branches.state === "ready" ? "text-[26px] text-foreground" : overview.branches.state === "error" ? "text-[16px] text-error-strong" : "text-[16px] text-muted-foreground"}`}>
                    {overview.branches.state === "ready" ? <>{overview.branches.filled}<span className="ml-0.5 text-[13px] text-muted-foreground">/{overview.branches.total} 지점 작성</span></> : overview.branches.state === "loading" ? "확인 중" : "확인 실패"}
                  </div>
                  <div className="text-[12px] text-muted-foreground mt-1 flex items-center gap-1">지점관리에서 편집 <ExternalLink size={11} /></div>
                </button>
                <button onClick={() => router.push("/jobs")} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-left p-4 border border-border-strong rounded-2xl bg-card hover:border-warning transition-colors">
                  <div className="flex items-center gap-2 text-warning-strong mb-2"><Briefcase size={16} /><span className="text-[12px] font-bold">③ 공고별 단가·정책</span></div>
                  <div className={`font-extrabold ${overview.jobs.state === "ready" ? "text-[26px] text-foreground" : overview.jobs.state === "error" ? "text-[16px] text-error-strong" : "text-[16px] text-muted-foreground"}`}>
                    {overview.jobs.state === "ready" ? <>{overview.jobs.filled}<span className="ml-0.5 text-[13px] text-muted-foreground">/{overview.jobs.total} 공고 단가입력</span></> : overview.jobs.state === "loading" ? "확인 중" : "확인 실패"}
                  </div>
                  <div className="text-[12px] text-muted-foreground mt-1 flex items-center gap-1">공고 편집에서 입력 <ExternalLink size={11} /></div>
                </button>
              </div>

              {/* 단가 미입력 공고 — 매니저가 직접 답해야 할 위험 */}
              {payGapJobs.length > 0 && (
                <div className="p-4 border border-warning/35 bg-yellow-50 rounded-2xl mb-6">
                  <div className="flex items-center gap-2 text-warning-strong mb-3 text-[14px] font-bold"><AlertTriangle size={16} /> 단가 미입력 공고 {payGapJobs.length}개 — 단가 문의가 오면 매니저가 직접 답해야 합니다</div>
                  <div className="flex flex-col gap-1.5">
                    {payGapJobs.slice(0, 6).map((j) => (
                      <div key={j.id} className="flex items-center justify-between gap-2 bg-card border border-warning-soft rounded-lg px-3 py-2">
                        <div className="min-w-0">
                          <span className="text-[13px] font-bold text-foreground">{j.title}</span>
                          {j.branch && <span className="ml-2 text-[12px] font-bold text-muted-foreground">{j.branch}</span>}
                        </div>
                        <Button variant="primary" size="chip" className="shrink-0 px-2.5 bg-warning hover:bg-warning-strong text-white shadow-none focus-visible:ring-warning" onClick={() => router.push(`/jobs?edit=${j.id}`)}>단가 채우기</Button>
                      </div>
                    ))}
                    {payGapJobs.length > 6 && <div className="text-[12px] text-muted-foreground px-1">외 {payGapJobs.length - 6}개</div>}
                  </div>
                </div>
              )}

              {/* 사람 확인 필요 분포(개선3) — 어떤 질문이 자주 매니저로 넘어가나 */}
              <div className="p-5 border border-border-strong rounded-2xl bg-card">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 text-foreground text-[14px] font-bold"><TrendingUp size={16} className="text-copilot" /> 사람 확인 필요 사유 분포 (현재 {countMetricText(overview.handoffs, "건")})</div>
                  <button onClick={() => router.push("/live?tab=intervention")} className="relative after:absolute after:-inset-2.5 after:content-[''] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-[12px] font-bold text-copilot hover:underline flex items-center gap-1">사람 확인 필요 목록 열기 <ExternalLink size={11} /></button>
                </div>
                <p className="text-[12px] text-muted-foreground mb-4">사람 확인이 자주 필요한 분류는 위 ①②③ 사실을 채우면 건수가 줄어듭니다. (단가·정산 → 공고 단가, 계약·정책 → 공고 정책/지점 정보)</p>
                {overview.handoffs.state === "loading" ? (
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground py-2"><Loader2 size={15} className="animate-spin" /> 불러오는 중…</div>
                ) : overview.handoffs.state === "error" ? (
                  <div role="alert" className="flex items-center gap-2 rounded-xl border border-error/30 bg-error-soft px-3 py-2 text-[13px] font-bold text-error-strong"><AlertTriangle size={15} /> 분포를 확인하지 못했습니다. 상단 새로고침을 눌러 다시 확인하세요.</div>
                ) : Object.keys(ovByCategory).length === 0 ? (
                  <div className="text-[13px] text-muted-foreground py-2">사람 확인이 필요한 건이 없어요.</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {Object.entries(ovByCategory).sort((a, b) => b[1] - a[1]).map(([cid, count]) => {
                      const cat = getCategory(cid);
                      const pct = ovHandoffTotal > 0 ? Math.round((count / ovHandoffTotal) * 100) : 0;
                      return (
                        <div key={cid} className="flex items-center gap-3">
                          <span className="w-[88px] shrink-0 text-[13px] font-bold text-gray-700 text-right">{cat.label}</span>
                          <div className="flex-1 h-5 bg-muted rounded-md overflow-hidden">
                            <div className="h-full bg-copilot rounded-md" style={{ width: `${Math.max(pct, 4)}%` }} />
                          </div>
                          <span className="w-[52px] shrink-0 text-[12px] font-bold text-muted-foreground">{count}건</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'persona' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-bold text-foreground">
                    <Sparkles size={20} className="text-warning-strong" /> AI 말투·성격 정의
                  </h2>
                  <p className="mt-1 text-[12px] text-muted-foreground">이 화면의 변경은 저장해야 실제 응대에 반영됩니다.</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!personaLoaded}
                    onClick={async () => {
                      if (!(await confirm({
                        title: "기본 말투·성격으로 되돌릴까요?",
                        description: "편집 중인 역할·지시·어조·이모지 설정이 기본값으로 초기화됩니다. (저장하기 전이라 서버에는 아직 반영되지 않아요)",
                        confirmText: "초기화",
                        destructive: true,
                      }))) return;
                      setPersona(DEFAULT_PERSONA);
                      toast.info("기본 말투·성격으로 되돌렸어요. 저장해야 반영됩니다.");
                    }}
                  >
                    <RefreshCw size={15} /> 기본값으로 초기화
                  </Button>
                  <Button variant="primary" size="sm" onClick={handleSave} isLoading={isSaving} disabled={!personaLoaded}>
                    {!isSaving && <Save size={15} />} {isSaving ? "저장 중…" : "말투·성격 저장"}
                  </Button>
                </div>
              </div>

              {personaLoading && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border border-border-strong bg-background px-3 py-2 text-[12px] font-bold text-muted-foreground"><Loader2 size={14} className="animate-spin" /> 저장된 설정을 불러오는 중입니다.</div>
              )}
              {personaError && (
                <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-error/30 bg-error-soft px-3 py-2">
                  <div className="flex items-center gap-2 text-[12px] font-bold text-error-strong"><AlertTriangle size={14} /> 저장된 말투·성격을 확인하지 못해 편집을 잠시 막았습니다.</div>
                  <Button variant="secondary" size="toolbar" onClick={() => void mutatePersona()}>다시 시도</Button>
                </div>
              )}

              <div className="space-y-6">
                <div>
                  <label className="block text-[13px] font-bold text-gray-700 mb-2">기본 역할 (Role)</label>
                  <input
                    type="text"
                    value={persona.role}
                    onChange={(e) => setPersonaField("role", e.target.value)}
                    disabled={!personaLoaded}
                    className="bg-input-background/90 font-medium shadow-inset hover:border-foreground/25 min-h-11 w-full px-4 py-3 border border-border-strong rounded-2xl text-sm focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring disabled:bg-background"
                  />
                </div>

                <div>
                  <label className="block text-[13px] font-bold text-gray-700 mb-2">핵심 지시사항 (Instructions)</label>
                  <textarea
                    rows={6}
                    value={persona.instructions}
                    onChange={(e) => setPersonaField("instructions", e.target.value)}
                    disabled={!personaLoaded}
                    className="bg-input-background/90 font-medium shadow-inset hover:border-foreground/25 min-h-11 w-full px-4 py-3 border border-border-strong rounded-2xl text-sm font-mono leading-relaxed focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring disabled:bg-background"
                  />
                  <p className="text-[12px] text-muted-foreground mt-2">‘말투·성격 저장’을 누르면 60초 이내 실제 AI 응대(응대 미리보기 포함)에 반영됩니다. 안전 규칙(민감한 질문은 매니저에게 넘기기 등)은 항상 유지됩니다.</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-4 border-t border-border-strong">
                  <div>
                    <label className="block text-[13px] font-bold text-gray-700 mb-3">어조 (Tone & Manner)</label>
                    <div role="radiogroup" aria-label="어조" className="flex flex-col gap-2">
                      {TONE_OPTIONS.map((tone) => {
                        const selected = persona.tone === tone;
                        return (
                          <button
                            key={tone}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={!personaLoaded}
                            onClick={() => setPersonaField("tone", tone)}
                            className={`flex min-h-11 items-center gap-3 rounded-xl border px-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${selected ? "border-warning bg-warning-soft" : "border-border-strong bg-card hover:bg-background"}`}
                          >
                            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${selected ? "border-warning" : "border-border-strong"}`}>
                              {selected && <span className="h-2.5 w-2.5 rounded-full bg-warning" />}
                            </span>
                            <span className={`text-sm font-medium ${selected ? 'text-foreground font-bold' : 'text-muted-foreground'}`}>{tone}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-gray-700 mb-3">이모지 사용 빈도</label>
                    <div className="bg-background border border-border-strong rounded-2xl p-4">
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={persona.emoji}
                        onChange={(e) => setPersonaField("emoji", Number(e.target.value))}
                        disabled={!personaLoaded}
                        className="w-full accent-brand-yellow"
                      />
                      <div className="flex justify-between text-[12px] font-bold text-muted-foreground mt-2">
                        <span>사용 안 함</span>
                        <span>적당히</span>
                        <span>자주 사용</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'knowledge' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
                <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                  <Database size={20} className="text-info" /> 사내 지식 베이스
                </h2>
                <span className={`rounded-full px-3 py-1 text-[12px] font-bold ${kbFailed ? "bg-error-soft text-error-strong" : kbLoading ? "bg-muted text-muted-foreground" : "bg-success-soft text-success-strong"}`}>
                  {kbFailed ? "불러오기 실패" : kbLoading ? "확인 중" : "DB 연동"}
                </span>
              </div>
              <p className="text-sm text-muted-foreground mb-6">옹봇이 지원자 응대에 사용하는 운영 정보·대화 예시·자동 발송 문구입니다. 저장된 항목은 60초 이내 실제 응대에 반영됩니다.</p>

              {/* 파일 업로드(RAG)는 백엔드가 없어 가짜 진행바·"벡터 인덱싱 중"까지 보여준 뒤 마지막에야
                  데모임을 알리는 화면이었다 — 매니저의 시간을 쓰게 하고 그 사이 학습된다고 믿게 만든다.
                  실제 경로(아래 지식 목록 직접 추가)만 남긴다. */}
              <div className="border border-border-strong bg-background rounded-2xl px-5 py-4 mb-8 flex items-start gap-3">
                <UploadCloud size={20} className="text-muted-foreground shrink-0 mt-0.5" />
                <div>
                  <div className="text-[14px] font-bold text-gray-700">파일 업로드로 학습시키는 기능은 아직 없어요 <span className="ml-1 text-[12px] font-bold text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full align-middle">준비중</span></div>
                  <div className="text-[13px] text-muted-foreground mt-0.5">옹봇이 참고하는 지식은 아래 목록에 직접 추가하세요 — 추가하면 1분 안에 응대에 반영돼요.</div>
                </div>
              </div>

              {/* 카테고리 탭 + 액션 */}
              <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                <div className="flex items-center gap-1.5 bg-background border border-border-strong rounded-2xl p-1">
                  {KB_CATEGORIES.map((c) => {
                    const count = examples.filter((e) => e.category === c.key).length;
                    const on = kbCategory === c.key;
                    return (
                      <button aria-pressed={on}
                        key={c.key}
                        onClick={() => { setKbCategory(c.key); setKbForm(null); }}
                        disabled={kbLoading || kbFailed}
                        className={`px-3.5 py-1.5 rounded-lg text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${on ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        {c.label} <span className={on ? "text-muted-foreground" : "text-muted-foreground"}>{count}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="chip" className="px-3.5 py-2 text-[13px] rounded-2xl" onClick={handleKbSeed} isLoading={kbSeeding} disabled={kbLoading || kbFailed}>
                {!kbSeeding && <Sprout size={15} />} 기본값 채우기
              </Button>
                  <Button variant="primary" size="chip" className="px-3.5 py-2 text-[13px] rounded-2xl" onClick={openKbAdd} disabled={kbLoading || kbFailed}><Plus size={15} /> 새 항목</Button>
                </div>
              </div>

              <p className="text-[13px] text-muted-foreground bg-background border border-border-strong rounded-lg px-3.5 py-2.5 mb-4 leading-relaxed">
                {KB_CATEGORIES.find((c) => c.key === kbCategory)?.hint}
              </p>

              {/* 추가/편집 인라인 폼 */}
              <AnimatePresence>
                {kbForm && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden mb-4"
                  >
                    <div className="border-2 border-foreground rounded-2xl p-5 bg-card">
                      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                        <div className="text-[14px] font-extrabold text-foreground flex items-center gap-2">
                          {kbForm.id === null ? <Plus size={16} /> : <Pencil size={16} />}
                          {kbForm.id === null ? "새 지식 항목" : "지식 항목 수정"}
                          <span className="text-[12px] font-bold bg-info-soft text-info-strong px-1.5 py-0.5 rounded-full">{CATEGORY_LABEL[kbForm.category] ?? kbForm.category}</span>
                        </div>
                        <button aria-label="편집 창 닫기" onClick={() => setKbForm(null)} className="after:absolute after:-inset-2 after:content-[''] relative outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-muted-foreground hover:text-gray-700 p-1 rounded-lg"><X size={18} /></button>
                      </div>
                      <div className="flex flex-col gap-3">
                        <div>
                          <label className="block text-[12px] font-bold text-gray-700 mb-1.5">
                            제목 {kbForm.category === "system_message" && <span className="text-warning-strong font-medium">(키 — 변경 시 자동 발송이 끊길 수 있어요)</span>}
                          </label>
                          <input
                            value={kbForm.title}
                            onChange={(e) => setKbForm({ ...kbForm, title: e.target.value })}
                            placeholder={kbForm.category === "facts" ? "예: 강북미아" : kbForm.category === "knowledge" ? "예: 정산·지급일" : kbForm.category === "system_message" ? "예: danggeun_start" : "예: 시급 문의 응대"}
                            className="bg-input-background/90 font-medium shadow-inset hover:border-foreground/25 min-h-11 w-full px-4 py-2.5 border border-border-strong rounded-2xl text-sm focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        </div>
                        <div>
                          <label className="block text-[12px] font-bold text-gray-700 mb-1.5">내용</label>
                          <textarea
                            value={kbForm.body}
                            onChange={(e) => setKbForm({ ...kbForm, body: e.target.value })}
                            rows={kbForm.category === "facts" ? 3 : 5}
                            placeholder={kbForm.category === "facts" ? "시급 15,000~20,000원, 토일 08:00-16:00, 픽업 서울 강북구..." : kbForm.category === "knowledge" ? "지원자 질문에 AI가 그대로 인용할 공식 답변을 입력하세요. 예: 급여는 익월 5일에 지급돼요..." : "발송될 문구를 입력하세요. {{이름}}, {{지점}}, {{지원폼주소}} 등 치환자 사용 가능."}
                            className="bg-input-background/90 font-medium shadow-inset hover:border-foreground/25 min-h-11 w-full px-4 py-3 border border-border-strong rounded-2xl text-sm leading-relaxed focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring resize-none"
                          />
                        </div>
                        <div className="flex items-center justify-end gap-2 pt-1">
                          <Button variant="secondary" size="chip" className="px-4 py-2 text-[13px] rounded-2xl" onClick={() => setKbForm(null)}>취소</Button>
                          <Button variant="primary" size="chip" className="px-5 py-2 text-[13px] rounded-2xl" onClick={handleKbSave} isLoading={kbBusy}>
                    {!kbBusy && <Save size={15} />} 저장
                  </Button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* 항목 목록 */}
              <div className="space-y-3">
                {kbLoading && (
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground p-4"><Loader2 size={15} className="animate-spin" /> 불러오는 중...</div>
                )}
                {kbFailed && (
                  <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl border border-error/30 bg-error-soft p-4">
                    <div className="flex items-center gap-2 text-[13px] font-bold text-error-strong"><AlertTriangle size={15} /> 저장된 지식 항목을 확인하지 못했습니다.</div>
                    <Button variant="secondary" size="toolbar" onClick={() => void mutateExamples()}>다시 시도</Button>
                  </div>
                )}
                {!kbLoading && !kbFailed && kbItems.length === 0 && (
                  <div className="text-center text-[13px] text-muted-foreground border border-dashed border-border-strong rounded-2xl p-8">
                    이 분류에 등록된 항목이 없어요. <button onClick={openKbAdd} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-info-strong font-bold hover:underline">새 항목 추가</button> 또는 기본값 채우기를 눌러보세요.
                  </div>
                )}
                {!kbFailed && kbItems.map((ex) => (
                  <div key={ex.id} className="group flex items-start justify-between p-4 border border-border-strong rounded-2xl bg-card hover:border-gray-300 transition-colors">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-background flex items-center justify-center text-gray-700 shrink-0">
                        <FileText size={16} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[14px] font-bold text-foreground">{ex.title}</div>
                        <div className="text-[12px] text-muted-foreground mt-0.5 whitespace-pre-wrap line-clamp-3">{ex.body}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-3">
                      <button aria-label={`${ex.title} 수정`} onClick={() => openKbEdit(ex)} title="수정" className="after:absolute after:-inset-2 after:content-[''] relative p-2 rounded-lg text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Pencil size={15} /></button>
                      <button aria-label={`${ex.title} 삭제`} onClick={() => handleKbDelete(ex)} title="삭제" className="after:absolute after:-inset-2 after:content-[''] relative p-2 rounded-lg text-muted-foreground hover:bg-error-soft hover:text-error-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Trash2 size={15} /></button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'rules' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-foreground mb-6 flex items-center gap-2">
                <SlidersHorizontal size={20} className="text-success" /> 사람 개입 규칙
              </h2>
              <p className="text-sm text-muted-foreground mb-6">옹봇이 <b>스스로 답하지 않고 매니저에게 넘기는</b> 실제 사유 분류입니다. 안전을 위해 항상 작동하며, 각 분류 옆 숫자는 <b>현재 사람 확인을 기다리는 건수</b>입니다. ‘정보 채우면 자동화 가능’ 항목은 위 ①②③ 사실을 채우면 매니저가 직접 답할 일이 줄어듭니다.</p>

              {overview.handoffs.state === "error" && (
                <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-error/30 bg-error-soft px-3 py-2">
                  <div className="flex items-center gap-2 text-[12px] font-bold text-error-strong"><AlertTriangle size={14} /> 현재 대기 건수를 확인하지 못했습니다.</div>
                  <Button variant="secondary" size="toolbar" onClick={() => void mutateOvHandoffs()}>다시 시도</Button>
                </div>
              )}

              <div className="space-y-2.5">
                {AGENT_CATEGORY_IDS.map((cid) => {
                  const cat = getCategory(cid);
                  const count = ovByCategory[cid] ?? 0;
                  return (
                    <div key={cid} className="p-4 border border-border-strong rounded-2xl bg-card shadow-sm flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[14px] font-bold text-foreground">{cat.label}</span>
                          <span className={`px-1.5 py-0.5 rounded-full text-[12px] font-bold border ${TONE_BADGE[cat.tone]}`}>{TONE_LABEL[cat.tone]}</span>
                        </div>
                        <div className="text-[13px] text-muted-foreground">{cat.action}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        {overview.handoffs.state === "ready" ? (
                          <>
                            <div className={`text-[18px] font-extrabold ${count > 0 ? "text-copilot" : "text-muted-foreground"}`}>{count}</div>
                            <div className="text-[12px] font-bold text-muted-foreground">대기</div>
                          </>
                        ) : (
                          <div className={`text-[12px] font-bold ${overview.handoffs.state === "error" ? "text-error-strong" : "text-muted-foreground"}`}>{overview.handoffs.state === "error" ? "확인 실패" : "확인 중"}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-5 p-4 bg-background border border-border-strong rounded-2xl text-[13px] text-muted-foreground leading-relaxed">
                <b className="text-gray-700">항상 적용되는 안전 규칙:</b> 항의·법적 표현(취소/불법/신고 등), 반복 재촉·감정 격화, 계약·세금·보험 질문은 분류와 무관하게 즉시 매니저에게 넘어갑니다. 이 안전 규칙은 끌 수 없습니다.
              </div>
            </div>
          )}

          {activeTab === 'mode' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              {/* 전역 AI 응답 모드 (실데이터 연동) — 자동 응대 / 코파일럿(초안만) / 완전 중지 */}
              <div className={`border rounded-2xl p-7 shadow-sm mb-6 transition-colors ${killError || killDisabled ? 'bg-error-soft border-error/30' : killMode === 'draft' && !killEnvForced ? 'bg-copilot-soft border-copilot/30' : 'bg-card border-border-strong'}`}>
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${killError || killDisabled || killEnvForced ? 'bg-error-soft' : killMode === 'draft' ? 'bg-copilot-soft' : 'bg-success-soft'}`}>
                    {killMode === 'draft' && !killEnvForced ? (
                      <Zap size={20} className="text-copilot-strong" />
                    ) : (
                      <Power size={20} className={killError || killDisabled || killEnvForced ? 'text-error-strong' : 'text-success'} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-[18px] font-extrabold text-foreground">응답 모드·안전</h2>
                      {killLoading ? (
                        <span className="text-[12px] font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-full">확인 중…</span>
                      ) : killError ? (
                        <span className="text-[12px] font-bold text-error-strong bg-error-soft px-2 py-0.5 rounded-full">확인 실패</span>
                      ) : (
                        <span className={`text-[12px] font-bold px-2 py-0.5 rounded-full ${killDisabled || killEnvForced ? 'text-error-strong bg-error-soft' : killMode === 'draft' ? 'text-copilot-strong bg-copilot-soft' : 'text-success-strong bg-success/25'}`}>
                          {killEnvForced ? '중단됨 (환경변수)' : killDisabled ? '중단됨' : killMode === 'draft' ? '코파일럿' : '작동 중'}
                        </span>
                      )}
                    </div>
                    <p className="text-[13px] text-muted-foreground mt-1 max-w-[560px]">
                      인입되는 모든 지원자 메시지에 대한 AI 동작 방식을 전역으로 결정합니다.
                    </p>

                    {/* 3단 세그먼트 */}
                    <div role="radiogroup" aria-label="AI 전역 응답 모드" className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2 max-w-[640px]">
                      {([
                        { id: 'auto' as const, label: '자동 응대', desc: 'AI가 답장을 직접 발송하고 단계도 진행합니다.', icon: <Bot size={15} />, activeCls: 'border-success bg-success-soft ring-1 ring-success', dotCls: 'text-success-strong' },
                        { id: 'draft' as const, label: '코파일럿 (초안만)', desc: 'AI는 초안만 작성 — 발송은 매니저 승인 후에만 됩니다.', icon: <Zap size={15} />, activeCls: 'border-copilot bg-copilot-soft ring-1 ring-copilot', dotCls: 'text-copilot-strong' },
                        { id: 'off' as const, label: '완전 중지', desc: 'AI가 아무것도 하지 않습니다. 매니저가 직접 응대합니다.', icon: <Power size={15} />, activeCls: 'border-error bg-error-soft ring-1 ring-error', dotCls: 'text-error-strong' },
                      ]).map((opt) => {
                        const active = !killLoading && !killError && killMode === opt.id && !killEnvForced;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => handleChangeKillMode(opt.id)}
                            disabled={killLoading || Boolean(killError) || killBusy || killEnvForced}
                            title={killEnvForced ? "환경변수로 강제 중단된 상태입니다" : opt.desc}
                            className={`text-left rounded-2xl border p-3 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${active ? opt.activeCls : 'border-border-strong bg-card hover:border-foreground/30'}`}
                          >
                            <div className={`flex items-center gap-1.5 text-[13px] font-extrabold ${active ? opt.dotCls : 'text-gray-700'}`}>
                              {opt.icon} {opt.label}
                              {killBusy && killMode !== opt.id && <span className="sr-only">변경 중</span>}
                            </div>
                            <div className="text-[12px] text-muted-foreground mt-1 leading-snug">{opt.desc}</div>
                          </button>
                        );
                      })}
                    </div>

                    {!killLoading && killUpdatedAt && (
                      <p className="text-[12px] text-muted-foreground mt-3">
                        마지막 변경: {new Date(killUpdatedAt).toLocaleString("ko-KR")}
                      </p>
                    )}
                    {killEnvForced && (
                      <p className="text-[12px] font-bold text-warning-strong mt-2 flex items-center gap-1.5">
                        <AlertTriangle size={13} /> 환경변수 AGENT_DISABLED=1 이 설정돼 있어, 이 설정과 무관하게 항상 중단됩니다.
                      </p>
                    )}
                    {killError && (
                      <div role="alert" className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-error/30 bg-card px-3 py-2">
                        <div className="flex items-center gap-2 text-[12px] font-bold text-error-strong"><AlertTriangle size={13} /> 현재 모드를 확인하지 못해 변경을 막았습니다.</div>
                        <Button variant="secondary" size="toolbar" onClick={() => void mutateKill()}>다시 시도</Button>
                      </div>
                    )}
                    {killBusy && (
                      <p className="text-[12px] font-bold text-muted-foreground mt-2 flex items-center gap-1.5">
                        <Loader2 size={12} className="animate-spin" /> 변경 중…
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="bg-card border border-border-strong rounded-2xl p-7 shadow-sm">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-2xl bg-copilot-soft flex items-center justify-center">
                    <Database size={20} className="text-copilot-strong" />
                  </div>
                  <div>
                    <h2 className="text-[18px] font-extrabold text-foreground">현재 모델·개인정보</h2>
                    <p className="text-[13px] text-muted-foreground">지금 쓰는 AI 모델과 개인정보 처리 상태를 확인합니다.</p>
                  </div>
                </div>

                {/* 실제로는 Claude(응대 Sonnet / 분류 Haiku)로 동작하는데 화면에는 존재하지 않는 모델명
                    (Ongbot-Core·GPT-4o)이 선택지로 있었다 — 비활성이라도 "우리가 GPT를 쓴다"는 오정보가 된다.
                    목업을 지우고 현재 사실만 적는다. */}
                <div className="rounded-2xl border border-border-strong bg-background p-5 space-y-3">
                  <div>
                    <div className="text-[14px] font-bold text-gray-700 mb-1">지금 쓰는 AI</div>
                    <p className="text-[13px] text-muted-foreground leading-relaxed">
                      지원자 응대는 Claude Sonnet, 문자 분류는 Claude Haiku로 동작해요. 모델을 화면에서 바꾸는 기능은 아직 없어요(변경이 필요하면 개발팀에 요청).
                    </p>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-2 text-[14px] font-bold text-gray-700">개인정보 처리 <span className="rounded-full bg-warning-soft px-1.5 py-0.5 text-[12px] font-bold text-warning-strong">자동 마스킹 준비중</span></div>
                    <p className="text-[13px] text-muted-foreground leading-relaxed">
                      민감정보 자동 마스킹은 아직 준비 중이에요. 지원자가 주민등록번호·계좌번호를 보내면 매니저가 직접 확인해 주세요.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'simulator' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
                <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                  <FlaskConical size={20} className="text-copilot-strong" /> 응대 미리보기
                </h2>
                <span className="text-[12px] font-bold bg-copilot-soft text-copilot-strong px-3 py-1 rounded-full">실제 Claude 호출</span>
              </div>
              <p className="text-sm text-muted-foreground mb-6">지원자가 보낼 법한 문자를 입력하면, 지금 설정된 말투·성격과 지식 베이스로 옹봇이 어떤 답변 초안을 만드는지 미리 확인할 수 있어요. <b>실제 발송은 되지 않습니다.</b></p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {/* Input */}
                <div className="flex flex-col gap-4">
                  <div>
                    <label className="block text-[13px] font-bold text-gray-700 mb-2">지원자가 보낸 문자 <span className="text-error-strong">*</span></label>
                    <textarea
                      value={simInbound}
                      onChange={(e) => setSimInbound(e.target.value)}
                      rows={4}
                      placeholder="예: 안녕하세요, 시급이 어떻게 되나요? 오토바이 없어도 지원 가능한가요?"
                      className="bg-input-background/90 font-medium shadow-inset hover:border-foreground/25 min-h-11 w-full px-4 py-3 border border-border-strong rounded-2xl text-sm leading-relaxed focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring resize-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-gray-700 mb-2">참고 공고 내용 <span className="text-muted-foreground font-medium">(선택)</span></label>
                    <textarea
                      value={simPosting}
                      onChange={(e) => setSimPosting(e.target.value)}
                      rows={5}
                      placeholder="공고문을 붙여넣으면 시급·근무지 등 사실을 그 내용 기준으로 답변합니다. 비워두면 일반 컨텍스트로 응대해요."
                      className="bg-input-background/90 font-medium shadow-inset hover:border-foreground/25 min-h-11 w-full px-4 py-3 border border-border-strong rounded-2xl text-sm leading-relaxed focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring resize-none"
                    />
                  </div>
                  <Button variant="primary" size="lg" onClick={handleRunSimulation} disabled={!simInbound.trim()} isLoading={simRunning} className="w-full">
                {!simRunning && <PlayCircle size={18} className="text-brand-yellow" />} {simRunning ? "응대 생성 중…" : "이 문자에 AI가 어떻게 답할지 보기"}
              </Button>
                </div>

                {/* Output */}
                <div className="bg-background border border-border-strong rounded-2xl p-5 min-h-[300px] flex flex-col">
                  <div className="text-[13px] font-bold text-muted-foreground mb-3 flex items-center gap-1.5"><Bot size={15} /> 옹봇 응답 결과</div>
                  {!simResult && !simRunning && (
                    <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground">
                      <FlaskConical size={32} className="mb-3 opacity-40" />
                      <div className="text-[13px] font-medium">왼쪽에 문자를 입력하고 실행하면<br />여기에 AI 답변 초안이 표시됩니다.</div>
                    </div>
                  )}
                  {simRunning && (
                    <div className="flex-1 flex flex-col items-center justify-center text-center text-copilot-strong">
                      <Loader2 size={28} className="animate-spin mb-3" />
                      <div className="text-[13px] font-bold">실제 Claude 모델을 호출하는 중...</div>
                    </div>
                  )}
                  {simResult && simResult.status === 'reply' && (
                    <div className="flex flex-col gap-4">
                      <div className="flex items-start gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-brand-yellow flex items-center justify-center shrink-0 border border-yellow-500"><Bot size={16} className="text-foreground" /></div>
                        <div className="bg-card border border-border-strong rounded-2xl rounded-tl-sm p-3.5 text-[14px] leading-relaxed text-gray-800 whitespace-pre-wrap shadow-sm">
                          {simResult.draft_text}
                        </div>
                      </div>
                      <div className="bg-card border border-border-strong rounded-2xl p-3.5">
                        <div className="text-[12px] font-bold text-muted-foreground mb-1.5 flex items-center gap-1.5"><Sparkles size={13} className="text-copilot-strong" /> 판단 근거 (reasoning)</div>
                        <div className="text-[13px] text-gray-700 leading-relaxed whitespace-pre-wrap">{simResult.reasoning}</div>
                      </div>
                    </div>
                  )}
                  {simResult && simResult.status === 'need_info' && (
                    <div className="flex flex-col gap-4">
                      <div className="bg-yellow-50 border border-warning/35 rounded-2xl p-4">
                        <div className="text-[13px] font-bold text-warning-strong mb-1.5 flex items-center gap-1.5"><AlertTriangle size={15} /> 사람 확인 필요</div>
                        <div className="text-[13px] text-warning-strong leading-relaxed">AI가 자체 답변하지 않고 매니저 인계 큐에 남기는 상황이에요. Slack 알림이 켜져 있으면 함께 발송됩니다.</div>
                      </div>
                      {simResult.missing_info && (
                        <div className="bg-card border border-border-strong rounded-2xl p-3.5">
                          <div className="text-[12px] font-bold text-muted-foreground mb-1.5">부족한 정보</div>
                          <div className="text-[13px] text-gray-700 leading-relaxed whitespace-pre-wrap">{simResult.missing_info}</div>
                        </div>
                      )}
                      <div className="bg-card border border-border-strong rounded-2xl p-3.5">
                        <div className="text-[12px] font-bold text-muted-foreground mb-1.5 flex items-center gap-1.5"><Sparkles size={13} className="text-copilot-strong" /> 판단 근거 (reasoning)</div>
                        <div className="text-[13px] text-gray-700 leading-relaxed whitespace-pre-wrap">{simResult.reasoning}</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'improve' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              {/* R4-3 AI 사용량 카드 — 이번 달 ai_usage_daily 집계 */}
              <div className="p-5 border border-border-strong rounded-2xl bg-card mb-6">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 text-[14px] font-bold text-foreground">
                    <Coins size={16} className="text-warning-strong" /> 이번 달 AI 사용량
                  </div>
                  <a
                    href="https://console.anthropic.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] font-bold text-info hover:underline flex items-center gap-1"
                  >
                    크레딧 잔액은 Anthropic 콘솔에서 <ExternalLink size={11} />
                  </a>
                </div>
                {usageLoading ? (
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground py-2"><Loader2 size={15} className="animate-spin" /> 불러오는 중…</div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div>
                      <div className="text-[12px] font-bold text-muted-foreground mb-0.5">Claude 호출</div>
                      <div className="text-[20px] font-extrabold text-foreground">{monthStats.calls.toLocaleString()}<span className="text-[12px] font-bold text-muted-foreground">회</span></div>
                    </div>
                    <div>
                      <div className="text-[12px] font-bold text-muted-foreground mb-0.5">토큰 (입력 / 출력)</div>
                      <div className="text-[20px] font-extrabold text-foreground">{fmtTokens(monthStats.tokensIn)}<span className="text-[13px] font-bold text-muted-foreground"> / {fmtTokens(monthStats.tokensOut)}</span></div>
                    </div>
                    <div>
                      <div className="text-[12px] font-bold text-muted-foreground mb-0.5">추정 비용</div>
                      <div className="text-[20px] font-extrabold text-foreground">${monthStats.cost.toFixed(2)}</div>
                    </div>
                  </div>
                )}

                {/* 월별 비용 추이(AI+SMS, 환율 1,500원) + 월말 예상 */}
                {!usageLoading && (() => {
                  const months = usageApi?.months ?? [];
                  if (months.length === 0) return null;
                  const max = Math.max(1, ...months.map((m) => m.total_cost_krw));
                  const proj = usageApi?.projection;
                  return (
                    <div className="mt-4 pt-4 border-t border-muted">
                      <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
                        <div className="text-[13px] font-bold text-gray-700">월별 비용 · AI+문자 (환율 1,500원)</div>
                        {proj && (
                          <div className="text-[12px] text-muted-foreground">
                            이번 달 <b className="text-foreground">₩{proj.mtd_krw.toLocaleString()}</b>
                            {" · "}월말 예상 <b className="text-warning-strong">₩{proj.projected_krw.toLocaleString()}</b>
                            <span className="text-muted-foreground"> ({proj.elapsed_days}/{proj.days_in_month}일)</span>
                          </div>
                        )}
                      </div>
                      <div className="space-y-1">
                        {months.map((mo) => (
                          <div key={mo.month} className="flex items-center gap-2 text-[12px]">
                            <span className="w-14 shrink-0 font-bold text-muted-foreground">{mo.month}</span>
                            <div className="flex-1 h-4 bg-background rounded overflow-hidden">
                              <div className="h-full bg-warning/35" style={{ width: `${(mo.total_cost_krw / max) * 100}%` }} />
                            </div>
                            <span className="w-24 shrink-0 text-right font-bold text-foreground">₩{mo.total_cost_krw.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                <p className="text-[12px] text-muted-foreground mt-3 leading-relaxed">
                  * 추정 비용 = 토큰 × 모델 단가 (Sonnet 4.6 입력 $3 · 출력 $15 / Haiku 4.5 입력 $1 · 출력 $5 per 1M tokens, 캐시 읽기는 입력 단가의 10%로 계산). 월별 원화는 환율 1,500원 가정. 실제 청구액과 다를 수 있어요.
                </p>
              </div>

              {/* R4-2 개선 제안 — 반영은 매니저 승인으로만 (자동 반영 금지) */}
              <h2 className="text-lg font-bold text-foreground mb-2 flex items-center gap-2">
                <Lightbulb size={20} className="text-warning-strong" /> 개선 제안
              </h2>
              <p className="text-sm text-muted-foreground mb-5">
                최근 7일간 <b>매니저가 고쳐 보낸 AI 초안 · AI가 매니저에게 넘긴 사유 · 정보 부족 사례</b>에서 AI가 배울 거리를 찾아 제안합니다.
                제안은 <b>매니저가 승인해야만</b> 지식베이스에 반영돼요 — 자동으로 지식이 바뀌지 않습니다.
              </p>

              <Button variant="primary" onClick={handleRunImprove} isLoading={improveLoading}>
              {!improveLoading && <Sparkles size={16} className="text-brand-yellow" />} {improveLoading ? "분석 중…" : "개선 제안 받기"}
            </Button>
              <p className="text-[12px] text-muted-foreground mt-1.5">실행하면 Claude 호출 1회 비용이 발생해요.</p>

              {improveRan && !improveLoading && proposals.length === 0 && (
                <div className="mt-5 text-center text-[13px] text-muted-foreground border border-dashed border-border-strong rounded-2xl p-8">
                  아직 배울 재료가 없어요 — 코파일럿 초안 수정·매니저에게 넘어간 사례가 쌓이면 제안을 만들어요.
                </div>
              )}

              {proposals.length > 0 && (
                <div className="mt-5 space-y-3">
                  {proposals.map((p, idx) => (
                    <div key={`${p.kind}-${p.title}-${idx}`} className="border border-border-strong rounded-2xl p-4 bg-card hover:border-gray-300 transition-colors">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className={`px-1.5 py-0.5 rounded-full text-[12px] font-bold border ${IMPROVE_KIND_BADGE[p.kind]}`}>{IMPROVE_KIND_LABEL[p.kind]}</span>
                        <span className={`px-1.5 py-0.5 rounded-full text-[12px] font-bold border ${p.confidence === 'high' ? 'bg-success-soft text-success-strong border-success/25' : 'bg-background text-muted-foreground border-border-strong'}`}>
                          {p.confidence === 'high' ? '확신 높음' : '확신 중간'}
                        </span>
                      </div>
                      <div className="text-[14px] font-bold text-foreground">{p.title}</div>
                      <div className="text-[13px] text-gray-700 mt-1 leading-relaxed whitespace-pre-wrap">{p.body}</div>
                      {p.evidence && <div className="text-[12px] text-muted-foreground mt-2">근거: {p.evidence}</div>}
                      <div className="flex items-center gap-2 mt-3 flex-wrap">
                        {p.kind === "system_message_tweak" ? (
                          <span className="text-[12px] font-bold text-warning-strong bg-yellow-50 border border-warning/35 rounded-lg px-3 py-1.5">
                            자동 반영되지 않아요 — ‘사내 지식 베이스 &gt; 자동 발송 문구’에서 직접 반영하세요
                          </span>
                        ) : (
                          <Button variant="primary" size="chip" onClick={() => handleApproveProposal(idx)} isLoading={approvingIdx === idx} disabled={approvingIdx !== null}>
                          {approvingIdx !== idx && <CheckCircle2 size={13} />} 승인 — 지식에 추가
                        </Button>
                        )}
                        <Button variant="secondary" size="chip" className="px-3.5 py-1.5 text-[13px] rounded-lg" onClick={() => handleDismissProposal(idx)}>무시</Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}
