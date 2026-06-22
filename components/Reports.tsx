import { useState, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, AreaChart, Area, Cell } from "recharts";
import { Download, TrendingUp, Users, Brain, CheckCircle, Coins } from "lucide-react";
import { toast } from "sonner";

interface ApplicantRow {
  status: string;
  created_at: string | null;
}

interface UsageRow {
  total_cost_krw: number | null;
}

function lastSixMonths(): { key: string; name: string }[] {
  const out: { key: string; name: string }[] = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, name: `${d.getMonth() + 1}월` });
  }
  return out;
}

export function Reports() {
  const [dateRange, setDateRange] = useState("올해");
  const [stats, setStats] = useState({ total: 0, passed: 0, screening: 0, cost: 0 });
  const [trend, setTrend] = useState<{ name: string; 지원자: number; 합격자: number }[]>([]);
  const [funnel, setFunnel] = useState<{ step: string; count: number }[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [aRes, uRes] = await Promise.all([
          fetch("/api/admin/applicants"),
          fetch("/api/admin/usage"),
        ]);
        const apps = ((await aRes.json()).data ?? []) as ApplicantRow[];
        const usage = ((await uRes.json()).data ?? []) as UsageRow[];

        const by = (s: string) => apps.filter((a) => a.status === s).length;
        const passed = by("확정인력");
        const screening = by("스크리닝 중") + by("스크리닝 완료");
        const cost = usage.reduce((acc, u) => acc + (u.total_cost_krw ?? 0), 0);
        setStats({ total: apps.length, passed, screening, cost });

        setFunnel([
          { step: "지원서 접수", count: apps.length },
          { step: "AI 스크리닝", count: screening + passed },
          { step: "스크리닝 완료", count: by("스크리닝 완료") + passed },
          { step: "최종 합격", count: passed },
        ]);

        const months = lastSixMonths();
        setTrend(
          months.map((m) => {
            const inMonth = apps.filter((a) => (a.created_at ?? "").slice(0, 7) === m.key);
            return {
              name: m.name,
              지원자: inMonth.length,
              합격자: inMonth.filter((a) => a.status === "확정인력").length,
            };
          })
        );
      } catch {
        toast.error("리포트 데이터를 불러오지 못했어요");
      }
    })();
  }, []);

  const handleDownload = () => {
    toast.info("리포트 다운로드는 준비 중이에요");
  };

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">리포트 · 분석</h1>
          <p className="text-[14px] text-[#718096]">채용 성과와 AI 에이전트의 효율성을 다각도로 분석합니다.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-white border border-[#E2E8F0] rounded-xl px-2 py-1 shadow-sm">
            {['이번 주', '이번 달', '올해'].map(range => (
              <button 
                key={range}
                onClick={() => setDateRange(range)}
                className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] ${dateRange === range ? 'bg-[#F1F4F8] text-[#1A202C]' : 'text-[#718096] hover:text-[#4A5568]'}`}
              >
                {range}
              </button>
            ))}
          </div>
          <button 
            onClick={handleDownload}
            className="flex items-center gap-2 bg-white border border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC] px-4 py-2.5 rounded-xl font-bold transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[#FFCB3C]"
          >
            <Download size={16} /> 리포트 다운로드
          </button>
        </div>
      </div>

      {/* Overview Stats */}
      <div className="grid grid-cols-4 gap-5 mb-8">
        <div className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm">
          <div className="flex justify-between items-start mb-4">
            <div className="w-10 h-10 rounded-xl bg-[#F0FFF4] flex items-center justify-center">
              <Users size={20} className="text-[#38A169]" />
            </div>
          </div>
          <div className="text-[13px] font-bold text-[#718096] mb-1">총 지원자 수</div>
          <div className="text-2xl font-extrabold text-[#1A202C]">{stats.total.toLocaleString()}<span className="text-sm font-medium text-[#A0AEC0] ml-1">명</span></div>
        </div>

        <div className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm">
          <div className="flex justify-between items-start mb-4">
            <div className="w-10 h-10 rounded-xl bg-[#EBF8FF] flex items-center justify-center">
              <CheckCircle size={20} className="text-[#3182CE]" />
            </div>
          </div>
          <div className="text-[13px] font-bold text-[#718096] mb-1">확정 인력</div>
          <div className="text-2xl font-extrabold text-[#1A202C]">{stats.passed.toLocaleString()}<span className="text-sm font-medium text-[#A0AEC0] ml-1">명</span></div>
        </div>

        <div className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm">
          <div className="flex justify-between items-start mb-4">
            <div className="w-10 h-10 rounded-xl bg-[#FFFBEB] flex items-center justify-center">
              <Coins size={20} className="text-[#D69E2E]" />
            </div>
          </div>
          <div className="text-[13px] font-bold text-[#718096] mb-1">최근 30일 누적 비용</div>
          <div className="text-2xl font-extrabold text-[#1A202C]">{Math.round(stats.cost).toLocaleString()}<span className="text-sm font-medium text-[#A0AEC0] ml-1">원</span></div>
        </div>

        <div className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm">
          <div className="flex justify-between items-start mb-4">
            <div className="w-10 h-10 rounded-xl bg-[#FEFCBF] flex items-center justify-center">
              <Brain size={20} className="text-[#D69E2E]" />
            </div>
          </div>
          <div className="text-[13px] font-bold text-[#718096] mb-1">스크리닝 진행 중</div>
          <div className="text-2xl font-extrabold text-[#1A202C]">{stats.screening.toLocaleString()}<span className="text-sm font-medium text-[#A0AEC0] ml-1">명</span></div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 mb-6">
        {/* Sourcing Trend Chart */}
        <div className="bg-white border border-[#E2E8F0] rounded-2xl p-6 shadow-sm">
          <h3 className="text-[16px] font-bold text-[#1A202C] mb-6">월별 지원자 및 합격자 추이</h3>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%" minHeight={140} minWidth={1}>
              <AreaChart data={trend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs key="defs-reports">
                  <linearGradient key="grad-app" id="colorApplicants" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3182CE" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#3182CE" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient key="grad-hire" id="colorHires" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#38A169" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#38A169" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid key="grid" strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" />
                <XAxis key="xaxis" dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#718096' }} dy={10} />
                <YAxis key="yaxis" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#718096' }} />
                <RechartsTooltip 
                  key="tooltip"
                  contentStyle={{ borderRadius: '12px', border: '1px solid #E2E8F0', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
                  labelStyle={{ fontWeight: 'bold', color: '#1A202C', marginBottom: '4px' }}
                />
                <Legend key="legend" iconType="circle" wrapperStyle={{ fontSize: '13px', paddingTop: '20px' }} />
                <Area key="area-applicants" type="monotone" dataKey="지원자" stroke="#3182CE" strokeWidth={3} fillOpacity={1} fill="url(#colorApplicants)" />
                <Area key="area-hires" type="monotone" dataKey="합격자" stroke="#38A169" strokeWidth={3} fillOpacity={1} fill="url(#colorHires)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Funnel Chart */}
        <div className="bg-white border border-[#E2E8F0] rounded-2xl p-6 shadow-sm">
          <h3 className="text-[16px] font-bold text-[#1A202C] mb-6">채용 퍼널 전환율 (Funnel)</h3>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%" minHeight={140} minWidth={1}>
              <BarChart data={funnel} layout="vertical" margin={{ top: 0, right: 30, left: 30, bottom: 0 }}>
                <CartesianGrid key="grid" strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#E2E8F0" />
                <XAxis key="xaxis" type="number" hide />
                <YAxis key="yaxis" dataKey="step" type="category" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#4A5568', fontWeight: 600 }} width={110} />
                <RechartsTooltip 
                  key="tooltip"
                  cursor={{ fill: '#F7FAFC' }}
                  contentStyle={{ borderRadius: '12px', border: '1px solid #E2E8F0', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
                />
                <Bar key="bar" dataKey="count" fill="#FFCB3C" radius={[0, 6, 6, 0]} barSize={28}>
                  {funnel.map((entry, index) => (
                    <Cell key={`reports-cell-${index}`} fill={index === 0 ? '#E2E8F0' : index === funnel.length - 1 ? '#38A169' : '#FFCB3C'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}