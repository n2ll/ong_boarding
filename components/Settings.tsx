import { useState } from "react";
import { Save, Bell, Lock, User, Link as LinkIcon } from "lucide-react";
import { toast } from "sonner";

export function Settings() {
  const [activeTab, setActiveTab] = useState("profile");

  const handleSave = () => {
    toast.success("설정이 저장되었습니다.");
  };

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
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
        </div>

        {/* Content Area */}
        <div className="flex-1 bg-white border border-[#E2E8F0] rounded-2xl shadow-sm p-8">
          {activeTab === 'profile' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-[#1A202C] mb-6 border-b border-[#E2E8F0] pb-4">기본 정보</h2>
              
              <div className="space-y-6 max-w-md">
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">이름</label>
                  <input type="text" defaultValue="정현강" className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">이메일 (로그인 ID)</label>
                  <input type="email" disabled defaultValue="hk.jung@ongboarding.com" className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm bg-[#F7FAFC] text-[#A0AEC0] cursor-not-allowed" />
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">연락처</label>
                  <input type="tel" defaultValue="010-1234-5678" className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                </div>

                <div className="pt-6">
                  <button onClick={handleSave} className="flex items-center gap-2 bg-[#1A202C] hover:bg-[#2D3748] text-white px-6 py-2.5 rounded-xl font-bold transition-colors">
                    <Save size={16} /> 변경사항 저장
                  </button>
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
                  <button onClick={handleSave} className="bg-white border border-[#E2E8F0] text-[#1A202C] hover:bg-[#F7FAFC] px-6 py-2.5 rounded-xl font-bold transition-colors shadow-sm">
                    비밀번호 변경
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'integrations' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-[#1A202C] mb-6 border-b border-[#E2E8F0] pb-4">외부 서비스 연동</h2>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-5 border border-[#E2E8F0] rounded-xl flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-[#FAE100] rounded-lg flex items-center justify-center text-[#371D1E] font-bold">K</div>
                    <div>
                      <div className="text-[14px] font-bold text-[#1A202C]">카카오 알림톡 연동</div>
                      <div className="text-[12px] text-[#718096] mt-0.5">지원자 면접 안내 발송용</div>
                    </div>
                  </div>
                  <button className="px-3 py-1.5 text-[12px] font-bold bg-[#F1F4F8] text-[#4A5568] rounded-lg">연동됨</button>
                </div>
                <div className="p-5 border border-[#E2E8F0] rounded-xl flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-[#00C471] rounded-lg flex items-center justify-center text-white font-bold">N</div>
                    <div>
                      <div className="text-[14px] font-bold text-[#1A202C]">네이버 웍스 (메신저)</div>
                      <div className="text-[12px] text-[#718096] mt-0.5">사내 채용팀 알림 수신용</div>
                    </div>
                  </div>
                  <button className="px-3 py-1.5 text-[12px] font-bold bg-[#1A202C] text-white hover:bg-[#2D3748] rounded-lg transition-colors">연동하기</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}