import { useState, useEffect } from "react";
import useSWR from "swr";
import { Save, Bell, Lock, User, Link as LinkIcon, CheckCircle2, AlertCircle, Loader2, Building2 } from "lucide-react";
import { DemoBanner } from "./DemoBanner";
import { Clients } from "./Clients";

interface Integration {
  key: string;
  configured: boolean;
  kakao_ready?: boolean;
  required: string[];
}

const INTEGRATION_META: Record<string, { name: string; desc: string; badge: string; badgeColor: string }> = {
  claude: { name: "Claude (AI 에이전트)", desc: "응대·스크리닝·공고 생성용 LLM", badge: "AI", badgeColor: "bg-[#1A202C] text-white" },
  solapi: { name: "SOLAPI (문자·알림톡)", desc: "지원자 SMS / 카카오 알림톡 발송", badge: "SMS", badgeColor: "bg-[#FAE100] text-[#371D1E]" },
  supabase: { name: "Supabase (DB·실시간)", desc: "지원자·메시지 데이터베이스", badge: "DB", badgeColor: "bg-[#3ECF8E] text-white" },
  slack: { name: "Slack 알림", desc: "운영 이벤트 사내 알림", badge: "#", badgeColor: "bg-[#4A154B] text-white" },
  naver_geocode: { name: "네이버 클라우드 (지오코딩)", desc: "주소 → 좌표 변환(거리 매칭)", badge: "N", badgeColor: "bg-[#00C471] text-white" },
};

