import { useState, useEffect } from "react";
import type { LucideIcon } from "lucide-react";
import useSWR from "swr";
import { Save, Bell, Lock, User, Link as LinkIcon, CheckCircle2, AlertCircle, Loader2, MapPin, Shield, ToggleRight, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Branches } from "./Branches";
import { Team } from "./Team";
import { useConfirm } from "./ConfirmDialog";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";

interface Integration {
  key: string;
  configured: boolean;
  kakao_ready?: boolean;
  required: string[];
}

const INTEGRATION_META: Record<string, { name: string; desc: string; badge: string; badgeColor: string }> = {
  claude: { name: "Claude (AI 에이전트)", desc: "응대·스크리닝·공고 생성용 LLM", badge: "AI", badgeColor: "bg-foreground text-white" },
  solapi: { name: "SOLAPI (문자·알림톡)", desc: "지원자 SMS / 카카오 알림톡 발송", badge: "SMS", badgeColor: "bg-[#FAE100] text-[#371D1E]" },
  supabase: { name: "Supabase (DB·실시간)", desc: "지원자·메시지 데이터베이스", badge: "DB", badgeColor: "bg-[#3ECF8E] text-[#0B2E20]" },
  slack: { name: "Slack 알림", desc: "운영 이벤트 사내 알림", badge: "#", badgeColor: "bg-[#4A154B] text-white" },
  naver_geocode: { name: "네이버 클라우드 (지오코딩)", desc: "주소 → 좌표 변환(거리 매칭)", badge: "N", badgeColor: "bg-[#00C471] text-[#04301F]" },
};

/**
 * 좌측 세로 탭. 버튼이 아니라 탭이므로 <Button>이 아니라 role="tab"을 지킨다.
 * 같은 마크업이 7번 반복되던 것을 하나로 모았다.
 */
