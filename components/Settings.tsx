import { useState, useEffect } from "react";
import useSWR from "swr";
import { Save, Bell, Lock, User, Link as LinkIcon, CheckCircle2, AlertCircle, Loader2, MapPin, Shield, ToggleRight, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Branches } from "./Branches";
import { Team } from "./Team";
import { useConfirm } from "./ConfirmDialog";

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
  // /settings#branches|#team|#switches 딥링크 — 다른 화면·공고 폼에서 해당 서브탭으로 바로 진입.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const h = window.location.hash;
    // #clients는 화주사 화면을 /shippers로 합치면서 옮겨갔다 — 기존 링크·북마크를 깨지 않게 리다이렉트.
    if (h === "#clients") {
      window.location.replace("/shippers");
      return;
    }
    if (h === "#branches" || h === "#team" || h === "#switches") setActiveTab(h.slice(1));
  }, []);
  // 외부 연동 탭을 열 때만 조회(조건부 key), 이후엔 SWR 캐시로 즉시 표시.
  const { data: intData, isLoading: intLoading } = useSWR<{ data?: Integration[] }>(
    activeTab === "integrations" ? "/api/admin/settings/integrations" : null
  );
  const integrations = intData?.data ?? [];
  // '다시 부르기' 기능 스위치 — 화면은 "스위치를 켜세요"라고 안내하는데 콘솔에 스위치가 없어
  // DB를 직접 고쳐야 했다. 매니저가 여기서 켜고 끈다.
  const confirm = useConfirm();
  const { data: reSwitch, error: switchError, mutate: mutateSwitch, isLoading: switchLoading } = useSWR<{ enabled?: boolean }>(
    activeTab === "switches" ? "/api/admin/reengagement/switch" : null
  );
  const [switchSaving, setSwitchSaving] = useState(false);
  const reEnabled = !!reSwitch?.enabled;
  const toggleReengagement = async () => {
    const next = !reEnabled;
    // 켜는 쪽만 확인 — 과거 인력에게 문자가 나갈 수 있게 되는 결정이다(끄는 건 안전 방향).
    if (next && !(await confirm({
      title: "‘다시 부르기’를 켤까요?",
      description: "옹고잉·옹매니징 배송원 중 옹보딩에 지원하지 않은 분들을 인력풀로 불러올 수 있게 됩니다. 지금 다른 라인에서 일하고 있는 분도 포함되고, 이름·전화번호가 인력풀에 저장돼요. 실제 문자는 인재풀에서 매니저가 보낼 때만 나갑니다. 법적 검토·승인이 끝났는지 확인해 주세요.",
      confirmText: "켜기",
    }))) return;
    setSwitchSaving(true);
    try {
      const res = await fetch("/api/admin/reengagement/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "저장 실패");
      toast.success(next ? "‘다시 부르기’를 켰어요." : "‘다시 부르기’를 껐어요. (편입 잠금 — 미리보기만)");
      void mutateSwitch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSwitchSaving(false);
    }
  };

  return (
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto">
      {/* 페이지 전체에 '준비중' 배너·배지를 달면, 실제로 동작하는 화주사·지점·팀·외부연동까지
          미완성으로 오해된다(채용·확정 전 반드시 세팅해야 하는 것들이 여기 있다).
          준비중 표시는 실제 미완성 탭(프로필·알림·보안)에만 붙인다. */}
      <div className="mb-8">
        <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">설정</h1>
        <p className="text-[14px] text-[#718096]">지점·팀과 외부 연동을 관리합니다. 화주사는 ‘화주사’ 화면에서 관리해요. (프로필·알림·보안은 준비 중)</p>
      </div>

      <div className="flex gap-8">
        {/* Sidebar Nav */}
        <div className="w-[240px] shrink-0 flex flex-col gap-2">
          <button 
            onClick={() => setActiveTab("profile")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'profile' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <User size={18} /> 프로필 설정 <span className="ml-auto text-[10px] font-bold text-[#A0AEC0] bg-[#EDF2F7] px-1.5 py-0.5 rounded shrink-0">준비중</span>
          </button>
          <button 
            onClick={() => setActiveTab("notifications")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'notifications' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <Bell size={18} /> 알림 설정 <span className="ml-auto text-[10px] font-bold text-[#A0AEC0] bg-[#EDF2F7] px-1.5 py-0.5 rounded shrink-0">준비중</span>
          </button>
          <button 
            onClick={() => setActiveTab("security")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'security' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <Lock size={18} /> 보안 및 인증 <span className="ml-auto text-[10px] font-bold text-[#A0AEC0] bg-[#EDF2F7] px-1.5 py-0.5 rounded shrink-0">준비중</span>
          </button>
          <button
            onClick={() => setActiveTab("integrations")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'integrations' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <LinkIcon size={18} /> 외부 연동
          </button>
          <button
            onClick={() => setActiveTab("branches")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'branches' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <MapPin size={18} /> 지점 관리
          </button>
          <button
            onClick={() => setActiveTab("team")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'team' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <Shield size={18} /> 팀 · 권한
          </button>
          <button
            onClick={() => setActiveTab("switches")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${activeTab === 'switches' ? 'bg-white border-2 border-[#1A202C] text-[#1A202C] shadow-sm' : 'border-2 border-transparent text-[#718096] hover:bg-white hover:border-[#E2E8F0]'}`}
          >
            <ToggleRight size={18} /> 기능 스위치
          </button>
        </div>

        {/* Content Area */}
        {(activeTab === 'branches' || activeTab === 'team') ? (
          <div className="flex-1 min-w-0">
            {activeTab === 'branches' && <Branches embedded />}
            {activeTab === 'team' && <Team embedded />}
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
              <h2 className="text-lg font-bold text-[#1A202C] mb-2 border-b border-[#E2E8F0] pb-4">알림 설정</h2>
              {/* 토글이 눈으로는 켜지는데 저장되지 않는 '거짓 어포던스'였다 — 켜둔 줄 알고 알림을 기다리게 된다.
                  저장 경로가 생길 때까지 비활성 + 사유 명시. 실제 운영 알림은 Slack 웹훅으로 나간다. */}
              <p className="text-[12.5px] text-[#B7791F] bg-[#FFFBEC] border border-[#FAF089] rounded-lg px-3 py-2 mb-6">
                아직 저장되지 않는 화면이에요(계정 알림 설정 준비 중). 지금 운영 알림은 Slack으로 받고 있어요.
              </p>
              <div className="space-y-6 max-w-2xl opacity-60">
                <div className="flex items-center justify-between p-4 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl">
                  <div>
                    <div className="text-[14px] font-bold text-[#1A202C] mb-1">AI 응대 실패 (Human Takeover) 알림</div>
                    <div className="text-[13px] text-[#718096]">AI가 답변하지 못하거나 지원자가 매니저 연결을 요청할 때 즉시 알림을 받습니다.</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-not-allowed">
                    <input type="checkbox" defaultChecked disabled className="sr-only peer" />
                    <div className="w-11 h-6 bg-[#CBD5E0] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#38A169]"></div>
                  </label>
                </div>
                <div className="flex items-center justify-between p-4 border border-[#E2E8F0] rounded-xl">
                  <div>
                    <div className="text-[14px] font-bold text-[#1A202C] mb-1">신규 지원자 발생 알림</div>
                    <div className="text-[13px] text-[#718096]">새로운 지원서가 접수되었을 때 데일리 리포트 형태로 알림을 받습니다.</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-not-allowed">
                    <input type="checkbox" disabled className="sr-only peer" />
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
                  <input type="password" disabled placeholder="••••••••" className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm bg-[#F7FAFC] text-[#A0AEC0] cursor-not-allowed" />
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">새 비밀번호</label>
                  <input type="password" disabled placeholder="영문, 숫자, 특수문자 조합 8자 이상" className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm bg-[#F7FAFC] text-[#A0AEC0] cursor-not-allowed" />
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">새 비밀번호 확인</label>
                  <input type="password" disabled placeholder="비밀번호 다시 입력" className="w-full px-4 py-2.5 border border-[#E2E8F0] rounded-xl text-sm bg-[#F7FAFC] text-[#A0AEC0] cursor-not-allowed" />
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

          {activeTab === 'switches' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-[#1A202C] mb-1 border-b border-[#E2E8F0] pb-4">기능 스위치</h2>
              <p className="text-[13px] text-[#718096] mt-4 mb-6">위험할 수 있는 기능을 매니저가 직접 켜고 끕니다.</p>
              <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 max-w-2xl">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-[14px] font-bold text-[#1A202C] mb-1">다시 부르기 (배송원 재편입)</div>
                    <p className="text-[13px] text-[#718096] leading-relaxed">
                      옹고잉·옹매니징 배송원 중 옹보딩 미지원자(지금 일하고 있는 분 포함)를 인력풀로 불러오는 기능이에요. 꺼져 있으면 <b>미리보기만</b> 되고 아무 것도 편입되지 않아요.
                      켜도 문자가 저절로 나가지는 않아요 — 실제 발송은 인재풀에서 매니저가 보낼 때만 됩니다.
                    </p>
                    <p className="text-[12px] text-[#A0AEC0] mt-2">법적 검토·승인이 끝난 뒤에 켜 주세요.</p>
                  </div>
                  {switchLoading ? (
                    <Loader2 size={18} className="animate-spin text-[#A0AEC0] shrink-0 mt-1" />
                  ) : switchError ? (
                    // 상태를 모르는데 OFF로 렌더하면 실제 ON인 기능을 꺼진 줄 알고, 토글은 '켜기'만 시도해 끌 수도 없다.
                    <AlertCircle size={18} className="text-[#E53E3E] shrink-0 mt-1" />
                  ) : (
                    <button
                      onClick={toggleReengagement}
                      disabled={switchSaving || !!switchError}
                      title={reEnabled ? "끄면 편입이 잠기고 미리보기만 됩니다" : "켜면 과거 인력을 인력풀로 편입할 수 있어요"}
                      className={`w-12 h-7 rounded-full relative transition-colors shrink-0 mt-1 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] ${reEnabled ? "bg-[#38A169]" : "bg-[#CBD5E0]"}`}
                    >
                      <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform ${reEnabled ? "translate-x-6" : "translate-x-1"}`} />
                    </button>
                  )}
                </div>
                <div className="mt-4 pt-4 border-t border-[#F1F4F8] flex items-center gap-2 text-[12.5px] font-bold">
                  {switchError ? (
                    <span className="text-[#E53E3E]">상태를 불러오지 못했어요 — 새로고침 후 다시 확인해 주세요(켜짐/꺼짐을 알 수 없어 조작을 막았어요).</span>
                  ) : switchSaving ? (
                    <span className="flex items-center gap-1.5 text-[#718096]"><RefreshCw size={13} className="animate-spin" /> 저장 중…</span>
                  ) : reEnabled ? (
                    <span className="text-[#2F855A]">지금 켜져 있어요 — 인력풀에서 편입할 수 있어요</span>
                  ) : (
                    <span className="text-[#718096]">지금 꺼져 있어요 — 편입 잠금(미리보기만)</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'integrations' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-[#1A202C] mb-1 border-b-0 pb-0">외부 서비스 연동</h2>
              <p className="text-[13px] text-[#718096] mb-6">서버에 연결 정보가 들어가 있는지로 판단한 실제 연결 상태입니다. (비밀 키는 표시되지 않아요)</p>
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
                              // 환경변수 이름은 실무자가 할 수 있는 일이 아니다 — 행동(개발팀 요청)을 안내하고
                              // 이름은 title에만 남겨 필요한 사람이 확인할 수 있게 한다.
                              <div className="text-[11px] text-[#A0AEC0] mt-1" title={`필요한 서버 설정: ${it.required.join(", ")}`}>
                                아직 연결 정보가 없어요 — 개발팀에 연결 요청이 필요해요
                              </div>
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