export function Settings() {
  // 실동작인 '외부 연동' 탭을 기본으로 승격 — 프로필/알림/보안은 인증 도입 전 미리보기.
  const [activeTab, setActiveTab] = useState("integrations");
  // /settings#clients 딥링크 — 다른 화면(예: /shippers 안내 배너)에서 '화주사 관리' 서브탭으로 바로 진입.
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#clients") setActiveTab("clients");
  }, []);
  // 외부 연동 탭을 열 때만 조회(조건부 key), 이후엔 SWR 캐시로 즉시 표시.
  const { data: intData, isLoading: intLoading } = useSWR<{ data?: Integration[] }>(
    activeTab === "integrations" ? "/api/admin/settings/integrations" : null
  );
  const integrations = intData?.data ?? [];

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      <DemoBanner variant="soon" note="프로필·알림·보안 설정은 화면 미리보기입니다(사용자/인증 테이블 도입 후 실저장). 단, ‘외부 연동’ 탭은 실제 서버 연결 상태를 보여줍니다." />
      <div className="mb-8">
        <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1 flex items-center gap-2">설정 <span className="text-[11px] font-bold text-[#718096] bg-[#EDF2F7] px-2 py-0.5 rounded align-middle">준비중</span></h1>
        <p className="text-[14px] text-[#718096]">개인 프로필과 시스템 환경설정을 관리합니다.</p>
      </div>

      <div className="flex gap-8">
        {/* Sidebar Nav */}
        <div className="w-[240px] shrink-0 flex flex-col gap-2">
          <button 
            onClick={() => setActiveTab("profile")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'profile' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <User size={18} /> 프로필 설정
          </button>
          <button 
            onClick={() => setActiveTab("notifications")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'notifications' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <Bell size={18} /> 알림 설정
          </button>
          <button 
            onClick={() => setActiveTab("security")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'security' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <Lock size={18} /> 보안 및 인증
          </button>
          <button
            onClick={() => setActiveTab("integrations")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'integrations' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <LinkIcon size={18} /> 외부 연동
          </button>
          <button
            onClick={() => setActiveTab("clients")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'clients' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <Building2 size={18} /> 화주사 관리
          </button>
        </div>

        {/* Content Area */}
        {activeTab === 'clients' ? (
          <div className="flex-1 min-w-0">
            <Clients embedded />
          </div>
        ) : (
        <div className="flex-1 bg-white border border-[#E2E8F0] rounded-2xl shadow-sm p-8">
          {activeTab === 'profile' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-[#1A202C] mb-6 border-b border-[#E2E8F0] pb-4">기본 정보</h2>
              
              <div className="space-y-6 max-w-md">
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">이름</label>
                  <input type="text" disabled placeholder="인증 도입 후 표시됩니다" className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm bg-[#F7FAFC] text-[#A0AEC0] cursor-not-allowed" />
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">이메일 (로그인 ID)</label>
                  <input type="email" disabled placeholder="인증 도입 후 표시됩니다" className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm bg-[#F7FAFC] text-[#A0AEC0] cursor-not-allowed" />
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">연락처</label>
                  <input type="tel" disabled placeholder="인증 도입 후 표시됩니다" className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm bg-[#F7FAFC] text-[#A0AEC0] cursor-not-allowed" />
                </div>

                <div className="pt-6">
                  <button disabled className="flex items-center gap-2 bg-[#1A202C] text-white px-6 py-2.5 rounded-xl font-bold opacity-50 cursor-not-allowed">
                    <Save size={16} /> 변경사항 저장
                  </button>
                  <p className="text-[12px] text-[#A0AEC0] mt-2">사용자 인증(계정) 도입 후 제공됩니다.</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-[#1A202C] mb-6 border-b border-[#E2E8F0] pb-4">알림 설정</h2>
              <div className="space-y-6 max-w-2xl">
                <div className="flex items-center justify-between p-4 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl">
                  <div>
                    <div className="text-[14px] font-bold text-[#1A202C] mb-1">AI 응대 실패 (Human Takeover) 알림</div>
                    <div className="text-[13px] text-[#718096]">AI가 답변하지 못하거나 지원자가 매니저 연결을 요청할 때 즉시 알림을 받습니다.</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" defaultChecked className="sr-only peer" />
                    <div className="w-11 h-6 bg-[#CBD5E0] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#38A169]"></div>
                  </label>
                </div>
                <div className="flex items-center justify-between p-4 border border-[#E2E8F0] rounded-xl">
                  <div>
                    <div className="text-[14px] font-bold text-[#1A202C] mb-1">신규 지원자 발생 알림</div>
                    <div className="text-[13px] text-[#718096]">새로운 지원서가 접수되었을 때 데일리 리포트 형태로 알림을 받습니다.</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer" />
                    <div className="w-11 h-6 bg-[#CBD5E0] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#38A169]"></div>
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'security' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-[#1A202C] mb-6 border-b border-[#E2E8F0] pb-4">보안 및 인증</h2>
              <div className="space-y-6 max-w-md">
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">현재 비밀번호</label>
                  <input type="password" placeholder="••••••••" className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">새 비밀번호</label>
                  <input type="password" placeholder="영문, 숫자, 특수문자 조합 8자 이상" className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">새 비밀번호 확인</label>
                  <input type="password" placeholder="비밀번호 다시 입력" className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                </div>
                <div className="pt-4">
                  <button disabled className="bg-white border border-[#E2E8F0] text-[#A0AEC0] px-6 py-2.5 rounded-xl font-bold shadow-sm cursor-not-allowed">
                    비밀번호 변경
                  </button>
                  <p className="text-[12px] text-[#A0AEC0] mt-2">사용자 인증(계정) 도입 후 제공됩니다.</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'integrations' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-[#1A202C] mb-1 border-b-0 pb-0">외부 서비스 연동</h2>
              <p className="text-[13px] text-[#718096] mb-6">서버 환경변수 설정 여부로 판단한 실제 연결 상태입니다. (키 값은 표시되지 않습니다)</p>
              {intLoading ? (
                <div className="flex items-center gap-2 text-[#A0AEC0] py-8"><Loader2 size={18} className="animate-spin" /> 연동 상태 확인 중…</div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  {integrations.map((it) => {
                    const meta = INTEGRATION_META[it.key] ?? { name: it.key, desc: "", badge: "?", badgeColor: "bg-[#EDF2F7] text-[#4A5568]" };
                    return (
                      <div key={it.key} className="p-5 border border-[#E2E8F0] rounded-xl flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center font-bold shrink-0 ${meta.badgeColor}`}>{meta.badge}</div>
                          <div className="min-w-0">
                            <div className="text-[14px] font-bold text-[#1A202C] truncate">{meta.name}</div>
                            <div className="text-[12px] text-[#718096] mt-0.5 truncate">{meta.desc}</div>
                            {it.key === "solapi" && it.configured && (
                              <div className={`text-[11px] mt-1 font-bold ${it.kakao_ready ? "text-[#38A169]" : "text-[#D69E2E]"}`}>
                                {it.kakao_ready ? "알림톡(PFID) 준비됨" : "알림톡 PFID 미설정 — SMS만 가능"}
                              </div>
                            )}
                            {!it.configured && (
                              <div className="text-[11px] text-[#A0AEC0] mt-1">필요: {it.required.join(", ")}</div>
                            )}
                          </div>
                        </div>
                        {it.configured ? (
                          <span className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-bold bg-[#F0FFF4] text-[#38A169] border border-[#C6F6D5] rounded-lg shrink-0">
                            <CheckCircle2 size={13} /> 연결됨
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-bold bg-[#FFFAF0] text-[#DD6B20] border border-[#FEEBC8] rounded-lg shrink-0">
                            <AlertCircle size={13} /> 미설정
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}