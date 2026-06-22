import { useState, useEffect, useCallback } from "react";
import { Search, Filter, Briefcase, MapPin, Users, Activity, MoreHorizontal, CheckCircle2, Copy, Edit2, Play, Pause, AlertCircle, Sparkles, Loader2, Wand2, X } from "lucide-react";
import { toast } from "sonner";

interface JobRow {
  id: string;
  title: string;
  branch: string;
  role: string;
  status: "active" | "closed";
  candidates: number;
  newCandidates: number;
  automation: boolean;
  created: string;
  deadline: string;
}

interface ApiJob {
  id: number;
  title: string;
  branch: string | null;
  status: string;
  vehicle_required: boolean;
  created_at: string;
  closed_at: string | null;
  counts: Record<string, number>;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

function toJobRow(j: ApiJob): JobRow {
  const total = Object.values(j.counts ?? {}).reduce((a, b) => a + b, 0);
  return {
    id: String(j.id),
    title: j.title,
    branch: j.branch ?? "-",
    role: j.vehicle_required ? "배송원" : "도보 배달",
    status: j.status === "active" ? "active" : "closed",
    candidates: total,
    newCandidates: j.counts?.["sent"] ?? 0,
    automation: j.status === "active",
    created: fmtDate(j.created_at),
    deadline: j.closed_at ? fmtDate(j.closed_at) : "상시 모집",
  };
}

export function Jobs() {
  const [activeTab, setActiveTab] = useState('active');
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedJD, setGeneratedJD] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [registering, setRegistering] = useState(false);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/jobs?status=all");
      const json = await res.json();
      if (json.jobs)
        setJobs(
          (json.jobs as ApiJob[])
            .filter((j) => !j.title.startsWith("__"))
            .map(toJobRow)
        );
      else toast.error("공고 목록을 불러오지 못했어요");
    } catch {
      toast.error("공고 목록을 불러오지 못했어요");
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  const handleGenerateJD = async () => {
    if (!aiPrompt.trim()) return toast.error("채용 조건을 입력해주세요.");
    setIsGenerating(true);
    setGeneratedJD("");
    setMissing([]);
    try {
      const res = await fetch("/api/admin/recommend/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rough: aiPrompt.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "공고 생성에 실패했어요");
        return;
      }
      setGeneratedJD(json.posting ?? "");
      const miss = Array.isArray(json.missing) ? (json.missing as string[]) : [];
      setMissing(miss);
      if (miss.length > 0) toast.info("메모에 빠진 항목이 있어요. [?] 부분을 채워주세요.");
      else toast.success("AI가 공고 초안을 완성했어요.");
    } catch {
      toast.error("공고 생성에 실패했어요");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRegisterJob = async () => {
    const posting = generatedJD.trim();
    if (!posting || registering) return;
    const lines = posting.split("\n").map((l) => l.trim()).filter(Boolean);
    const title = (lines[0] ?? "새 공고").slice(0, 80);
    setRegistering(true);
    try {
      const res = await fetch("/api/admin/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body: posting }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "공고 등록에 실패했어요");
        return;
      }
      toast.success("새 공고가 등록되었어요. AI 자동 스크리닝이 시작됩니다.");
      setAiModalOpen(false);
      setAiPrompt("");
      setGeneratedJD("");
      setMissing([]);
      await loadJobs();
    } catch {
      toast.error("공고 등록에 실패했어요");
    } finally {
      setRegistering(false);
    }
  };

  const filteredJobs = jobs.filter(job => {
    if (activeTab === 'all') return true;
    return job.status === activeTab;
  });

  const toggleAutomation = (id: string, current: boolean) => {
    setJobs(jobs.map(job =>
      job.id === id ? { ...job, automation: !current } : job
    ));
    if (!current) {
      toast.success("AI 에이전트 자동 스크리닝이 활성화되었습니다.");
    } else {
      toast.info("AI 에이전트 자동 스크리닝이 일시 중지되었습니다.");
    }
  };

  const copyJobLink = (title: string) => {
    toast.success(`'${title}' 공고 링크가 복사되었습니다.`);
  };

  return (
    <div className="p-8 pb-12">
      {/* Stats Summary */}
      <div className="grid grid-cols-4 gap-5 mb-8">
        {[
          { label: "전체 공고", value: jobs.length, unit: "건" },
          { label: "진행 중인 공고", value: jobs.filter(j => j.status === 'active').length, unit: "건", highlight: true },
          { label: "AI 자동화 켜짐", value: jobs.filter(j => j.automation).length, unit: "건", color: "text-[#3182CE]" },
          { label: "신규 지원자(미시작)", value: jobs.reduce((a, j) => a + j.newCandidates, 0), unit: "명", color: "text-[#38A169]" }
        ].map((stat, i) => (
          <div key={i} className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm flex flex-col justify-between">
            <div className="text-[13px] font-bold text-[#718096] mb-2">{stat.label}</div>
            <div className="flex items-baseline gap-1">
              <span className={`text-[28px] font-extrabold tracking-tight leading-none ${stat.highlight ? 'text-[#D69E2E]' : stat.color || 'text-[#1A202C]'}`}>
                {stat.value}
              </span>
              <span className="text-sm font-semibold text-[#A0AEC0]">{stat.unit}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-sm overflow-hidden flex flex-col min-h-[600px]">
        {/* Toolbar */}
        <div className="p-5 border-b border-[#E2E8F0] flex items-center justify-between gap-4">
          <div className="flex gap-1.5">
            <button
              onClick={() => setActiveTab('all')}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeTab === 'all' ? 'bg-[#1A202C] text-white' : 'bg-white border border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC]'}`}
            >
              전체
            </button>
            <button
              onClick={() => setActiveTab('active')}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeTab === 'active' ? 'bg-[#1A202C] text-white' : 'bg-white border border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC]'}`}
            >
              진행 중 <span className="opacity-60 ml-1 font-medium">{jobs.filter(j => j.status === 'active').length}</span>
            </button>
            <button
              onClick={() => setActiveTab('closed')}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeTab === 'closed' ? 'bg-[#1A202C] text-white' : 'bg-white border border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC]'}`}
            >
              마감됨 <span className="opacity-60 ml-1 font-medium">{jobs.filter(j => j.status === 'closed').length}</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            <button className="flex items-center gap-2 bg-white border border-[#E2E8F0] px-4 py-2 rounded-xl text-sm font-semibold text-[#4A5568] hover:bg-[#F7FAFC] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
              <Filter size={16} /> 상세 필터
            </button>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
              <input
                type="text"
                placeholder="공고명, 지점 검색"
                className="pl-9 pr-4 py-2 border border-[#E2E8F0] rounded-xl text-sm w-[260px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
              />
            </div>
            <button
              onClick={() => setAiModalOpen(true)}
              className="flex items-center gap-1.5 bg-[#FFCB3C] hover:bg-[#E0B500] text-[#1A202C] px-4 py-2 rounded-xl text-sm font-bold transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
            >
              <Wand2 size={16} /> 새 공고
            </button>
          </div>
        </div>

        {/* Table Header */}
        <div className="grid grid-cols-[2fr_1fr_1fr_1.5fr_1fr_0.5fr] items-center px-6 py-3.5 border-b border-[#E2E8F0] bg-[#F7FAFC] text-[13px] font-bold text-[#718096]">
          <div>공고 정보</div>
          <div>지점 / 직무</div>
          <div>모집 기간</div>
          <div>지원자 관리 (AI 현황)</div>
          <div>상태</div>
          <div className="text-right">관리</div>
        </div>

        {/* Table Body */}
        <div className="flex flex-col flex-1">
          {filteredJobs.length > 0 ? (
            filteredJobs.map(job => (
              <div key={job.id} className="grid grid-cols-[2fr_1fr_1fr_1.5fr_1fr_0.5fr] items-center px-6 py-5 border-b border-[#F1F4F8] hover:bg-[#F7FAFC] transition-colors">
                <div className="flex flex-col gap-1.5 min-w-0 pr-4">
                  <div className="text-[15px] font-bold text-[#1A202C] truncate cursor-pointer hover:underline">{job.title}</div>
                  <div className="text-[12px] text-[#A0AEC0] font-mono">{job.id}</div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5 text-[13.5px] font-semibold text-[#4A5568]">
                    <MapPin size={14} className="text-[#A0AEC0]" /> {job.branch}
                  </div>
                  <div className="flex items-center gap-1.5 text-[13px] text-[#718096]">
                    <Briefcase size={14} className="text-[#A0AEC0]" /> {job.role}
                  </div>
                </div>

                <div className="flex flex-col gap-1 text-[13px] text-[#4A5568]">
                  <div>{job.created} ~</div>
                  <div className="font-bold text-[#2D3748]">{job.deadline}</div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="flex flex-col">
                    <div className="text-[13px] text-[#718096]">총 지원자</div>
                    <div className="text-[15px] font-extrabold text-[#1A202C]">{job.candidates}명 {job.newCandidates > 0 && <span className="text-[12px] font-bold text-[#D69E2E] ml-1">+{job.newCandidates}</span>}</div>
                  </div>
                  <div className="w-px h-8 bg-[#E2E8F0]"></div>
                  <div className="flex flex-col gap-1">
                    <div className="text-[12px] font-bold text-[#718096]">AI 자동 스크리닝</div>
                    <button
                      onClick={() => toggleAutomation(job.id, job.automation)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] ${job.automation ? 'bg-[#3182CE]' : 'bg-[#CBD5E0]'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${job.automation ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                </div>

                <div>
                  {job.status === 'active' ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold bg-[#F0FFF4] text-[#38A169] border border-[#C6F6D5]">
                      <Play size={12} className="fill-current" /> 진행 중
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold bg-[#F1F4F8] text-[#718096] border border-[#E2E8F0]">
                      <Pause size={12} className="fill-current" /> 마감됨
                    </span>
                  )}
                </div>

                <div className="flex justify-end gap-1">
                  <button onClick={() => copyJobLink(job.title)} className="p-2 text-[#718096] hover:bg-[#E2E8F0] rounded-lg transition-colors" title="공고 링크 복사">
                    <Copy size={16} />
                  </button>
                  <button className="p-2 text-[#718096] hover:bg-[#E2E8F0] rounded-lg transition-colors" title="공고 수정">
                    <Edit2 size={16} />
                  </button>
                  <button className="p-2 text-[#718096] hover:bg-[#E2E8F0] rounded-lg transition-colors">
                    <MoreHorizontal size={16} />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-12">
              <div className="w-16 h-16 bg-[#F1F4F8] rounded-full flex items-center justify-center mb-4">
                <Briefcase size={24} className="text-[#A0AEC0]" />
              </div>
              <h3 className="text-[16px] font-bold text-[#1A202C] mb-2">공고가 없습니다</h3>
              <p className="text-[14px] text-[#718096] mb-6">현재 선택된 상태의 공고가 존재하지 않습니다.</p>
              <button
                onClick={() => setAiModalOpen(true)}
                className="flex items-center gap-2 bg-[#FFCB3C] hover:bg-[#E0B500] text-[#1A202C] px-5 py-2.5 rounded-xl font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
              >
                새 공고 등록하기
              </button>
            </div>
          )}
        </div>
      </div>

      {/* AI JD Generator Modal */}
      {aiModalOpen && (
        <div className="fixed inset-0 bg-[#00000080] z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white w-full max-w-[800px] rounded-[20px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-7 py-5 border-b border-[#E2E8F0]">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#FFFBEC] flex items-center justify-center text-[#D69E2E]">
                  <Wand2 size={18} />
                </div>
                <div>
                  <h2 className="text-[18px] font-extrabold text-[#1A202C] tracking-tight">AI 맞춤형 공고 작성</h2>
                  <p className="text-[13px] text-[#718096] mt-0.5">간단한 조건만 입력하면 시니어에 최적화된 공고 초안을 생성합니다.</p>
                </div>
              </div>
              <button onClick={() => setAiModalOpen(false)} className="text-[#A0AEC0] hover:text-[#4A5568] transition-colors">
                <X size={24} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-7 flex flex-col gap-6 bg-[#F7FAFC]">
              {/* Prompt Input */}
              <div className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm">
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">어떤 포지션을 찾고 계신가요?</label>
                <textarea
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="예: 스타벅스 성수점 매장 청소 및 테이블 관리, 주 3일 오전반, 시급 1.1만원, 60대 우대"
                  className="w-full bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3.5 text-[14px] text-[#1A202C] placeholder:text-[#A0AEC0] focus:outline-none focus:border-[#FFCB3C] min-h-[100px] resize-none"
                />
                <div className="flex justify-end mt-3">
                  <button
                    onClick={handleGenerateJD}
                    disabled={isGenerating || !aiPrompt}
                    className="flex items-center gap-1.5 px-5 py-2.5 bg-[#1A202C] text-white hover:bg-[#2D3748] disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-[13.5px] font-bold transition-colors"
                  >
                    {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} className="text-[#FFCB3C]" />}
                    {isGenerating ? 'JD 생성 중...' : 'AI 초안 생성'}
                  </button>
                </div>
              </div>

              {/* Generated Result */}
              {(isGenerating || generatedJD) && (
                <div className="bg-white border border-[#FFCB3C] rounded-2xl p-5 shadow-sm relative overflow-hidden">
                  {isGenerating && (
                    <div className="absolute inset-0 bg-white/60 backdrop-blur-sm z-10 flex flex-col items-center justify-center">
                      <Wand2 size={28} className="text-[#D69E2E] animate-bounce mb-3" />
                      <div className="text-[14px] font-bold text-[#1A202C]">AI 옹봇이 공고를 작성하고 있습니다...</div>
                      <div className="text-[12px] text-[#718096] mt-1">시니어 지원자가 이해하기 쉬운 톤앤매너로 다듬는 중</div>
                    </div>
                  )}
                  <div className="flex items-center justify-between mb-3">
                    <label className="block text-[13px] font-bold text-[#D69E2E] flex items-center gap-1.5">
                      <Sparkles size={14} /> AI가 작성한 공고 초안
                    </label>
                    <span className="text-[11px] text-[#A0AEC0]">자유롭게 수정 가능합니다</span>
                  </div>
                  {missing.length > 0 && (
                    <div className="mb-3 flex items-start gap-2 bg-[#FFF5F5] border border-[#FEB2B2] rounded-xl px-3.5 py-2.5">
                      <AlertCircle size={15} className="text-[#E53E3E] mt-0.5 shrink-0" />
                      <div className="text-[12.5px] text-[#C53030] leading-relaxed">
                        <b>메모에 빠진 항목</b>이 있어 <b>[?]</b>로 표시했어요. 등록 전에 채워주세요:
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {missing.map((m) => (
                            <span key={m} className="text-[11px] font-bold bg-white border border-[#FEB2B2] text-[#C53030] px-2 py-0.5 rounded-md">{m}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  <textarea
                    value={generatedJD}
                    onChange={(e) => setGeneratedJD(e.target.value)}
                    className="w-full bg-[#FFFBEC] border-0 rounded-xl px-4 py-3.5 text-[13.5px] text-[#2D3748] leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#FFCB3C] min-h-[280px] font-medium resize-none"
                  />
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-7 py-5 border-t border-[#E2E8F0] bg-white">
              <button
                onClick={() => setAiModalOpen(false)}
                className="px-5 py-2.5 rounded-xl text-[14px] font-bold text-[#4A5568] hover:bg-[#F1F4F8] transition-colors"
              >
                닫기
              </button>
              <button
                onClick={handleRegisterJob}
                disabled={!generatedJD || registering}
                className="px-6 py-2.5 rounded-xl text-[14px] font-bold text-[#1A202C] bg-[#FFCB3C] hover:bg-[#E0B500] disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm flex items-center gap-2"
              >
                {registering ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                {registering ? "등록 중..." : "이 내용으로 공고 등록"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}