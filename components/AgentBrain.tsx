import { useState, useRef, useEffect, useCallback } from "react";
import { Brain, Save, RefreshCw, MessageSquare, Database, Sparkles, Settings2, SlidersHorizontal, UploadCloud, FileText, CheckCircle2, Loader2, FlaskConical, Bot, PlayCircle, AlertTriangle, Plus, Pencil, Trash2, X, Sprout } from "lucide-react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";

interface PromptExample {
  id: number;
  category: string;
  title: string;
  body: string;
}

type KbCategory = "facts" | "system_message" | "conversation";

const KB_CATEGORIES: { key: KbCategory; label: string; hint: string }[] = [
  { key: "facts", label: "운영 정보", hint: "지점·시급·정책 등 AI가 사실로 인용하는 정보. 여기 없는 사실은 추측하지 않고 매니저에게 넘깁니다." },
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

const CATEGORY_LABEL: Record<string, string> = {
  conversation: "대화 예시",
  facts: "운영 정보",
  system_message: "자동 발송 문구",
};

export function AgentBrain() {
  const [activeTab, setActiveTab] = useState("knowledge");
  const [isSaving, setIsSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'vectorizing' | 'complete'>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [examples, setExamples] = useState<PromptExample[]>([]);
  const [kbLoading, setKbLoading] = useState(true);
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

  const loadExamples = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/prompt-examples");
      const json = await res.json();
      setExamples((json.data ?? []) as PromptExample[]);
    } catch {
      /* 지식 베이스는 실패해도 화면 유지 */
    } finally {
      setKbLoading(false);
    }
  }, []);

  useEffect(() => {
    loadExamples();
  }, [loadExamples]);

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
    if (!confirm(`'${ex.title}' 항목을 삭제할까요? 이 작업은 되돌릴 수 없어요.`)) return;
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

  const kbItems = examples.filter((e) => e.category === kbCategory);

  const handleSave = () => {
    setIsSaving(true);
    setTimeout(() => {
      setIsSaving(false);
      toast.info("페르소나·규칙 편집 저장은 준비 중이에요 (지식 베이스는 prompt_examples 연동됨)");
    }, 600);
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
      setUploadState('complete');
      toast.success("문서가 성공적으로 에이전트 두뇌에 학습되었습니다!");
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
            <p className="text-[14px] text-[#718096]">지식 베이스는 실데이터(prompt_examples)와 연동됩니다. 페르소나·규칙 편집은 데모입니다.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 bg-white border border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC] px-4 py-2.5 rounded-xl font-bold transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
            <RefreshCw size={16} /> 변경사항 초기화
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
        </div>

        {/* Content Area */}
        <div className="flex-1 bg-white border border-[#E2E8F0] rounded-2xl shadow-sm p-8">
          {activeTab === 'persona' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-[#1A202C] mb-6 flex items-center gap-2">
                <Sparkles size={20} className="text-[#FFCB3C]" /> AI 에이전트 성격 정의 (System Prompt)
              </h2>

              <div className="space-y-6">
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">기본 역할 (Role)</label>
                  <input
                    type="text"
                    defaultValue="당신은 시니어 배달원 채용을 돕는 친절하고 인내심 많은 전문 채용 매니저 '옹봇'입니다."
                    className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
                  />
                </div>

                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2 flex items-center justify-between">
                    핵심 지시사항 (Instructions)
                    <button className="text-[#3182CE] text-xs font-bold hover:underline">자동 교정</button>
                  </label>
                  <textarea
                    rows={6}
                    defaultValue={`1. 시니어(50~70대) 지원자가 이해하기 쉽도록 전문 용어(예: 파이프라인, 스크리닝 등) 사용을 피하고 쉬운 우리말을 사용하세요.
2. 항상 존댓말을 사용하고, 지원자의 답변이 늦어지더라도 재촉하지 마세요.
3. 지점 위치나 근무 시간에 대한 질문을 받으면 즉시 사내 지식 베이스를 검색하여 정확하게 안내하세요.
4. 면접 일정 조율 시에는 반드시 오전/오후 중 선호하는 시간대를 먼저 물어보세요.`}
                    className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm font-mono leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
                  />
                  <p className="text-[12px] text-[#A0AEC0] mt-2">마크다운(Markdown) 문법을 지원합니다. 구체적일수록 AI가 더 정확하게 답변합니다.</p>
                </div>

                <div className="grid grid-cols-2 gap-6 pt-4 border-t border-[#E2E8F0]">
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-3">어조 (Tone & Manner)</label>
                    <div className="flex flex-col gap-3">
                      {['친절하고 따뜻하게', '전문적이고 단호하게', '밝고 활기차게'].map((tone, i) => (
                        <label key={i} className="flex items-center gap-3 cursor-pointer">
                          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${i === 0 ? 'border-[#FFCB3C]' : 'border-[#CBD5E0]'}`}>
                            {i === 0 && <div className="w-2.5 h-2.5 rounded-full bg-[#FFCB3C]"></div>}
                          </div>
                          <span className={`text-sm font-medium ${i === 0 ? 'text-[#1A202C] font-bold' : 'text-[#718096]'}`}>{tone}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-3">이모지 사용 빈도</label>
                    <div className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl p-4">
                      <input type="range" min="0" max="100" defaultValue="40" className="w-full accent-[#FFCB3C]" />
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
                      <div className="w-16 h-16 bg-[#F0FFF4] rounded-full flex items-center justify-center mb-4">
                        <CheckCircle2 size={32} className="text-[#38A169]" />
                      </div>
                      <h3 className="text-[18px] font-extrabold text-[#1A202C] mb-1">학습 완료!</h3>
                      <p className="text-[13px] text-[#718096]">이제 옹봇이 이 문서의 내용을 바탕으로 지원자에게 답변할 수 있습니다.</p>
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
                            placeholder={kbForm.category === "facts" ? "예: 강북미아" : kbForm.category === "system_message" ? "예: danggeun_start" : "예: 시급 문의 응대"}
                            className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
                          />
                        </div>
                        <div>
                          <label className="block text-[12px] font-bold text-[#4A5568] mb-1.5">내용</label>
                          <textarea
                            value={kbForm.body}
                            onChange={(e) => setKbForm({ ...kbForm, body: e.target.value })}
                            rows={kbForm.category === "facts" ? 3 : 5}
                            placeholder={kbForm.category === "facts" ? "시급 15,000~20,000원, 토일 08:00-16:00, 픽업 서울 강북구..." : "발송될 문구를 입력하세요. {{이름}}, {{지점}}, {{지원폼주소}} 등 치환자 사용 가능."}
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
              <p className="text-sm text-[#718096] mb-6">AI가 처리할 수 없는 특정 상황이나 금지어, 에스컬레이션(상담원 연결) 조건을 정의합니다.</p>

              <div className="space-y-4">
                <div className="p-4 border border-[#E2E8F0] rounded-xl bg-white shadow-sm flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="bg-[#EBF8FF] text-[#3182CE] px-2 py-1 rounded text-[11px] font-bold">조건 1</span>
                      <span className="text-[14px] font-bold text-[#1A202C]">지원자가 "퇴사", "산재", "사고" 단어 언급 시</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" defaultChecked className="sr-only peer" />
                      <div className="w-11 h-6 bg-[#CBD5E0] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#38A169]"></div>
                    </label>
                  </div>
                  <div className="flex items-center gap-3 pl-2 text-[13px]">
                    <span className="text-[#A0AEC0]">↳ 액션:</span>
                    <span className="text-[#4A5568] bg-[#F7FAFC] px-3 py-1.5 rounded-lg border border-[#E2E8F0]">즉시 답변을 중단하고 <b className="text-[#E53E3E]">매니저 호출 (Human Takeover)</b> 실행</span>
                  </div>
                </div>

                <div className="p-4 border border-[#E2E8F0] rounded-xl bg-white shadow-sm flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="bg-[#EBF8FF] text-[#3182CE] px-2 py-1 rounded text-[11px] font-bold">조건 2</span>
                      <span className="text-[14px] font-bold text-[#1A202C]">AI가 지식 베이스(RAG)에서 답변을 찾지 못했을 때</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" defaultChecked className="sr-only peer" />
                      <div className="w-11 h-6 bg-[#CBD5E0] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#38A169]"></div>
                    </label>
                  </div>
                  <div className="flex items-center gap-3 pl-2 text-[13px]">
                    <span className="text-[#A0AEC0]">↳ 액션:</span>
                    <span className="text-[#4A5568] bg-[#F7FAFC] px-3 py-1.5 rounded-lg border border-[#E2E8F0]">"죄송합니다. 정확한 확인을 위해 담당자에게 연결해 드리겠습니다." 메시지 전송 후 대기</span>
                  </div>
                </div>

                <button className="w-full py-3 border-2 border-dashed border-[#E2E8F0] rounded-xl text-[14px] font-bold text-[#718096] hover:bg-[#F7FAFC] hover:border-[#CBD5E0] transition-colors flex items-center justify-center gap-2">
                  + 새 예외 규칙 추가
                </button>
              </div>
            </div>
          )}

          {activeTab === 'advanced' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="bg-white border border-[#E2E8F0] rounded-2xl p-7 shadow-sm">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-[#FAF5FF] flex items-center justify-center">
                    <Database size={20} className="text-[#805AD5]" />
                  </div>
                  <div>
                    <h2 className="text-[18px] font-extrabold text-[#1A202C]">고급 설정</h2>
                    <p className="text-[13px] text-[#718096]">LLM 모델 교체 및 데이터 보존 정책을 관리합니다.</p>
                  </div>
                </div>

                <div className="space-y-6">
                  <div>
                    <h3 className="text-[14px] font-bold text-[#1A202C] mb-3">기본 LLM 모델 엔진</h3>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex items-start gap-3 p-4 border border-[#FFCB3C] bg-[#FFFBEB] rounded-xl cursor-pointer">
                        <input type="radio" name="llm" defaultChecked className="mt-1 w-4 h-4 text-[#FFCB3C] focus:ring-[#FFCB3C]" />
                        <div>
                          <div className="text-[14px] font-bold text-[#1A202C]">Ongbot-Core (권장)</div>
                          <div className="text-[12px] text-[#718096] mt-1">시니어 채용에 특화 파인튜닝된 자체 모델. 속도가 가장 빠릅니다.</div>
                        </div>
                      </label>
                      <label className="flex items-start gap-3 p-4 border border-[#E2E8F0] hover:border-[#CBD5E0] bg-white rounded-xl cursor-pointer transition-colors">
                        <input type="radio" name="llm" className="mt-1 w-4 h-4 text-[#FFCB3C] focus:ring-[#FFCB3C]" />
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
                      <div className="w-11 h-6 bg-[#38A169] rounded-full relative cursor-pointer flex items-center px-1">
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
        </div>
      </div>
    </div>
  );
}