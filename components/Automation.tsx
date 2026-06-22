import { useState, useEffect } from "react";
import { Plus, CheckCircle2, MessageSquare, Save, FileText, Filter, Calendar, Users, AlertTriangle, Sparkles, Zap, Smartphone, Briefcase, Activity, Clock, Play, X, Power, Inbox } from "lucide-react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";
import { DemoBanner } from "./DemoBanner";

interface AutoStats {
  aiDisabled: boolean;
  screening: number;
  confirmed: number;
  waiting: number;
  inbox: number;
  activeJobs: number;
  loading: boolean;
}

interface RuleDef {
  id: string;
  label: string;
  desc: string;
  hasThreshold: boolean;
  defaultThreshold?: number;
  unit?: string;
}
interface RuleConfig {
  enabled: boolean;
  threshold?: number;
}
interface RuleResult {
  id: string;
  triggered: boolean;
  detail: string;
}

const MOCK_WORKFLOWS = [
  { id: 1, name: "신규 지원자 대화형 스크리닝", status: "active", category: "지원자 파이프라인 관리", runs: "1,240", success: "98.5%", lastRun: "방금 전" },
  { id: 2, name: "고득점자 자동 면접 제안 (캘린더)", status: "active", category: "지원자 파이프라인 관리", runs: "342", success: "95.2%", lastRun: "10분 전" },
  { id: 5, name: "결원 발생 시 긴급 소싱 포스팅", status: "active", category: "인력 충원 및 채널 연동", runs: "12", success: "100%", lastRun: "어제" },
  { id: 6, name: "휴면 인재풀(DB) 자동 최신화 (알림톡)", status: "paused", category: "CRM 리타겟팅", runs: "-", success: "-", lastRun: "-" }
];

