"use client";

import { useState, useEffect, useCallback } from "react";
import {
  X, Phone, MessageSquare, Ban, Loader2, Check, CheckCircle2, Circle,
  Briefcase, Building2, MapPin, CalendarClock, Save, UserCheck, Clock, Sparkles, Zap,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { calcAge, STATUS_COLORS, SLOTS, matchesSlot } from "@/lib/admin/types";
import { ConversationThread } from "./ConversationThread";
import { useConfirm } from "./ConfirmDialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";

// ──────────────────────────────────────────────────────────────────────────
// 타입
// ──────────────────────────────────────────────────────────────────────────

interface CandidateLink {
  id: number;
  job_id: number;
  agent_stage: string | null;
  agent_state: { screening?: Record<string, boolean>; onboarding?: Record<string, boolean> } | null;
  paused_reason: string | null;
  confirmed_at: string | null;
  activated_at: string | null;
  created_at: string;
  job_title: string | null;
  job_branch: string | null;
  job_status: string | null;
  client_id: number | null;
  client_name: string | null;
}

interface ApplicantFull {
  id: number;
  name: string;
  phone: string | null;
  status: string;
  source: string | null;
  birth_date: string | null;
  location: string | null;
  own_vehicle: string | null;
  license_type: string | null;
  vehicle_type: string | null;
  experience: string | null;
  work_hours: string | null;
  branch1: string | null;
  branch2: string | null;
  available_date: string | null;
  baemin_id: string | null;
  guide_sent: boolean | null;
  onboarding_call_status: string | null;
  kakao_channel_friend: boolean | null;
  confirmed_slot: string | null;
  confirmed_branch: string | null;
  current_branch: string | null;
  start_date: string | null;
  last_message_at: string | null;
  availability: string | null;
  availability_updated_at: string | null;
  sms_opt_out_at: string | null;
  access_token: string | null;
}

// 재컨택 반응 요약(B2) — 상세 GET이 pool_events(최근 90일)로 계산해 내려준다.
interface RecontactInterestJob {
  job_id: number;
  title: string | null;
  immediate: boolean;
  clicked_at: string;
}

interface RecontactSummary {
  last_ping_at: string | null;
  last_link_view_at: string | null;
  interest_jobs: RecontactInterestJob[];
}

interface Detail {
  applicant: ApplicantFull;
  candidates: CandidateLink[];
  recontact?: RecontactSummary | null;
}

/** 관심 공고 배지용 제목 축약 */
function shortJobTitle(title: string | null, jobId: number): string {
  const t = (title ?? "").trim();
  if (!t) return `공고 #${jobId}`;
  return t.length > 12 ? t.slice(0, 12) + "…" : t;
}

const SOURCE_LABEL: Record<string, string> = {
  danggeun: "당근", baemin: "배민", danggeun_practice: "당근(연습)",
  manual: "수기", direct: "직접지원", facebook: "페이스북", naver: "네이버",
};

const SCREENING_LABELS: Record<string, string> = {
  자차_재확인: "배송용 자차 보유 재확인",
  프로모션_종료가능성_안내: "프로모션 종료 가능성 안내",
  정산주기_안내: "정산 주기 안내",
  공휴일_업무여부_확인: "공휴일 업무 가능 확인",
  본인명의_정산_문제없음: "본인 명의 정산 가능",
  업무시간_체계_이해: "업무시간 체계 이해",
  지원자_질문_해소: "지원자 질문 해소",
};
const SCREENING_KEYS = Object.keys(SCREENING_LABELS);

const ONBOARDING_LABELS: Record<string, string> = {
  앱설치_교육_안내발송됨: "앱설치·교육 안내 발송",
  배민_아이디_수신: "배민 커넥트 ID 수신",
  만남장소_안내발송됨: "만남장소 안내 발송",
};
const ONBOARDING_KEYS = Object.keys(ONBOARDING_LABELS);

const STAGE_LABEL: Record<string, string> = {
  exploration: "탐색", screening: "스크리닝", onboarding: "온보딩",
  active: "활성", paused: "수동", abort: "중단",
};

const CALL_STATUS_OPTIONS = ["미실시", "통화 완료", "부재중", "예정", "카톡대체"];

// 가용성 축 — status(채용 단계)와 별개. 빈값 = 미확인. 갱신 시각은 서버가 기록.
const AVAILABILITY_OPTIONS = ["즉시가능", "이번주가능", "휴면"];

// ──────────────────────────────────────────────────────────────────────────
// 데이터 훅
// ──────────────────────────────────────────────────────────────────────────

function useApplicantDetail(applicantId: number | null) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (applicantId == null) {
      setDetail(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/applicants/${applicantId}`);
      const json = await res.json();
      if (res.ok) setDetail(json as Detail);
    } catch {
      // 무시 — UI는 로딩 상태 유지
    } finally {
      setLoading(false);
    }
  }, [applicantId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { detail, loading, reload };
}

// ──────────────────────────────────────────────────────────────────────────
// 소형 위젯
// ──────────────────────────────────────────────────────────────────────────

function ChecklistRow({ label, done }: { label: string; done: boolean }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      {done ? <CheckCircle2 size={16} className="text-[#38A169] shrink-0" /> : <Circle size={16} className="text-[#CBD5E0] shrink-0" />}
      <span className={`text-[12.5px] ${done ? "text-[#2D3748] font-medium" : "text-[#A0AEC0]"}`}>{label}</span>
    </div>
  );
}

function InfoCell({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-bold text-[#A0AEC0]">{label}</span>
      <span className="text-[13px] font-semibold text-[#1A202C]">{value || "-"}</span>
    </div>
  );
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금 전";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

// ──────────────────────────────────────────────────────────────────────────
// 상세 본문 (LiveConsole 우측 패널 + 드로어 공용)
// ──────────────────────────────────────────────────────────────────────────

export function ApplicantDetailContent({
  applicantId,
  jobId = null,
  variant = "panel",
  onChanged,
  detail: externalDetail,
  reload: externalReload,
}: {
  applicantId: number;
  jobId?: number | null;
  variant?: "panel" | "drawer";
  onChanged?: () => void;
  detail?: Detail | null;
  reload?: () => void;
}) {
  const local = useApplicantDetail(externalDetail !== undefined ? null : applicantId);
  const detail = externalDetail !== undefined ? externalDetail : local.detail;
  const reload = externalReload ?? local.reload;
  const loading = externalDetail !== undefined ? false : local.loading;

  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Partial<ApplicantFull>>({});
  const [dirty, setDirty] = useState(false);
  // 확정 모달: 확정 시점에 슬롯을 함께 받아 confirmed_slot 공백을 방지한다.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmSlots, setConfirmSlots] = useState<string[]>([]);
  // 인력풀 제외(=status 부적합) 확인 모달 — 모든 공고에서 빠지는 파괴적 액션이라 확인을 받는다.
  const [excludeOpen, setExcludeOpen] = useState(false);

  useEffect(() => {
    setEdit({});
    setDirty(false);
  }, [applicantId]);

  if (loading && !detail) {
    return <div className="p-6 text-[13px] text-[#A0AEC0] text-center">불러오는 중…</div>;
  }
  if (!detail) {
    return <div className="p-6 text-[13px] text-[#A0AEC0] text-center">정보를 불러오지 못했어요</div>;
  }

  const a = detail.applicant;
  const cands = detail.candidates;
  const age = calcAge(a.birth_date);

  // 표시 대상 후보 (jobId 지정 시 그 공고, 아니면 최신)
  const focusCand = (jobId != null ? cands.find((c) => c.job_id === jobId) : cands[0]) ?? null;
  const isPurePool = cands.length === 0;

  const val = <K extends keyof ApplicantFull>(k: K): ApplicantFull[K] =>
    (k in edit ? (edit[k] as ApplicantFull[K]) : a[k]);

  const setField = <K extends keyof ApplicantFull>(k: K, v: ApplicantFull[K]) => {
    setEdit((p) => ({ ...p, [k]: v }));
    setDirty(true);
  };

  const toggleSlot = (slot: string) => {
    const cur = String(val("confirmed_slot") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const next = cur.includes(slot) ? cur.filter((s) => s !== slot) : [...cur, slot];
    setField("confirmed_slot", next.join(", "));
  };

  // 온보딩 통화: select 옵션이 사후 도입이라 옵션에 없는 자유입력 기존 값이 존재한다.
  // 그대로 두면 매칭되는 option이 없어 빈 값으로 렌더돼 화면에서 사라져 보이므로,
  // 기존 값을 fallback option으로 그대로 노출한다. (정규화는 별도 마이그레이션)
  const callStatus = String(val("onboarding_call_status") ?? "");
  const legacyCallStatus = callStatus !== "" && !CALL_STATUS_OPTIONS.includes(callStatus);

  const patch = async (body: Record<string, unknown>, msg: string) => {
    if (busy) return false;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/applicants/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error || "변경에 실패했어요");
        return false;
      }
      toast.success(msg);
      setEdit({});
      setDirty(false);
      await reload();
      onChanged?.();
      return true;
    } catch {
      toast.error("변경에 실패했어요");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveFields = () => {
    if (!dirty) return;
    patch(edit, "저장했어요.");
  };

  // 확정 모달 열기 — 기존 확정 슬롯(있으면)을 미리 선택해 둔다.
  const openConfirm = () => {
    setConfirmSlots(
      String(a.confirmed_slot ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    );
    setConfirmOpen(true);
  };

  const toggleConfirmSlot = (slot: string) => {
    setConfirmSlots((cur) => (cur.includes(slot) ? cur.filter((s) => s !== slot) : [...cur, slot]));
  };

  // 확정 확정(commit) — status + confirmed_slot을 함께 저장. 슬롯 미선택도 허용(비강제)하되 권장.
  const commitConfirm = async () => {
    const body: Record<string, unknown> = { status: "확정인력" };
    if (confirmSlots.length > 0) body.confirmed_slot = confirmSlots.join(", ");
    const ok = await patch(body, `${a.name}님을 확정인력으로 이동했어요.`);
    if (ok) setConfirmOpen(false);
  };

  // 인력풀 제외(commit) — status='부적합'. 지원자를 모든 공고 매칭·발송에서 빼는 person-level 액션.
  // (특정 공고만 부적합/보류는 공고별 후보 목록에서. 여긴 인력풀 전체 제외 전용.)
  const commitExclude = async () => {
    const ok = await patch({ status: "부적합" }, `${a.name}님을 인력풀에서 제외했어요.`);
    if (ok) setExcludeOpen(false);
  };

  // 수신거부 수동 등록/해제 — sms_opt_out_at 토글 (실시간 응대 스레드 헤더와 동일 동작)
  const toggleOptOut = async () => {
    const registering = !a.sms_opt_out_at;
    const ok = await confirm(
      registering
        ? {
            title: `${a.name}님을 수신거부로 등록할까요?`,
            description: "캠페인 발송이 영구 중단됩니다. 수동 문자는 계속 보낼 수 있어요.",
            confirmText: "수신거부 등록",
            destructive: true,
          }
        : {
            title: `${a.name}님 수신거부를 해제할까요?`,
            description: "다시 캠페인 발송 대상에 포함됩니다.",
            confirmText: "해제",
          }
    );
    if (!ok) return;
    await patch(
      { sms_opt_out_at: registering ? new Date().toISOString() : null },
      registering ? "수신거부로 등록했어요. 캠페인 발송에서 제외됩니다." : "수신거부를 해제했어요."
    );
  };

  // 관심 공고 배지 클릭 → 대기 안내 문구 클립보드 복사 (확정 뉘앙스 금지 — '먼저 안내' 수준).
  const copyInterestReply = async (ij: RecontactInterestJob) => {
    const jobTitle = (ij.title ?? "").trim() || `공고 #${ij.job_id}`;
    const text = `[옹고잉] ${a.name}님, '${jobTitle}' 관심 감사합니다. 현재 순차적으로 안내드리고 있어요. 자리가 정리되는 대로 먼저 연락드릴게요!`;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("대기 안내 문구를 복사했어요. 스레드에 붙여넣어 발송하세요.");
    } catch {
      toast.error("복사에 실패했어요");
    }
  };

  const recontact = detail.recontact ?? null;
  const hasRecontact =
    !!recontact && (!!recontact.last_ping_at || !!recontact.last_link_view_at || recontact.interest_jobs.length > 0);

  const screening = focusCand?.agent_state?.screening ?? {};
  const onboarding = focusCand?.agent_state?.onboarding ?? {};
  const screeningDone = SCREENING_KEYS.filter((k) => screening[k] === true).length;
  const onboardingDone = ONBOARDING_KEYS.filter((k) => onboarding[k] === true).length;

  const telHref = a.phone ? `tel:${a.phone.replace(/[^0-9+]/g, "")}` : undefined;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* panel 헤더 (LiveConsole 우측용) */}
      {variant === "panel" && (
        <div className="h-[60px] shrink-0 border-b border-[#E2E8F0] px-5 flex items-center justify-between">
          <h2 className="text-[15px] font-extrabold text-[#1A202C] flex items-center gap-2">
            <Sparkles size={16} className="text-[#FFCB3C]" /> 지원자 상세
          </h2>
          <span className="text-[11.5px] font-bold px-2 py-1 rounded-md" style={{ backgroundColor: `${STATUS_COLORS[a.status] ?? "#A0AEC0"}1A`, color: STATUS_COLORS[a.status] ?? "#4A5568" }}>{a.status}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-5 space-y-5 min-h-0">
        {/* 풀/공고 구분 + 액션 */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {isPurePool ? (
              <span className="px-2.5 py-1 rounded-md text-[11.5px] font-bold bg-[#EDF2F7] text-[#4A5568]">순수 인재풀</span>
            ) : (
              <span className="px-2.5 py-1 rounded-md text-[11.5px] font-bold bg-[#EBF8FF] text-[#3182CE]">공고 지원자 · {cands.length}건</span>
            )}
            {a.source && <span className="px-2.5 py-1 rounded-md text-[11.5px] font-bold bg-[#F7FAFC] text-[#718096] border border-[#E2E8F0]">{SOURCE_LABEL[a.source] ?? a.source}</span>}
            {focusCand?.agent_stage && <span className="px-2.5 py-1 rounded-md text-[11.5px] font-bold bg-[#FAF5FF] text-[#805AD5]">{STAGE_LABEL[focusCand.agent_stage] ?? focusCand.agent_stage}</span>}
          </div>
          <div className="flex gap-2">
            <a href={telHref} onClick={(e) => { if (!telHref) { e.preventDefault(); toast.error("연락처가 없어요."); } }} className="flex-1 bg-[#F7FAFC] hover:bg-[#EDF2F7] border border-[#E2E8F0] text-[#1A202C] py-2 rounded-xl text-[12.5px] font-bold flex justify-center items-center gap-1.5 transition-colors"><Phone size={14} /> 전화</a>
            <button
              onClick={async () => {
                if (!a.access_token) return toast.error("맞춤 링크 토큰이 없어요.");
                try {
                  await navigator.clipboard.writeText(`${window.location.origin}/p/${a.access_token}`);
                  toast.success("맞춤 공고 링크를 복사했어요. 문자로 보내주세요.");
                } catch {
                  toast.error("복사에 실패했어요");
                }
              }}
              className="flex-1 bg-[#F7FAFC] hover:bg-[#EDF2F7] border border-[#E2E8F0] text-[#1A202C] py-2 rounded-xl text-[12.5px] font-bold flex justify-center items-center gap-1.5 transition-colors"
              title="본인 전용 맞춤 공고 페이지(/p/토큰) 링크 복사"
            >
              <MessageSquare size={14} /> 맞춤링크
            </button>
            <button onClick={openConfirm} disabled={busy} className="flex-1 bg-[#1A202C] hover:bg-[#2D3748] text-white py-2 rounded-xl text-[12.5px] font-bold flex justify-center items-center gap-1.5 disabled:opacity-50"><UserCheck size={14} /> 확정</button>
            <button onClick={() => setExcludeOpen(true)} disabled={busy} title="인력풀에서 제외 — 모든 공고에서 빠집니다" className="px-3 bg-white border border-[#E53E3E] text-[#E53E3E] py-2 rounded-xl text-[12.5px] font-bold hover:bg-[#FFF5F5] disabled:opacity-50 flex items-center gap-1.5"><Ban size={14} /></button>
          </div>
        </div>

        {/* 재컨택 반응 요약 — "이 답장이 무엇에 대한 것인지"를 스레드 옆에서 바로 대조 */}
        {hasRecontact && recontact && (
          <div className="rounded-xl border border-[#BEE3F8] bg-[#EBF8FF] p-3.5 space-y-2.5">
            <h3 className="text-[12.5px] font-extrabold text-[#2B6CB0] flex items-center gap-1.5">
              <Zap size={14} /> 재컨택 반응
            </h3>
            <div className="grid grid-cols-3 gap-x-3 gap-y-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-bold text-[#A0AEC0]">마지막 발송</span>
                <span className="text-[12.5px] font-semibold text-[#1A202C]" title={recontact.last_ping_at ?? undefined}>
                  {recontact.last_ping_at ? relTime(recontact.last_ping_at) : "없음"}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-bold text-[#A0AEC0]">링크 열람</span>
                <span className="text-[12.5px] font-semibold text-[#1A202C]" title={recontact.last_link_view_at ?? undefined}>
                  {recontact.last_link_view_at ? relTime(recontact.last_link_view_at) : "미열람"}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-bold text-[#A0AEC0]">마지막 답장</span>
                <span className="text-[12.5px] font-semibold text-[#1A202C]" title={a.last_message_at ?? undefined}>
                  {a.last_message_at ? relTime(a.last_message_at) : "없음"}
                </span>
              </div>
            </div>
            {recontact.interest_jobs.length > 0 && (
              <div>
                <span className="text-[11px] font-bold text-[#A0AEC0]">관심 클릭 공고 · 클릭 시 대기 안내 문구 복사</span>
                <div className="flex gap-1.5 flex-wrap mt-1.5">
                  {recontact.interest_jobs.map((ij) => (
                    <button
                      key={ij.job_id}
                      onClick={() => copyInterestReply(ij)}
                      title={`${ij.title ?? `공고 #${ij.job_id}`} — 관심 클릭 ${relTime(ij.clicked_at)} · 대기 안내 문구를 클립보드에 복사`}
                      className="px-2.5 py-1 rounded-md text-[11.5px] font-bold bg-white border border-[#BEE3F8] text-[#2B6CB0] hover:bg-[#BEE3F8] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                    >
                      ⭐ {shortJobTitle(ij.title, ij.job_id)}
                      {ij.immediate && <span className="ml-1 text-[#2F855A]">· 바로가능</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 지원 공고 목록 */}
        {!isPurePool && (
          <div>
            <h3 className="text-[12px] font-bold text-[#718096] mb-2">지원 공고</h3>
            <div className="space-y-2">
              {cands.map((c) => (
                <div key={c.id} className={`rounded-xl border p-3 ${focusCand?.id === c.id ? "border-[#FFCB3C] bg-[#FFFBEB]" : "border-[#E2E8F0] bg-white"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-bold text-[#1A202C] line-clamp-1">{c.job_title ?? `공고 #${c.job_id}`}</span>
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-[#FAF5FF] text-[#805AD5] shrink-0">{STAGE_LABEL[c.agent_stage ?? ""] ?? c.agent_stage ?? "-"}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5 text-[11.5px] text-[#718096] flex-wrap">
                    {c.job_branch && <span className="flex items-center gap-1"><MapPin size={11} /> {c.job_branch}</span>}
                    {c.client_name && <span className="flex items-center gap-1"><Building2 size={11} /> {c.client_name}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 스크리닝 / 온보딩 진행 */}
        {focusCand && (
          <div className="grid grid-cols-1 gap-3">
            <div className="rounded-xl border border-[#E2E8F0] p-3.5 bg-white">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-[12.5px] font-extrabold text-[#1A202C]">스크리닝 체크리스트</h3>
                <span className="text-[12px] font-extrabold text-[#3182CE]">{screeningDone}/{SCREENING_KEYS.length}</span>
              </div>
              <div className="h-1.5 bg-[#EDF2F7] rounded-full overflow-hidden mb-2"><div className="h-full bg-[#3182CE] rounded-full" style={{ width: `${(screeningDone / SCREENING_KEYS.length) * 100}%` }} /></div>
              {SCREENING_KEYS.map((k) => <ChecklistRow key={k} label={SCREENING_LABELS[k]} done={screening[k] === true} />)}
            </div>
            {(focusCand.agent_stage === "onboarding" || focusCand.agent_stage === "active" || onboardingDone > 0) && (
              <div className="rounded-xl border border-[#E2E8F0] p-3.5 bg-white">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-[12.5px] font-extrabold text-[#1A202C]">온보딩 체크리스트</h3>
                  <span className="text-[12px] font-extrabold text-[#38A169]">{onboardingDone}/{ONBOARDING_KEYS.length}</span>
                </div>
                <div className="h-1.5 bg-[#EDF2F7] rounded-full overflow-hidden mb-2"><div className="h-full bg-[#38A169] rounded-full" style={{ width: `${(onboardingDone / ONBOARDING_KEYS.length) * 100}%` }} /></div>
                {ONBOARDING_KEYS.map((k) => <ChecklistRow key={k} label={ONBOARDING_LABELS[k]} done={onboarding[k] === true} />)}
              </div>
            )}
          </div>
        )}

        {/* 기본 정보 */}
        <div className="rounded-xl border border-[#E2E8F0] p-3.5 bg-[#F7FAFC]">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-[12px] font-bold text-[#718096]">기본 정보</h3>
            {a.sms_opt_out_at ? (
              <div className="flex items-center gap-1.5">
                <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-[#FFF5F5] text-[#C53030] border border-[#FEB2B2]" title={`수신거부 등록: ${relTime(a.sms_opt_out_at)}`}>수신거부 — 캠페인 발송 제외</span>
                <button
                  onClick={toggleOptOut}
                  disabled={busy}
                  title="수신거부 해제 — 다시 캠페인 발송 대상에 포함"
                  className="px-2 py-0.5 rounded-md text-[11px] font-bold text-[#4A5568] bg-white hover:bg-[#EDF2F7] border border-[#E2E8F0] transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                >
                  해제
                </button>
              </div>
            ) : (
              <button
                onClick={toggleOptOut}
                disabled={busy}
                title="수신거부 수동 등록 — 캠페인 발송이 영구 중단됩니다"
                className="px-2 py-0.5 rounded-md text-[11px] font-bold text-[#C53030] bg-white hover:bg-[#FFF5F5] border border-[#FEB2B2] transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
              >
                수신거부 등록
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <InfoCell label="연락처" value={a.phone} />
            <InfoCell label="나이" value={age ? `${age}세` : null} />
            <InfoCell label="이동수단" value={a.own_vehicle} />
            <InfoCell label="면허" value={a.license_type} />
            <InfoCell label="경력" value={a.experience} />
            <InfoCell label="희망 근무" value={a.work_hours} />
            <InfoCell label="희망 지점" value={a.branch1} />
            <InfoCell label="거주 지역" value={a.location} />
          </div>
        </div>

        {/* 온보딩 / 확정 관리 (편집) */}
        <div className="rounded-xl border border-[#E2E8F0] p-3.5 bg-white space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[12.5px] font-extrabold text-[#1A202C] flex items-center gap-1.5"><Briefcase size={14} className="text-[#A0AEC0]" /> 온보딩 · 확정 관리</h3>
            <span className="flex items-center gap-1 text-[11px] text-[#A0AEC0]"><Clock size={12} /> {relTime(a.last_message_at)}</span>
          </div>

          {/* 확정 슬롯 */}
          <div>
            <span className="text-[11px] font-bold text-[#A0AEC0]">확정 슬롯</span>
            <div className="flex gap-1.5 flex-wrap mt-1.5">
              {SLOTS.map((s) => {
                const on = String(val("confirmed_slot") ?? "").split(",").map((x) => x.trim()).includes(s);
                return (
                  <button key={s} onClick={() => toggleSlot(s)} className={`px-2.5 py-1 rounded-md text-[11.5px] font-bold transition-all ${on ? "bg-[#FFCB3C] text-[#1A202C]" : "bg-[#F7FAFC] border border-[#E2E8F0] text-[#718096]"}`}>{s}</button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-bold text-[#A0AEC0]">확정 지점</span>
              <input value={String(val("confirmed_branch") ?? "")} onChange={(e) => setField("confirmed_branch", e.target.value)} className="border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-[#FFCB3C]" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-bold text-[#A0AEC0]">근무 시작일</span>
              <input type="date" value={String(val("start_date") ?? "")} onChange={(e) => setField("start_date", e.target.value)} className="border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-[#FFCB3C]" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-bold text-[#A0AEC0]">배민 커넥트 ID</span>
              <input value={String(val("baemin_id") ?? "")} onChange={(e) => setField("baemin_id", e.target.value)} className="border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-[#FFCB3C]" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-bold text-[#A0AEC0]">온보딩 통화</span>
              <select value={callStatus} onChange={(e) => setField("onboarding_call_status", e.target.value)} className="border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-[#FFCB3C] bg-white">
                <option value="">미지정</option>
                {legacyCallStatus && <option value={callStatus}>{callStatus}</option>}
                {CALL_STATUS_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-bold text-[#A0AEC0]">
                가용성
                {a.availability_updated_at && <span className="font-medium"> · 갱신: {relTime(a.availability_updated_at)}</span>}
              </span>
              <select value={String(val("availability") ?? "")} onChange={(e) => setField("availability", e.target.value)} className="border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-[#FFCB3C] bg-white">
                <option value="">미확인</option>
                {AVAILABILITY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!val("guide_sent")} onChange={(e) => setField("guide_sent", e.target.checked)} className="accent-[#FFCB3C] w-4 h-4" />
              <span className="text-[12px] font-semibold text-[#4A5568]">가이드 전달</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!!val("kakao_channel_friend")} onChange={(e) => setField("kakao_channel_friend", e.target.checked)} className="accent-[#FFCB3C] w-4 h-4" />
              <span className="text-[12px] font-semibold text-[#4A5568]">카카오 채널 친구</span>
            </label>
          </div>

          <button onClick={saveFields} disabled={!dirty || busy} className="w-full bg-[#1A202C] hover:bg-[#2D3748] text-white py-2 rounded-xl text-[12.5px] font-bold flex justify-center items-center gap-1.5 disabled:opacity-40 transition-colors">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 저장
          </button>
        </div>
      </div>

      {/* 확정 모달 — 확정 시점에 슬롯을 함께 지정해 슬롯 보드 정확도를 확보 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{a.name}님을 확정인력으로</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              확정 슬롯을 함께 지정하면 슬롯 보드에 정확히 반영됩니다.
              {a.work_hours ? `\n희망 시간대: ${a.work_hours}` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div>
            <span className="text-[11px] font-bold text-[#A0AEC0]">확정 슬롯 (복수 선택 가능)</span>
            <div className="flex gap-1.5 flex-wrap mt-1.5">
              {SLOTS.map((s) => {
                const on = confirmSlots.includes(s);
                const hoped = matchesSlot(a.work_hours, s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleConfirmSlot(s)}
                    className={`px-2.5 py-1.5 rounded-md text-[12px] font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] ${on ? "bg-[#FFCB3C] text-[#1A202C]" : "bg-[#F7FAFC] border border-[#E2E8F0] text-[#718096]"}`}
                  >
                    {s}{hoped && !on ? " ·희망" : ""}
                  </button>
                );
              })}
            </div>
            {confirmSlots.length === 0 && (
              <p className="text-[11.5px] text-[#D69E2E] mt-2 leading-relaxed">
                슬롯 미선택 시 슬롯 보드에서는 희망 시간대로 <b>추정 표시</b>됩니다. 가능하면 슬롯을 지정해 주세요.
              </p>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl" disabled={busy}>취소</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); commitConfirm(); }} disabled={busy} className="rounded-xl">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />} 확정
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 인력풀 제외 모달 — 공고 단위 부적합/보류와 구분. 여긴 사람 전체를 풀에서 뺀다. */}
      <AlertDialog open={excludeOpen} onOpenChange={setExcludeOpen}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{a.name}님을 인력풀에서 제외</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              이 지원자를 <b>모든 공고 매칭·발송에서 제외</b>합니다 (부적합 처리).
              {"\n\n"}특정 공고에만 맞지 않는 경우라면, 공고별 후보 목록에서 <b>보류·부적합</b>을 쓰세요 — 지원자는 인력풀에 남아 다른 공고에 계속 후보로 노출됩니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl" disabled={busy}>취소</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); commitExclude(); }} disabled={busy} className="rounded-xl bg-[#E53E3E] hover:bg-[#C53030]">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />} 인력풀 제외
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 슬라이드 드로어 (인재풀 · 공고별 지원자에서 사용)
// ──────────────────────────────────────────────────────────────────────────

export function ApplicantDetailPanel({
  isOpen,
  onClose,
  applicantId,
  jobId = null,
  onChanged,
  initialTab = "detail",
}: {
  isOpen: boolean;
  onClose: () => void;
  applicantId: number | null;
  jobId?: number | null;
  onChanged?: () => void;
  /** 열 때 처음 보여줄 탭 — 답장 대기 큐처럼 바로 대화로 들어가고 싶을 때 "chat" */
  initialTab?: "detail" | "chat";
}) {
  const [tab, setTab] = useState<"detail" | "chat">(initialTab);
  const { detail, reload } = useApplicantDetail(isOpen ? applicantId : null);

  // 전역 킬스위치 — 드로어 대화 탭에서 'AI 응대 중' 오표시·수동 발송 잠금이 남지 않도록
  // LiveConsole과 동일 판정을 전달 (env 강제 중단 포함)
  const [globalKill, setGlobalKill] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/admin/agent/kill-switch")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j) setGlobalKill(j.disabled === true || j.env_forced === true);
      })
      .catch(() => {});
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) setTab(initialTab);
  }, [isOpen, applicantId, initialTab]);

  if (!isOpen || applicantId == null) return null;

  const a = detail?.applicant;
  const age = a ? calcAge(a.birth_date) : null;

  return (
    <>
      <AnimatePresence>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 bg-black/30 z-40 backdrop-blur-[2px]" />
      </AnimatePresence>
      <AnimatePresence>
        <motion.div
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", damping: 26, stiffness: 220 }}
          className="fixed top-0 right-0 w-[560px] max-w-[94vw] h-full bg-white shadow-[-10px_0_30px_rgba(0,0,0,0.1)] z-50 flex flex-col border-l border-[#E2E8F0]"
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-[#E2E8F0] flex justify-between items-start bg-[#F7FAFC] shrink-0">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-2xl bg-[#EDF2F7] text-[#4A5568] flex items-center justify-center font-bold text-[18px] shadow-inner">{a?.name?.charAt(0) ?? "?"}</div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-[19px] font-extrabold text-[#1A202C]">{a?.name ?? "지원자"}</h2>
                  {age && <span className="text-[12px] font-medium text-[#718096] bg-white px-2 py-0.5 rounded-md border border-[#E2E8F0]">{age}세</span>}
                  {a && <span className="text-[12px] font-bold px-2 py-0.5 rounded-md" style={{ backgroundColor: `${STATUS_COLORS[a.status] ?? "#A0AEC0"}1A`, color: STATUS_COLORS[a.status] ?? "#4A5568" }}>{a.status}</span>}
                </div>
                <div className="text-[12px] text-[#A0AEC0] font-mono">#{applicantId} · {a?.phone ?? "연락처 없음"}</div>
              </div>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-[#E2E8F0] rounded-lg transition-colors text-[#A0AEC0] hover:text-[#1A202C]"><X size={20} /></button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-[#E2E8F0] bg-white shrink-0 px-3">
            {[
              { id: "detail" as const, label: "상세 정보", icon: <Check size={14} /> },
              { id: "chat" as const, label: "대화 내역", icon: <MessageSquare size={14} /> },
            ].map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} className={`flex items-center gap-1.5 px-4 py-3 text-[13px] font-bold border-b-2 -mb-px transition-colors ${tab === t.id ? "border-[#FFCB3C] text-[#1A202C]" : "border-transparent text-[#A0AEC0] hover:text-[#718096]"}`}>{t.icon} {t.label}</button>
            ))}
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 flex flex-col">
            {tab === "detail" ? (
              <ApplicantDetailContent
                applicantId={applicantId}
                jobId={jobId}
                variant="drawer"
                detail={detail}
                reload={() => { reload(); onChanged?.(); }}
                onChanged={onChanged}
              />
            ) : a ? (
              <ConversationThread
                key={applicantId}
                applicantId={applicantId}
                applicantName={a.name}
                phone={a.phone}
                jobId={jobId}
                smsOptOutAt={a.sms_opt_out_at}
                globalKill={globalKill}
                onChanged={() => { reload(); onChanged?.(); }}
                className="flex-1 min-h-0"
              />
            ) : (
              <div className="p-6 text-[13px] text-[#A0AEC0] text-center">불러오는 중…</div>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </>
  );
}
