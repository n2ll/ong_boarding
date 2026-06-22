import { ArrowRight, TrendingUp, Users, Zap, MapPin, MousePointerClick, MessageSquare, Calendar, PlayCircle, BarChart2, CheckCircle2, Activity, PhoneCall } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, BarChart, Bar, XAxis, Tooltip } from "recharts";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";

export function Dashboard() {
  const router = useRouter();
  const [stats, setStats] = useState({ today: 0, screening: 0, interview: 0, passed: 0, total: 0 });

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/applicants");
        const json = await res.json();
        const apps = (json.data ?? []) as { status: string; created_at: string }[];
        const todayStr = new Date().toISOString().slice(0, 10);
        const by = (s: string) => apps.filter((a) => a.status === s).length;
        setStats({
          today: apps.filter((a) => (a.created_at ?? "").slice(0, 10) === todayStr).length,
          screening: by("스크리닝 중"),
          interview: by("스크리닝 완료"),
          passed: by("확정인력"),
          total: apps.length,
        });
      } catch {
        /* 대시보드 통계는 실패해도 화면은 유지 */
      }
    })();
  }, []);

  const handleAction = (msg: string, path?: string) => {
    toast.success(msg);
    if (path) router.push(path);
  };

  return (
    <div className="p-8 pb-12 flex flex-col gap-6 bg-[#F7FAFC] min-h-full">
      {/* Top Section: Overview */}
      <div className="grid grid-cols-[1.8fr_1fr] gap-6">
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="bg-[#1A202C] rounded-[20px] p-8 relative overflow-hidden shadow-md text-white flex flex-col justify-between">
          <div className="absolute right-0 top-0 w-[400px] h-[400px] bg-[#3182CE] rounded-full blur-[120px] opacity-20 pointer-events-none"></div>
          
          <div className="relative z-10 flex items-center justify-between mb-8">
            <div>
              <h1 className="text-[20px] font-extrabold tracking-tight mb-1">전사 채용 파이프라인 오버뷰</h1>
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
              { label: "면접 제안 발송", value: String(stats.interview), sub: "명", icon: MessageSquare, color: "text-[#9F7AEA]" },
              { label: "최종 합격 처리", value: String(stats.passed), sub: "건", icon: CheckCircle2, color: "text-[#68D391]" },
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
              실무자 긴급 확인 사항 <span className="bg-[#E53E3E] text-white text-[11px] px-2 py-0.5 rounded-full font-bold">2</span>
            </h2>
          </div>
          
          <div className="flex flex-col gap-3 flex-1 overflow-y-auto">
            <div className="p-4 border border-[#FEB2B2] bg-[#FFF5F5] rounded-xl flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center text-[#E53E3E] shrink-0 border border-[#FEB2B2] shadow-sm">
                <Activity size={16} />
              </div>
              <div className="flex-1">
                <div className="text-[13px] font-bold text-[#C53030]">비마트 송파점 결원 발생 알림</div>
                <div className="text-[12px] text-[#9B2C2C] mt-0.5 mb-2.5">출근율 미달 감지. 자동 소싱 워크플로우를 즉시 가동할까요?</div>
                <button onClick={() => handleAction('당근알바/알바몬 긴급 공고가 자동 포스팅되었습니다.', '/automation')} className="text-[11.5px] font-bold bg-[#E53E3E] text-white px-3 py-1.5 rounded-lg hover:bg-[#C53030] transition-colors outline-none shadow-sm">
                  긴급 소싱 가동
                </button>
              </div>
            </div>

            <div className="p-4 border border-[#E2E8F0] bg-white rounded-xl flex items-start gap-3 hover:border-[#CBD5E0] transition-colors cursor-pointer" onClick={() => handleAction('실시간 콘솔로 이동합니다.', '/live')}>
              <div className="w-8 h-8 rounded-lg bg-[#F7FAFC] flex items-center justify-center text-[#4A5568] shrink-0 border border-[#E2E8F0]">
                <PhoneCall size={16} />
              </div>
              <div className="flex-1">
                <div className="text-[13px] font-bold text-[#1A202C]">AI 답변 불가 - 수동 개입 필요</div>
                <div className="text-[12px] text-[#718096] mt-0.5 mb-2.5">박동훈 지원자의 [우천 할증 단가] 상세 문의 대기 중</div>
                <span className="text-[11.5px] font-bold text-[#4A5568] bg-[#F1F4F8] px-3 py-1.5 rounded-lg transition-colors outline-none">
                  직접 답변하기
                </span>
              </div>
            </div>
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

        {/* Heatmap Teaser */}
        <div className="bg-white border border-[#E2E8F0] rounded-[16px] p-5 shadow-sm relative overflow-hidden flex flex-col cursor-pointer hover:border-[#FFCB3C] transition-colors group" onClick={() => router.push('/sourcing')}>
          <div className="flex items-center justify-between mb-3 relative z-10">
            <div>
              <h2 className="text-[14px] font-bold text-[#1A202C] flex items-center gap-1.5"><MapPin size={14} className="text-[#E53E3E]"/> QR 오프라인 히트맵 <span className="bg-[#EDF2F7] text-[#718096] text-[9px] px-1.5 py-0.5 rounded font-bold ml-0.5">준비중</span></h2>
              <div className="text-[11.5px] text-[#718096] mt-0.5">강남/송파 지역 스캔 활성도</div>
            </div>
            <PlayCircle size={18} className="text-[#A0AEC0] group-hover:text-[#1A202C] transition-colors" />
          </div>
          <div className="flex-1 rounded-xl relative overflow-hidden flex items-center justify-center border border-[#E2E8F0] blur-[2px]">
            <div className="absolute inset-0 opacity-40 mix-blend-multiply" style={{
              backgroundImage: `url('https://images.unsplash.com/photo-1524661135-423995f22d0b?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80')`,
              backgroundSize: 'cover', backgroundPosition: 'center', filter: 'grayscale(100%)'
            }}></div>
            <div className="absolute w-20 h-20 bg-[#E53E3E] rounded-full blur-xl top-4 left-6 opacity-70 mix-blend-multiply animate-pulse"></div>
            <div className="absolute w-12 h-12 bg-[#FFCB3C] rounded-full blur-lg bottom-4 right-6 opacity-80 mix-blend-multiply"></div>
          </div>
        </div>
      </div>
    </div>
  );
}