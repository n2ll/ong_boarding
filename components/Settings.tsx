import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import useSWR from "swr";
import { Link as LinkIcon, CheckCircle2, AlertCircle, Loader2, MapPin, Users, ToggleRight, RefreshCw, Settings2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Branches } from "./Branches";
import { Team } from "./Team";
import { useConfirm } from "./ConfirmDialog";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { PageShell } from "./ui/page-shell";
import { settingsSectionFromLocation, settingsSectionHref, type SettingsSection } from "@/lib/admin/settings-navigation";

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
  href,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  href: string;
}) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      aria-controls="settings-panel"
      className={`flex items-center gap-3 min-h-11 px-4 py-3 rounded-2xl text-sm font-bold transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        active
          ? "bg-card border-2 border-foreground text-foreground shadow-sm"
          : "border-2 border-transparent text-muted-foreground hover:bg-card hover:border-border-strong"
      }`}
    >
      <Icon size={18} /> {label}
    </Link>
  );
}

export function Settings() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab = settingsSectionFromLocation(
    searchParams.toString(),
    typeof window === "undefined" ? "" : window.location.hash,
  );
  // 기존 # 딥링크를 새 query 계약으로 조용히 이관한다.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const h = window.location.hash;
    if (h === "#clients") {
      router.replace("/shippers");
      return;
    }
    const legacy = settingsSectionFromLocation("", h);
    if (h && legacy !== "integrations") router.replace(settingsSectionHref(legacy));
  }, [router]);
  // 외부 연동 탭을 열 때만 조회(조건부 key), 이후엔 SWR 캐시로 즉시 표시.
  const { data: intData, error: intError, isLoading: intLoading, isValidating: intValidating, mutate: mutateIntegrations } = useSWR<{ data?: Integration[] }>(
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
    <PageShell>
      <div className="rounded-2xl border border-border-strong bg-card px-5 py-4 shadow-sm">
        <h1 className="sr-only">설정</h1>
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brand-muted"><Settings2 size={20} className="text-warning-strong" /></span>
          <div>
            <h2 className="text-[16px] font-extrabold text-foreground">운영에 실제로 쓰는 설정만 모았습니다</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">연동 상태, 지점 정보, 현장 담당자, 위험 기능을 관리합니다. 계정·비밀번호는 인증 체계 도입 전까지 제공하지 않습니다.</p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-5 lg:flex-row lg:gap-6">
        {/* Sidebar Nav */}
        <div role="tablist" aria-orientation="vertical" aria-label="설정 영역" className="grid w-full shrink-0 grid-cols-2 gap-2 lg:flex lg:w-[220px] lg:flex-col">
          {([
            { key: "integrations", icon: LinkIcon, label: "외부 연동" },
            { key: "branches", icon: MapPin, label: "지점 관리" },
            { key: "team", icon: Users, label: "현장 담당자" },
            { key: "switches", icon: ToggleRight, label: "기능 스위치" },
          ] as { key: SettingsSection; icon: LucideIcon; label: string }[]).map((t) => (
            <SettingsTab
              key={t.key}
              icon={t.icon}
              label={t.label}
              active={activeTab === t.key}
              href={settingsSectionHref(t.key)}
            />
          ))}
        </div>

        {/* Content Area */}
        {(activeTab === 'branches' || activeTab === 'team') ? (
          <div id="settings-panel" role="tabpanel" className="flex-1 min-w-0">
            {activeTab === 'branches' && <Branches embedded />}
            {activeTab === 'team' && <Team embedded />}
          </div>
        ) : (
        <div id="settings-panel" role="tabpanel" className="flex-1 bg-card border border-border-strong rounded-2xl shadow-sm p-5 sm:p-6">

          {activeTab === 'switches' && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h2 className="text-lg font-bold text-foreground mb-1 border-b border-border-strong pb-4">기능 스위치</h2>
              <p className="text-[13px] text-muted-foreground mt-4 mb-6">위험할 수 있는 기능을 매니저가 직접 켜고 끕니다.</p>
              <div className="rounded-2xl border border-border-strong bg-card p-5 max-w-2xl">
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
                      className={`after:absolute after:-inset-2 after:content-[''] w-12 h-7 rounded-full relative transition-colors shrink-0 mt-1 disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${reEnabled ? "bg-success" : "bg-switch-background"}`}
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
            <div>
              <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-foreground">외부 서비스 연동</h2>
                  <p className="mt-1 text-[13px] text-muted-foreground">서버의 실제 연결 상태입니다. 비밀 키 값은 표시하지 않습니다.</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void mutateIntegrations()} disabled={intValidating}>
                  <RefreshCw size={14} className={intValidating ? "animate-spin" : ""} /> 새로고침
                </Button>
              </div>
              {intLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground py-8"><Loader2 size={18} className="animate-spin" /> 연동 상태 확인 중…</div>
              ) : intError ? (
                <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-error/30 bg-error-soft p-4 text-error-strong">
                  <div className="flex items-start gap-2 text-[13px] font-bold"><AlertCircle size={17} className="mt-0.5 shrink-0" /> 연결 상태를 불러오지 못했어요. 알 수 없는 상태를 미연결로 표시하지 않았습니다.</div>
                  <Button variant="secondary" size="sm" onClick={() => void mutateIntegrations()}>다시 확인</Button>
                </div>
              ) : integrations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border-strong bg-background px-4 py-10 text-center text-[13px] text-muted-foreground">표시할 연동 항목이 없어요.</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {integrations.map((it) => {
                    const meta = INTEGRATION_META[it.key] ?? { name: it.key, desc: "", badge: "?", badgeColor: "bg-muted text-gray-700" };
                    return (
                      <div key={it.key} className="p-5 border border-border-strong rounded-2xl flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center font-bold shrink-0 ${meta.badgeColor}`}>{meta.badge}</div>
                          <div className="min-w-0">
                            <div className="text-[14px] font-bold text-foreground truncate">{meta.name}</div>
                            <div className="text-[12px] text-muted-foreground mt-0.5 truncate">{meta.desc}</div>
                            {it.key === "solapi" && it.configured && (
                              <div className={`text-xs mt-1 font-bold ${it.kakao_ready ? "text-success" : "text-warning-strong"}`}>
                                {it.kakao_ready ? "알림톡(PFID) 준비됨" : "알림톡 PFID 미설정 — SMS만 가능"}
                              </div>
                            )}
                            {!it.configured && (
                              // 환경변수 이름은 실무자가 할 수 있는 일이 아니다 — 행동(개발팀 요청)을 안내하고
                              // 이름은 title에만 남겨 필요한 사람이 확인할 수 있게 한다.
                              <div className="text-xs text-muted-foreground mt-1" title={`필요한 서버 설정: ${it.required.join(", ")}`}>
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
    </PageShell>
  );
}