export function Automation() {
  const [selectedWf, setSelectedWf] = useState(1);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [stats, setStats] = useState<AutoStats>({ aiDisabled: false, screening: 0, confirmed: 0, waiting: 0, inbox: 0, activeJobs: 0, loading: true });

  // 자동 점검 규칙 (실동작)
  const [ruleDefs, setRuleDefs] = useState<RuleDef[]>([]);
  const [ruleConfig, setRuleConfig] = useState<Record<string, RuleConfig>>({});
  const [ruleResults, setRuleResults] = useState<Record<string, RuleResult>>({});
  const [ruleRunning, setRuleRunning] = useState(false);
  const [ruleRanAt, setRuleRanAt] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/automation/rules");
        const json = await res.json();
        setRuleDefs((json.rules ?? []) as RuleDef[]);
        setRuleConfig((json.config ?? {}) as Record<string, RuleConfig>);
      } catch {
        /* 실패해도 화면 유지 */
      }
    })();
  }, []);

  const persistConfig = async (next: Record<string, RuleConfig>) => {
    try {
      await fetch("/api/admin/automation/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: next }),
      });
    } catch {
      toast.error("규칙 저장에 실패했어요");
    }
  };

  const toggleRule = (id: string) => {
    const next = { ...ruleConfig, [id]: { ...ruleConfig[id], enabled: !ruleConfig[id]?.enabled } };
    setRuleConfig(next);
    persistConfig(next);
  };

  const setThreshold = (id: string, value: number) => {
    const next = { ...ruleConfig, [id]: { ...ruleConfig[id], threshold: Math.max(0, value) } };
    setRuleConfig(next);
  };

  const runEvaluate = async () => {
    if (ruleRunning) return;
    setRuleRunning(true);
    try {
      await persistConfig(ruleConfig); // 최신 임계값 반영 후 평가
      const res = await fetch("/api/admin/automation/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notify: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "점검 실행에 실패했어요");
        return;
      }
      const map: Record<string, RuleResult> = {};
      for (const r of (json.results ?? []) as RuleResult[]) map[r.id] = r;
      setRuleResults(map);
      setRuleRanAt(json.ran_at ?? new Date().toISOString());
      if (json.triggered_count > 0) {
        toast.warning(`조치 필요 ${json.triggered_count}건 감지${json.notified ? " · 슬랙 발송됨" : " (슬랙 미설정)"}`);
      } else {
        toast.success("점검 완료 — 조치 필요 항목 없음");
      }
    } catch {
      toast.error("점검 실행에 실패했어요");
    } finally {
      setRuleRunning(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const [aRes, kRes, iRes, jRes] = await Promise.all([
          fetch("/api/admin/applicants"),
          fetch("/api/admin/agent/kill-switch"),
          fetch("/api/admin/inbox/pending"),
          fetch("/api/admin/jobs?status=active"),
        ]);
        const apps = ((await aRes.json()).data ?? []) as { status: string }[];
        const k = await kRes.json();
        const inbox = ((await iRes.json()).data ?? []) as unknown[];
        const jobs = ((await jRes.json()).jobs ?? []) as { title: string }[];
        const by = (s: string) => apps.filter((a) => a.status === s).length;
        setStats({
          aiDisabled: !!k.disabled || !!k.env_forced,
          screening: by("스크리닝 중"),
          confirmed: by("확정인력"),
          waiting: by("대기자"),
          inbox: inbox.length,
          activeJobs: jobs.filter((j) => !String(j.title).startsWith("__")).length,
          loading: false,
        });
      } catch {
        setStats((s) => ({ ...s, loading: false }));
      }
    })();
  }, []);

  const selectedWorkflow = MOCK_WORKFLOWS.find(w => w.id === selectedWf) || MOCK_WORKFLOWS[0];
  
  // Render different trees based on selected workflow
  const renderWorkflowCanvas = () => {
    if (selectedWf === 1) {
      return (
        <div className="flex flex-col items-center relative w-full max-w-[500px]">
          <NodeCard id="w1_n1" type="trigger" icon={Activity} color="text-[#3182CE]" bg="bg-[#EBF8FF]" border="border-[#3182CE]" title="신규 지원서 접수 (웹훅)" desc="모든 소싱 채널(Meta, 당근 등) 유입 시" />
          <VerticalLine animated />
          <NodeCard id="w1_n2" type="action" icon={MessageSquare} color="text-[#E53E3E]" bg="bg-[#FFF5F5]" border="border-[#E53E3E]" title="대화형 스크리닝 알림톡 발송" desc="운전면허증/야간근무 가능 여부 폼 전송" />
          <VerticalLine animated />
          <NodeCard id="w1_n3" type="condition" icon={Filter} color="text-[#805AD5]" bg="bg-[#FAF5FF]" border="border-[#805AD5]" title="조건: 필수 요건 통과" desc="면허 보유 AND 주말 야간 가능" />
          <SplitBranch 
            trueNode={<NodeCard id="w1_n4" type="action" icon={Sparkles} color="text-[#38A169]" bg="bg-[#F0FFF4]" border="border-[#38A169]" title="AI 스크리닝 90점 (Pass)" desc="파이프라인 상태: 면접 대상 전환" />}
            falseNode={<NodeCard id="w1_n5" type="action" icon={FileText} color="text-[#718096]" bg="bg-[#EDF2F7]" border="border-[#A0AEC0]" title="보류 상태로 전환" desc="파이프라인 상태: 불합격/보류" />}
          />
        </div>
      );
    } else if (selectedWf === 2) {
      return (
        <div className="flex flex-col items-center relative w-full max-w-[500px]">
          <NodeCard id="w2_n1" type="trigger" icon={Sparkles} color="text-[#D69E2E]" bg="bg-[#FEFCBF]" border="border-[#D69E2E]" title="지원자 점수 90점 이상 달성" desc="상태 변경 트리거 감지" />
          <VerticalLine animated />
          <NodeCard id="w2_n2" type="action" icon={Calendar} color="text-[#3182CE]" bg="bg-[#EBF8FF]" border="border-[#3182CE]" title="면접 캘린더 픽커 전송" desc="점장 Google Calendar 빈 시간 동기화" />
          <VerticalLine />
          <NodeCard id="w2_n3" type="condition" icon={AlertTriangle} color="text-[#DD6B20]" bg="bg-[#FEFCBF]" border="border-[#DD6B20]" title="일정 선택 대기 (24시간)" desc="시간 초과 시 분기 처리" />
          <SplitBranch 
            trueNode={<NodeCard id="w2_n4" type="action" icon={CheckCircle2} color="text-[#38A169]" bg="bg-[#F0FFF4]" border="border-[#38A169]" title="면접 일정 확정" desc="리마인더 스케줄 등록 완료" />}
            falseNode={<NodeCard id="w2_n5" type="action" icon={MessageSquare} color="text-[#718096]" bg="bg-[#EDF2F7]" border="border-[#A0AEC0]" title="미선택 리마인드 알림톡 전송" desc="1회 추가 독려 메시지" />}
          />
        </div>
      );
    } else if (selectedWf === 5) {
      return (
        <div className="flex flex-col items-center relative w-full max-w-[500px]">
          <NodeCard id="w5_n1" type="trigger" icon={Activity} color="text-[#E53E3E]" bg="bg-[#FFF5F5]" border="border-[#E53E3E]" title="API: 결원 감지 (근태 연동)" desc="당일 파트너 출근율 80% 미만" />
          <VerticalLine animated />
          <NodeCard id="w5_n2" type="action" icon={Zap} color="text-[#D69E2E]" bg="bg-[#FEFCBF]" border="border-[#D69E2E]" title="당근알바/알바몬 자동 '급구' 게재" desc="시급 1.5배 할증 적용 템플릿 사용" />
          <VerticalLine />
          <NodeCard id="w5_n3" type="condition" icon={Users} color="text-[#3182CE]" bg="bg-[#EBF8FF]" border="border-[#3182CE]" title="조건: 목표 인원 5명 충족 대기" desc="실시간 유입 모니터링" />
          <SplitBranch 
            trueNode={<NodeCard id="w5_n4" type="action" icon={CheckCircle2} color="text-[#38A169]" bg="bg-[#F0FFF4]" border="border-[#38A169]" title="공고 마감 및 점장 알림" desc="충원 완료 안내 발송" />}
            falseNode={<NodeCard id="w5_n5" type="action" icon={AlertTriangle} color="text-[#718096]" bg="bg-[#EDF2F7]" border="border-[#A0AEC0]" title="기존 휴면 DB 긴급 SOS 발송" desc="목표 미달 시 CRM 타겟팅 우회" />}
          />
        </div>
      );
    } else {
      return (
        <div className="flex flex-col items-center relative w-full max-w-[500px]">
          <NodeCard id="w6_n1" type="trigger" icon={Clock} color="text-[#805AD5]" bg="bg-[#FAF5FF]" border="border-[#805AD5]" title="지원 이력 6개월 경과 (스케줄러)" desc="매일 오전 9시 휴면 대상자 추출" />
          <VerticalLine />
          <NodeCard id="w6_n2" type="action" icon={Smartphone} color="text-[#3182CE]" bg="bg-[#EBF8FF]" border="border-[#3182CE]" title="구직 의사 확인 알림톡 발송" desc="'다시 근무하실 의향이 있으신가요?' 폼" />
          <VerticalLine />
          <NodeCard id="w6_n3" type="condition" icon={Filter} color="text-[#DD6B20]" bg="bg-[#FEFCBF]" border="border-[#DD6B20]" title="폼 응답 결과 필터링" desc="구직 의사 '있음' 응답 확인" />
          <SplitBranch 
            trueNode={<NodeCard id="w6_n4" type="action" icon={Briefcase} color="text-[#38A169]" bg="bg-[#F0FFF4]" border="border-[#38A169]" title="파이프라인 'Active' 전환" desc="리타겟팅 우선 추천 그룹 할당" />}
            falseNode={<NodeCard id="w6_n5" type="action" icon={FileText} color="text-[#718096]" bg="bg-[#EDF2F7]" border="border-[#A0AEC0]" title="DB 보존 기한 연장" desc="다음 6개월 후 재확인으로 연기" />}
          />
        </div>
      );
    }
  };

  const VerticalLine = ({ animated = false }) => (
    <div className="w-0.5 h-10 bg-[#CBD5E0] relative overflow-hidden">
      {animated && <div className="absolute top-0 w-full h-1/2 bg-[#3182CE] animate-[bounce_2s_infinite]"></div>}
    </div>
  );

  const SplitBranch = ({ trueNode, falseNode }: { trueNode: React.ReactNode, falseNode: React.ReactNode }) => (
    <div className="flex gap-8 relative z-0">
      <div className="absolute top-0 left-[50%] right-[-50%] h-0.5 bg-[#CBD5E0] -translate-x-[150px] w-[300px]"></div>
      
      <div className="flex flex-col items-center">
        <div className="w-0.5 h-6 bg-[#CBD5E0]"></div>
        <span className="bg-white border border-[#E2E8F0] text-[#38A169] text-[10px] font-bold px-2 py-0.5 rounded-full mb-4 shadow-sm">조건 충족 (TRUE)</span>
        {trueNode}
      </div>

      <div className="flex flex-col items-center opacity-80 hover:opacity-100 transition-opacity">
        <div className="w-0.5 h-6 bg-[#CBD5E0]"></div>
        <span className="bg-white border border-[#E2E8F0] text-[#718096] text-[10px] font-bold px-2 py-0.5 rounded-full mb-4 shadow-sm">조건 미달 (FALSE)</span>
        {falseNode}
      </div>
    </div>
  );

  const NodeCard = ({ id, type, icon: Icon, color, bg, border, title, desc }: any) => {
    const isSelected = selectedNode === id;
    return (
      <motion.div 
        key={id}
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} 
        onClick={(e) => { e.stopPropagation(); setSelectedNode(id); }}
        className={`w-[280px] sm:w-[320px] bg-white border rounded-[16px] p-4 relative z-10 cursor-pointer group hover:shadow-md transition-all ${isSelected ? `${border} ring-2 ring-opacity-50 ${border.replace('border-', 'ring-')} shadow-sm` : 'border-[#E2E8F0] shadow-sm'}`}
      >
        {type === 'condition' && <div className="absolute -left-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-white border border-[#E2E8F0] rounded-full flex items-center justify-center shadow-sm"><Filter size={12} className="text-[#A0AEC0]" /></div>}
        <div className="flex items-center gap-2 mb-2.5">
          <div className={`w-6 h-6 rounded-md ${bg} flex items-center justify-center`}><Icon size={12} className={color} /></div>
          <span className={`text-[10px] font-extrabold tracking-wider ${color}`}>{type.toUpperCase()}</span>
        </div>
        <h3 className="text-[14px] font-bold text-[#1A202C] mb-1">{title}</h3>
        <p className="text-[12px] text-[#718096] leading-tight">{desc}</p>
      </motion.div>
    );
  };

  const kpis = [
    {
      label: "AI 자동응답",
      value: stats.loading ? "…" : stats.aiDisabled ? "중단됨" : "작동 중",
      icon: Power,
      tone: stats.aiDisabled ? "text-[#E53E3E]" : "text-[#38A169]",
      live: !stats.aiDisabled,
    },
    { label: "스크리닝 진행 중", value: stats.loading ? "…" : `${stats.screening}명`, icon: Activity, tone: "text-[#D69E2E]" },
    { label: "확정 인력", value: stats.loading ? "…" : `${stats.confirmed}명`, icon: CheckCircle2, tone: "text-[#3182CE]" },
    { label: "대기자", value: stats.loading ? "…" : `${stats.waiting}명`, icon: Users, tone: "text-[#718096]" },
    { label: "미분류 인박스", value: stats.loading ? "…" : `${stats.inbox}건`, icon: Inbox, tone: stats.inbox > 0 ? "text-[#E53E3E]" : "text-[#718096]" },
    { label: "진행 중 공고", value: stats.loading ? "…" : `${stats.activeJobs}건`, icon: Briefcase, tone: "text-[#1A202C]" },
  ];

  return (
    <div className="flex flex-col min-h-full bg-[#F7FAFC]">
      {/* 실시간 자동화 현황 (실데이터) */}
      <div className="shrink-0 bg-white border-b border-[#E2E8F0] px-6 py-3.5">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="text-[12px] font-extrabold tracking-wide text-[#1A202C]">실시간 자동화 현황</span>
          <span className="text-[11px] font-bold text-[#38A169] bg-[#F0FFF4] border border-[#C6F6D5] px-1.5 py-0.5 rounded">LIVE · 실데이터</span>
        </div>
        <div className="grid grid-cols-6 gap-3">
          {kpis.map((k, i) => (
            <div key={i} className="border border-[#E2E8F0] rounded-xl px-3.5 py-2.5 bg-[#FCFDFE]">
              <div className="flex items-center gap-1.5 text-[11.5px] font-bold text-[#718096] mb-1">
                <k.icon size={13} className={k.tone} /> {k.label}
              </div>
              <div className={`text-[18px] font-extrabold tracking-tight flex items-center gap-1.5 ${k.tone}`}>
                {k.value}
                {k.live && <span className="w-1.5 h-1.5 rounded-full bg-[#38A169] animate-pulse" />}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 자동 점검 규칙 (실동작) */}
      <div className="shrink-0 bg-white border-b border-[#E2E8F0] px-6 py-3.5">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-extrabold tracking-wide text-[#1A202C]">자동 점검 규칙</span>
            <span className="text-[11px] font-bold text-[#38A169] bg-[#F0FFF4] border border-[#C6F6D5] px-1.5 py-0.5 rounded">실동작</span>
            {ruleRanAt && <span className="text-[11px] text-[#A0AEC0]">최근 점검: {new Date(ruleRanAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span>}
          </div>
          <button
            onClick={runEvaluate}
            disabled={ruleRunning}
            className="flex items-center gap-1.5 bg-[#1A202C] hover:bg-[#2D3748] text-white px-3.5 py-1.5 rounded-lg text-[12.5px] font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] disabled:opacity-60"
          >
            <Play size={13} /> {ruleRunning ? "점검 중…" : "지금 점검 실행"}
          </button>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {ruleDefs.map((rule) => {
            const cfg = ruleConfig[rule.id] ?? { enabled: false };
            const result = ruleResults[rule.id];
            return (
              <div key={rule.id} className={`border rounded-xl px-3.5 py-2.5 ${cfg.enabled ? "border-[#E2E8F0] bg-[#FCFDFE]" : "border-[#EDF2F7] bg-[#F7FAFC] opacity-70"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-bold text-[#1A202C] truncate">{rule.label}</div>
                    <div className="text-[11px] text-[#718096] leading-tight mt-0.5 line-clamp-2">{rule.desc}</div>
                  </div>
                  <button
                    onClick={() => toggleRule(rule.id)}
                    className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${cfg.enabled ? "bg-[#38A169]" : "bg-[#CBD5E0]"}`}
                    title={cfg.enabled ? "켜짐" : "꺼짐"}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${cfg.enabled ? "left-[18px]" : "left-0.5"}`} />
                  </button>
                </div>
                <div className="flex items-center justify-between mt-2 gap-2">
                  {rule.hasThreshold ? (
                    <label className="flex items-center gap-1.5 text-[11px] font-bold text-[#718096]">
                      기준
                      <input
                        type="number"
                        min={0}
                        value={cfg.threshold ?? rule.defaultThreshold ?? 0}
                        onChange={(e) => setThreshold(rule.id, Number(e.target.value))}
                        onBlur={() => persistConfig(ruleConfig)}
                        disabled={!cfg.enabled}
                        className="w-14 border border-[#E2E8F0] rounded-md px-2 py-1 text-[12px] text-[#1A202C] outline-none focus:border-[#3182CE] disabled:bg-[#EDF2F7]"
                      />
                      {rule.unit}
                    </label>
                  ) : (
                    <span className="text-[11px] text-[#A0AEC0]">조건형</span>
                  )}
                  {result ? (
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${result.triggered ? "bg-[#FFF5F5] text-[#E53E3E] border border-[#FEB2B2]" : "bg-[#F0FFF4] text-[#38A169] border border-[#C6F6D5]"}`}>
                      {result.triggered ? "조치 필요" : "정상"}
                    </span>
                  ) : (
                    <span className="text-[11px] text-[#CBD5E0] font-bold">미점검</span>
                  )}
                </div>
                {result && <div className="text-[11px] text-[#718096] mt-1.5">{result.detail}</div>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex h-[660px] overflow-hidden">
      {/* Left Sidebar */}
      <div className="w-[340px] shrink-0 border-r border-[#E2E8F0] flex flex-col bg-white z-20">
        <div className="p-5 border-b border-[#E2E8F0] flex justify-between items-center bg-white">
          <h2 className="text-[16px] font-extrabold text-[#1A202C] flex items-center gap-2">오토메이션 <span className="text-[10px] font-bold text-[#718096] bg-[#EDF2F7] px-1.5 py-0.5 rounded">준비중</span></h2>
          <button onClick={() => toast.success("새 워크플로우를 생성합니다.")} className="text-[#4A5568] hover:text-[#1A202C] transition-colors p-1 border border-[#E2E8F0] rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
            <Plus size={18} />
          </button>
        </div>
        
        <div className="p-4 flex-1 overflow-y-auto space-y-6">
          {Array.from(new Set(MOCK_WORKFLOWS.map(w => w.category))).map(category => (
            <div key={category} className="space-y-3">
              <h3 className="text-[11px] font-bold text-[#A0AEC0] px-1">{category}</h3>
              {MOCK_WORKFLOWS.filter(w => w.category === category).map((wf) => (
                <button 
                  key={wf.id}
                  onClick={() => { setSelectedWf(wf.id); setSelectedNode(null); }}
                  className={`w-full text-left p-4 rounded-xl transition-all border outline-none ${selectedWf === wf.id ? 'bg-[#F7FAFC] border-[#CBD5E0] shadow-sm' : 'border-transparent hover:border-[#E2E8F0] hover:bg-[#F7FAFC]'}`}
                >
                  <div className="flex justify-between items-start mb-2">
                    <div className="text-[13px] font-bold text-[#1A202C] leading-snug">{wf.name}</div>
                    <span className={`w-2 h-2 mt-1 shrink-0 rounded-full ${wf.status === 'active' ? 'bg-[#38A169]' : 'bg-[#A0AEC0]'}`}></span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] font-medium text-[#718096]">
                    <span>실행: <b>{wf.runs}</b>회</span>
                    <span>성공률: <b>{wf.success}</b></span>
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Right Canvas */}
      <div className="flex-1 flex flex-col relative bg-[#EEF1F5]">
        {/* Top bar inside Canvas */}
        <div className="h-[65px] bg-white border-b border-[#E2E8F0] px-6 flex items-center justify-between shrink-0 shadow-sm z-10">
          <div className="flex items-center gap-4">
            <h1 className="text-[16px] font-bold text-[#1A202C]">{selectedWorkflow.name}</h1>
            <span className={`border text-[11px] font-bold px-2 py-0.5 rounded-md flex items-center gap-1.5 ${selectedWorkflow.status === 'active' ? 'bg-[#F0FFF4] text-[#38A169] border-[#C6F6D5]' : 'bg-[#EDF2F7] text-[#718096] border-[#E2E8F0]'}`}>
              {selectedWorkflow.status === 'active' ? <><span className="w-1.5 h-1.5 rounded-full bg-[#38A169] animate-pulse"></span> Active</> : 'Paused'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-[11.5px] text-[#A0AEC0] font-medium mr-2 flex flex-col text-right">
              <span>최근 실행: {selectedWorkflow.lastRun}</span>
            </div>
            <button onClick={() => toast.success("해당 워크플로우 강제 실행(Test Run)이 시작되었습니다.")} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-bold text-[#4A5568] border border-[#E2E8F0] hover:bg-[#F7FAFC] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
              <Play size={14} /> 강제 실행
            </button>
            <button onClick={() => toast.success("워크플로우 설정이 저장되었습니다.")} className="flex items-center gap-1.5 bg-[#1A202C] hover:bg-[#2D3748] text-white px-4 py-2 rounded-lg text-[13px] font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#1A202C]">
              <Save size={16} /> 배포하기
            </button>
          </div>
        </div>

        <div className="px-6 pt-4 bg-[#EEF1F5]">
          <DemoBanner variant="soon" note="워크플로우 빌더는 화면 미리보기입니다. 실행·성공률·배포는 예시이며 실제 자동화 엔진은 연동 전입니다." />
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Canvas Area */}
          <div className="flex-1 overflow-auto relative p-12 flex justify-center bg-[#EEF1F5] background-dots" onClick={() => setSelectedNode(null)}>
            <AnimatePresence mode="wait">
              <motion.div key={selectedWf} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={{ duration: 0.2 }}>
                {renderWorkflowCanvas()}
              </motion.div>
            </AnimatePresence>
          </div>
          
          {/* Property Panel (Shows when a node is clicked) */}
          <AnimatePresence>
            {selectedNode && (
              <motion.div initial={{ x: 320, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 320, opacity: 0 }} className="w-[320px] bg-white border-l border-[#E2E8F0] flex flex-col shadow-[-4px_0_15px_rgba(0,0,0,0.03)] z-20">
                <div className="p-5 border-b border-[#E2E8F0] flex items-center justify-between bg-[#F7FAFC]">
                  <h3 className="text-[14px] font-bold text-[#1A202C]">노드 설정 속성</h3>
                  <button onClick={() => setSelectedNode(null)} className="p-1 text-[#A0AEC0] hover:bg-[#EDF2F7] rounded-md outline-none"><X size={18} /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-5 text-[13px] text-[#4A5568]">
                  <div className="space-y-5">
                    <div>
                      <label className="block text-[12px] font-bold text-[#718096] mb-1.5">노드 이름 (라벨)</label>
                      <input type="text" className="w-full border border-[#E2E8F0] rounded-lg px-3 py-2 outline-none focus:border-[#3182CE] text-[13px]" defaultValue="대화형 스크리닝 알림톡 발송" />
                    </div>
                    <div>
                      <label className="block text-[12px] font-bold text-[#718096] mb-1.5">연동 템플릿</label>
                      <select className="w-full border border-[#E2E8F0] rounded-lg px-3 py-2 outline-none focus:border-[#3182CE] text-[13px] bg-white">
                        <option>배달 파트너 필수 요건 확인 폼</option>
                        <option>일반 파트타이머 스크리닝 폼</option>
                      </select>
                    </div>
                    <div className="pt-4 border-t border-[#E2E8F0]">
                      <div className="text-[12px] font-bold text-[#718096] mb-2">데이터 매핑 (변수)</div>
                      <div className="bg-[#F7FAFC] p-3 rounded-lg border border-[#E2E8F0] text-[12px] font-mono">
                        {"{"} "지원자명": "$candidate.name" {"}"}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="p-4 border-t border-[#E2E8F0] bg-white">
                  <button onClick={() => toast.success("노드 설정이 임시 저장되었습니다.")} className="w-full bg-[#E2E8F0] hover:bg-[#CBD5E0] text-[#1A202C] rounded-lg py-2.5 text-[13px] font-bold transition-colors outline-none">노드 설정 저장</button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <style>{`.background-dots { background-image: radial-gradient(#CBD5E0 1px, transparent 1px); background-size: 20px 20px; }`}</style>
      </div>
      </div>
    </div>
  );
}