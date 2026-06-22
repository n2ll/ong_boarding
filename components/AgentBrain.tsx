import { useState, useRef, useEffect } from "react";
import { Brain, Save, RefreshCw, MessageSquare, Database, Sparkles, Settings2, SlidersHorizontal, UploadCloud, FileText, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";

interface PromptExample {
  id: number;
  category: string;
  title: string;
  body: string;
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

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/prompt-examples");
        const json = await res.json();
        setExamples((json.data ?? []) as PromptExample[]);
      } catch {
        /* 지식 베이스는 실패해도 화면 유지 */
      }
    })();
  }, []);

  const handleSave = () => {
    setIsSaving(true);
    setTimeout(() => {
      setIsSaving(false);
      toast.info("페르소나·규칙 편집 저장은 준비 중이에요 (지식 베이스는 prompt_examples 연동됨)");
    }, 600);
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
                className={`border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center text-center mb-8 transition-all relative overflow-hidden ${
                  isDragging 
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

              <div className="space-y-3">
                <h3 className="text-[14px] font-bold text-[#1A202C] mb-3 px-1">등록된 지식 항목 <span className="text-[#A0AEC0] font-medium">({examples.length}개)</span></h3>
                {examples.length === 0 && <div className="text-[13px] text-[#A0AEC0] p-4">등록된 지식 항목이 없어요</div>}
                {examples.map((ex) => (
                  <div key={ex.id} className="flex items-start justify-between p-4 border border-[#E2E8F0] rounded-xl bg-white hover:border-[#CBD5E0] transition-colors">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-[#F7FAFC] flex items-center justify-center text-[#4A5568] shrink-0">
                        <FileText size={16} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[14px] font-bold text-[#1A202C] flex items-center gap-2">
                          {ex.title}
                          <span className="text-[10px] font-bold bg-[#EBF8FF] text-[#3182CE] px-1.5 py-0.5 rounded">{CATEGORY_LABEL[ex.category] ?? ex.category}</span>
                        </div>
                        <div className="text-[12px] text-[#A0AEC0] mt-0.5 line-clamp-2">{ex.body}</div>
                      </div>
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
        </div>
      </div>
    </div>
  );
}