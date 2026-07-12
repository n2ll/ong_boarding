import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import useSWR from "swr";
import { Brain, Save, RefreshCw, MessageSquare, Database, Sparkles, Settings2, SlidersHorizontal, UploadCloud, FileText, CheckCircle2, Loader2, FlaskConical, Bot, PlayCircle, AlertTriangle, Plus, Pencil, Trash2, X, Sprout, Power, Layers, Building2, Briefcase, ExternalLink, TrendingUp, Zap, Lightbulb, Coins } from "lucide-react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";
import { useRouter } from "next/navigation";
import { useConfirm } from "./ConfirmDialog";
import { DemoBanner } from "./DemoBanner";
import { AGENT_CATEGORY_IDS, getCategory } from "@/lib/agent/handoff-category";

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
  urgent: "bg-[#FFF5F5] text-[#C53030] border-[#FEB2B2]",
  answerable: "bg-[#FFFBEC] text-[#B7791F] border-[#FAF089]",
  human: "bg-[#EBF8FF] text-[#2B6CB0] border-[#BEE3F8]",
  neutral: "bg-[#F7FAFC] text-[#718096] border-[#E2E8F0]",
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
  knowledge: "bg-[#EBF8FF] text-[#2B6CB0] border-[#BEE3F8]",
  conversation_example: "bg-[#F0FFF4] text-[#276749] border-[#C6F6D5]",
  system_message_tweak: "bg-[#FFFAF0] text-[#C05621] border-[#FBD38D]",
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

