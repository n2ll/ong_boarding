import { useState, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, Brain, CheckCircle2, Clock, MessageSquare, Phone, Mail, MoreHorizontal, FileText, Activity, Users, Send, Target, Zap, ShieldCheck } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar } from "recharts";
import { toast } from "sonner";

interface ApplicantDetail {
  id: number;
  name: string;
  phone: string | null;
  birth_date: string | null;
  location: string | null;
  own_vehicle: string | null;
  work_hours: string | null;
  experience: string | null;
  status: string;
  source: string | null;
  branch: string | null;
  created_at: string | null;
}

function calcAge(birth: string | null): string {
  if (!birth) return "";
  const y = new Date(birth).getFullYear();
  if (!y || Number.isNaN(y)) return "";
  return `${new Date().getFullYear() - y}세`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return "-";
  }
}

const SOURCE_LABEL: Record<string, string> = {
  danggeun: "당근알바 유입",
  baemin: "배민 유입",
  manual: "수기 등록",
  facebook: "페이스북 유입",
  naver: "네이버 유입",
  direct: "직접 지원",
};

export function CandidateProfile() {
  const { id } = useParams();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState("overview");
  const [noteText, setNoteText] = useState("");
  const [applicant, setApplicant] = useState<ApplicantDetail | null>(null);

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab) setActiveTab(tab);
  }, [searchParams]);

  useEffect(() => {
    const aid = Array.isArray(id) ? id[0] : id;
    if (!aid) return;
    (async () => {
      try {
        const res = await fetch("/api/admin/applicants");
        const json = await res.json();
        const found = ((json.data ?? []) as ApplicantDetail[]).find((a) => String(a.id) === String(aid));
        if (found) setApplicant(found);
      } catch {
        toast.error("지원자 정보를 불러오지 못했어요");
      }
    })();
  }, [id]);

  const ageLabel = calcAge(applicant?.birth_date ?? null);
  const sourceLabel = applicant?.source ? SOURCE_LABEL[applicant.source] ?? `${applicant.source} 유입` : "";

  const onboardingData = [
    { name: "Completed", value: 85 },
    { name: "Remaining", value: 15 },
  ];
  const COLORS = ["#38A169", "#EDF2F7"];

  return (
    <div className="flex flex-col h-full bg-[#EEF1F5] overflow-y-auto">
      {/* NBA (Next Best Action) Banner */}
      <div className="bg-gradient-to-r from-[#1A202C] via-[#2D3748] to-[#1A202C] text-white px-8 py-3.5 flex items-center justify-between shrink-0 border-b border-[#FFCB3C]/20 shadow-sm relative overflow-hidden">
        <div className="absolute inset-0 bg-[#FFCB3C]/5 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-[#FFCB3C]/20 via-transparent to-transparent pointer-events-none"></div>
        <div className="flex items-center gap-3 relative z-10">
          <Brain size={18} className="text-[#FFCB3C] animate-pulse" />
          <span className="text-[14px] font-extrabold text-[#FFCB3C]">AI 스크리닝 요약</span>
          <span className="text-[10px] font-bold text-[#1A202C] bg-[#FFCB3C] px-1.5 py-0.5 rounded">샘플</span>
          <div className="h-4 w-px bg-white/20 mx-2"></div>
          <span className="text-[14px] font-bold text-white">서류 적합도 92점 (상위 10%)</span>
          <span className="text-[13px] text-white/80 ml-2">거주지가 가깝고 관련 경력이 일치하여 면접 진행을 적극 권장합니다.</span>
        </div>
        <button 
          onClick={() => {
            toast.success("김철수 지원자에게 면접 가능 일정 확인 알림톡이 발송되었습니다.");
          }}
          className="relative z-10 bg-[#FFCB3C] text-[#1A202C] hover:bg-[#E0B500] px-4 py-2 rounded-lg text-[13px] font-bold transition-all shadow-sm flex items-center gap-2 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A202C] focus-visible:ring-[#FFCB3C]"
        >
          <Send size={14} /> [1초 만에] 면접 일정 조율하기
        </button>
      </div>

      <div className="p-8 max-w-[1200px] mx-auto w-full flex flex-col gap-6">
        {/* Header & Profile */}
        <div className="bg-white rounded-2xl border border-[#E2E8F0] p-6 shadow-sm flex items-start justify-between">
          <div className="flex gap-6">
            <div className="w-24 h-24 rounded-2xl bg-[#EBF8FF] text-[#3182CE] flex items-center justify-center text-3xl font-black shrink-0 border border-[#BEE3F8]">
              {applicant?.name?.charAt(0) ?? "?"}
            </div>
            <div className="flex flex-col justify-center">
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-[28px] font-extrabold text-[#1A202C] tracking-tight leading-none">{applicant?.name ?? "지원자"}</h1>
                {ageLabel && <span className="text-[14px] font-bold text-[#718096] bg-[#F7FAFC] px-2.5 py-1 rounded-md">{ageLabel}</span>}
                <span className="text-[13px] font-bold text-[#38A169] bg-[#F0FFF4] px-2.5 py-1 rounded-md border border-[#C6F6D5]">{applicant?.status ?? "-"}</span>
              </div>
              <div className="text-[15px] font-medium text-[#4A5568] flex items-center gap-4 mb-3">
                <span>{applicant?.branch ?? "지점 미지정"}</span>
                {sourceLabel && <><div className="w-1 h-1 rounded-full bg-[#CBD5E0]"></div><span>{sourceLabel}</span></>}
                <div className="w-1 h-1 rounded-full bg-[#CBD5E0]"></div>
                <span>지원일: {fmtDate(applicant?.created_at ?? null)}</span>
              </div>
              <div className="flex gap-2">
                <button className="flex items-center gap-1.5 bg-[#F1F4F8] hover:bg-[#E2E8F0] px-3 py-1.5 rounded-lg text-[13px] font-bold text-[#4A5568] transition-colors">
                  <Phone size={14} /> {applicant?.phone ?? "연락처 없음"}
                </button>
                <button 
                  onClick={() => window.dispatchEvent(new CustomEvent('open-chat-widget'))}
                  className="flex items-center gap-1.5 bg-[#F1F4F8] hover:bg-[#E2E8F0] px-3 py-1.5 rounded-lg text-[13px] font-bold text-[#4A5568] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                >
                  <MessageSquare size={14} /> 실시간 채팅
                </button>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="p-2 border border-[#E2E8F0] rounded-xl text-[#718096] hover:bg-[#F7FAFC] transition-colors">
              <MoreHorizontal size={20} />
            </button>
          </div>
        </div>

        {/* Layout Grid */}
        <div className="grid grid-cols-[1fr_380px] gap-6">
          {/* Left Column */}
          <div className="flex flex-col gap-6">
            {/* Tabs */}
            <div className="flex gap-6 border-b border-[#E2E8F0]">
              {[
                { id: "overview", label: "요약 · 프로필" },
                { id: "screening", label: "AI 스크리닝" },
                { id: "history", label: "활동 이력 · 메모" },
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`pb-3 text-[15px] font-bold border-b-2 transition-colors ${
                    activeTab === tab.id ? "text-[#1A202C] border-[#FFCB3C]" : "text-[#A0AEC0] border-transparent hover:text-[#4A5568]"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab Contents */}
            {activeTab === "overview" && (
              <div className="flex flex-col gap-6">
                <div className="bg-white rounded-2xl border border-[#E2E8F0] p-6 shadow-sm">
                  <h3 className="text-[16px] font-bold text-[#1A202C] mb-5">지원서 정보</h3>
                  <div className="grid grid-cols-2 gap-y-5 gap-x-8">
                    <div>
                      <div className="text-[12px] font-bold text-[#A0AEC0] mb-1">희망 근무시간</div>
                      <div className="text-[15px] font-semibold text-[#1A202C]">{applicant?.work_hours || "미확인"}</div>
                    </div>
                    <div>
                      <div className="text-[12px] font-bold text-[#A0AEC0] mb-1">이동 수단</div>
                      <div className="text-[15px] font-semibold text-[#1A202C]">{applicant?.own_vehicle || "미확인"}</div>
                    </div>
                    <div>
                      <div className="text-[12px] font-bold text-[#A0AEC0] mb-1">거주지</div>
                      <div className="text-[15px] font-semibold text-[#1A202C]">{applicant?.location || "미확인"}</div>
                    </div>
                    <div>
                      <div className="text-[12px] font-bold text-[#A0AEC0] mb-1">경력</div>
                      <div className="text-[15px] font-semibold text-[#1A202C]">{applicant?.experience || "미확인"}</div>
                    </div>
                  </div>
                </div>

                <div className="bg-white rounded-2xl border border-[#E2E8F0] p-6 shadow-sm">
                  <h3 className="text-[16px] font-bold text-[#1A202C] mb-4">경력 사항</h3>
                  <div className="flex flex-col gap-4">
                    <div className="flex gap-4 p-4 bg-[#F7FAFC] rounded-xl border border-[#EDF2F7]">
                      <div className="w-10 h-10 rounded-full bg-[#E2E8F0] flex items-center justify-center shrink-0">
                        <FileText size={18} className="text-[#718096]" />
                      </div>
                      <div>
                        <div className="text-[15px] font-bold text-[#1A202C]">쿠팡이츠 도보배달 파트너</div>
                        <div className="text-[13px] text-[#718096] mt-0.5">2023.01 ~ 2024.05 (1년 4개월)</div>
                        <div className="text-[14px] text-[#4A5568] mt-2">강남역 인근 도보 배달 수행. 지리 숙지도 높음.</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "screening" && (
              <div className="flex flex-col gap-6">
                <div className="bg-white rounded-2xl border border-[#E2E8F0] p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-5">
                    <h3 className="text-[16px] font-bold text-[#1A202C] flex items-center gap-2">
                      <Brain size={18} className="text-[#3182CE]" /> AI 심층 스크리닝 리포트
                    </h3>
                    <div className="text-[13px] font-bold text-[#3182CE] bg-[#EBF8FF] px-3 py-1.5 rounded-lg border border-[#BEE3F8]">
                      종합 평���: A+ (92점)
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-[1fr_1.5fr] gap-8 items-center mb-6">
                    <div className="h-[220px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <RadarChart id="screening-radar" cx="50%" cy="50%" outerRadius="70%" data={[
                          { subject: '업무적합도', A: 95, fullMark: 100 },
                          { subject: '도보거리', A: 90, fullMark: 100 },
                          { subject: '경험치', A: 85, fullMark: 100 },
                          { subject: '스마트기기', A: 90, fullMark: 100 },
                          { subject: '근태/성실성', A: 95, fullMark: 100 },
                        ]}>
                          <PolarGrid key="grid" stroke="#E2E8F0" />
                          <PolarAngleAxis key="axis-angle" dataKey="subject" tick={{ fill: '#718096', fontSize: 12, fontWeight: 700 }} />
                          <PolarRadiusAxis key="axis-radius" angle={30} domain={[0, 100]} ticks={[]} axisLine={false} />
                          <Radar key="radar-main" name="Candidate" dataKey="A" stroke="#3182CE" fill="#3182CE" fillOpacity={0.4} isAnimationActive={false} />
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex flex-col gap-4">
                      <div className="bg-[#F7FAFC] border border-[#EDF2F7] rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <Target size={16} className="text-[#3182CE]" />
                          <div className="text-[14px] font-bold text-[#1A202C]">직무 적합성 분석</div>
                        </div>
                        <p className="text-[13.5px] text-[#4A5568] leading-relaxed">
                          과거 쿠팡이츠 도보 배달 경험(1년 4개월)이 있어 비마트의 단거리 도보 배달 업무에 매우 적합합니다. 또한 강남역 인근 지리에 밝아 배달 소요 시간을 단축할 수 있을 것으로 기대됩니다.
                        </p>
                      </div>
                      <div className="bg-[#F7FAFC] border border-[#EDF2F7] rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <ShieldCheck size={16} className="text-[#38A169]" />
                          <div className="text-[14px] font-bold text-[#1A202C]">리스크 체크</div>
                        </div>
                        <p className="text-[13.5px] text-[#4A5568] leading-relaxed">
                          60대 연령으로 ��한 혹한기/혹서기 야외 활동 시 체력 저하 우려가 있으나, 주 3일 평일 오전조를 희망하고 있어 무리가 없을 것으로 판단됩니다.
                        </p>
                      </div>
                    </div>
                  </div>

                  <h3 className="text-[15px] font-bold text-[#1A202C] mb-4 mt-6">항목별 상세 평가</h3>
                  <div className="flex flex-col gap-3">
                    {[
                      { title: "도달 가능 거리", desc: "지원 지점(비마트 강남점)에서 도보 15분 거리 거주로 최적의 동선", score: "90/100" },
                      { title: "배달 앱 활용력", desc: "기존 타 배달 앱 경험으로 초기 교육 시간 단축 가능 (즉시 투입 가능 수준)", score: "95/100" },
                      { title: "고객 서비스 역량", desc: "특이사항 없음. 일반적인 비대면 배달 수행에 충분한 수준", score: "85/100" },
                    ].map((item, idx) => (
                      <div key={item.title} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-white border border-[#E2E8F0] rounded-xl hover:border-[#FFCB3C] transition-colors">
                        <div>
                          <div className="text-[14px] font-bold text-[#2D3748] mb-1">{item.title}</div>
                          <div className="text-[13px] text-[#718096]">{item.desc}</div>
                        </div>
                        <div className="text-[14px] font-extrabold text-[#3182CE] mt-2 sm:mt-0 shrink-0">{item.score}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeTab === "history" && (
              <div className="flex flex-col gap-6">
                <div className="bg-white rounded-2xl border border-[#E2E8F0] p-6 shadow-sm">
                  <h3 className="text-[16px] font-bold text-[#1A202C] mb-5">내부 메모</h3>
                  <div className="flex gap-3 mb-6">
                    <div className="w-8 h-8 rounded-full bg-[#FFCB3C] flex items-center justify-center font-bold text-[#1A202C] shrink-0">
                      나
                    </div>
                    <div className="flex-1 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl focus-within:border-[#FFCB3C] focus-within:ring-1 focus-within:ring-[#FFCB3C] p-2 transition-all">
                      <textarea 
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        placeholder="이 지원자에 대한 메모를 남겨주세요 (팀원들에게만 보입니다)" 
                        className="w-full bg-transparent resize-none outline-none text-[14px] text-[#1A202C] min-h-[60px] p-2"
                      />
                      <div className="flex justify-end">
                        <button className="bg-[#1A202C] hover:bg-[#2D3748] text-white px-4 py-1.5 rounded-lg text-[13px] font-bold transition-colors flex items-center gap-1.5">
                          <Send size={14} /> 메모 등록
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-4">
                    <div className="flex gap-3">
                      <div className="w-8 h-8 rounded-full bg-[#E2E8F0] flex items-center justify-center font-bold text-[#4A5568] shrink-0">
                        P
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[13px] font-bold text-[#1A202C]">박매니저</span>
                          <span className="text-[11px] text-[#A0AEC0]">2시간 전</span>
                        </div>
                        <div className="text-[14px] text-[#4A5568] bg-[#F7FAFC] p-3 rounded-xl border border-[#EDF2F7]">
                          도보 배달 경험이 있으셔서 앱 사용은 능숙하실 것 같습니다. 다만 체력적인 부분에 대해서 면접 때 한 번 더 체크해보면 좋겠습니다.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-white rounded-2xl border border-[#E2E8F0] p-6 shadow-sm">
                  <h3 className="text-[16px] font-bold text-[#1A202C] mb-5">상태 변경 타임라인</h3>
                  <div className="relative border-l-2 border-[#E2E8F0] ml-3 flex flex-col gap-6">
                    <div className="relative pl-6">
                      <div className="absolute -left-[9px] top-0.5 w-4 h-4 rounded-full border-2 border-white bg-[#38A169]"></div>
                      <div className="text-[14px] font-bold text-[#1A202C]">AI 스크리닝 합격 (92점)</div>
                      <div className="text-[12px] text-[#A0AEC0] mt-0.5">2026.06.20 14:30</div>
                    </div>
                    <div className="relative pl-6">
                      <div className="absolute -left-[9px] top-0.5 w-4 h-4 rounded-full border-2 border-white bg-[#3182CE]"></div>
                      <div className="text-[14px] font-bold text-[#1A202C]">지원서 접수 완료</div>
                      <div className="text-[12px] text-[#A0AEC0] mt-0.5">2026.06.20 14:25</div>
                    </div>
                    <div className="relative pl-6">
                      <div className="absolute -left-[9px] top-0.5 w-4 h-4 rounded-full border-2 border-white bg-[#D69E2E]"></div>
                      <div className="text-[14px] font-bold text-[#1A202C]">당근알바 채널 유입</div>
                      <div className="text-[12px] text-[#A0AEC0] mt-0.5">2026.06.20 14:15</div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Tracking & Onboarding */}
          <div className="flex flex-col gap-6">
            <div className="bg-white rounded-2xl border border-[#E2E8F0] p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[16px] font-bold text-[#1A202C]">근무 준비 온보딩</h3>
                <span className="text-[13px] font-extrabold text-[#38A169]">85% 완료</span>
              </div>
              <div className="flex items-center gap-5 mb-5">
                <div className="w-[80px] h-[80px] relative">
                  <ResponsiveContainer width="100%" height="100%" minHeight={80} minWidth={1}>
                    <PieChart id="onboarding-pie">
                      <Pie
                        data={onboardingData}
                        id="onboarding-pie-element"
                        cx="50%"
                        cy="50%"
                        innerRadius={28}
                        outerRadius={40}
                        stroke="none"
                        dataKey="value"
                        startAngle={90}
                        endAngle={-270}
                        isAnimationActive={false}
                      >
                        {onboardingData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 flex items-center justify-center flex-col">
                    <span className="text-[16px] font-extrabold text-[#1A202C] leading-none">85</span>
                    <span className="text-[10px] font-bold text-[#A0AEC0]">%</span>
                  </div>
                </div>
                <div className="flex-1 text-[13px] text-[#4A5568] leading-relaxed">
                  필수 서류 제출 및 기초 교육이 대부분 완료되었습니다. 마지막 1개 항목이 남았습니다.
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <CheckCircle2 size={18} className="text-[#38A169]" />
                  <span className="text-[13.5px] font-medium text-[#2D3748] line-through opacity-70">보건증/신분증 사본 제출</span>
                </div>
                <div className="flex items-center gap-3">
                  <CheckCircle2 size={18} className="text-[#38A169]" />
                  <span className="text-[13.5px] font-medium text-[#2D3748] line-through opacity-70">기초 안전보건 교육 이수</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-[18px] h-[18px] rounded-full border-2 border-[#CBD5E0]"></div>
                  <span className="text-[13.5px] font-bold text-[#1A202C]">업무용 배달 앱 설치 및 로그인</span>
                </div>
              </div>
              <button className="w-full mt-5 bg-[#F7FAFC] border border-[#E2E8F0] hover:bg-[#EDF2F7] text-[#4A5568] py-2 rounded-xl text-[13px] font-bold transition-colors">
                미완료 항목 안내 알림톡 발송
              </button>
            </div>
            
            <div className="bg-[#FFFBEB] rounded-2xl border border-[#FDE68A] p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <Activity size={18} className="text-[#D69E2E]" />
                <h3 className="text-[15px] font-extrabold text-[#D69E2E]">AI 채용 분석 리포트</h3>
              </div>
              <p className="text-[13px] text-[#744210] leading-relaxed mb-4">
                지원자의 성향은 신중하고 책임감이 강하며, 도보 배달 특성상 성실함이 돋보입니다. 장기 근속 확률이 88%로 예측됩니다.
              </p>
              <button className="text-[13px] font-bold text-[#B7791F] underline underline-offset-2">전체 분석 리포트 보기</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