function SettingsTab({
  icon: Icon,
  label,
  active,
  onClick,
  badge,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: string;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex items-center gap-3 min-h-11 px-4 py-3 rounded-xl text-sm font-bold transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        active
          ? "bg-white border-2 border-foreground text-foreground shadow-sm"
          : "border-2 border-transparent text-muted-foreground hover:bg-white hover:border-border-strong"
      }`}
    >
      <Icon size={18} /> {label}
      {badge && (
        <span className="ml-auto text-[11px] font-bold text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full shrink-0">
          {badge}
        </span>
      )}
    </button>
  );
}

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
    <div className="p-8 pb-12 flex flex-col h-full overflow-y-auto [&>*]:shrink-0">
      {/* 페이지 전체에 '준비중' 배너·배지를 달면, 실제로 동작하는 화주사·지점·팀·외부연동까지
          미완성으로 오해된다(채용·확정 전 반드시 세팅해야 하는 것들이 여기 있다).
          준비중 표시는 실제 미완성 탭(프로필·알림·보안)에만 붙인다. */}
      <div className="mb-8">
        <h1 className="text-2xl font-extrabold text-foreground tracking-tight mb-1">설정</h1>
        <p className="text-[14px] text-muted-foreground">지점·팀과 외부 연동을 관리합니다. 화주사는 ‘화주사’ 화면에서 관리해요. (프로필·알림·보안은 준비 중)</p>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        {/* Sidebar Nav */}
        <div role="tablist" aria-orientation="vertical" aria-label="설정 영역" className="flex w-full shrink-0 flex-col gap-2 lg:w-[240px]">
          {([
            { key: "profile", icon: User, label: "프로필 설정", badge: "준비중" },
            { key: "notifications", icon: Bell, label: "알림 설정", badge: "준비중" },
            { key: "security", icon: Lock, label: "보안 및 인증", badge: "준비중" },
            { key: "integrations", icon: LinkIcon, label: "외부 연동" },
            { key: "branches", icon: MapPin, label: "지점 관리" },
            { key: "team", icon: Shield, label: "팀 · 권한" },
            { key: "switches", icon: ToggleRight, label: "기능 스위치" },
          ] as { key: string; icon: LucideIcon; label: string; badge?: string }[]).map((t) => (
            <SettingsTab
              key={t.key}
              icon={t.icon}
              label={t.label}
              badge={t.badge}
              active={activeTab === t.key}
              onClick={() => setActiveTab(t.key)}
            />
          ))}
        </div>

        {/* Content Area */}
        {(activeTab === 'branches' || activeTab === 'team') ? (
          <div className="flex-1 min-w-0">
            {activeTab === 'branches' && <Branches embedded />}
            {activeTab === 'team' && <Team embedded />}
          </div>
        ) : (
        <div className="flex-1 bg-white/70 backdrop-blur-xl border border-border-strong rounded-2xl shadow-sm p-8">
          {activeTab === 'profile' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-foreground mb-6 border-b border-border-strong pb-4">기본 정보</h2>
              
              <div className="space-y-6 max-w-md">
                <Input label="이름" type="text" disabled placeholder="인증 도입 후 표시됩니다" className="bg-background text-muted-foreground cursor-not-allowed" />
                <Input label="이메일 (로그인 ID)" type="email" disabled placeholder="인증 도입 후 표시됩니다" className="bg-background text-muted-foreground cursor-not-allowed" />
                <Input label="연락처" type="tel" disabled placeholder="인증 도입 후 표시됩니다" className="bg-background text-muted-foreground cursor-not-allowed" />

                <div className="pt-6">
                  <Button variant="primary" disabled>
                    <Save size={16} /> 변경사항 저장
                  </Button>
                  <p className="text-[12px] text-muted-foreground mt-2">사용자 인증(계정) 도입 후 제공됩니다.</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-foreground mb-2 border-b border-border-strong pb-4">알림 설정</h2>
              {/* 토글이 눈으로는 켜지는데 저장되지 않는 '거짓 어포던스'였다 — 켜둔 줄 알고 알림을 기다리게 된다.
                  저장 경로가 생길 때까지 비활성 + 사유 명시. 실제 운영 알림은 Slack 웹훅으로 나간다. */}
              <p className="text-[13px] text-warning-strong bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 mb-6">
                아직 저장되지 않는 화면이에요(계정 알림 설정 준비 중). 지금 운영 알림은 Slack으로 받고 있어요.
              </p>
              <div className="space-y-6 max-w-2xl opacity-60">
                <div className="flex items-center justify-between p-4 bg-background border border-border-strong rounded-xl">
                  <div>
                    <div className="text-[14px] font-bold text-foreground mb-1">AI 응대 실패 (Human Takeover) 알림</div>
                    <div className="text-[13px] text-muted-foreground">AI가 답변하지 못하거나 지원자가 매니저 연결을 요청할 때 즉시 알림을 받습니다.</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-not-allowed">
                    <input type="checkbox" defaultChecked disabled className="sr-only peer" />
                    <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-success"></div>
                  </label>
                </div>
                <div className="flex items-center justify-between p-4 border border-border-strong rounded-xl">
                  <div>
                    <div className="text-[14px] font-bold text-foreground mb-1">신규 지원자 발생 알림</div>
                    <div className="text-[13px] text-muted-foreground">새로운 지원서가 접수되었을 때 데일리 리포트 형태로 알림을 받습니다.</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-not-allowed">
                    <input type="checkbox" disabled className="sr-only peer" />
                    <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-success"></div>
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'security' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-foreground mb-6 border-b border-border-strong pb-4">보안 및 인증</h2>
              <div className="space-y-6 max-w-md">
                <Input label="현재 비밀번호" type="password" disabled placeholder="••••••••" className="bg-background text-muted-foreground cursor-not-allowed" />
                <Input label="새 비밀번호" type="password" disabled placeholder="영문, 숫자, 특수문자 조합 8자 이상" className="bg-background text-muted-foreground cursor-not-allowed" />
                <Input label="새 비밀번호 확인" type="password" disabled placeholder="비밀번호 다시 입력" className="bg-background text-muted-foreground cursor-not-allowed" />
                <div className="pt-4">
                  <Button variant="secondary" disabled>비밀번호 변경</Button>
                  <p className="text-[12px] text-muted-foreground mt-2">사용자 인증(계정) 도입 후 제공됩니다.</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'switches' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-foreground mb-1 border-b border-border-strong pb-4">기능 스위치</h2>
              <p className="text-[13px] text-muted-foreground mt-4 mb-6">위험할 수 있는 기능을 매니저가 직접 켜고 끕니다.</p>
              <div className="rounded-xl border border-border-strong bg-white p-5 max-w-2xl">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-[14px] font-bold text-foreground mb-1">다시 부르기 (외부 인력)</div>
                    <p className="text-[13px] text-muted-foreground leading-relaxed">
                      옹고잉·옹매니징 배송원 중 옹보딩 미지원자(지금 일하고 있는 분 포함)를 인력풀로 불러오는 기능이에요. 꺼져 있으면 <b>미리보기만</b> 되고 아무 것도 편입되지 않아요.
                      켜도 문자가 저절로 나가지는 않아요 — 실제 발송은 인재풀에서 매니저가 보낼 때만 됩니다.
                    </p>
                    <p className="text-[12px] text-muted-foreground mt-2">법적 검토·승인이 끝난 뒤에 켜 주세요.</p>
                  </div>
                  {switchLoading ? (
                    <Loader2 size={18} className="animate-spin text-muted-foreground shrink-0 mt-1" />
                  ) : switchError ? (
                    // 상태를 모르는데 OFF로 렌더하면 실제 ON인 기능을 꺼진 줄 알고, 토글은 '켜기'만 시도해 끌 수도 없다.
                    <AlertCircle size={18} className="text-error shrink-0 mt-1" />
                  ) : (
                    // MASTER.md §3: 스위치는 button[role="switch"] + aria-checked를 쓴다.
                    <button
                      type="button"
                      role="switch"
                      aria-checked={reEnabled}
                      aria-label="다시 부르기 (외부 인력)"
                      onClick={toggleReengagement}
                      disabled={switchSaving || !!switchError}
                      title={reEnabled ? "끄면 편입이 잠기고 미리보기만 됩니다" : "켜면 과거 인력을 인력풀로 편입할 수 있어요"}
                      className={`after:absolute after:-inset-2 after:content-[''] w-12 h-7 rounded-full relative transition-colors shrink-0 mt-1 disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${reEnabled ? "bg-success" : "bg-gray-300"}`}
                    >
                      <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform ${reEnabled ? "translate-x-6" : "translate-x-1"}`} />
                    </button>
                  )}
                </div>
                <div className="mt-4 pt-4 border-t border-muted flex items-center gap-2 text-[13px] font-bold">
                  {switchError ? (
                    <span className="text-error">상태를 불러오지 못했어요 — 새로고침 후 다시 확인해 주세요(켜짐/꺼짐을 알 수 없어 조작을 막았어요).</span>
                  ) : switchSaving ? (
                    <span className="flex items-center gap-1.5 text-muted-foreground"><RefreshCw size={13} className="animate-spin" /> 저장 중…</span>
                  ) : reEnabled ? (
                    <span className="text-success-strong">지금 켜져 있어요 — 인력풀에서 편입할 수 있어요</span>
                  ) : (
                    <span className="text-muted-foreground">지금 꺼져 있어요 — 편입 잠금(미리보기만)</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'integrations' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-foreground mb-1 border-b-0 pb-0">외부 서비스 연동</h2>
              <p className="text-[13px] text-muted-foreground mb-6">서버에 연결 정보가 들어가 있는지로 판단한 실제 연결 상태입니다. (비밀 키는 표시되지 않아요)</p>
              {intLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground py-8"><Loader2 size={18} className="animate-spin" /> 연동 상태 확인 중…</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {integrations.map((it) => {
                    const meta = INTEGRATION_META[it.key] ?? { name: it.key, desc: "", badge: "?", badgeColor: "bg-muted text-gray-700" };
                    return (
                      <div key={it.key} className="p-5 border border-border-strong rounded-xl flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center font-bold shrink-0 ${meta.badgeColor}`}>{meta.badge}</div>
                          <div className="min-w-0">
                            <div className="text-[14px] font-bold text-foreground truncate">{meta.name}</div>
                            <div className="text-[12px] text-muted-foreground mt-0.5 truncate">{meta.desc}</div>
                            {it.key === "solapi" && it.configured && (
                              <div className={`text-[11px] mt-1 font-bold ${it.kakao_ready ? "text-success" : "text-warning-strong"}`}>
                                {it.kakao_ready ? "알림톡(PFID) 준비됨" : "알림톡 PFID 미설정 — SMS만 가능"}
                              </div>
                            )}
                            {!it.configured && (
                              // 환경변수 이름은 실무자가 할 수 있는 일이 아니다 — 행동(개발팀 요청)을 안내하고
                              // 이름은 title에만 남겨 필요한 사람이 확인할 수 있게 한다.
                              <div className="text-[11px] text-muted-foreground mt-1" title={`필요한 서버 설정: ${it.required.join(", ")}`}>
                                아직 연결 정보가 없어요 — 개발팀에 연결 요청이 필요해요
                              </div>
                            )}
                          </div>
                        </div>
                        {it.configured ? (
                          <Badge variant="success" className="gap-1 px-2.5 py-1.5 text-[12px] rounded-lg">
                            <CheckCircle2 size={13} /> 연결됨
                          </Badge>
                        ) : (
                          <Badge variant="warning" className="gap-1 px-2.5 py-1.5 text-[12px] rounded-lg">
                            <AlertCircle size={13} /> 미설정
                          </Badge>
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