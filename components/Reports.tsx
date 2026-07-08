import { useState, useMemo } from "react";
import useSWR from "swr";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, AreaChart, Area, Cell } from "recharts";
import { Download, TrendingUp, Users, Brain, CheckCircle, Coins } from "lucide-react";
import { toast } from "sonner";

interface ApplicantRow {
  status: string;
  created_at: string | null;
  // Airtable 일괄 임포트분 식별용 — 있으면 유입 시점이 임포트 시각이라 시계열을 오염시킨다.
  airtable_record_id?: string | null;
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

function inRange(created_at: string | null, range: string): boolean {
  if (!created_at) return false;
  const d = new Date(created_at);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  if (range === "올해") return d.getFullYear() === now.getFullYear();
  if (range === "이번 달") return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  if (range === "이번 주") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // 월요일 시작
    return d >= start;
  }
  return true;
}

export function Reports() {
  const [dateRange, setDateRange] = useState("올해");
  // applicants는 여러 탭과 동일 키라 SWR이 dedup·캐시; usage도 캐시.
  const { data: appsRes } = useSWR<{ data?: ApplicantRow[] }>("/api/admin/applicants");
  const { data: usageRes } = useSWR<{ data?: UsageRow[] }>("/api/admin/usage");
  const apps = useMemo(() => appsRes?.data ?? [], [appsRes]);
  const usage = useMemo(() => usageRes?.data ?? [], [usageRes]);

  // Airtable 일괄 임포트분(airtable_record_id 보유)은 created_at이 실제 제출일이 아니라 임포트 시각이라
  // created_at 기반 집계를 오염시킨다(임포트 ~390명이 전원 특정 월에 몰림) → 시계열/기간 집계에서 제외.
  const liveApps = useMemo(() => apps.filter((a) => !a.airtable_record_id), [apps]);

  // 기간(dateRange) 집계는 created_at을 기준으로 필터하므로 임포트분(liveApps)을 먼저 제외해야
  // '올해/이번 달'에 임포트 시각이 몰려 지원서 접수가 가짜로 급증하는 것을 막는다.
  const rangedApps = useMemo(() => liveApps.filter((a) => inRange(a.created_at, dateRange)), [liveApps, dateRange]);

  const stats = useMemo(() => {
    const by = (s: string) => rangedApps.filter((a) => a.status === s).length;
    const cost = usage.reduce((acc, u) => acc + (u.total_cost_krw ?? 0), 0);
    return { total: rangedApps.length, passed: by("확정인력"), screening: by("스크리닝 중") + by("스크리닝 완료"), cost };
  }, [rangedApps, usage]);

  const funnel = useMemo(() => {
    const by = (s: string) => rangedApps.filter((a) => a.status === s).length;
    const passed = by("확정인력");
    const screening = by("스크리닝 중") + by("스크리닝 완료");
    return [
      { step: "지원서 접수", count: rangedApps.length },
      { step: "AI 스크리닝", count: screening + passed },
      { step: "스크리닝 완료", count: by("스크리닝 완료") + passed },
      { step: "최종 합격", count: passed },
    ];
  }, [rangedApps]);

  // 추이 차트는 dateRange와 무관하게 항상 최근 6개월로 표시.
  // created_at 기반 시계열이라 임포트분(liveApps로 제외)을 빼야 실제 월별 유입을 반영한다.
  const trend = useMemo(() => {
    const months = lastSixMonths();
    return months.map((m) => {
      const inMonth = liveApps.filter((a) => (a.created_at ?? "").slice(0, 7) === m.key);
      return { name: m.name, 지원자: inMonth.length, 합격자: inMonth.filter((a) => a.status === "확정인력").length };
    });
  }, [liveApps]);

  const handleDownload = () => {
    const rows: (string | number)[][] = [
      ["리포트 기간", dateRange],
      [],
      ["항목", "값"],
      ["총 지원자(명)", stats.total],
      ["확정 인력(명)", stats.passed],
      ["스크리닝 진행 중(명)", stats.screening],
      ["최근 30일 누적 비용(원)", Math.round(stats.cost)],
      [],
      ["퍼널 단계", "인원"],
      ...funnel.map((f) => [f.step, f.count] as (string | number)[]),
    ];
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = rows.map((r) => r.map(esc).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `리포트_${dateRange}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("리포트를 CSV로 내보냈어요.");
  };

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">리포트 · 분석</h1>
          <p className="text-[14px] text-[#718096]">채용 성과와 AI 에이전트의 효율성을 다각도로 분석합니다. <span className="text-[#A0AEC0]">· 실시간 인입 기준(일괄 임포트 제외)</span></p>
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
          <h3 className="text-[16px] font-bold text-[#1A202C] mb-1">월별 지원자 및 합격자 추이</h3>
          <p className="text-[12px] text-[#718096] mb-5">실시간 인입 기준(일괄 임포트 제외)</p>
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