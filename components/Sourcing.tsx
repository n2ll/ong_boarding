import { useState } from "react";
import { Plus, Link2, Sparkles, Target, Users, Download, Megaphone, Map, Send, X, Smartphone, DollarSign, Lock, PieChart as PieChartIcon, TrendingUp, BarChart2, Briefcase, ChevronDown, CheckCircle2, User, Activity, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";

export function Sourcing() {
  const [activeTab, setActiveTab] = useState<"dashboard" | "ab_test" | "crm_retarget" | "offline_heatmap">("dashboard");
  
  // Modals state
  const [retargetModalOpen, setRetargetModalOpen] = useState(false);
  const [addChannelModalOpen, setAddChannelModalOpen] = useState(false);
  const [newCampaignModalOpen, setNewCampaignModalOpen] = useState(false);
  const [budgetModalOpen, setBudgetModalOpen] = useState(false);

  // Campaign Creation State
  const [targetingMode, setTargetingMode] = useState<"auto" | "manual">("auto");

  const handleAction = (msg: string) => {
    toast.success(msg, { action: { label: '실행 취소', onClick: () => toast.info('작업이 취소되었습니다.') } });
  };

  return (
    <div className="p-8 pb-12 flex flex-col max-w-[1400px] mx-auto h-full overflow-y-auto scrollbar-custom bg-[#F7FAFC]">
      {/* Header */}
      <div className="mb-6 flex justify-between items-end shrink-0">
        <div>
          <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1 flex items-center gap-2">마케팅 캠페인 및 매체 관리 <span className="text-[11px] font-bold text-[#718096] bg-[#EDF2F7] px-2 py-0.5 rounded align-middle">준비중</span></h1>
          <p className="text-[14px] text-[#718096]">구인 공고를 여러 매체에 캠페인으로 배포하고, 예산 대비 획득 단가(CPA)를 최적화합니다.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setAddChannelModalOpen(true)} className="flex items-center gap-1.5 px-4 py-2 bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] rounded-lg text-[13px] font-bold text-[#4A5568] transition-colors shadow-sm outline-none">
            <Link2 size={16} /> 매체 연동
          </button>
          <button onClick={() => setBudgetModalOpen(true)} className="flex items-center gap-1.5 px-4 py-2 bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] rounded-lg text-[13px] font-bold text-[#4A5568] transition-colors shadow-sm outline-none">
            <DollarSign size={16} /> 총괄 예산 관리
          </button>
          <button onClick={() => setNewCampaignModalOpen(true)} className="flex items-center gap-1.5 px-4 py-2 bg-[#1A202C] hover:bg-[#2D3748] rounded-lg text-[13px] font-bold text-white transition-colors shadow-sm outline-none">
            <Megaphone size={16} /> 새 마케팅 캠페인 생성
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-[#E2E8F0] shrink-0">
        {[
          { id: "dashboard", label: "캠페인 성과 리포트", icon: BarChart2 },
          { id: "ab_test", label: "A/B 테스트 현황", icon: Target },
          { id: "crm_retarget", label: "CRM 리타겟팅", icon: Users },
          { id: "offline_heatmap", label: "오프라인 QR 히트맵", icon: Map },
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id as any)} className={`flex items-center gap-2 px-4 py-3 text-[14px] font-bold transition-all border-b-2 outline-none ${activeTab === tab.id ? "border-[#FFCB3C] text-[#1A202C]" : "border-transparent text-[#718096] hover:text-[#4A5568]"}`}>
            <tab.icon size={16} /> {tab.label}
          </button>
        ))}
      </div>

      {/* 1. Dashboard Tab */}
      {activeTab === "dashboard" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-6">
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-white border border-[#E2E8F0] p-5 rounded-2xl shadow-sm flex flex-col justify-between h-[120px]">
              <div className="flex items-center justify-between text-[#718096] font-bold text-[12.5px]"><span>총 누적 소진액 (이번 달)</span></div>
              <div><div className="text-[24px] font-extrabold text-[#1A202C] tracking-tight">₩ 2,750,000</div><div className="text-[12px] text-[#A0AEC0] mt-1 font-medium">예산 소진율 68%</div></div>
            </div>
            <div className="bg-white border border-[#E2E8F0] p-5 rounded-2xl shadow-sm flex flex-col justify-between h-[120px]">
              <div className="flex items-center justify-between text-[#718096] font-bold text-[12.5px]"><span>활성 캠페인</span> <span className="text-[#38A169] bg-[#F0FFF4] px-2 py-0.5 rounded-md text-[11px] font-bold border border-[#C6F6D5]">운영 중</span></div>
              <div><div className="text-[24px] font-extrabold text-[#1A202C] tracking-tight">12<span className="text-[14px] font-medium text-[#A0AEC0] ml-1">건</span></div><div className="text-[12px] text-[#A0AEC0] mt-1 font-medium">총 4개 매체 노출 중</div></div>
            </div>
            <div className="bg-white border border-[#E2E8F0] p-5 rounded-2xl shadow-sm flex flex-col justify-between h-[120px]">
              <div className="flex items-center justify-between text-[#718096] font-bold text-[12.5px]"><span>획득 리드 (지원자 수)</span> <TrendingUp size={16} className="text-[#38A169]"/></div>
              <div><div className="text-[24px] font-extrabold text-[#1A202C] tracking-tight">342<span className="text-[14px] font-medium text-[#A0AEC0] ml-1">명</span></div><div className="text-[12px] text-[#38A169] mt-1 font-bold">+15% vs 지난달</div></div>
            </div>
            <div className="bg-gradient-to-br from-[#1A202C] to-[#2D3748] border border-[#1A202C] p-5 rounded-2xl shadow-md text-white flex flex-col justify-between h-[120px] relative overflow-hidden">
              <div className="absolute right-[-20px] bottom-[-20px] opacity-10"><PieChartIcon size={100} /></div>
              <div className="flex items-center justify-between text-white/70 font-bold text-[12.5px] relative z-10"><span>평균 전환 단가 (CPA)</span></div>
              <div className="relative z-10"><div className="text-[24px] font-extrabold text-[#FFCB3C] tracking-tight">₩ 5,200</div><div className="text-[12px] text-white/60 mt-1 font-medium">목표 CPA(₩8,000) 대비 초과 달성</div></div>
            </div>
          </div>

          <div className="grid grid-cols-[1fr_350px] gap-6">
            <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-sm overflow-hidden flex flex-col">
              <div className="p-5 border-b border-[#E2E8F0] flex justify-between items-center bg-[#F7FAFC]">
                <h2 className="text-[15px] font-bold text-[#1A202C]">진행 중인 캠페인 성과</h2>
                <select className="border border-[#E2E8F0] rounded-lg px-3 py-1.5 text-[12px] font-medium text-[#4A5568] bg-white outline-none"><option>전체 매체</option><option>Meta Ads</option><option>당근알바</option></select>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-white border-b border-[#E2E8F0]">
                      <th className="px-4 py-3 text-[12px] font-bold text-[#718096]">캠페인명 / 연결 공고</th>
                      <th className="px-4 py-3 text-[12px] font-bold text-[#718096]">송출 매체</th>
                      <th className="px-4 py-3 text-[12px] font-bold text-[#718096] text-right">소진액</th>
                      <th className="px-4 py-3 text-[12px] font-bold text-[#718096] text-right">CPA</th>
                      <th className="px-4 py-3 text-[12px] font-bold text-[#718096] text-center">상태</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1F4F8]">
                    {[
                      { name: "[송파] 야간 특별단가", job: "비마트 송파점", channel: "Meta Ads, 당근", spend: "1,250,000", cpa: 6940, status: "active" },
                      { name: "강남권 파트장 모집", job: "비마트 강남점", channel: "알바몬", spend: "850,000", cpa: 11330, status: "active" },
                      { name: "복귀 프로모션", job: "크루 복귀", channel: "CRM 알림톡", spend: "50,000", cpa: 1190, status: "active" },
                      { name: "자전거 상시모집", job: "비마트 마포점", channel: "Meta Ads", spend: "600,000", cpa: 13330, status: "warning" }
                    ].map((row, i) => (
                      <tr key={i} className="hover:bg-[#F7FAFC] transition-colors group">
                        <td className="px-4 py-3.5"><div className="text-[13px] font-bold text-[#1A202C]">{row.name}</div><div className="text-[11px] text-[#A0AEC0] mt-0.5">{row.job}</div></td>
                        <td className="px-4 py-3.5"><span className="inline-block text-[11px] font-medium text-[#4A5568] bg-[#EDF2F7] px-2 py-1 rounded">{row.channel}</span></td>
                        <td className="px-4 py-3.5 text-right text-[13px] font-medium text-[#4A5568]">₩{row.spend}</td>
                        <td className="px-4 py-3.5 text-right"><span className={`text-[13px] font-extrabold ${row.cpa > 10000 ? 'text-[#E53E3E]' : 'text-[#38A169]'}`}>₩{row.cpa.toLocaleString()}</span></td>
                        <td className="px-4 py-3.5 text-center">{row.status === 'active' ? <span className="w-2.5 h-2.5 rounded-full bg-[#38A169] inline-block"></span> : <span className="w-2.5 h-2.5 rounded-full bg-[#E53E3E] inline-block animate-pulse"></span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div className="bg-[#FFFDF5] border border-[#FDE68A] rounded-2xl p-5 flex flex-col shadow-sm">
                <div className="flex items-center gap-2 mb-3"><Sparkles size={18} className="text-[#D69E2E]" /><h3 className="text-[14px] font-bold text-[#B7791F]">AI 예산 최적화 제안</h3></div>
                <div className="text-[13px] text-[#975A16] leading-relaxed mb-4">현재 <span className="font-bold border-b border-[#D69E2E]">상시모집 캠페인</span>의 단가(₩13,330)가 초과했습니다. 예산을 <b>Meta Ads(송파)</b>로 이관 시 이번 주 <b>약 28명 추가 획득</b>이 예상됩니다.</div>
                <button onClick={() => handleAction("캠페인 예산이 최적화 비율로 재배분되었습니다.")} className="bg-[#D69E2E] hover:bg-[#B7791F] text-white py-2.5 rounded-xl text-[13px] font-bold outline-none">원클릭 예산 최적화</button>
              </div>
              <div className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm flex-1">
                <h3 className="text-[14px] font-bold text-[#1A202C] mb-4">매체별 누적 CPA</h3>
                <div className="space-y-4">
                  {[{ name: "Meta Ads", cpa: 4130, color: "bg-[#3182CE]", pct: "40%" }, { name: "당근알바", cpa: 6940, color: "bg-[#DD6B20]", pct: "65%" }, { name: "알바몬", cpa: 11330, color: "bg-[#ECC94B]", pct: "100%" }].map((ch, i) => (
                    <div key={i}><div className="flex justify-between text-[12px] mb-1.5"><span className="font-bold text-[#4A5568]">{ch.name}</span><span className="font-medium text-[#718096]">₩{ch.cpa.toLocaleString()}</span></div><div className="h-2 w-full bg-[#F1F4F8] rounded-full overflow-hidden"><div className={`h-full ${ch.color} rounded-full`} style={{ width: ch.pct }}></div></div></div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* 2. A/B Testing Tab */}
      {activeTab === "ab_test" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-6">
          <div className="bg-white p-6 border border-[#E2E8F0] rounded-2xl shadow-sm flex items-center justify-between">
            <div><h2 className="text-[18px] font-extrabold text-[#1A202C]">공고 A/B 테스트 현황</h2><p className="text-[13.5px] text-[#718096] mt-1">동일한 공고를 2개의 다른 소구점으로 테스트합니다.</p></div>
            <button onClick={() => toast.success("새 A/B 테스트 생성 모달이 열립니다.")} className="flex items-center gap-1.5 bg-[#FFCB3C] text-[#1A202C] px-4 py-2.5 rounded-xl text-[14px] font-bold outline-none"><Plus size={16} /> 테스트 생성</button>
          </div>
          <div className="bg-white border border-[#E2E8F0] rounded-2xl p-6 shadow-sm relative overflow-hidden">
            <div className="flex items-center justify-between mb-6 border-b border-[#E2E8F0] pb-4">
              <div><h3 className="text-[16px] font-bold text-[#1A202C]">[강남권] 도보 배달 크루 모집 캠페인</h3><span className="inline-block mt-2 text-[12px] font-bold bg-[#EBF8FF] text-[#3182CE] px-2 py-1 rounded-md border border-[#BEE3F8]">테스트 진행 중 (2일차)</span></div>
            </div>
            <div className="grid grid-cols-2 gap-8 relative">
              <div className="absolute left-1/2 top-0 bottom-0 w-px border-l border-dashed border-[#CBD5E0]"></div>
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white border border-[#E2E8F0] px-3 py-1.5 rounded-full text-[12px] font-extrabold text-[#718096] shadow-sm z-10">VS</div>
              <div className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl p-5 hover:border-[#FFCB3C] cursor-pointer group" onClick={() => handleAction("A안을 선택했습니다.")}>
                <div className="flex justify-between mb-4"><span className="w-8 h-8 rounded-full bg-[#1A202C] text-white flex items-center justify-center font-bold">A</span><span className="text-[12px] text-[#A0AEC0]">건강 강조</span></div>
                <div className="bg-white border border-[#E2E8F0] p-4 rounded-lg mb-5 shadow-sm"><h4 className="text-[15px] font-bold text-[#1A202C] mb-2">"동네 마실하듯 걸으며 용돈 벌어보실래요?"</h4></div>
                <div className="grid grid-cols-3 gap-4">
                  <div><div className="text-[11px] text-[#718096]">CTR</div><div className="text-[15px] font-extrabold">2.4%</div></div>
                  <div><div className="text-[11px] text-[#718096]">Leads</div><div className="text-[15px] font-extrabold">18명</div></div>
                  <div><div className="text-[11px] text-[#718096]">CPA</div><div className="text-[15px] font-extrabold text-[#E53E3E]">₩5,500</div></div>
                </div>
              </div>
              <div className="bg-[#FFFDF5] border-2 border-[#FFCB3C] rounded-xl p-5 relative cursor-pointer group shadow-sm" onClick={() => handleAction("B안을 선택했습니다.")}>
                <div className="absolute -top-3 -right-3 bg-[#E53E3E] text-white text-[11px] font-bold px-3 py-1 rounded-full shadow-md animate-pulse">승리 예상</div>
                <div className="flex justify-between mb-4"><span className="w-8 h-8 rounded-full bg-[#FFCB3C] text-[#1A202C] flex items-center justify-center font-bold">B</span><span className="text-[12px] text-[#A0AEC0]">수익 강조</span></div>
                <div className="bg-white border border-[#E2E8F0] p-4 rounded-lg mb-5 shadow-sm"><h4 className="text-[15px] font-bold text-[#1A202C] mb-2">"[주급지급] 하루 3시간 걷고 주 15만원 벌기"</h4></div>
                <div className="grid grid-cols-3 gap-4">
                  <div><div className="text-[11px] text-[#718096]">CTR</div><div className="text-[15px] font-extrabold text-[#38A169]">4.8%</div></div>
                  <div><div className="text-[11px] text-[#718096]">Leads</div><div className="text-[15px] font-extrabold text-[#1A202C]">42명</div></div>
                  <div><div className="text-[11px] text-[#718096]">CPA</div><div className="text-[15px] font-extrabold text-[#38A169]">₩2,380</div></div>
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-center">
              <button onClick={() => handleAction("B안에 예산이 전액 할당되었습니다.")} className="bg-[#1A202C] text-white px-6 py-3 rounded-xl text-[14px] font-bold hover:bg-[#2D3748] flex items-center gap-2 shadow-md outline-none">
                <Sparkles size={16} className="text-[#FFCB3C]" /> 승리 예상 B안에 예산 100% 자동 할당
              </button>
            </div>
          </div>
        </motion.div>
      )}

      {/* 3. CRM Retargeting Tab */}
      {activeTab === "crm_retarget" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-6">
          <div className="bg-white p-6 border border-[#E2E8F0] rounded-2xl shadow-sm">
            <div className="mb-6"><h2 className="text-[18px] font-extrabold text-[#1A202C]">휴면 인력 CRM 캠페인</h2><p className="text-[13.5px] text-[#718096] mt-1">기존 DB를 세그먼트화하여 가장 저렴한 비용으로 우수 인력을 리타겟팅합니다.</p></div>
            <div className="grid grid-cols-3 gap-5">
              {[{ title: "작년 겨울 우수 근무자", target: 452, color: "text-[#3182CE]", bg: "bg-[#EBF8FF]" }, { title: "최종 면접 탈락자", target: 128, color: "text-[#D69E2E]", bg: "bg-[#FEFCBF]" }, { title: "지원서 중단자", target: 890, color: "text-[#E53E3E]", bg: "bg-[#FFF5F5]" }].map((crm, i) => (
                <div key={i} className="border border-[#E2E8F0] rounded-xl p-5 hover:shadow-md transition-shadow bg-white flex flex-col group">
                  <div className={`w-12 h-12 rounded-xl ${crm.bg} flex items-center justify-center mb-4 group-hover:scale-105 transition-transform`}><Users size={22} className={crm.color} /></div>
                  <h3 className="text-[16px] font-bold text-[#1A202C] mb-4">{crm.title}</h3>
                  <div className="mt-auto pt-4 border-t border-[#F1F4F8] flex items-center justify-between">
                    <div><div className="text-[11px] text-[#A0AEC0] mb-0.5">타겟 대상</div><div className="text-[18px] font-extrabold text-[#1A202C]">{crm.target}<span className="text-[13px] font-medium text-[#718096] ml-0.5">명</span></div></div>
                    <button onClick={() => setRetargetModalOpen(true)} className="bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] text-[#1A202C] px-4 py-2 rounded-lg text-[13px] font-bold shadow-sm outline-none">캠페인 실행</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}

      {/* 4. Offline Heatmap Tab */}
      {activeTab === "offline_heatmap" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-6 h-[600px] relative">
          <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-sm flex flex-col h-full overflow-hidden relative">
            <div className="p-6 border-b border-[#E2E8F0] z-20 bg-white"><h2 className="text-[18px] font-extrabold text-[#1A202C]">오프라인 전단/현수막 QR 히트맵</h2></div>
            <div className="flex-1 relative overflow-hidden bg-[#e5e3df] blur-md select-none pointer-events-none opacity-50">
              <div className="absolute inset-0 opacity-40 mix-blend-multiply" style={{ backgroundImage: `url('https://images.unsplash.com/photo-1524661135-423995f22d0b?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&q=80')`, backgroundSize: 'cover' }}></div>
            </div>
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-white/40 backdrop-blur-[6px]">
              <div className="w-16 h-16 bg-[#1A202C] rounded-2xl flex items-center justify-center text-white mb-5 shadow-xl"><Lock size={28} /></div>
              <h3 className="text-[22px] font-extrabold text-[#1A202C] tracking-tight mb-2">기능 준비중</h3>
              <p className="text-[14.5px] text-[#4A5568] text-center max-w-[400px]">지도 기반 QR 히트맵 기능이 곧 업데이트 됩니다.</p>
              <button onClick={() => toast.success("업데이트 알림 예약이 완료되었습니다.")} className="mt-6 px-6 py-2.5 bg-white border border-[#E2E8F0] rounded-xl text-[14px] font-bold text-[#4A5568] hover:bg-[#F7FAFC] shadow-sm outline-none">업데이트 알림 받기</button>
            </div>
          </div>
        </motion.div>
      )}

      {/* MODALS */}
      {/* Add Channel Modal */}
      {addChannelModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white w-[500px] rounded-2xl shadow-xl overflow-hidden">
            <div className="p-5 border-b border-[#E2E8F0] flex justify-between bg-[#F7FAFC]"><h2 className="text-[16px] font-bold">매체 연동</h2><button onClick={() => setAddChannelModalOpen(false)}><X size={20}/></button></div>
            <div className="p-6 space-y-5">
              <div><label className="text-[13px] font-bold mb-2 block">플랫폼 선택</label><select className="w-full border border-[#E2E8F0] rounded-xl p-3 outline-none"><option>당근알바</option><option>Meta Ads</option></select></div>
              <div><label className="text-[13px] font-bold mb-2 block">API Key</label><input type="password" placeholder="키 입력" className="w-full border border-[#E2E8F0] rounded-xl p-3 outline-none" /></div>
            </div>
            <div className="p-5 border-t border-[#E2E8F0] flex justify-end gap-2"><button onClick={() => setAddChannelModalOpen(false)} className="px-5 py-2.5 font-bold text-[#718096]">취소</button><button onClick={() => { setAddChannelModalOpen(false); toast.success("매체 연동 성공!"); }} className="px-5 py-2.5 bg-[#1A202C] text-white rounded-xl font-bold">연동하기</button></div>
          </motion.div>
        </div>
      )}

      {/* New Campaign Modal */}
      {newCampaignModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white w-[800px] rounded-2xl shadow-xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-[#E2E8F0] flex justify-between bg-[#F7FAFC]"><h2 className="text-[16px] font-bold">신규 마케팅 캠페인 생성</h2><button onClick={() => setNewCampaignModalOpen(false)}><X size={20}/></button></div>
            <div className="p-6 overflow-y-auto space-y-8 flex-1">
              <section><h3 className="font-bold mb-4">1. 연결 공고</h3><input type="text" placeholder="캠페인 이름" className="w-full border rounded-xl p-3 mb-3 outline-none" /><select className="w-full border rounded-xl p-3 outline-none"><option>비마트 송파점 야간 파트너</option></select></section>
              <section><h3 className="font-bold mb-4">2. 송출 매체</h3><div className="grid grid-cols-3 gap-3">{['당근알바', '알바몬', 'Meta Ads'].map(ch => <label key={ch} className="p-3 border rounded-xl flex items-center gap-2"><input type="checkbox" defaultChecked className="accent-[#1A202C]"/><span className="text-[13px] font-bold">{ch}</span></label>)}</div></section>
              <section>
                <div className="flex justify-between mb-4"><h3 className="font-bold">3. 타겟팅 설정</h3><div className="flex bg-[#F1F4F8] p-1 rounded-lg"><button onClick={() => setTargetingMode("auto")} className={`px-3 py-1 text-[12px] font-bold rounded-md ${targetingMode === "auto" ? "bg-white shadow-sm" : ""}`}>AI 자동</button><button onClick={() => setTargetingMode("manual")} className={`px-3 py-1 text-[12px] font-bold rounded-md ${targetingMode === "manual" ? "bg-white shadow-sm" : ""}`}>수동 상세</button></div></div>
                {targetingMode === "auto" ? <div className="bg-[#EBF8FF] p-4 rounded-xl text-[13px] text-[#2B6CB0]">AI가 공고를 분석하여 송파구 반경 5km, 2040 남성을 타겟팅합니다.</div> : <div className="border p-4 rounded-xl text-[13px]"><select className="w-full border p-2 rounded mb-3"><option>반경 3km</option></select><select className="w-full border p-2 rounded"><option>20~40대</option></select></div>}
              </section>
              <section><h3 className="font-bold mb-4">4. 예산</h3><input type="text" placeholder="₩ 500,000" className="w-full border rounded-xl p-3 outline-none" /></section>
            </div>
            <div className="p-5 border-t border-[#E2E8F0] flex justify-end gap-2 bg-[#F7FAFC]"><button onClick={() => setNewCampaignModalOpen(false)} className="px-5 py-2.5 font-bold text-[#718096]">취소</button><button onClick={() => { setNewCampaignModalOpen(false); toast.success("캠페인이 시작되었습니다."); }} className="px-6 py-2.5 bg-[#FFCB3C] text-[#1A202C] rounded-xl font-bold flex items-center gap-2"><Megaphone size={16}/> 라이브하기</button></div>
          </motion.div>
        </div>
      )}

      {/* Budget Modal */}
      {budgetModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white w-[600px] rounded-2xl shadow-xl overflow-hidden">
            <div className="p-5 border-b border-[#E2E8F0] flex justify-between bg-[#F7FAFC]"><h2 className="text-[16px] font-bold">예산 상세 관리</h2><button onClick={() => setBudgetModalOpen(false)}><X size={20}/></button></div>
            <div className="p-6 space-y-4">
              {[{ n: "당근알바", v: 40 }, { n: "Meta Ads", v: 35 }, { n: "알바몬", v: 25 }].map((item, i) => (
                <div key={i} className="border p-4 rounded-xl flex items-center justify-between"><span className="font-bold text-[14px] w-24">{item.n}</span><input type="range" defaultValue={item.v} className="flex-1 mx-4 accent-[#FFCB3C]"/><span className="font-bold">{item.v}%</span></div>
              ))}
            </div>
            <div className="p-5 border-t border-[#E2E8F0] flex justify-between items-center"><span className="text-[13px] font-bold text-[#38A169]">AI 비율 적용됨</span><button onClick={() => { setBudgetModalOpen(false); toast.success("예산이 저장되었습니다."); }} className="px-6 py-2.5 bg-[#1A202C] text-white rounded-xl font-bold">저장하기</button></div>
          </motion.div>
        </div>
      )}

      {/* Retarget Modal */}
      {retargetModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white w-[500px] rounded-2xl shadow-xl overflow-hidden">
            <div className="p-5 border-b border-[#E2E8F0] flex justify-between bg-[#F7FAFC]"><h2 className="text-[16px] font-bold">CRM 알림톡 발송</h2><button onClick={() => setRetargetModalOpen(false)}><X size={20}/></button></div>
            <div className="p-6"><textarea className="w-full h-32 border rounded-xl p-4 outline-none resize-none text-[13.5px]" defaultValue="[비마트 강남점] 옹보딩님!\n우수 크루 복귀 보너스 5만원 이벤트를 진행합니다." /></div>
            <div className="p-5 border-t flex justify-between items-center"><span className="text-[13px] font-bold text-[#718096]">비용: ₩6,780</span><button onClick={() => { setRetargetModalOpen(false); toast.success("알림톡 발송 시작!"); }} className="px-6 py-2.5 bg-[#FFCB3C] rounded-xl font-bold flex items-center gap-2"><Send size={16}/> 일괄 발송</button></div>
          </motion.div>
        </div>
      )}
    </div>
  );
}