export function AgentBrain() {
  const confirm = useConfirm();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("overview");
  // AI 지식 현황(개선1·3): 사실 3계층 집계 + 인계 분포 — 모두 SWR로 캐시·dedup(타 탭과 키 공유).
  const { data: ovBranchesApi, mutate: mutateOvBranches } = useSWR<{ data?: OverviewBranch[] }>("/api/admin/branches");
  const { data: ovJobsApi, mutate: mutateOvJobs } = useSWR<{ jobs?: OverviewJob[] }>("/api/admin/jobs?status=active");
  const { data: ovHandoffsApi, isLoading: ovHandoffsLoading, mutate: mutateOvHandoffs } = useSWR<{ by_category?: Record<string, number>; total?: number }>("/api/admin/agent/handoffs");
  const ovBranches = useMemo(() => ovBranchesApi?.data ?? [], [ovBranchesApi]);
  const ovJobs = useMemo(() => ((ovJobsApi?.jobs ?? []) as OverviewJob[]).filter((j) => !j.title.startsWith("__")), [ovJobsApi]);
  const ovByCategory = useMemo(() => ovHandoffsApi?.by_category ?? {}, [ovHandoffsApi]);
  const ovHandoffTotal = ovHandoffsApi?.total ?? 0;
  const ovLoading = ovHandoffsLoading;
  const loadOverview = useCallback(() => {
    void mutateOvBranches();
    void mutateOvJobs();
    void mutateOvHandoffs();
  }, [mutateOvBranches, mutateOvJobs, mutateOvHandoffs]);
  const [isSaving, setIsSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'vectorizing' | 'complete'>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const { data: examplesApi, isLoading: examplesLoading, mutate: mutateExamples } = useSWR<{ data?: PromptExample[] }>("/api/admin/prompt-examples");
  const examples = useMemo(() => examplesApi?.data ?? [], [examplesApi]);
  const kbLoading = examplesLoading && examples.length === 0;
  const loadExamples = useCallback(async () => { await mutateExamples(); }, [mutateExamples]);
  const [kbCategory, setKbCategory] = useState<KbCategory>("facts");
  const [kbForm, setKbForm] = useState<KbForm | null>(null);
  const [kbBusy, setKbBusy] = useState(false);
  const [kbSeeding, setKbSeeding] = useState(false);

  // 응대 시뮬레이터 상태
  const [simInbound, setSimInbound] = useState("");
  const [simPosting, setSimPosting] = useState("");
  const [simRunning, setSimRunning] = useState(false);
  const [simResult, setSimResult] = useState<SimDraft | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 🔁 개선 제안 (R4-2) — 최근 7일 재료에서 배울 거리 추출. 반영은 매니저 승인으로만.
  const [improveLoading, setImproveLoading] = useState(false);
  const [improveRan, setImproveRan] = useState(false);
  const [proposals, setProposals] = useState<ImproveProposal[]>([]);
  const [approvingIdx, setApprovingIdx] = useState<number | null>(null);

  // AI 사용량 카드 (R4-3) — 이번 달 ai_usage_daily 모델별 집계 (기존 usage API 재사용).
  const { data: usageApi, isLoading: usageLoading } = useSWR<{ month?: { models?: UsageMonthModel[] } }>("/api/admin/usage");
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
  const { data: personaApi, isLoading: personaLoading } = useSWR<{ data?: { role?: string; instructions?: string; tone?: string; emoji?: number } }>("/api/admin/agent/persona");
  const [persona, setPersona] = useState<PersonaForm>(DEFAULT_PERSONA);
  const personaLoaded = !personaLoading;
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
  type KillMode = "auto" | "draft" | "off";
  const { data: killApi, isLoading: killLoading } = useSWR<{ mode?: KillMode; disabled?: boolean; env_forced?: boolean; updated_at?: string | null }>("/api/admin/agent/kill-switch");
  const [killMode, setKillMode] = useState<KillMode>("auto");
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
  const killDisabled = killMode === "off";

  const handleChangeKillMode = async (next: KillMode) => {
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
      setKillUpdatedAt(new Date().toISOString());
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
  const factsCount = examples.filter((e) => e.category === "facts" && !e.title.startsWith("__")).length;
  const branchesFilled = ovBranches.filter((b) => (b.ai_facts ?? "").trim()).length;
  const jobsPayFilled = ovJobs.filter((j) => (j.pay_info ?? "").trim()).length;
  const payGapJobs = ovJobs.filter((j) => !(j.pay_info ?? "").trim());

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
      toast.success("페르소나를 저장했어요. 60초 이내 AI 응대에 반영됩니다. (예외 처리 규칙은 별도 데모)");
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
        toast.error(json.error || "시뮬레이션에 실패했어요");
        return;
      }
      setSimResult(json.draft as SimDraft);
    } catch {
      toast.error("시뮬레이션에 실패했어요");
    } finally {
      setSimRunning(false);
    }
  };

  const simulateUploadAndVectorize = () => {
    if (uploadState !== 'idle') return;

    setUploadState('uploading');
    setUploadProgress(0);

    const interval = setInterval(() => {
      setUploadProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval);
          setUploadState('vectorizing');
          simulateVectorization();
          return 100;
        }
        return prev + 15;
      });
    }, 200);
  };

  const simulateVectorization = () => {
    setTimeout(() => {
      // 데모 시연 — 실제 학습(RAG 인덱싱)은 일어나지 않으므로 성공 토스트를 띄우지 않는다.
      setUploadState('complete');
      setTimeout(() => setUploadState('idle'), 3000);
    }, 2500);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      simulateUploadAndVectorize();
    }
  };

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-[#FFCB3C] rounded-2xl flex items-center justify-center shadow-sm">
            <Brain size={24} className="text-[#1A202C]" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">에이전트 두뇌</h1>
            <p className="text-[14px] text-[#718096]">AI가 응대할 때 쓰는 말투·지식·인계 규칙을 관리합니다. 여기서 바꾸면 바로 적용돼요.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setPersona(DEFAULT_PERSONA); toast.info("기본 페르소나로 되돌렸어요. 저장해야 반영됩니다."); }}
            className="flex items-center gap-2 bg-white border border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC] px-4 py-2.5 rounded-xl font-bold transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
          >
            <RefreshCw size={16} /> 기본값으로 초기화
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-2 bg-[#1A202C] hover:bg-[#2D3748] text-white px-6 py-2.5 rounded-xl font-bold transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] disabled:opacity-70"
          >
            {isSaving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
            {isSaving ? '저장 중...' : '설정 저장'}
          </button>
        </div>
      </div>

      <div className="flex gap-8">
        {/* Sidebar Nav */}
        <div className="w-[240px] shrink-0 flex flex-col gap-2">
          <button
            onClick={() => setActiveTab("overview")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'overview' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <Layers size={18} className={activeTab === 'overview' ? 'text-[#DD6B20]' : ''} /> AI 지식 현황
          </button>
          <button
            onClick={() => setActiveTab("persona")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'persona' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <MessageSquare size={18} className={activeTab === 'persona' ? 'text-[#FFCB3C]' : ''} /> 페르소나 및 어조
          </button>
          <button
            onClick={() => setActiveTab("knowledge")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'knowledge' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <Database size={18} className={activeTab === 'knowledge' ? 'text-[#3182CE]' : ''} /> 사내 지식 베이스
          </button>
          <button
            onClick={() => setActiveTab("rules")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'rules' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <SlidersHorizontal size={18} className={activeTab === 'rules' ? 'text-[#38A169]' : ''} /> 예외 처리 규칙
          </button>
          <button
            onClick={() => setActiveTab("advanced")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'advanced' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <Settings2 size={18} className={activeTab === 'advanced' ? 'text-[#E53E3E]' : ''} /> 고급 설정
          </button>
          <button
            onClick={() => setActiveTab("simulator")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'simulator' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <FlaskConical size={18} className={activeTab === 'simulator' ? 'text-[#805AD5]' : ''} /> 응대 시뮬레이터
          </button>
          <button
            onClick={() => setActiveTab("improve")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'improve' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <Lightbulb size={18} className={activeTab === 'improve' ? 'text-[#D69E2E]' : ''} /> 🔁 개선 제안
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 bg-white border border-[#E2E8F0] rounded-2xl shadow-sm p-8">
          {activeTab === 'overview' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-bold text-[#1A202C] flex items-center gap-2">
                  <Layers size={20} className="text-[#DD6B20]" /> AI가 참고하는 사실 — 한눈에
                </h2>
                <button onClick={loadOverview} disabled={ovLoading} className="flex items-center gap-1.5 text-[12.5px] font-bold text-[#718096] hover:text-[#1A202C] disabled:opacity-50">
                  {ovLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 새로고침
                </button>
              </div>
              <p className="text-sm text-[#718096] mb-6">옹봇은 응대할 때 <b>① 공통 운영정보 · ② 지점별 정보 · ③ 공고별 단가·정책</b> 세 곳의 사실만 인용합니다. 비어 있는 곳은 인용할 수 없어 매니저 인계가 늘어납니다. 빈칸을 채우면 인계가 줄어요.</p>

              {/* 3계층 커버리지 카드 */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                <button onClick={() => setActiveTab("knowledge")} className="text-left p-4 border border-[#E2E8F0] rounded-2xl bg-white hover:border-[#3182CE] transition-colors">
                  <div className="flex items-center gap-2 text-[#3182CE] mb-2"><Database size={16} /><span className="text-[12px] font-bold">① 공통 운영정보</span></div>
                  <div className="text-[22px] font-extrabold text-[#1A202C]">{factsCount}<span className="text-[13px] font-bold text-[#A0AEC0]">개 항목</span></div>
                  <div className="text-[11.5px] text-[#718096] mt-1 flex items-center gap-1">두뇌 &gt; 사내 지식 베이스 <ExternalLink size={11} /></div>
                </button>
                <button onClick={() => router.push("/branches")} className="text-left p-4 border border-[#E2E8F0] rounded-2xl bg-white hover:border-[#38A169] transition-colors">
                  <div className="flex items-center gap-2 text-[#38A169] mb-2"><Building2 size={16} /><span className="text-[12px] font-bold">② 지점별 정보</span></div>
                  <div className="text-[22px] font-extrabold text-[#1A202C]">{branchesFilled}<span className="text-[13px] font-bold text-[#A0AEC0]">/{ovBranches.length} 지점 작성</span></div>
                  <div className="text-[11.5px] text-[#718096] mt-1 flex items-center gap-1">지점관리에서 편집 <ExternalLink size={11} /></div>
                </button>
                <button onClick={() => router.push("/jobs")} className="text-left p-4 border border-[#E2E8F0] rounded-2xl bg-white hover:border-[#DD6B20] transition-colors">
                  <div className="flex items-center gap-2 text-[#DD6B20] mb-2"><Briefcase size={16} /><span className="text-[12px] font-bold">③ 공고별 단가·정책</span></div>
                  <div className="text-[22px] font-extrabold text-[#1A202C]">{jobsPayFilled}<span className="text-[13px] font-bold text-[#A0AEC0]">/{ovJobs.length} 공고 단가입력</span></div>
                  <div className="text-[11.5px] text-[#718096] mt-1 flex items-center gap-1">공고 편집에서 입력 <ExternalLink size={11} /></div>
                </button>
              </div>

              {/* 단가 미입력 공고 — 인계 위험 */}
              {payGapJobs.length > 0 && (
                <div className="p-4 border border-[#FBD38D] bg-[#FFFAF0] rounded-2xl mb-6">
                  <div className="flex items-center gap-2 text-[#C05621] mb-3 text-[13.5px] font-bold"><AlertTriangle size={16} /> 단가 미입력 공고 {payGapJobs.length}개 — 단가 문의가 오면 매니저 인계됩니다</div>
                  <div className="flex flex-col gap-1.5">
                    {payGapJobs.slice(0, 6).map((j) => (
                      <div key={j.id} className="flex items-center justify-between gap-2 bg-white border border-[#FEEBC8] rounded-lg px-3 py-2">
                        <div className="min-w-0">
                          <span className="text-[13px] font-bold text-[#1A202C]">{j.title}</span>
                          {j.branch && <span className="ml-2 text-[11px] font-bold text-[#A0AEC0]">{j.branch}</span>}
                        </div>
                        <button onClick={() => router.push(`/jobs?edit=${j.id}`)} className="shrink-0 px-2.5 py-1 rounded-md text-[11.5px] font-bold bg-[#DD6B20] text-white hover:bg-[#C05621] transition-colors">단가 채우기</button>
                      </div>
                    ))}
                    {payGapJobs.length > 6 && <div className="text-[11.5px] text-[#A0AEC0] px-1">외 {payGapJobs.length - 6}개</div>}
                  </div>
                </div>
              )}

              {/* 인계 분포(개선3) — 어떤 질문이 자주 매니저로 넘어가나 */}
              <div className="p-5 border border-[#E2E8F0] rounded-2xl bg-white">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 text-[#1A202C] text-[14px] font-bold"><TrendingUp size={16} className="text-[#805AD5]" /> 인계 사유 분포 (현재 대기 {ovHandoffTotal}건)</div>
                  <button onClick={() => router.push("/live")} className="text-[12px] font-bold text-[#805AD5] hover:underline flex items-center gap-1">인계 큐 열기 <ExternalLink size={11} /></button>
                </div>
                <p className="text-[12px] text-[#718096] mb-4">자주 인계되는 카테고리는 위 ①②③ 사실을 채우면 줄어듭니다. (단가·정산 → 공고 단가, 계약·정책 → 공고 정책/지점 정보)</p>
                {ovLoading ? (
                  <div className="flex items-center gap-2 text-[13px] text-[#A0AEC0] py-2"><Loader2 size={15} className="animate-spin" /> 불러오는 중…</div>
                ) : Object.keys(ovByCategory).length === 0 ? (
                  <div className="text-[13px] text-[#A0AEC0] py-2">대기 중인 인계가 없어요.</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {Object.entries(ovByCategory).sort((a, b) => b[1] - a[1]).map(([cid, count]) => {
                      const cat = getCategory(cid);
                      const pct = ovHandoffTotal > 0 ? Math.round((count / ovHandoffTotal) * 100) : 0;
                      return (
                        <div key={cid} className="flex items-center gap-3">
                          <span className="w-[88px] shrink-0 text-[12.5px] font-bold text-[#4A5568] text-right">{cat.label}</span>
                          <div className="flex-1 h-5 bg-[#F1F4F8] rounded-md overflow-hidden">
                            <div className="h-full bg-[#805AD5] rounded-md" style={{ width: `${Math.max(pct, 4)}%` }} />
                          </div>
                          <span className="w-[52px] shrink-0 text-[12px] font-bold text-[#718096]">{count}건</span>
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
              <h2 className="text-lg font-bold text-[#1A202C] mb-6 flex items-center gap-2">
                <Sparkles size={20} className="text-[#FFCB3C]" /> AI 에이전트 성격 · 말투 정의
              </h2>

              <div className="space-y-6">
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">기본 역할 (Role)</label>
                  <input
                    type="text"
                    value={persona.role}
                    onChange={(e) => setPersonaField("role", e.target.value)}
                    disabled={!personaLoaded}
                    className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] disabled:bg-[#F7FAFC]"
                  />
                </div>

                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">핵심 지시사항 (Instructions)</label>
                  <textarea
                    rows={6}
                    value={persona.instructions}
                    onChange={(e) => setPersonaField("instructions", e.target.value)}
                    disabled={!personaLoaded}
                    className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm font-mono leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] disabled:bg-[#F7FAFC]"
                  />
                  <p className="text-[12px] text-[#A0AEC0] mt-2">‘설정 저장’을 누르면 60초 이내 실제 AI 응대(시뮬레이터 포함)에 반영됩니다. 안전 규칙(민감 질문 매니저 인계 등)은 항상 유지됩니다.</p>
                </div>

                <div className="grid grid-cols-2 gap-6 pt-4 border-t border-[#E2E8F0]">
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-3">어조 (Tone & Manner)</label>
                    <div className="flex flex-col gap-3">
                      {TONE_OPTIONS.map((tone) => {
                        const selected = persona.tone === tone;
                        return (
                          <label key={tone} className="flex items-center gap-3 cursor-pointer" onClick={() => personaLoaded && setPersonaField("tone", tone)}>
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${selected ? 'border-[#FFCB3C]' : 'border-[#CBD5E0]'}`}>
                              {selected && <div className="w-2.5 h-2.5 rounded-full bg-[#FFCB3C]"></div>}
                            </div>
                            <span className={`text-sm font-medium ${selected ? 'text-[#1A202C] font-bold' : 'text-[#718096]'}`}>{tone}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-3">이모지 사용 빈도</label>
                    <div className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl p-4">
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={persona.emoji}
                        onChange={(e) => setPersonaField("emoji", Number(e.target.value))}
                        disabled={!personaLoaded}
                        className="w-full accent-[#FFCB3C]"
                      />
                      <div className="flex justify-between text-[11px] font-bold text-[#A0AEC0] mt-2">
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
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold text-[#1A202C] flex items-center gap-2">
                  <Database size={20} className="text-[#3182CE]" /> 사내 지식 베이스
                </h2>
                <span className="text-[12px] font-bold bg-[#F0FFF4] text-[#38A169] px-3 py-1 rounded-full">prompt_examples 연동됨</span>
              </div>
              <p className="text-sm text-[#718096] mb-6">옹봇이 지원자 응대에 사용하는 운영 정보·대화 예시·자동 발송 문구입니다. 아래 목록은 DB(prompt_examples)에서 실시간으로 불러옵니다. 파일 업로드(RAG)는 데모입니다.</p>

              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => uploadState === 'idle' && fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center text-center mb-8 transition-all relative overflow-hidden ${isDragging
                    ? 'border-[#FFCB3C] bg-[#FFFBEC] scale-[1.01]'
                    : uploadState !== 'idle'
                      ? 'border-[#CBD5E0] bg-white cursor-default'
                      : 'border-[#CBD5E0] bg-[#F7FAFC] hover:bg-[#EDF2F7] hover:border-[#A0AEC0] cursor-pointer'
                  }`}
              >
                <input type="file" ref={fileInputRef} className="hidden" onChange={simulateUploadAndVectorize} accept=".pdf,.doc,.docx,.txt" />

                <AnimatePresence mode="wait">
                  {uploadState === 'idle' && (
                    <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center">
                      <div className={`w-14 h-14 rounded-full shadow-sm flex items-center justify-center mb-4 transition-colors ${isDragging ? 'bg-[#FFCB3C] text-white' : 'bg-white text-[#4A5568]'}`}>
                        <UploadCloud size={28} />
                      </div>
                      <h3 className="text-[16px] font-extrabold text-[#1A202C] mb-1.5">파일 업로드 (데모) <span className="text-[10px] font-bold text-[#1A202C] bg-[#FEFCBF] px-1.5 py-0.5 rounded align-middle">데모</span></h3>
                      <p className="text-[13px] font-medium text-[#718096]">RAG 벡터 스토어는 아직 연동되지 않았어요. 실제 지식은 아래 목록을 참고하세요.</p>
                    </motion.div>
                  )}

                  {uploadState === 'uploading' && (
                    <motion.div key="uploading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center w-full max-w-md">
                      <FileText size={32} className="text-[#3182CE] mb-4" />
                      <h3 className="text-[15px] font-bold text-[#1A202C] mb-4">파일 업로드 중...</h3>
                      <div className="w-full h-2.5 bg-[#EDF2F7] rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-[#3182CE] rounded-full"
                          initial={{ width: 0 }}
                          animate={{ width: `${uploadProgress}%` }}
                        />
                      </div>
                      <div className="w-full flex justify-between mt-2 text-[11px] font-bold text-[#718096]">
                        <span>2026_면접가이드.pdf</span>
                        <span>{Math.min(uploadProgress, 100)}%</span>
                      </div>
                    </motion.div>
                  )}

                  {uploadState === 'vectorizing' && (
                    <motion.div key="vectorizing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center">
                      <div className="relative mb-6">
                        <Brain size={48} className="text-[#805AD5]" />
                        <Sparkles size={20} className="text-[#FFCB3C] absolute -top-1 -right-1 animate-pulse" />
                        <div className="absolute inset-0 border-4 border-[#805AD5] border-t-transparent rounded-full animate-spin opacity-20 scale-125"></div>
                      </div>
                      <h3 className="text-[16px] font-extrabold text-[#1A202C] mb-2">AI 두뇌에 지식 주입 중...</h3>
                      <p className="text-[13px] text-[#718096]">문서를 텍스트 청크(Chunk)로 분해하고 벡터 스토어에 인덱싱하고 있습니다.</p>

                      <div className="mt-5 bg-[#FAF5FF] border border-[#E9D8FD] rounded-lg p-3 text-[11.5px] font-mono text-[#553C9A] w-full max-w-md text-left">
                        <div className="flex items-center gap-2 mb-1 opacity-70"><CheckCircle2 size={12} /> Text Extraction... Done</div>
                        <div className="flex items-center gap-2 mb-1 opacity-70"><CheckCircle2 size={12} /> Chunking 1024 tokens... Done</div>
                        <div className="flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Generating Embeddings (text-embedding-3-small)...</div>
                      </div>
                    </motion.div>
                  )}

                  {uploadState === 'complete' && (
                    <motion.div key="complete" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center">
                      <div className="w-16 h-16 bg-[#FFFBEC] rounded-full flex items-center justify-center mb-4">
                        <AlertTriangle size={32} className="text-[#B7791F]" />
                      </div>
                      <h3 className="text-[18px] font-extrabold text-[#1A202C] mb-1">데모 시연입니다 — 실제로 학습되지 않습니다</h3>
                      <p className="text-[13px] text-[#718096]">옹봇이 실제로 참고하는 지식은 아래 지식 베이스 목록에 직접 추가해주세요.</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* 카테고리 탭 + 액션 */}
              <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                <div className="flex items-center gap-1.5 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl p-1">
                  {KB_CATEGORIES.map((c) => {
                    const count = examples.filter((e) => e.category === c.key).length;
                    const on = kbCategory === c.key;
                    return (
                      <button
                        key={c.key}
                        onClick={() => { setKbCategory(c.key); setKbForm(null); }}
                        className={`px-3.5 py-1.5 rounded-lg text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] ${on ? "bg-white text-[#1A202C] shadow-sm" : "text-[#718096] hover:text-[#1A202C]"}`}
                      >
                        {c.label} <span className={on ? "text-[#A0AEC0]" : "text-[#CBD5E0]"}>{count}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleKbSeed}
                    disabled={kbSeeding}
                    className="flex items-center gap-1.5 bg-white border border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC] px-3.5 py-2 rounded-xl text-[13px] font-bold transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                  >
                    {kbSeeding ? <Loader2 size={15} className="animate-spin" /> : <Sprout size={15} />} 기본값 채우기
                  </button>
                  <button
                    onClick={openKbAdd}
                    className="flex items-center gap-1.5 bg-[#1A202C] hover:bg-[#2D3748] text-white px-3.5 py-2 rounded-xl text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                  >
                    <Plus size={15} /> 새 항목
                  </button>
                </div>
              </div>

              <p className="text-[12.5px] text-[#718096] bg-[#F7FAFC] border border-[#E2E8F0] rounded-lg px-3.5 py-2.5 mb-4 leading-relaxed">
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
                    <div className="border-2 border-[#1A202C] rounded-2xl p-5 bg-white">
                      <div className="flex items-center justify-between mb-4">
                        <div className="text-[14px] font-extrabold text-[#1A202C] flex items-center gap-2">
                          {kbForm.id === null ? <Plus size={16} /> : <Pencil size={16} />}
                          {kbForm.id === null ? "새 지식 항목" : "지식 항목 수정"}
                          <span className="text-[10px] font-bold bg-[#EBF8FF] text-[#3182CE] px-1.5 py-0.5 rounded">{CATEGORY_LABEL[kbForm.category] ?? kbForm.category}</span>
                        </div>
                        <button onClick={() => setKbForm(null)} className="text-[#A0AEC0] hover:text-[#4A5568] p-1 rounded-lg"><X size={18} /></button>
                      </div>
                      <div className="flex flex-col gap-3">
                        <div>
                          <label className="block text-[12px] font-bold text-[#4A5568] mb-1.5">
                            제목 {kbForm.category === "system_message" && <span className="text-[#C05621] font-medium">(키 — 변경 시 자동 발송이 끊길 수 있어요)</span>}
                          </label>
                          <input
                            value={kbForm.title}
                            onChange={(e) => setKbForm({ ...kbForm, title: e.target.value })}
                            placeholder={kbForm.category === "facts" ? "예: 강북미아" : kbForm.category === "knowledge" ? "예: 정산·지급일" : kbForm.category === "system_message" ? "예: danggeun_start" : "예: 시급 문의 응대"}
                            className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
                          />
                        </div>
                        <div>
                          <label className="block text-[12px] font-bold text-[#4A5568] mb-1.5">내용</label>
                          <textarea
                            value={kbForm.body}
                            onChange={(e) => setKbForm({ ...kbForm, body: e.target.value })}
                            rows={kbForm.category === "facts" ? 3 : 5}
                            placeholder={kbForm.category === "facts" ? "시급 15,000~20,000원, 토일 08:00-16:00, 픽업 서울 강북구..." : kbForm.category === "knowledge" ? "지원자 질문에 AI가 그대로 인용할 공식 답변을 입력하세요. 예: 급여는 익월 5일에 지급돼요..." : "발송될 문구를 입력하세요. {{이름}}, {{지점}}, {{지원폼주소}} 등 치환자 사용 가능."}
                            className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none"
                          />
                        </div>
                        <div className="flex items-center justify-end gap-2 pt-1">
                          <button onClick={() => setKbForm(null)} className="px-4 py-2 rounded-xl text-[13px] font-bold text-[#718096] hover:bg-[#F7FAFC] border border-[#E2E8F0]">취소</button>
                          <button
                            onClick={handleKbSave}
                            disabled={kbBusy}
                            className="px-5 py-2 rounded-xl text-[13px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] disabled:opacity-60 flex items-center gap-1.5"
                          >
                            {kbBusy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} 저장
                          </button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* 항목 목록 */}
              <div className="space-y-3">
                {kbLoading && (
                  <div className="flex items-center gap-2 text-[13px] text-[#A0AEC0] p-4"><Loader2 size={15} className="animate-spin" /> 불러오는 중...</div>
                )}
                {!kbLoading && kbItems.length === 0 && (
                  <div className="text-center text-[13px] text-[#A0AEC0] border border-dashed border-[#E2E8F0] rounded-xl p-8">
                    이 분류에 등록된 항목이 없어요. <button onClick={openKbAdd} className="text-[#3182CE] font-bold hover:underline">새 항목 추가</button> 또는 기본값 채우기를 눌러보세요.
                  </div>
                )}
                {kbItems.map((ex) => (
                  <div key={ex.id} className="group flex items-start justify-between p-4 border border-[#E2E8F0] rounded-xl bg-white hover:border-[#CBD5E0] transition-colors">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-[#F7FAFC] flex items-center justify-center text-[#4A5568] shrink-0">
                        <FileText size={16} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[14px] font-bold text-[#1A202C]">{ex.title}</div>
                        <div className="text-[12px] text-[#718096] mt-0.5 whitespace-pre-wrap line-clamp-3">{ex.body}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-3">
                      <button onClick={() => openKbEdit(ex)} title="수정" className="p-2 rounded-lg text-[#718096] hover:bg-[#F7FAFC] hover:text-[#1A202C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"><Pencil size={15} /></button>
                      <button onClick={() => handleKbDelete(ex)} title="삭제" className="p-2 rounded-lg text-[#718096] hover:bg-[#FFF5F5] hover:text-[#E53E3E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"><Trash2 size={15} /></button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'rules' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-[#1A202C] mb-6 flex items-center gap-2">
                <SlidersHorizontal size={20} className="text-[#38A169]" /> 예외 처리 및 폴백(Fallback) 규칙
              </h2>
              <p className="text-sm text-[#718096] mb-6">옹봇이 <b>스스로 답하지 않고 매니저에게 인계(pause)</b>하는 실제 사유 분류입니다. 안전을 위해 항상 작동하며, 각 카테고리 옆 숫자는 <b>현재 대기 중인 인계 건수</b>입니다. ‘정보 채우면 자동화 가능’ 항목은 위 ①②③ 사실을 채우면 인계가 줄어듭니다.</p>

              <div className="space-y-2.5">
                {AGENT_CATEGORY_IDS.map((cid) => {
                  const cat = getCategory(cid);
                  const count = ovByCategory[cid] ?? 0;
                  return (
                    <div key={cid} className="p-4 border border-[#E2E8F0] rounded-xl bg-white shadow-sm flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[14px] font-bold text-[#1A202C]">{cat.label}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10.5px] font-bold border ${TONE_BADGE[cat.tone]}`}>{TONE_LABEL[cat.tone]}</span>
                        </div>
                        <div className="text-[12.5px] text-[#718096]">↳ {cat.action}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className={`text-[18px] font-extrabold ${count > 0 ? "text-[#805AD5]" : "text-[#CBD5E0]"}`}>{count}</div>
                        <div className="text-[10.5px] font-bold text-[#A0AEC0]">대기</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-5 p-4 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl text-[12.5px] text-[#718096] leading-relaxed">
                <b className="text-[#4A5568]">항상 적용되는 안전 규칙:</b> 항의·법적 표현(취소/불법/신고 등), 반복 재촉·감정 격화, 계약·세금·보험 질문은 카테고리와 무관하게 즉시 인계됩니다. 이 안전 규칙은 끌 수 없습니다.
              </div>
            </div>
          )}

          {activeTab === 'advanced' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              {/* 전역 AI 응답 모드 (실데이터 연동) — 자동 응대 / 코파일럿(초안만) / 완전 중지 */}
              <div className={`border rounded-2xl p-7 shadow-sm mb-6 transition-colors ${killDisabled ? 'bg-[#FFF5F5] border-[#FEB2B2]' : killMode === 'draft' && !killEnvForced ? 'bg-[#FAF5FF] border-[#D6BCFA]' : 'bg-white border-[#E2E8F0]'}`}>
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${killDisabled || killEnvForced ? 'bg-[#FED7D7]' : killMode === 'draft' ? 'bg-[#E9D8FD]' : 'bg-[#F0FFF4]'}`}>
                    {killMode === 'draft' && !killEnvForced ? (
                      <Zap size={20} className="text-[#6B46C1]" />
                    ) : (
                      <Power size={20} className={killDisabled || killEnvForced ? 'text-[#E53E3E]' : 'text-[#38A169]'} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-[18px] font-extrabold text-[#1A202C]">AI 전역 응답</h2>
                      {killLoading ? (
                        <span className="text-[11px] font-bold text-[#718096] bg-[#EDF2F7] px-2 py-0.5 rounded-full">확인 중…</span>
                      ) : (
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${killDisabled || killEnvForced ? 'text-[#C53030] bg-[#FED7D7]' : killMode === 'draft' ? 'text-[#553C9A] bg-[#E9D8FD]' : 'text-[#276749] bg-[#C6F6D5]'}`}>
                          {killEnvForced ? '중단됨 (환경변수)' : killDisabled ? '중단됨' : killMode === 'draft' ? '코파일럿' : '작동 중'}
                        </span>
                      )}
                    </div>
                    <p className="text-[13px] text-[#718096] mt-1 max-w-[560px]">
                      인입되는 모든 지원자 메시지에 대한 AI 동작 방식을 전역으로 결정합니다.
                    </p>

                    {/* 3단 세그먼트 */}
                    <div role="radiogroup" aria-label="AI 전역 응답 모드" className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2 max-w-[640px]">
                      {([
                        { id: 'auto' as const, label: '자동 응대', desc: 'AI가 답장을 직접 발송하고 단계도 진행합니다.', icon: <Bot size={15} />, activeCls: 'border-[#38A169] bg-[#F0FFF4] ring-1 ring-[#38A169]', dotCls: 'text-[#276749]' },
                        { id: 'draft' as const, label: '코파일럿 (초안만)', desc: 'AI는 초안만 작성 — 발송은 매니저 승인 후에만 됩니다.', icon: <Zap size={15} />, activeCls: 'border-[#805AD5] bg-[#FAF5FF] ring-1 ring-[#805AD5]', dotCls: 'text-[#553C9A]' },
                        { id: 'off' as const, label: '완전 중지', desc: 'AI가 아무것도 하지 않습니다. 매니저가 직접 응대합니다.', icon: <Power size={15} />, activeCls: 'border-[#E53E3E] bg-[#FFF5F5] ring-1 ring-[#E53E3E]', dotCls: 'text-[#C53030]' },
                      ]).map((opt) => {
                        const active = killMode === opt.id && !killEnvForced;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => handleChangeKillMode(opt.id)}
                            disabled={killLoading || killBusy || killEnvForced}
                            title={killEnvForced ? "환경변수로 강제 중단된 상태입니다" : opt.desc}
                            className={`text-left rounded-xl border p-3 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${active ? opt.activeCls : 'border-[#E2E8F0] bg-white hover:border-[#CBD5E0]'}`}
                          >
                            <div className={`flex items-center gap-1.5 text-[13px] font-extrabold ${active ? opt.dotCls : 'text-[#4A5568]'}`}>
                              {opt.icon} {opt.label}
                              {killBusy && killMode !== opt.id && <span className="sr-only">변경 중</span>}
                            </div>
                            <div className="text-[11.5px] text-[#718096] mt-1 leading-snug">{opt.desc}</div>
                          </button>
                        );
                      })}
                    </div>

                    {!killLoading && killUpdatedAt && (
                      <p className="text-[12px] text-[#A0AEC0] mt-3">
                        마지막 변경: {new Date(killUpdatedAt).toLocaleString("ko-KR")}
                      </p>
                    )}
                    {killEnvForced && (
                      <p className="text-[12px] font-bold text-[#C05621] mt-2 flex items-center gap-1.5">
                        <AlertTriangle size={13} /> 환경변수 AGENT_DISABLED=1 이 설정돼 있어, 이 설정과 무관하게 항상 중단됩니다.
                      </p>
                    )}
                    {killBusy && (
                      <p className="text-[12px] font-bold text-[#718096] mt-2 flex items-center gap-1.5">
                        <Loader2 size={12} className="animate-spin" /> 변경 중…
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="bg-white border border-[#E2E8F0] rounded-2xl p-7 shadow-sm">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-[#FAF5FF] flex items-center justify-center">
                    <Database size={20} className="text-[#805AD5]" />
                  </div>
                  <div>
                    <h2 className="text-[18px] font-extrabold text-[#1A202C] flex items-center gap-2">
                      고급 설정
                      <span className="text-[10px] font-bold text-[#975A16] bg-[#FEFCBF] px-1.5 py-0.5 rounded">준비중</span>
                    </h2>
                    <p className="text-[13px] text-[#718096]">LLM 모델 교체 및 데이터 보존 정책을 관리합니다.</p>
                  </div>
                </div>

                <DemoBanner variant="soon" note="LLM 모델 선택과 PII 마스킹 토글은 아직 백엔드에 연동되지 않은 미리보기입니다. 현재 응대는 기본 모델로 동작하며, 이 화면에서 바꿔도 실제 설정은 변경되지 않습니다." />

                <div className="space-y-6 opacity-60 pointer-events-none select-none" aria-disabled="true">
                  <div>
                    <h3 className="text-[14px] font-bold text-[#1A202C] mb-3">기본 LLM 모델 엔진</h3>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex items-start gap-3 p-4 border border-[#FFCB3C] bg-[#FFFBEB] rounded-xl cursor-not-allowed">
                        <input type="radio" name="llm" defaultChecked disabled className="mt-1 w-4 h-4 text-[#FFCB3C] focus:ring-[#FFCB3C]" />
                        <div>
                          <div className="text-[14px] font-bold text-[#1A202C]">Ongbot-Core (권장)</div>
                          <div className="text-[12px] text-[#718096] mt-1">시니어 채용에 특화 파인튜닝된 자체 모델. 속도가 가장 빠릅니다.</div>
                        </div>
                      </label>
                      <label className="flex items-start gap-3 p-4 border border-[#E2E8F0] bg-white rounded-xl cursor-not-allowed">
                        <input type="radio" name="llm" disabled className="mt-1 w-4 h-4 text-[#FFCB3C] focus:ring-[#FFCB3C]" />
                        <div>
                          <div className="text-[14px] font-bold text-[#1A202C]">GPT-4o (OpenAI)</div>
                          <div className="text-[12px] text-[#718096] mt-1">범용성이 뛰어나고 복잡한 문맥 추론에 강합니다. (비용 증가)</div>
                        </div>
                      </label>
                    </div>
                  </div>

                  <div className="pt-2">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-[14px] font-bold text-[#1A202C]">개인정보 마스킹 (PII 필터링)</h3>
                      <div className="w-11 h-6 bg-[#CBD5E0] rounded-full relative flex items-center px-1">
                        <div className="w-4 h-4 bg-white rounded-full translate-x-5 transition-transform" />
                      </div>
                    </div>
                    <p className="text-[12.5px] text-[#718096]">
                      지원자가 대화 중 주민등록번호, 계좌번호 등 민감한 개인정보를 입력할 경우 즉시 별표(*) 처리하여 DB에 저장되지 않도록 방지합니다.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'simulator' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold text-[#1A202C] flex items-center gap-2">
                  <FlaskConical size={20} className="text-[#805AD5]" /> 응대 시뮬레이터
                </h2>
                <span className="text-[12px] font-bold bg-[#FAF5FF] text-[#805AD5] px-3 py-1 rounded-full">실제 Claude 호출</span>
              </div>
              <p className="text-sm text-[#718096] mb-6">지원자가 보낼 법한 문자를 입력하면, 현재 페르소나·지식 베이스로 옹봇이 어떤 답변 초안을 생성하는지 미리 확인할 수 있어요. <b>실제 발송은 되지 않습니다.</b></p>

              <div className="grid grid-cols-2 gap-6">
                {/* Input */}
                <div className="flex flex-col gap-4">
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">지원자가 보낸 문자 <span className="text-[#E53E3E]">*</span></label>
                    <textarea
                      value={simInbound}
                      onChange={(e) => setSimInbound(e.target.value)}
                      rows={4}
                      placeholder="예: 안녕하세요, 시급이 어떻게 되나요? 오토바이 없어도 지원 가능한가요?"
                      className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">참고 공고 내용 <span className="text-[#A0AEC0] font-medium">(선택)</span></label>
                    <textarea
                      value={simPosting}
                      onChange={(e) => setSimPosting(e.target.value)}
                      rows={5}
                      placeholder="공고문을 붙여넣으면 시급·근무지 등 사실을 그 내용 기준으로 답변합니다. 비워두면 일반 컨텍스트로 응대해요."
                      className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none"
                    />
                  </div>
                  <button
                    onClick={handleRunSimulation}
                    disabled={simRunning || !simInbound.trim()}
                    className="flex items-center justify-center gap-2 bg-[#1A202C] hover:bg-[#2D3748] text-white py-3 rounded-xl text-[14px] font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {simRunning ? <Loader2 size={18} className="animate-spin" /> : <PlayCircle size={18} className="text-[#FFCB3C]" />}
                    {simRunning ? "옹봇이 답변을 생각 중..." : "응대 시뮬레이션 실행"}
                  </button>
                </div>

                {/* Output */}
                <div className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-2xl p-5 min-h-[300px] flex flex-col">
                  <div className="text-[13px] font-bold text-[#718096] mb-3 flex items-center gap-1.5"><Bot size={15} /> 옹봇 응답 결과</div>
                  {!simResult && !simRunning && (
                    <div className="flex-1 flex flex-col items-center justify-center text-center text-[#A0AEC0]">
                      <FlaskConical size={32} className="mb-3 opacity-40" />
                      <div className="text-[13px] font-medium">왼쪽에 문자를 입력하고 실행하면<br />여기에 AI 답변 초안이 표시됩니다.</div>
                    </div>
                  )}
                  {simRunning && (
                    <div className="flex-1 flex flex-col items-center justify-center text-center text-[#805AD5]">
                      <Loader2 size={28} className="animate-spin mb-3" />
                      <div className="text-[13px] font-bold">실제 Claude 모델을 호출하는 중...</div>
                    </div>
                  )}
                  {simResult && simResult.status === 'reply' && (
                    <div className="flex flex-col gap-4">
                      <div className="flex items-start gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-[#FFCB3C] flex items-center justify-center shrink-0 border border-[#E0B500]"><Bot size={16} className="text-[#1A202C]" /></div>
                        <div className="bg-white border border-[#E2E8F0] rounded-2xl rounded-tl-sm p-3.5 text-[14px] leading-relaxed text-[#2D3748] whitespace-pre-wrap shadow-sm">
                          {simResult.draft_text}
                        </div>
                      </div>
                      <div className="bg-white border border-[#E2E8F0] rounded-xl p-3.5">
                        <div className="text-[12px] font-bold text-[#718096] mb-1.5 flex items-center gap-1.5"><Sparkles size={13} className="text-[#805AD5]" /> 판단 근거 (reasoning)</div>
                        <div className="text-[12.5px] text-[#4A5568] leading-relaxed whitespace-pre-wrap">{simResult.reasoning}</div>
                      </div>
                    </div>
                  )}
                  {simResult && simResult.status === 'need_info' && (
                    <div className="flex flex-col gap-4">
                      <div className="bg-[#FFFAF0] border border-[#FBD38D] rounded-xl p-4">
                        <div className="text-[13px] font-bold text-[#C05621] mb-1.5 flex items-center gap-1.5"><AlertTriangle size={15} /> 매니저 인계 필요 (need_info)</div>
                        <div className="text-[12.5px] text-[#7B341E] leading-relaxed">AI가 자체 답변하지 않고 매니저에게 넘기는 상황이에요. 실제 운영에선 자동 응답이 중단되고 슬랙 알림이 발송됩니다.</div>
                      </div>
                      {simResult.missing_info && (
                        <div className="bg-white border border-[#E2E8F0] rounded-xl p-3.5">
                          <div className="text-[12px] font-bold text-[#718096] mb-1.5">부족한 정보</div>
                          <div className="text-[12.5px] text-[#4A5568] leading-relaxed whitespace-pre-wrap">{simResult.missing_info}</div>
                        </div>
                      )}
                      <div className="bg-white border border-[#E2E8F0] rounded-xl p-3.5">
                        <div className="text-[12px] font-bold text-[#718096] mb-1.5 flex items-center gap-1.5"><Sparkles size={13} className="text-[#805AD5]" /> 판단 근거 (reasoning)</div>
                        <div className="text-[12.5px] text-[#4A5568] leading-relaxed whitespace-pre-wrap">{simResult.reasoning}</div>
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
              <div className="p-5 border border-[#E2E8F0] rounded-2xl bg-white mb-6">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 text-[14px] font-bold text-[#1A202C]">
                    <Coins size={16} className="text-[#D69E2E]" /> 이번 달 AI 사용량
                  </div>
                  <a
                    href="https://console.anthropic.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] font-bold text-[#3182CE] hover:underline flex items-center gap-1"
                  >
                    크레딧 잔액은 Anthropic 콘솔에서 <ExternalLink size={11} />
                  </a>
                </div>
                {usageLoading ? (
                  <div className="flex items-center gap-2 text-[13px] text-[#A0AEC0] py-2"><Loader2 size={15} className="animate-spin" /> 불러오는 중…</div>
                ) : (
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <div className="text-[11.5px] font-bold text-[#A0AEC0] mb-0.5">Claude 호출</div>
                      <div className="text-[20px] font-extrabold text-[#1A202C]">{monthStats.calls.toLocaleString()}<span className="text-[12px] font-bold text-[#A0AEC0]">회</span></div>
                    </div>
                    <div>
                      <div className="text-[11.5px] font-bold text-[#A0AEC0] mb-0.5">토큰 (입력 / 출력)</div>
                      <div className="text-[20px] font-extrabold text-[#1A202C]">{fmtTokens(monthStats.tokensIn)}<span className="text-[13px] font-bold text-[#A0AEC0]"> / {fmtTokens(monthStats.tokensOut)}</span></div>
                    </div>
                    <div>
                      <div className="text-[11.5px] font-bold text-[#A0AEC0] mb-0.5">추정 비용</div>
                      <div className="text-[20px] font-extrabold text-[#1A202C]">${monthStats.cost.toFixed(2)}</div>
                    </div>
                  </div>
                )}
                <p className="text-[11px] text-[#A0AEC0] mt-3 leading-relaxed">
                  * 추정 비용 = 토큰 × 모델 단가 (Sonnet 4.6 입력 $3 · 출력 $15 / Haiku 4.5 입력 $1 · 출력 $5 per 1M tokens, 캐시 읽기는 입력 단가의 10%로 계산). 실제 청구액과 다를 수 있어요.
                </p>
              </div>

              {/* R4-2 개선 제안 — 반영은 매니저 승인으로만 (자동 반영 금지) */}
              <h2 className="text-lg font-bold text-[#1A202C] mb-2 flex items-center gap-2">
                <Lightbulb size={20} className="text-[#D69E2E]" /> 🔁 개선 제안
              </h2>
              <p className="text-sm text-[#718096] mb-5">
                최근 7일간 <b>매니저가 고쳐 보낸 AI 초안 · 매니저 인계 사유 · 정보 부족 사례</b>에서 AI가 배울 거리를 찾아 제안합니다.
                제안은 <b>매니저가 승인해야만</b> 지식베이스에 반영돼요 — 자동으로 지식이 바뀌지 않습니다.
              </p>

              <button
                onClick={handleRunImprove}
                disabled={improveLoading}
                className="flex items-center gap-2 bg-[#1A202C] hover:bg-[#2D3748] text-white px-5 py-2.5 rounded-xl text-[14px] font-bold transition-colors shadow-sm disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
              >
                {improveLoading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} className="text-[#FFCB3C]" />}
                {improveLoading ? "지난 7일 기록에서 배울 거리를 찾는 중..." : "지난 7일에서 배울 거리 찾기"}
              </button>
              <p className="text-[11.5px] text-[#A0AEC0] mt-1.5">실행하면 Claude 호출 1회 비용이 발생해요.</p>

              {improveRan && !improveLoading && proposals.length === 0 && (
                <div className="mt-5 text-center text-[13px] text-[#A0AEC0] border border-dashed border-[#E2E8F0] rounded-xl p-8">
                  아직 배울 재료가 없어요 — 코파일럿 초안 수정·인계 사례가 쌓이면 제안을 만들어요.
                </div>
              )}

              {proposals.length > 0 && (
                <div className="mt-5 space-y-3">
                  {proposals.map((p, idx) => (
                    <div key={`${p.kind}-${p.title}-${idx}`} className="border border-[#E2E8F0] rounded-xl p-4 bg-white hover:border-[#CBD5E0] transition-colors">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10.5px] font-bold border ${IMPROVE_KIND_BADGE[p.kind]}`}>{IMPROVE_KIND_LABEL[p.kind]}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10.5px] font-bold border ${p.confidence === 'high' ? 'bg-[#F0FFF4] text-[#276749] border-[#C6F6D5]' : 'bg-[#F7FAFC] text-[#718096] border-[#E2E8F0]'}`}>
                          {p.confidence === 'high' ? '확신 높음' : '확신 중간'}
                        </span>
                      </div>
                      <div className="text-[14px] font-bold text-[#1A202C]">{p.title}</div>
                      <div className="text-[13px] text-[#4A5568] mt-1 leading-relaxed whitespace-pre-wrap">{p.body}</div>
                      {p.evidence && <div className="text-[12px] text-[#A0AEC0] mt-2">근거: {p.evidence}</div>}
                      <div className="flex items-center gap-2 mt-3 flex-wrap">
                        {p.kind === "system_message_tweak" ? (
                          <span className="text-[12px] font-bold text-[#C05621] bg-[#FFFAF0] border border-[#FBD38D] rounded-lg px-3 py-1.5">
                            자동 반영되지 않아요 — ‘사내 지식 베이스 &gt; 자동 발송 문구’에서 직접 반영하세요
                          </span>
                        ) : (
                          <button
                            onClick={() => handleApproveProposal(idx)}
                            disabled={approvingIdx !== null}
                            className="flex items-center gap-1.5 bg-[#1A202C] hover:bg-[#2D3748] text-white px-3.5 py-1.5 rounded-lg text-[12.5px] font-bold transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                          >
                            {approvingIdx === idx ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} 승인 — 지식에 추가
                          </button>
                        )}
                        <button
                          onClick={() => handleDismissProposal(idx)}
                          className="px-3.5 py-1.5 rounded-lg text-[12.5px] font-bold text-[#718096] border border-[#E2E8F0] hover:bg-[#F7FAFC] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                        >
                          무시
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}