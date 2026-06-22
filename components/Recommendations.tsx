import { useState, useEffect } from "react";
import { Sparkles, Briefcase, User, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface ApiJob {
  id: number;
  title: string;
  body: string;
  branch: string | null;
  pickup_address: string | null;
  vehicle_required: boolean;
  status: string;
  counts: Record<string, number>;
}

interface ScoredCand {
  id: number;
  source: "applicant" | "legacy";
  name: string;
  phone: string;
  location: string | null;
  sigungu: string | null;
  own_vehicle: string | null;
  score: {
    total: number;
    distance: number;
    vehicle: number;
    recency: number;
    distanceKm: number;
  };
}

function buildTags(c: ScoredCand): string[] {
  const tags: string[] = [];
  if (c.score.distanceKm <= 3) tags.push("근거리 거주");
  else tags.push(`${c.score.distanceKm.toFixed(1)}km 거리`);
  if (c.own_vehicle === "있음") tags.push("자차 보유");
  if (c.score.recency >= 10) tags.push("최근 지원");
  if (c.sigungu) tags.push(c.sigungu);
  return tags.slice(0, 4);
}

function buildReason(c: ScoredCand): string {
  const parts: string[] = [];
  parts.push(`공고 위치에서 약 ${c.score.distanceKm.toFixed(1)}km 거리에 거주합니다.`);
  if (c.own_vehicle === "있음")
    parts.push("자차를 보유하고 있어 우천·악천후에도 유연한 대처가 가능합니다.");
  if (c.score.recency >= 8) parts.push("최근 지원 이력이 있어 연락 가능성이 높습니다.");
  return parts.join(" ");
}

export function Recommendations() {
  const [jobs, setJobs] = useState<ApiJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [recs, setRecs] = useState<ScoredCand[]>([]);
  const [poolSize, setPoolSize] = useState(0);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/jobs?status=all");
        const json = await res.json();
        const list = ((json.jobs ?? []) as ApiJob[]).filter(
          (j) => j.status !== "closed" && !j.title.startsWith("__")
        );
        setJobs(list);
        if (list.length > 0) setSelectedJobId(list[0].id);
      } catch {
        toast.error("공고 목록을 불러오지 못했어요");
      }
    })();
  }, []);

  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;

  const handleSelect = (id: number) => {
    setSelectedJobId(id);
    setRecs([]);
    setGenerated(false);
  };

  const handleGenerate = async () => {
    if (!selectedJob) return;
    setLoading(true);
    setRecs([]);
    try {
      const res = await fetch("/api/admin/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          posting: selectedJob.body || selectedJob.title,
          manualAddress: selectedJob.pickup_address || undefined,
          manualVehicleRequired: selectedJob.vehicle_required,
          topN: 10,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "추천 생성에 실패했어요");
        return;
      }
      setRecs((json.candidates ?? []) as ScoredCand[]);
      setPoolSize(json.poolSize ?? 0);
      setGenerated(true);
      if ((json.candidates ?? []).length === 0) toast.info("조건에 맞는 후보가 없어요");
    } catch {
      toast.error("추천 생성에 실패했어요");
    } finally {
      setLoading(false);
    }
  };

  const handleOffer = (name: string) => {
    toast.success(`${name}님 프로필을 면접 제안 대상으로 표시했어요.`);
  };

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 bg-gradient-to-br from-[#FFCB3C] to-[#D69E2E] rounded-xl flex items-center justify-center shadow-sm">
          <Sparkles size={20} className="text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">AI 인재 추천</h1>
          <p className="text-[14px] text-[#718096]">공고를 선택하면 거리·차량·최신성 기준으로 인재풀을 분석해 추천합니다.</p>
        </div>
      </div>

      <div className="grid grid-cols-[300px_1fr] gap-6">
        {/* Left Pane - Active Jobs */}
        <div className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm flex flex-col">
          <h2 className="text-sm font-bold text-[#718096] mb-4">분석할 공고 선택</h2>
          <div className="flex flex-col gap-2">
            {jobs.length === 0 && (
              <div className="text-[13px] text-[#A0AEC0] py-6 text-center">진행 중인 공고가 없어요</div>
            )}
            {jobs.map((job) => {
              const total = Object.values(job.counts || {}).reduce((a, b) => a + b, 0);
              return (
                <button
                  key={job.id}
                  onClick={() => handleSelect(job.id)}
                  className={`text-left p-4 rounded-xl border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] ${selectedJobId === job.id ? 'border-[#1A202C] bg-[#F7FAFC] shadow-sm' : 'border-transparent hover:bg-[#F1F4F8]'}`}
                >
                  <div className="text-[13px] font-bold text-[#1A202C] mb-1 leading-tight">{job.title}</div>
                  <div className="text-[11px] text-[#A0AEC0] flex items-center gap-1">
                    <Briefcase size={12} /> 후보 {total}명 {job.branch ? `· ${job.branch}` : ""}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Pane - Recommendations */}
        <div className="flex flex-col gap-4">
          <div className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm flex items-center justify-between">
            <div>
              <div className="text-[14px] font-bold text-[#1A202C]">{selectedJob?.title ?? "공고를 선택하세요"}</div>
              <div className="text-[12px] text-[#718096] mt-0.5">
                {generated ? `인재풀 ${poolSize.toLocaleString()}명 분석 · 상위 ${recs.length}명` : "AI 추천을 생성하면 거리·차량 기준 상위 후보를 보여줘요"}
              </div>
            </div>
            <button
              onClick={handleGenerate}
              disabled={!selectedJob || loading}
              className="flex items-center gap-2 bg-[#1A202C] hover:bg-[#2D3748] disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              {loading ? "분석 중…" : "AI 추천 생성"}
            </button>
          </div>

          {!generated && !loading && (
            <div className="bg-white border border-dashed border-[#E2E8F0] rounded-2xl p-12 text-center text-[#A0AEC0] text-[14px]">
              공고를 선택하고 [AI 추천 생성]을 눌러주세요.
            </div>
          )}

          {recs.map((rec) => {
            const tags = buildTags(rec);
            return (
              <div key={`${rec.source}-${rec.id}`} className="bg-white border border-[#E2E8F0] rounded-2xl p-6 shadow-sm flex gap-6">
                <div className="shrink-0 flex flex-col items-center gap-2 w-[100px]">
                  <div className="w-16 h-16 rounded-full bg-[#EBF8FF] border-[3px] border-[#3182CE] flex items-center justify-center text-[#3182CE] relative">
                    <User size={28} />
                    <div className="absolute -bottom-2 -right-2 bg-[#3182CE] text-white text-[10px] font-extrabold px-1.5 py-0.5 rounded-full">
                      {rec.score.total}점
                    </div>
                  </div>
                  <div className="font-extrabold text-[#1A202C]">{rec.name}</div>
                </div>

                <div className="flex-1 flex flex-col justify-center">
                  <div className="flex flex-wrap gap-2 mb-3">
                    {tags.map((tag, i) => (
                      <span key={i} className="bg-[#F0FFF4] text-[#38A169] border border-[#C6F6D5] px-2.5 py-1 rounded-lg text-[12px] font-bold flex items-center gap-1">
                        <Check size={12} /> {tag}
                      </span>
                    ))}
                  </div>
                  <div className="bg-[#F7FAFC] rounded-xl p-4 text-[13px] text-[#4A5568] leading-relaxed relative">
                    <Sparkles size={16} className="text-[#FFCB3C] absolute top-4 left-4" />
                    <p className="pl-6">{buildReason(rec)}</p>
                  </div>
                </div>

                <div className="shrink-0 flex flex-col justify-center gap-2">
                  <button
                    onClick={() => handleOffer(rec.name)}
                    className="w-full bg-[#1A202C] hover:bg-[#2D3748] text-white px-5 py-2.5 rounded-xl text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                  >
                    면접 제안하기
                  </button>
                  <button className="w-full bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] text-[#4A5568] px-5 py-2.5 rounded-xl text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
                    프로필 보기
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
