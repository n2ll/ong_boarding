"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import {
  X, Phone, MessageSquare, Ban, Loader2, Check, CheckCircle2, Circle, ChevronDown,
  Building2, MapPin, Save, UserCheck, Clock, Sparkles, Zap, RotateCcw,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import useSWR from "swr";
import { calcAge, STATUS_COLORS, SLOTS, SLOT_LABEL, matchesSlot, applicantAvailableSlots } from "@/lib/admin/types";
import { isSystemJobTitle } from "@/lib/jobs";
import { isLiveLinkResolved } from "@/lib/candidate-links";
import { ConversationThread } from "./ConversationThread";
import { useConfirm } from "./ConfirmDialog";
import { FollowupSendModal, type FollowupKind } from "./FollowupSendModal";
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
  job_start_date: string | null;
  job_effectively_closed: boolean;
  job_recruit_mode: string | null;
  /** 만남장소 발송 요건 — 서버가 픽업주소를 요구하고, 비internal 라인은 현장매니저까지 필요. */
  job_pickup_address: string | null;
  job_site_manager_id: number | null;
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
  sigungu: string | null;
  applied_at: string | null;
  own_vehicle: string | null;
  license_type: string | null;
  vehicle_type: string | null;
  experience: string | null;
  work_hours: string | null;
  /** 지원자가 최근에 알려준 가능 시간대(4슬롯 키) — 노출 규칙·조건 바가 이 값을 우선 판정한다. */
  available_slots?: string[] | null;
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
  current_job_id: number | null;
  start_date: string | null;
  last_message_at: string | null;
  availability: string | null;
  availability_updated_at: string | null;
  sms_opt_out_at: string | null;
  access_token: string | null;
  // 옹고잉 TMS 활동 신호 캐시(tms-sync cron) — NULL=미확인 / true / false
  tms_active_signal: boolean | null;
  tms_active_reason: string | null;
  tms_active_checked_at: string | null;
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

// 선탑(동승) 이력 — pool_events(suntop_scheduled/suntop_done) 원장. 예정→완료 2단계 + 프리보딩 자산.
interface SuntopEvent {
  id: number;
  stage: "scheduled" | "done";
  created_at: string;
  meta: { client?: string; line?: string; note?: string; scheduled_at?: string } | null;
}

// 옹매니징 인력 보강 — 계약 배송원 상세(차종·라인·정산 요약). [id] GET이 전화 매칭으로 내려준다.
interface OngmanagingDetail {
  vehicleType: string | null;
  isBackupSpecialist: boolean;
  managerName: string | null;
  lines: { lineName: string; clientName: string | null }[];
  settledMonths: number;
  lastSettledMonth: string | null;
}

interface Detail {
  applicant: ApplicantFull;
  candidates: CandidateLink[];
  recontact?: RecontactSummary | null;
  suntop?: { done: boolean; scheduled: boolean; events: SuntopEvent[] } | null;
  ongmanaging?: OngmanagingDetail | null;
  blacklisted?: boolean;
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

// internal(도시락 등 정기배송) 라인용 스크리닝 체크리스트 표시 — 비마트 전용 자동통과 항목
// (프로모션 종료·정산주기·업무시간·공휴일)은 감추고, 라인에 유효한 3개만 라인 언어로 보여준다.
const GENERAL_SCREENING_LABELS: Record<string, string> = {
  자차_재확인: "차종 확인",
  본인명의_정산_문제없음: "본인 명의 정산",
  지원자_질문_해소: "지원자 질문 해소",
};
const GENERAL_SCREENING_KEYS = Object.keys(GENERAL_SCREENING_LABELS);

// 표시 라벨만 실무 언어로 통일(LiveConsole·Jobs·Dashboard와 동일 단어) — DB 값(agent_stage)은 그대로.
const STAGE_LABEL: Record<string, string> = {
  exploration: "초기 대화", screening: "스크리닝", onboarding: "온보딩",
  active: "활동 중", paused: "수동 응대", abort: "중단",
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
      {done ? <CheckCircle2 size={16} className="text-success shrink-0" /> : <Circle size={16} className="text-gray-300 shrink-0" />}
      <span className={`text-[12.5px] ${done ? "text-gray-800 font-medium" : "text-gray-400"}`}>{label}</span>
    </div>
  );
}

function InfoCell({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-bold text-gray-400">{label}</span>
      <span className="text-[13px] font-semibold text-foreground">{value || "-"}</span>
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

// 원지원일 'YYYY-MM' 표기 — Pipeline 코호트 표기와 동일 규칙
function appliedMonth(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 핵심 판단 카드 셀 — 값이 없으면 회색 축약(빈 값 나열로 시선 낭비 방지) */
function KeyCell({ label, value, empty = "미입력", sub, title, action }: {
  label: string;
  value: string | null | undefined;
  empty?: string;
  sub?: string;
  title?: string;
  /** 라벨 옆 작은 보조 액션(예: 자기 신고 값 지우기) — 없으면 렌더하지 않는다. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0" title={title}>
      <span className="text-[11px] font-bold text-gray-400 flex items-center gap-1">{label}{action}</span>
      {value ? (
        <span className="text-[13px] font-semibold text-foreground truncate">{value}</span>
      ) : (
        <span className="text-[12.5px] font-medium text-gray-300">{empty}</span>
      )}
      {sub && <span className="text-[10.5px] text-gray-400">{sub}</span>}
    </div>
  );
}

/** 접이식 섹션 — '훑고 행동' 위계에서 상세는 필요할 때만 펼친다. 접기 상태는 세션 내 유지. */
function CollapsibleSection({ title, summary, open, onToggle, children }: {
  title: string;
  summary?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border-strong bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
      >
        <span className="text-[12.5px] font-extrabold text-foreground">{title}</span>
        <span className="flex items-center gap-1.5 min-w-0">
          {summary && <span className="text-[11.5px] font-bold text-gray-400 truncate">{summary}</span>}
          <ChevronDown size={14} className={`text-gray-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && <div className="px-3.5 pb-3.5 border-t border-muted pt-3">{children}</div>}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 상세 본문 (LiveConsole 우측 패널 + 드로어 공용)
// ──────────────────────────────────────────────────────────────────────────

export function ApplicantDetailContent({
  applicantId,
  jobId = null,
  focusJobId: focusJobIdProp,
  onFocusJobChange,
  variant = "panel",
  onChanged,
  detail: externalDetail,
  reload: externalReload,
  autoOpenConfirm,
  onAutoOpenConfirmConsumed,
}: {
  applicantId: number;
  jobId?: number | null;
  /** 표시 기준 공고를 부모가 들고 있을 때(드로어) — 상세 탭과 대화 탭이 같은 공고를 보게 한다.
   *  주지 않으면(응대 화면) 이 컴포넌트가 내부 state로 관리한다. */
  focusJobId?: number | null;
  onFocusJobChange?: (jobId: number | null) => void;
  variant?: "panel" | "drawer";
  onChanged?: () => void;
  detail?: Detail | null;
  reload?: () => void;
  /** 이 지원자(id 일치)의 확정 모달을 자동으로 연다 — '확정 대기' 큐의 확정 버튼이 이 패널의 확정 모달을
   *  쓰게 해서 지점·슬롯·시작일 없이 확정되던 '빠른 확정' 경로를 없앤다. 상세 로드 후에 1회만 열고,
   *  열면 onAutoOpenConfirmConsumed로 신호를 소비해 이후 리마운트에서 다시 열리지 않게 한다.
   *  (패널은 applicantId가 key라 지원자 전환 시 리마운트되므로 단순 카운터로는 신호가 유실된다.) */
  autoOpenConfirm?: { id: number; n: number; jobId?: number | null } | null;
  onAutoOpenConfirmConsumed?: () => void;
}) {
  const local = useApplicantDetail(externalDetail !== undefined ? null : applicantId);
  // 패널 안에서 매니저가 직접 고른 표시 공고. null이면 부르는 화면이 준 jobId를 따른다.
  // 이 패널의 확정·후속 발송·체크리스트는 모두 '표시 중인 공고' 기준이라, 여러 공고에 붙은 분에게는
  // 어느 공고를 보고 있는지 고를 수 있어야 한다(예전엔 가장 최근 공고로 고정돼 선택지가 없었다).
  const [focusOverrideLocal, setFocusOverrideLocal] = useState<number | null>(null);
  // 부르는 화면이 공고를 바꾸면(응대 화면 탭) 그 선택이 이깁니다 — 패널의 옛 선택이 남아 어긋나지 않게.
  useEffect(() => { setFocusOverrideLocal(null); }, [applicantId, jobId]);
  // 부모가 표시 기준 공고를 들고 있으면 그 값을 쓴다(드로어: 상세 탭·대화 탭이 같은 공고를 봐야 한다).
  const controlled = onFocusJobChange != null;
  const focusOverride = controlled ? (focusJobIdProp ?? null) : focusOverrideLocal;
  const setFocusOverride = (v: number | null) => (controlled ? onFocusJobChange!(v) : setFocusOverrideLocal(v));
  const detail = externalDetail !== undefined ? externalDetail : local.detail;
  const reload = externalReload ?? local.reload;
  const loading = externalDetail !== undefined ? false : local.loading;
  // 확정 모달 외부 오픈 — openConfirm은 아래(상세 로드 이후 구간)에서 정의되므로 최신 함수를 ref로 받는다.
  // 상세가 로드되기 전에는 확정 대상 후보를 알 수 없어 열지 않고, 로드되면 그때 연다.
  const openConfirmRef = useRef<(seedJobId?: number | null) => void>(() => {});
  const consumedAutoOpen = useRef<number | null>(null);
  useEffect(() => {
    if (!autoOpenConfirm || autoOpenConfirm.id !== applicantId) return;
    if (consumedAutoOpen.current === autoOpenConfirm.n) return;
    if (!detail) return; // 후보·지점을 알아야 대상 공고를 시드할 수 있다
    consumedAutoOpen.current = autoOpenConfirm.n;
    // 큐 카드가 보여준 공고를 그대로 시드 — 열린 링크가 여러 개일 때 다른 공고로 확정되는 오귀속 방지.
    openConfirmRef.current(autoOpenConfirm.jobId ?? null);
    onAutoOpenConfirmConsumed?.();
  }, [autoOpenConfirm, applicantId, detail, onAutoOpenConfirmConsumed]);

  const confirm = useConfirm();
  // '확정 지점' 드롭다운 소스 — 활성 지점(화주사 결속). 자유텍스트 오타로 충원율 집계가 누락되던 문제(A5) 방지.
  const { data: branchesApi } = useSWR<{ data?: { id: number; name: string; client_id: number | null; active: boolean }[] }>("/api/admin/branches");
  const allBranches = branchesApi?.data ?? [];
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Partial<ApplicantFull>>({});
  const [dirty, setDirty] = useState(false);
  // 확정 모달: 확정 시점에 슬롯을 함께 받아 confirmed_slot 공백을 방지한다.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmSlots, setConfirmSlots] = useState<string[]>([]);
  // 확정 대상 공고(진행 중 후보 중 선택) + 시작일·지점 — 확정을 공고에 결속하고 필요한 정보를 함께 받는다.
  const [confirmJobId, setConfirmJobId] = useState<number | null>(null);
  const [confirmStartDate, setConfirmStartDate] = useState("");
  const [confirmBranch, setConfirmBranch] = useState("");
  // 확정 후속 안내 발송 모달 — 어떤 종류(만남장소/첫날규칙/앱안내)를 열지. null=닫힘.
  const [followup, setFollowup] = useState<FollowupKind | null>(null);
  // 확정 후 옹고잉 앱 설치·가이드 안내 발송 옵션 — 문구는 두뇌 탭 'ongoing_app_guide'에서 관리.
  // 문구가 아직 준비되지 않았을 때 자리표시 문안이 나가지 않도록 기본 꺼짐(문구 설정 후 사용).
  const [confirmSendAppGuide, setConfirmSendAppGuide] = useState(false);
  // 인력풀 제외(=status 부적합) 확인 모달 — 모든 공고에서 빠지는 파괴적 액션이라 확인을 받는다.
  const [excludeOpen, setExcludeOpen] = useState(false);
  // 접이식 섹션 열림 상태 — undefined면 데이터 기반 기본값(진행 중 공고·status)을 따른다. 세션 내 유지.
  const [sectionOpen, setSectionOpen] = useState<Partial<Record<"jobs" | "profile" | "manage", boolean>>>({});
  // 선탑(동승) 기록 폼 — 프리보딩 자산 원장(pool_events) 수동 기록. stage: 'scheduled'(예정) | 'done'(완료).
  const [suntopFormOpen, setSuntopFormOpen] = useState(false);
  const [suntopStage, setSuntopStage] = useState<"scheduled" | "done">("done");
  const [suntopClient, setSuntopClient] = useState("");
  const [suntopLine, setSuntopLine] = useState("");
  const [suntopSchedAt, setSuntopSchedAt] = useState("");
  // 시간대 되돌리기 진행 플래그 — 쓰는 곳(clearAvailableSlots)은 아래쪽이지만 선언은 반드시 여기,
  // 상세 로딩·실패 조기 return보다 **위**에 둔다. 핸들러 옆에 두면 상세가 도착한 렌더에서만
  // 호출돼 훅 개수가 렌더마다 달라지고, React가 그 순간 화면을 통째로 날린다(#310).
  const [clearingSlots, setClearingSlots] = useState(false);

  useEffect(() => {
    setEdit({});
    setDirty(false);
    setSectionOpen({});
    setSuntopFormOpen(false);
    setSuntopClient("");
    setSuntopLine("");
  }, [applicantId]);

  // '다른 라인 활동' — 옹매니징 활성계약·지난달정산 또는 옹고잉 실배차 신호.
  // 인재풀 목록에서 '활동중' 배지를 뺀 뒤(B5) 이 값을 볼 곳이 없어져서, 한 사람 기준으로 여기서 확인한다.
  // 미연동(configured=false)과 '대조했고 활동 없음'을 구분해 표시한다 — NULL을 '비활동'으로 오해하면 이미 일하는 분에게 연락한다.
  const [activeWork, setActiveWork] = useState<{ state: "loading" | "off" | "none" | "partial" | "active"; reasons: string[] }>({ state: "loading", reasons: [] });
  useEffect(() => {
    let cancelled = false;
    setActiveWork({ state: "loading", reasons: [] });
    fetch("/api/admin/ongmanaging/active-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicantIds: [applicantId] }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: { configured?: boolean; active?: { id: number; reasons?: string[] }[]; unchecked?: number }) => {
        if (cancelled) return;
        if (!j.configured) return setActiveWork({ state: "off", reasons: [] });
        const hit = (j.active ?? []).find((x) => x.id === applicantId);
        if (hit) return setActiveWork({ state: "active", reasons: hit.reasons ?? [] });
        // unchecked>0 = 이 사람의 배차 신호가 아직 대조되지 않았다(NULL).
        // NULL을 '활동 없음'으로 뭉개지 않는다 — 마이그레이션(2026-07-tms-active-cache.sql)에 명시된 금지 사항.
        setActiveWork({ state: (j.unchecked ?? 0) > 0 ? "partial" : "none", reasons: [] });
      })
      .catch(() => {
        // 대조 실패를 '활동 없음'으로 보여주면 안 된다 — 미확인으로 남긴다.
        if (!cancelled) setActiveWork({ state: "off", reasons: [] });
      });
    return () => { cancelled = true; };
  }, [applicantId]);

  if (loading && !detail) {
    return <div className="p-6 text-[13px] text-gray-400 text-center">불러오는 중…</div>;
  }
  if (!detail) {
    return <div className="p-6 text-[13px] text-gray-400 text-center">정보를 불러오지 못했어요</div>;
  }

  const a = detail.applicant;
  const cands = detail.candidates;
  const age = calcAge(a.birth_date);
  // 시간대 판정 — 노출 규칙·조건 바와 **같은 함수**. 화면과 판정이 어긋나면 매니저가 원인을 못 찾는다.
  const slotJudgment = applicantAvailableSlots({ work_hours: a.work_hours, available_slots: a.available_slots });
  const slotDisplay = {
    text: slotJudgment.slots.length
      ? slotJudgment.slots.map((k) => SLOT_LABEL[k]).join(", ") +
        (slotJudgment.source === "self" ? " (본인 확인)" : "")
      : slotJudgment.partial
        ? "미확인 (요일만 확인됨)"
        : "",
    title:
      slotJudgment.source === "self"
        ? `대화·입력으로 확인된 값이에요. 지원 당시 폼 원문: ${a.work_hours ?? "-"}`
        : slotJudgment.source === "parsed"
          ? `지원 당시 폼 원문에서 해석한 값이에요: ${a.work_hours ?? "-"}`
          : slotJudgment.source === "form_token"
            ? "지원 폼에서 고른 시간대예요"
            : `시간대를 알 수 없어요(폼 원문: ${a.work_hours ?? "-"}). 노출 규칙에서 '미확인'을 함께 골라야 이분이 대상에 들어옵니다.`,
  };

  // 표시 대상 후보 — 패널에서 고른 공고 > 부르는 화면이 준 공고 > 최신.
  // (기본값을 '최신'에서 바꾸지 않는다 — 확정 모달·후속 발송의 대상이 조용히 달라지면 안 된다.)
  const focusJobId = focusOverride ?? jobId;
  const focusCand = (focusJobId != null ? cands.find((c) => c.job_id === focusJobId) : cands[0]) ?? null;
  // 이 목록은 **이력**이라 종료·마감·시스템 공고까지 다 보여준다. 하지만 "지금 붙어 있는 자리 N건"을
  // 셀 때는 인력풀 목록 칩·응대 화면 탭과 **같은 판정**을 써야 한다 — 안 그러면 목록 1건 · 탭 1건 ·
  // 상세 2건으로 갈려서, 이 커밋이 세우려던 불변식이 정작 확정이 일어나는 화면에서 깨진다.
  const liveCands = cands.filter((c) =>
    isLiveLinkResolved({ agentStage: c.agent_stage, jobTitle: c.job_title, jobEffectivelyClosed: c.job_effectively_closed })
  );
  const isPurePool = cands.length === 0;
  // 표시 중인 공고가 internal(도시락 등) 라인인가 — 배민 전용 필드(슬롯·지점·배민ID·배민 온보딩)를
  // 이 상세 패널 전반에서 숨기거나 라인 언어로 치환하는 단일 판정(확정 모달과 동일 규칙).
  const detailInternal = focusCand?.job_recruit_mode === "internal";

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

  // 재채용 블랙리스트 등록/해제 — "절대 재채용 불가"(노무·커뮤니케이션 핏). 콜드 발송에서 하드 제외.
  const toggleBlacklist = async () => {
    if (busy) return;
    const phone = a.phone;
    if (!phone) {
      toast.error("전화번호가 없어 블랙리스트 처리할 수 없어요");
      return;
    }
    if (detail.blacklisted) {
      const ok = await confirm({
        title: "블랙리스트 해제",
        description: `${a.name}님을 재채용 블랙리스트에서 해제할까요? 이후 캠페인 발송 대상에 다시 포함될 수 있어요.`,
        confirmText: "해제",
      });
      if (!ok) return;
      setBusy(true);
      try {
        const res = await fetch(`/api/admin/blacklist`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone }),
        });
        if (!res.ok) {
          toast.error("해제에 실패했어요");
          return;
        }
        toast.success("블랙리스트에서 해제했어요");
        await reload();
        onChanged?.();
      } finally {
        setBusy(false);
      }
    } else {
      const reason = window.prompt("재채용 블랙리스트 등록 — 사유 (노무 이슈·커뮤니케이션 핏 등)", "");
      if (reason === null) return; // 취소
      setBusy(true);
      try {
        const res = await fetch(`/api/admin/blacklist`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone, name: a.name, reason }),
        });
        if (!res.ok) {
          toast.error("등록에 실패했어요");
          return;
        }
        toast.success("블랙리스트에 등록했어요 — 콜드 발송에서 제외됩니다");
        await reload();
        onChanged?.();
      } finally {
        setBusy(false);
      }
    }
  };

  const saveFields = () => {
    if (!dirty) return;
    patch(edit, "저장했어요.");
  };

  // 대화로 채워진 시간대 되돌리기 — 이 값이 노출 규칙 판정의 1순위라, 잘못 채워지면 매니저가
  // 지울 수단이 있어야 한다(없으면 그 사람이 여러 공고에서 조용히 빠진 채 고착된다).
  // (진행 플래그 clearingSlots는 조기 return 위에서 선언한다 — 훅은 렌더마다 같은 순서·개수)
  const clearAvailableSlots = async () => {
    if (clearingSlots || busy) return;
    setClearingSlots(true);
    try {
      await patch({ available_slots: null }, "확인된 시간대를 지웠어요 — 지원 당시 값으로 판정합니다.");
    } finally {
      setClearingSlots(false);
    }
  };

  // 확정 모달 열기 — 기존 확정 슬롯(있으면)을 미리 선택해 둔다.
  // 확정 대상 공고 후보 — 진행 중(비마감) 공고만. 확정은 마감 공고로 못 하게 여기서 거른다.
  // 확정 대상 후보 = 서버 PATCH의 current_job_id 검증과 같은 기준(링크 존재 · 비마감 · 비시스템)으로 맞춘다.
  //  · 시스템 예약 공고(__ 접두)는 서버가 400으로 거절하므로 제외.
  //  · **abort(중단된 대화)는 제외하지 않는다** — 서버는 abort 후보로도 확정을 수락하고 후처리도 정합적이다
  //    (hired_at 기록·라인 태깅·죽은 링크 정리). 제외하면 '확정 대기' 큐에 뜨는 사람을 어떤 경로로도 확정할 수
  //    없어지고(예: 활성 공고 후보이지만 대화가 중단된 케이스), 안내문이 시키는 '후보로 다시 추가'도
  //    upsert(ignoreDuplicates)라 no-op이어서 막다른 길이 된다. 대신 아래에서 '중단된 대화' 경고만 보여준다.
  const confirmableCands = cands.filter(
    (c) => !c.job_effectively_closed && !isSystemJobTitle(c.job_title ?? "")
  );
  // 선택된 대상 공고의 대화가 중단(abort) 상태인지 — 확정은 허용하되 매니저가 알고 누르게 한다.
  const confirmTargetAborted =
    (confirmableCands.find((c) => c.job_id === confirmJobId) ?? confirmableCands[0])?.agent_stage === "abort";
  // 확정 대상 공고가 internal(도시락 등 정기배송) 라인인지 — 지점·슬롯은 배민/비마트 전용 개념이라
  // internal 라인 확정 창에선 숨겨 혼동을 막는다(라인 형태별 조건부 UX).
  const confirmTargetInternal =
    (confirmableCands.find((c) => c.job_id === confirmJobId) ?? confirmableCands[0])?.job_recruit_mode === "internal";
  // '확정 지점' 드롭다운 옵션 — 대상 공고 화주사의 활성 지점 이름(정확일치 집계와 맞게 branches.name 사용).
  // client_id=null(화주사 미결속 공고)이면 무소속 지점을 끌어오지 않게 빈 목록.
  const confirmClientId = (confirmableCands.find((c) => c.job_id === confirmJobId) ?? confirmableCands[0])?.client_id ?? null;
  const confirmBranchNames = confirmClientId == null ? [] : allBranches.filter((b) => b.active && b.client_id === confirmClientId).map((b) => b.name);
  // 편집 폼은 이 지원자가 연결된 모든 화주사(병행 투입 포함)의 활성 지점 — 확정 화주사가 focus와 달라도 값이 '미등록'으로 오표기되지 않게.
  const editClientIds = new Set(cands.map((c) => c.client_id).filter((id): id is number => id != null));
  const editBranchNames = allBranches.filter((b) => b.active && b.client_id != null && editClientIds.has(b.client_id)).map((b) => b.name);
  // 후속 안내(만남장소 등) 발송 대상 공고 — 매니저 확정이 결속한 current_job_id(권위 소스, 서버 검증)를 1순위로.
  // confirmed_at은 에이전트 스크리닝→온보딩 마커라 병행 후보에선 확정 공고와 다를 수 있어 폴백으로만.
  const confirmedJobId = a.current_job_id ?? (cands.find((c) => c.confirmed_at != null) ?? focusCand)?.job_id ?? null;

  // seedJobId: 외부(확정 대기 큐)에서 '그 카드가 보여준 공고'를 지정해 열 때 사용 — 열린 링크가 여러 개면
  // 큐(진행단계 우선)와 이 모달(최신 링크)의 기본 선택이 달라 다른 공고로 확정되는 오귀속이 생긴다.
  const openConfirm = (seedJobId?: number | null) => {
    setConfirmSlots(
      String(a.confirmed_slot ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    );
    // 대상 공고 기본값: 외부 시드 → 현재 포커스 후보 → 확정 가능 후보 첫 번째.
    // 대상 시드도 confirmableCands와 같은 기준(비마감·비시스템) — abort를 빼면 시드가 비어 확정이 막힌다.
    const seeded = seedJobId != null ? confirmableCands.find((c) => c.job_id === seedJobId) ?? null : null;
    const focusOpen =
      focusCand && !focusCand.job_effectively_closed && !isSystemJobTitle(focusCand.job_title ?? "") ? focusCand : null;
    const target = seeded ?? focusOpen ?? confirmableCands[0] ?? null;
    setConfirmJobId(target?.job_id ?? null);
    setConfirmStartDate(String(a.start_date ?? target?.job_start_date ?? "").slice(0, 10));
    // 지점 기본값 — '미지정'(지점 미보유 라인 자리값)은 채우지 않는다.
    const seedBranch = a.confirmed_branch ?? a.branch1 ?? target?.job_branch ?? "";
    setConfirmBranch(seedBranch === "미지정" ? "" : String(seedBranch));
    setConfirmSendAppGuide(false);
    setConfirmOpen(true);
  };
  // '확정 대기' 큐 등 외부에서 이 모달을 열 수 있게 최신 함수를 ref에 담아둔다(위 자동 오픈 effect가 호출).
  openConfirmRef.current = openConfirm;

  // 확정 후속 안내 발송 대상 공고 — 만남장소는 서버가 픽업주소(+비internal이면 현장매니저)를 요구한다.
  // PR1에서 큐의 disabled+툴팁 안내가 사라져 발송 실패를 400으로만 알게 됐던 것을 여기서 복원.
  const followupCand = cands.find((c) => c.job_id === confirmedJobId) ?? null;
  // 서버 confirm/send의 만남장소 '하드' 요건은 job_id 하나다 — 본문을 직접 쓰면(text override)
  // 집결지·현장매니저 없이도 발송된다. 그래서 버튼을 잠그는 건 job_id가 없을 때만이고,
  // 나머지는 '기본 문안 자동 완성이 안 된다'는 경고로만 알린다(직접 작성 경로를 막지 않는다).
  const venueHardBlock = !confirmedJobId
    ? "확정 시 대상 공고를 지정해야 만남장소를 보낼 수 있어요."
    : null;
  const venueWarn = venueHardBlock
    ? null
    : !followupCand || isSystemJobTitle(followupCand.job_title ?? "")
      ? "이 확정은 특정 공고에 묶이지 않아(슬롯 단위 라인) 집결지 정보가 없어요 — 문안을 직접 작성해 보내세요."
      : !followupCand.job_pickup_address
        ? "공고에 집결지가 없어 기본 문안이 자동으로 채워지지 않아요 — 공고에 집결지를 넣거나 문안을 직접 작성하세요."
        : followupCand.job_recruit_mode !== "internal" && followupCand.job_site_manager_id == null
          ? "공고에 현장매니저가 없어 기본 문안이 자동으로 채워지지 않아요 — 공고에 현장매니저를 지정하거나 문안을 직접 작성하세요."
          : null;

  const toggleConfirmSlot = (slot: string) => {
    setConfirmSlots((cur) => (cur.includes(slot) ? cur.filter((s) => s !== slot) : [...cur, slot]));
  };

  // 투입 확정 취소 — 잘못된 공고로 확정했을 때 정정. 서버가 공고 결속·확정 필드 해제 + 그 공고 AI 재개.
  const doUnconfirm = async () => {
    if (busy) return;
    const ok = await confirm({
      title: "투입 확정을 취소할까요?",
      description: `${a.name}님의 확정을 취소해요. 대상 공고 결속·시작일·확정 지점이 해제되고, 그 공고의 AI 응대가 다시 시작돼요.`,
      confirmText: "확정 취소",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/applicants/${a.id}/unconfirm`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error || "확정 취소에 실패했어요");
        return;
      }
      toast.success(`${a.name}님의 투입 확정을 취소했어요.`);
      await reload();
      onChanged?.();
    } catch {
      toast.error("확정 취소에 실패했어요");
    } finally {
      setBusy(false);
    }
  };

  // 확정 대상 공고 선택 시 시작일·지점 기본값도 그 공고 기준으로 갱신.
  const pickConfirmJob = (jid: number) => {
    setConfirmJobId(jid);
    const c = confirmableCands.find((x) => x.job_id === jid);
    if (c) {
      if (!confirmStartDate && c.job_start_date) setConfirmStartDate(String(c.job_start_date).slice(0, 10));
      // 대상 공고 전환 시 현재 지점값이 새 공고 화주사의 활성 지점에 없으면 그 공고 지점(또는 공백)으로 정정 — 타 화주사 지점 잔류로 오집계되는 것 방지.
      const nb = c.client_id == null ? [] : allBranches.filter((b) => b.active && b.client_id === c.client_id).map((b) => b.name);
      if (!nb.includes(confirmBranch)) setConfirmBranch(c.job_branch && c.job_branch !== "미지정" ? c.job_branch : "");
    }
  };

  // 확정 확정(commit) — status + 대상 공고(current_job_id) + 시작일·지점·슬롯을 한 번에 저장.
  // current_job_id로 확정이 공고에 결속되고, 서버가 잔여 후보 자동 정리·라인 태깅을 그 공고 기준으로 처리한다.
  const commitConfirm = async () => {
    const body: Record<string, unknown> = { status: "확정인력" };
    if (confirmJobId != null) body.current_job_id = confirmJobId;
    if (confirmStartDate.trim()) body.start_date = confirmStartDate.trim();
    // 지점·슬롯은 지점/슬롯 개념이 있는 라인(비internal)에서만 저장 — internal은 필드 자체가 숨겨짐.
    if (!confirmTargetInternal) {
      if (confirmSlots.length > 0) body.confirmed_slot = confirmSlots.join(", ");
      if (confirmBranch.trim()) body.confirmed_branch = confirmBranch.trim();
    }
    const ok = await patch(body, `${a.name}님을 확정인력으로 이동했어요.`);
    if (ok) {
      setConfirmOpen(false);
      // 확정 후 옹고잉 앱 안내 발송(옵션) — 문구는 두뇌 탭 'ongoing_app_guide'. 실패해도 확정은 유지.
      if (confirmSendAppGuide) {
        try {
          const res = await fetch("/api/admin/confirm/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ applicant_id: a.id, kind: "app_guide", job_id: confirmJobId ?? undefined }),
          });
          if (res.ok) toast.success("옹고잉 앱 안내 문자를 발송했어요.");
          else {
            const j = await res.json().catch(() => ({}));
            toast.error(j.error || "앱 안내 발송에 실패했어요(확정은 완료).");
          }
        } catch {
          toast.error("앱 안내 발송에 실패했어요(확정은 완료).");
        }
      }
    }
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

  // 선탑(동승) 기록/삭제 — pool_events 원장. 예정(scheduled)·완료(done) 2단계.
  // 완료 기록 시 배지가 뜨고 새 공고 안내(announce-targets)에서 S그룹(최우선) 대상이 된다.
  const openSuntopForm = (stage: "scheduled" | "done") => {
    setSuntopStage(stage);
    setSuntopClient("");
    setSuntopLine("");
    setSuntopSchedAt("");
    setSuntopFormOpen(true);
  };
  const recordSuntop = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/applicants/${a.id}/suntop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: suntopStage, client: suntopClient, line: suntopLine, scheduled_at: suntopSchedAt }),
      });
      if (!res.ok) throw new Error();
      toast.success(suntopStage === "scheduled" ? "선탑 예정으로 기록했어요." : "선탑 완료로 기록했어요. 새 공고 안내에서 최우선 대상이 됩니다.");
      setSuntopFormOpen(false);
      setSuntopClient("");
      setSuntopLine("");
      setSuntopSchedAt("");
      reload();
      onChanged?.();
    } catch {
      toast.error("선탑 기록에 실패했어요");
    } finally {
      setBusy(false);
    }
  };
  const removeSuntop = async (eventId: number) => {
    try {
      const res = await fetch(`/api/admin/applicants/${a.id}/suntop?event_id=${eventId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("선탑 기록을 삭제했어요");
      reload();
    } catch {
      toast.error("삭제에 실패했어요");
    }
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

  // 접이식 기본값 — 지원 공고: 진행 중(중단 제외) 후보가 있으면 펼침 / 온보딩·확정: 스크리닝 완료·확정인력이면 펼침.
  // 토글 전(undefined)까지만 기본값을 따르고, 한 번 토글하면 세션 내 유지된다.
  const jobsOpen = sectionOpen.jobs ?? cands.some((c) => c.agent_stage != null && c.agent_stage !== "abort");
  const profileOpen = sectionOpen.profile ?? false;
  const manageOpen = sectionOpen.manage ?? (a.status === "스크리닝 완료" || a.status === "확정인력");
  const toggleSection = (key: "jobs" | "profile" | "manage", cur: boolean) =>
    setSectionOpen((p) => ({ ...p, [key]: !cur }));

  // 상세 정보 — 값 있는 필드만 그리드로, 빈 필드는 회색 한 줄로 축약(빈 값 나열로 스크롤 낭비 방지)
  const profileFields: { label: string; value: string | null }[] = [
    { label: "연락처", value: a.phone },
    { label: "나이", value: age != null ? `${age}세` : null },
    { label: "이동수단", value: a.own_vehicle },
    { label: "면허", value: a.license_type },
    { label: "경력", value: a.experience },
    { label: "희망 근무(지원 당시 원문)", value: a.work_hours },
    { label: "희망 지점", value: a.branch1 },
    { label: "거주 지역", value: a.location },
  ];
  const filledProfile = profileFields.filter((f) => f.value);
  const emptyProfile = profileFields.filter((f) => !f.value);

  return (
    <div className="flex flex-col h-full min-h-0 @container">
      {/* panel 헤더 (LiveConsole 우측용) */}
      {variant === "panel" && (
        <div className="h-[60px] shrink-0 border-b border-border-strong px-5 flex items-center justify-between">
          <h2 className="text-[15px] font-extrabold text-foreground flex items-center gap-2">
            <Sparkles size={16} className="text-brand-yellow" /> 지원자 상세
          </h2>
          <span className="text-[11.5px] font-bold px-2 py-1 rounded-full" style={{ backgroundColor: `${STATUS_COLORS[a.status] ?? "#9CA3AF"}1A`, color: STATUS_COLORS[a.status] ?? "#374151" }}>{a.status}</span>
        </div>
      )}

      {/* 상단 고정 — 스크롤 없이 항상 보이는 '훑고 행동' 블록 (①신원 ②다시 연락 ③핵심 판단 ④액션) */}
      <div className="shrink-0 px-5 pt-4 pb-4 space-y-3 border-b border-border-strong">
        {/* ① 이름·나이·전화·지역 — 드로어는 자체 헤더가 같은 정보를 담당 */}
        {variant === "panel" && (
          <div className="flex items-center gap-x-2 gap-y-1 flex-wrap">
            <span className="text-[15px] font-extrabold text-foreground">{a.name}</span>
            {age != null && <span className="text-[12px] font-semibold text-muted-foreground">{age}세</span>}
            {telHref ? (
              <a href={telHref} className="text-[12.5px] font-bold text-info hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40">{a.phone}</a>
            ) : (
              <span className="text-[12px] text-gray-400">연락처 없음</span>
            )}
            {a.sigungu && <span className="text-[12px] text-muted-foreground flex items-center gap-0.5"><MapPin size={11} /> {a.sigungu}</span>}
          </div>
        )}

        {/* 구분·유입·단계 배지 */}
        <div className="flex items-center gap-2 flex-wrap">
          {isPurePool ? (
            <span className="px-2.5 py-1 rounded-full text-[11.5px] font-bold bg-muted text-gray-700">순수 인재풀</span>
          ) : (
            <span className="px-2.5 py-1 rounded-full text-[11.5px] font-bold bg-info-soft text-info">공고 지원자 · {cands.length}건</span>
          )}
          {a.source && <span className="px-2.5 py-1 rounded-full text-[11.5px] font-bold bg-background text-muted-foreground border border-border-strong" title="유입 채널 — 이 지원자가 처음 들어온 경로">유입 · {SOURCE_LABEL[a.source] ?? a.source}</span>}
          {focusCand?.agent_stage && <span className="px-2.5 py-1 rounded-full text-[11.5px] font-bold bg-copilot-soft text-copilot">{STAGE_LABEL[focusCand.agent_stage] ?? focusCand.agent_stage}</span>}
          {detail.suntop?.done && (
            <span className="px-2.5 py-1 rounded-full text-[11.5px] font-bold bg-success-soft text-success-strong border border-success/25" title={`선탑(동승) 완료 ${detail.suntop.events.length}회 — 현장을 미리 경험한 프리보딩 인력. 새 공고 안내 시 최우선 대상`}>선탑 완료</span>
          )}
          {a.tms_active_signal === true && (
            <span
              className="px-2.5 py-1 rounded-full text-[11.5px] font-bold bg-yellow-50 text-yellow-700 border border-yellow-300"
              title={`옹고잉 실배차 기준 현재 활동 중 — 최근/예정 배차 있음${a.tms_active_checked_at ? ` (${relTime(a.tms_active_checked_at)} 확인)` : ""}. 콜드 상태로 다시 연락하기 전 검토 대상(병행 가능 건이면 유지 가능 — 자동 제외 아님)`}
            >
              활동 중(옹고잉)
            </span>
          )}
          {a.sms_opt_out_at && (
            <span className="px-2.5 py-1 rounded-full text-[11.5px] font-bold bg-error-soft text-error-strong border border-error/30" title={`수신거부 등록 ${relTime(a.sms_opt_out_at)} — 캠페인 발송 제외. 해제는 아래 '상세 정보'에서`}>수신거부</span>
          )}
          {detail.blacklisted && (
            <span className="px-2.5 py-1 rounded-full text-[11.5px] font-bold bg-foreground text-white" title="재채용 블랙리스트 — 절대 재채용 불가. 콜드 발송에서 하드 제외됩니다">블랙리스트</span>
          )}
          <button
            onClick={toggleBlacklist}
            disabled={busy}
            className="px-2 py-1 rounded-full text-[11px] font-bold border border-border-strong text-muted-foreground hover:bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow disabled:opacity-50"
          >
            {detail.blacklisted ? "블랙리스트 해제" : "블랙리스트 등록"}
          </button>
        </div>

        {/* 옹매니징 연동 — 전화 매칭된 계약 배송원의 차종·라인·정산 요약(개인정보·금액 미반입) */}
        {detail.ongmanaging && (
          <div className="rounded-xl border border-success/25 bg-success-soft p-3.5 space-y-2">
            <h3 className="text-[12.5px] font-extrabold text-success-strong">옹매니징 연동 · 계약 배송원</h3>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-success-strong">
              {detail.ongmanaging.vehicleType && <span>차종 <b>{detail.ongmanaging.vehicleType}</b></span>}
              {detail.ongmanaging.isBackupSpecialist && <span className="font-bold text-yellow-700">백업 전문가</span>}
              <span>정산 <b>{detail.ongmanaging.settledMonths}개월</b>{detail.ongmanaging.lastSettledMonth ? ` · 최근 ${detail.ongmanaging.lastSettledMonth}` : ""}</span>
              {detail.ongmanaging.managerName && <span>담당 {detail.ongmanaging.managerName}</span>}
            </div>
            {detail.ongmanaging.lines.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {detail.ongmanaging.lines.map((l, i) => (
                  <span key={i} className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-white border border-success/25 text-success-strong">
                    {l.lineName}{l.clientName ? ` · ${l.clientName}` : ""}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ② 다시 연락 반응 요약 — "이 답장이 무엇에 대한 것인지"를 스레드 옆에서 바로 대조 */}
        {hasRecontact && recontact && (
          <div className="rounded-xl border border-info/25 bg-info-soft p-3.5 space-y-2.5">
            <h3 className="text-[12.5px] font-extrabold text-info-strong flex items-center gap-1.5">
              <Zap size={14} /> 다시 연락 반응
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-3 gap-y-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-bold text-gray-400">마지막 발송</span>
                <span className="text-[12.5px] font-semibold text-foreground" title={recontact.last_ping_at ?? undefined}>
                  {recontact.last_ping_at ? relTime(recontact.last_ping_at) : "없음"}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-bold text-gray-400">링크 열람</span>
                <span className="text-[12.5px] font-semibold text-foreground" title={recontact.last_link_view_at ?? undefined}>
                  {recontact.last_link_view_at ? relTime(recontact.last_link_view_at) : "미열람"}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-bold text-gray-400">마지막 답장</span>
                <span className="text-[12.5px] font-semibold text-foreground" title={a.last_message_at ?? undefined}>
                  {a.last_message_at ? relTime(a.last_message_at) : "없음"}
                </span>
              </div>
            </div>
            {recontact.interest_jobs.length > 0 && (
              <div>
                <span className="text-[11px] font-bold text-gray-400">관심 클릭 공고 · 클릭 시 대기 안내 문구 복사</span>
                <div className="flex gap-1.5 flex-wrap mt-1.5">
                  {recontact.interest_jobs.map((ij) => (
                    <button
                      key={ij.job_id}
                      onClick={() => copyInterestReply(ij)}
                      title={`${ij.title ?? `공고 #${ij.job_id}`} — 관심 클릭 ${relTime(ij.clicked_at)} · 대기 안내 문구를 클립보드에 복사`}
                      className="px-2.5 py-1 rounded-full text-[11.5px] font-bold bg-white border border-info/25 text-info-strong hover:bg-info/25 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
                    >
                      ⭐ {shortJobTitle(ij.title, ij.job_id)}
                      {ij.immediate && <span className="ml-1 text-success-strong">· 바로가능</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ③ 핵심 판단 정보 — 자차·가용성·원지원일·희망 시간 (좁은 우측 패널에선 2칸, 드로어에선 4칸) */}
        <div className="rounded-xl border border-border-strong bg-background p-3 grid grid-cols-1 sm:grid-cols-2 @md:grid-cols-4 gap-x-3 gap-y-2">
          <KeyCell label="자차" value={[a.own_vehicle, a.vehicle_type].filter(Boolean).join(" · ") || null} title="이동수단 · 차종" />
          <KeyCell
            label="가용성"
            value={a.availability}
            empty="미확인"
            sub={a.availability_updated_at ? `확인 ${relTime(a.availability_updated_at)}` : undefined}
            title="지금 일할 수 있는 상태인지 — 확인 시점이 오래됐다면 재확인이 필요해요"
          />
          <KeyCell
            label="원지원일"
            value={appliedMonth(a.applied_at)}
            empty="기록 없음"
            title={a.applied_at ? `처음 지원한 날: ${new Date(a.applied_at).toLocaleDateString("ko-KR")}` : "처음 지원한 시점 기록이 없어요"}
          />
          {/* 시간대는 **판정 결과**를 보여준다 — 노출 규칙·조건 바가 쓰는 값과 화면이 달라지면
              '왜 이 사람이 빠졌는지'를 알 수 없다. 자기 신고(AI 대화·매니저 입력)면 그 사실과 되돌리기를 함께. */}
          <KeyCell
            label="희망 시간"
            value={slotDisplay.text}
            empty="미확인"
            title={slotDisplay.title}
            action={
              slotJudgment.source === "self" ? (
                <button
                  type="button"
                  onClick={clearAvailableSlots}
                  disabled={clearingSlots}
                  title="대화·입력으로 채워진 시간대를 지웁니다. 지우면 지원 당시 폼 값으로 판정하고, 이후 대화에서 다시 확인될 수 있어요."
                  className="text-[10px] font-bold text-error-strong hover:underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow rounded"
                >
                  지우기
                </button>
              ) : undefined
            }
          />
          {/* 다른 라인 활동 — 인재풀 목록에서 뺀 '활동중' 신호를 사람 단위로 여기서 확인한다.
              '확인 안 됨'(미연동·조회 실패)과 '활동 없음'을 구분해 적는다 — 둘을 같게 보여주면 이미 일하는 분에게 연락하게 된다. */}
          <KeyCell
            label="다른 라인 활동"
            value={
              activeWork.state === "active"
                ? [
                    activeWork.reasons.includes("active_contract") ? "계약 진행" : null,
                    activeWork.reasons.includes("recent_settlement") ? "지난달 정산" : null,
                    activeWork.reasons.includes("tms_active") ? "배차 있음" : null,
                  ].filter(Boolean).join(" · ") || "활동 중"
                : activeWork.state === "none"
                  ? "활동 없음"
                  : activeWork.state === "partial"
                    ? "일부 확인 안 됨"
                    : null
            }
            empty={activeWork.state === "loading" ? "확인 중…" : "확인 안 됨"}
            title={
              activeWork.state === "partial"
                ? "계약·정산은 대조했지만 배차 신호가 아직 동기화되지 않았어요(하루 1회 갱신). 활동 없음으로 단정할 수 없어요."
                : "옹매니징 계약·정산 또는 옹고잉 배차 기준. '확인 안 됨'은 연동이 없거나 조회에 실패한 상태로, 활동 없음을 뜻하지 않아요."
            }
          />
        </div>

        {/* ④ 핵심 액션 */}
        <div className="flex gap-2">
          <a href={telHref} onClick={(e) => { if (!telHref) { e.preventDefault(); toast.error("연락처가 없어요."); } }} className="flex-1 bg-background hover:bg-muted border border-border-strong text-foreground py-2 rounded-xl text-[12.5px] font-bold flex justify-center items-center gap-1.5 transition-colors"><Phone size={14} /> 전화</a>
          <button
            onClick={async () => {
              if (!a.access_token) return toast.error("이 지원자 전용 맞춤 공고 링크가 아직 없어요. 다시 연락 문자를 보내면 자동으로 만들어져요.");
              try {
                await navigator.clipboard.writeText(`${window.location.origin}/p/${a.access_token}`);
                toast.success("맞춤 공고 링크를 복사했어요. 문자로 보내주세요.");
              } catch {
                toast.error("복사에 실패했어요");
              }
            }}
            className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex-1 bg-background hover:bg-muted border border-border-strong text-foreground py-2 rounded-xl text-[12.5px] font-bold flex justify-center items-center gap-1.5 transition-colors"
            title="이 지원자 전용 맞춤 공고 페이지 링크 복사 — 문자에 붙여 보낼 수 있어요"
          >
            <MessageSquare size={14} /> 맞춤 공고 링크
          </button>
          {a.status === "확정인력" ? (
            <button onClick={doUnconfirm} disabled={busy} title="투입 확정을 취소하고 대상 공고 결속·확정 필드를 해제합니다" className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex-1 bg-white border border-warning text-warning hover:bg-yellow-50 py-2 rounded-xl text-[12.5px] font-bold flex justify-center items-center gap-1.5 disabled:opacity-50"><RotateCcw size={14} /> 확정 취소</button>
          ) : (
            <button onClick={() => openConfirm()} disabled={busy} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex-1 bg-foreground hover:bg-gray-800 text-white py-2 rounded-xl text-[12.5px] font-bold flex justify-center items-center gap-1.5 disabled:opacity-50"><UserCheck size={14} /> 확정</button>
          )}
          <button onClick={() => setExcludeOpen(true)} disabled={busy} title="인력풀에서 제외 — 모든 공고에서 빠집니다" className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 bg-white border border-error text-error py-2 rounded-xl text-[12.5px] font-bold hover:bg-error-soft disabled:opacity-50 flex items-center gap-1.5"><Ban size={14} /></button>
        </div>
      </div>

      {/* 접이식 상세 — 기본 접힘. 헤더 클릭으로 필요한 것만 펼친다 */}
      <div className="flex-1 overflow-y-auto p-5 space-y-3 min-h-0">
        {/* 지원 공고 — 후보 목록 + 진행 체크리스트 (진행 중 공고가 있으면 기본 펼침) */}
        {!isPurePool && (
          <CollapsibleSection
            title="지원 공고"
            summary={`${liveCands.length}건${cands.length > liveCands.length ? ` · 지난 ${cands.length - liveCands.length}` : ""}${focusCand ? ` · 스크리닝 ${screeningDone}/${SCREENING_KEYS.length}` : ""}`}
            open={jobsOpen}
            onToggle={() => toggleSection("jobs", jobsOpen)}
          >
            {liveCands.length > 1 && (
              <div className="mb-2 text-[11.5px] font-bold text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg px-2.5 py-1.5 leading-snug">
                이 분은 공고 {liveCands.length}건에 붙어 있어요 — 아래에서 공고를 누르면 그 공고 기준으로 바뀝니다
                (체크리스트·확정 창 대상이 <b>표시 중</b> 공고를 따라가요).
                {/* 후속 안내는 '확정된 공고' 기준이라 표시 중과 다를 수 있다 — 여기서 같이 움직인다고 적으면 거짓이다. */}
                <br />
                만남장소·첫날·앱안내는 <b>확정된 공고</b> 기준으로 나가요.
              </div>
            )}
            <div className="space-y-2">
              {cands.map((c) => {
                const isFocus = focusCand?.id === c.id;
                // 공고가 1건이면 고를 것이 없어 버튼으로 만들지 않는다(누를 수 있어 보이는 오해 방지).
                const selectable = cands.length > 1;
                return (
                  <div
                    key={c.id}
                    role={selectable ? "button" : undefined}
                    tabIndex={selectable ? 0 : undefined}
                    aria-pressed={selectable ? isFocus : undefined}
                    onClick={selectable ? () => setFocusOverride(c.job_id) : undefined}
                    onKeyDown={
                      selectable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setFocusOverride(c.job_id);
                            }
                          }
                        : undefined
                    }
                    className={`rounded-xl border p-3 ${isFocus ? "border-brand-yellow bg-yellow-50" : "border-border-strong bg-white"} ${
                      selectable ? "cursor-pointer hover:border-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      {/* 시스템 더미 공고는 제목 원문(`__baemin_system__`)을 그대로 보여주지 않는다 —
                          인계 큐·대상 판정과 같은 라벨 규칙('공고 미지정'). */}
                      <span className="text-[13px] font-bold text-foreground line-clamp-1">
                        {isSystemJobTitle(c.job_title ?? "") ? "공고 미지정 (내부 처리용)" : c.job_title ?? `공고 #${c.job_id}`}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {selectable && isFocus && (
                          <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded-full bg-foreground text-white">표시 중</span>
                        )}
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-copilot-soft text-copilot">
                          {/* 단계가 비어 있으면 '관심만 누른 상태' — '-'로 두면 매니저가 이유를 알 수 없다. */}
                          {STAGE_LABEL[c.agent_stage ?? ""] ?? c.agent_stage ?? "관심"}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5 text-[11.5px] text-muted-foreground flex-wrap">
                      {c.job_branch && <span className="flex items-center gap-1"><MapPin size={11} /> {c.job_branch}</span>}
                      {c.client_name && <span className="flex items-center gap-1"><Building2 size={11} /> {c.client_name}</span>}
                      {c.job_effectively_closed && <span className="font-bold text-gray-400">마감된 공고</span>}
                      {/* 지금 붙어 있는 자리가 아닌 행 — 위 '공고 N건'에 세지 않는다는 것을 눈으로도 알 수 있게. */}
                      {c.agent_stage === "abort" && <span className="font-bold text-gray-400">종료된 건</span>}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 스크리닝 / 온보딩 진행 — 표시 중인 공고 기준 */}
            {focusCand && (
              <div className="grid grid-cols-1 gap-3 mt-3">
                {(() => {
                  // internal 라인은 비마트 전용 자동통과 항목을 감추고 유효 3개만 라인 언어로 표시.
                  const keys = detailInternal ? GENERAL_SCREENING_KEYS : SCREENING_KEYS;
                  const labels = detailInternal ? GENERAL_SCREENING_LABELS : SCREENING_LABELS;
                  const done = keys.filter((k) => screening[k] === true).length;
                  return (
                    <div className="rounded-xl border border-border-strong p-3.5 bg-white">
                      <div className="flex items-center justify-between mb-1">
                        <h3 className="text-[12.5px] font-extrabold text-foreground">스크리닝 체크리스트</h3>
                        <span className="text-[12px] font-extrabold text-info">{done}/{keys.length}</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden mb-2"><div className="h-full bg-info rounded-full" style={{ width: `${(done / keys.length) * 100}%` }} /></div>
                      {keys.map((k) => <ChecklistRow key={k} label={labels[k]} done={screening[k] === true} />)}
                    </div>
                  );
                })()}
                {/* 온보딩 체크리스트는 배민 커넥트 온보딩 전용 — internal 라인엔 표시하지 않는다(선탑 이력이 대체). */}
                {!detailInternal && (focusCand.agent_stage === "onboarding" || focusCand.agent_stage === "active" || onboardingDone > 0) && (
                  <div className="rounded-xl border border-border-strong p-3.5 bg-white">
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-[12.5px] font-extrabold text-foreground">온보딩 체크리스트</h3>
                      <span className="text-[12px] font-extrabold text-success">{onboardingDone}/{ONBOARDING_KEYS.length}</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden mb-2"><div className="h-full bg-success rounded-full" style={{ width: `${(onboardingDone / ONBOARDING_KEYS.length) * 100}%` }} /></div>
                    {ONBOARDING_KEYS.map((k) => <ChecklistRow key={k} label={ONBOARDING_LABELS[k]} done={onboarding[k] === true} />)}
                  </div>
                )}
              </div>
            )}
          </CollapsibleSection>
        )}

        {/* 상세 정보 — 기본 접힘. 값 있는 필드만 그리드, 빈 필드는 아래 한 줄로 축약 */}
        <CollapsibleSection
          title="상세 정보"
          summary={emptyProfile.length > 0 ? `미입력 ${emptyProfile.length}` : undefined}
          open={profileOpen}
          onToggle={() => toggleSection("profile", profileOpen)}
        >
          <div className="flex items-center justify-between gap-2 mb-3">
            <span className="text-[11px] font-bold text-gray-400">문자 수신</span>
            {a.sms_opt_out_at ? (
              <div className="flex items-center gap-1.5">
                <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-error-soft text-error-strong border border-error/30" title={`수신거부 등록: ${relTime(a.sms_opt_out_at)}`}>수신거부 — 캠페인 발송 제외</span>
                <button
                  onClick={toggleOptOut}
                  disabled={busy}
                  title="수신거부 해제 — 다시 캠페인 발송 대상에 포함"
                  className="px-2 py-0.5 rounded-full text-[11px] font-bold text-gray-700 bg-white hover:bg-muted border border-border-strong transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
                >
                  해제
                </button>
              </div>
            ) : (
              <button
                onClick={toggleOptOut}
                disabled={busy}
                title="수신거부 수동 등록 — 캠페인 발송이 영구 중단됩니다"
                className="px-2 py-0.5 rounded-full text-[11px] font-bold text-error-strong bg-white hover:bg-error-soft border border-error/30 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
              >
                수신거부 등록
              </button>
            )}
          </div>
          {filledProfile.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              {filledProfile.map((f) => <InfoCell key={f.label} label={f.label} value={f.value} />)}
            </div>
          )}
          {emptyProfile.length > 0 && (
            <p className="text-[11.5px] text-gray-400 mt-3">미입력 · {emptyProfile.map((f) => f.label).join(" · ")}</p>
          )}
        </CollapsibleSection>

        {/* 온보딩·확정 관리 — 스크리닝 완료·확정인력이면 기본 펼침 */}
        <CollapsibleSection
          title="온보딩 · 확정 관리"
          summary={dirty ? <span className="text-yellow-600">저장 안 된 변경</span> : undefined}
          open={manageOpen}
          onToggle={() => toggleSection("manage", manageOpen)}
        >
          <div className="space-y-3">
            {/* 확정 후속 안내 — 확정인력에 지속 노출. 확정하면 '확정 대기' 큐에서 빠져 만남장소·첫날규칙 발송 경로가 끊기던 문제(주제 C1) 해소. 발송·문구는 공용 send 라우트(미리보기·편집) 재사용. */}
            {a.status === "확정인력" && (
              <div className="rounded-xl border border-success/25 bg-success-soft p-3">
                <div className="text-[12px] font-bold text-success-strong mb-2">확정 후속 안내 발송</div>
                <div className="flex gap-1.5 flex-wrap">
                  <button onClick={() => setFollowup("venue")} disabled={!!venueHardBlock} title={venueHardBlock ?? venueWarn ?? "만남장소 안내 발송 (내용 확인·수정)"} className="px-2.5 py-1 rounded-full text-[11.5px] font-bold bg-info-soft text-info-strong border border-info/25 hover:bg-info/25 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow disabled:opacity-40 disabled:cursor-not-allowed">만남장소</button>
                  <button onClick={() => setFollowup("first_day")} className="px-2.5 py-1 rounded-full text-[11.5px] font-bold bg-yellow-50 text-yellow-700 border border-yellow-200 hover:bg-yellow-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow">첫날규칙</button>
                  <button onClick={() => setFollowup("app_guide")} className="px-2.5 py-1 rounded-full text-[11.5px] font-bold bg-muted text-gray-700 border border-border-strong hover:bg-gray-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow">앱안내</button>
                </div>
                {/* **발송 대상 공고를 이름으로 밝힌다** — 이 발송은 '표시 중' 공고가 아니라 확정 결속
                    (current_job_id)을 따른다. 공고 6~7개가 동시에 열리면 매니저는 표시 중 공고를 보고
                    발송을 누르게 되고, 미리보기 본문의 주소만으로는 대상이 다른 것을 알아채기 어렵다. */}
                <p className="text-[10.5px] text-success-strong mt-1.5">
                  발송 대상 공고: <b>{followupCand ? (isSystemJobTitle(followupCand.job_title ?? "") ? "공고 미지정 (슬롯 단위 라인)" : followupCand.job_title) : "미지정"}</b>
                </p>
                {confirmedJobId != null && focusCand && confirmedJobId !== focusCand.job_id && (
                  <p className="text-[10.5px] font-bold text-warning-strong mt-0.5 leading-relaxed">
                    표시 중 공고와 달라요 — 다른 공고로 보내려면 그 공고로 다시 확정해야 해요.
                  </p>
                )}
                {/* 만남장소가 왜 안 눌리는지/왜 문안이 안 채워지는지 그 자리에서 알려준다(발송 후 400으로만 알게 되던 문제). */}
                {venueHardBlock ? (
                  <p className="text-[10.5px] text-yellow-700 mt-1.5 leading-relaxed">만남장소 발송 불가 — {venueHardBlock}</p>
                ) : venueWarn ? (
                  <p className="text-[10.5px] text-yellow-700 mt-1.5 leading-relaxed">{venueWarn}</p>
                ) : (
                  <p className="text-[10.5px] text-muted-foreground mt-1.5">신입에게 만남장소·첫날 규칙을 발송하세요. 내용은 발송 전 미리보기에서 수정할 수 있어요.</p>
                )}
              </div>
            )}
            {/* 확정 슬롯(비마트 전용) + 마지막 메시지 시점. internal 라인은 슬롯 개념이 없어 시각만 표시. */}
            {detailInternal ? (
              <div className="flex items-center justify-end">
                <span className="flex items-center gap-1 text-[11px] text-gray-400" title="이 지원자와 주고받은 마지막 메시지 시점"><Clock size={12} /> 마지막 메시지 {relTime(a.last_message_at)}</span>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-gray-400">확정 슬롯</span>
                  <span className="flex items-center gap-1 text-[11px] text-gray-400" title="이 지원자와 주고받은 마지막 메시지 시점"><Clock size={12} /> 마지막 메시지 {relTime(a.last_message_at)}</span>
                </div>
                <div className="flex gap-1.5 flex-wrap mt-1.5">
                  {SLOTS.map((s) => {
                    const on = String(val("confirmed_slot") ?? "").split(",").map((x) => x.trim()).includes(s);
                    return (
                      <button key={s} onClick={() => toggleSlot(s)} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-2.5 py-1 rounded-full text-[11.5px] font-bold transition-all ${on ? "bg-brand-yellow text-foreground" : "bg-background border border-border-strong text-muted-foreground"}`}>{s}</button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* 확정 지점 — 등록 지점 드롭다운. 지점 개념 라인·등록 지점 있을 때만(internal·미보유 숨김). */}
              {!detailInternal && (editBranchNames.length > 0 || String(val("confirmed_branch") ?? "").trim() !== "") && (
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-bold text-gray-400">확정 지점</span>
                  <select value={String(val("confirmed_branch") ?? "")} onChange={(e) => setField("confirmed_branch", e.target.value)} className="pr-8 border border-border-strong rounded-lg px-2.5 py-1.5 text-[12.5px] bg-white focus:outline-none focus:border-brand-yellow">
                    <option value="">미지정</option>
                    {editBranchNames.map((n) => <option key={n} value={n}>{n}</option>)}
                    {String(val("confirmed_branch") ?? "").trim() !== "" && !editBranchNames.includes(String(val("confirmed_branch"))) && <option value={String(val("confirmed_branch"))}>{String(val("confirmed_branch"))} (미등록)</option>}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold text-gray-400">근무 시작일</span>
                <input type="date" value={String(val("start_date") ?? "")} onChange={(e) => setField("start_date", e.target.value)} className="border border-border-strong rounded-xl px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-brand-yellow" />
              </label>
              {/* 배민 커넥트 ID — 배민 온보딩 전용. internal은 숨김. */}
              {!detailInternal && (
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-bold text-gray-400">배민 커넥트 ID</span>
                  <input value={String(val("baemin_id") ?? "")} onChange={(e) => setField("baemin_id", e.target.value)} className="border border-border-strong rounded-xl px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-brand-yellow" />
                </label>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold text-gray-400">온보딩 통화</span>
                <select value={callStatus} onChange={(e) => setField("onboarding_call_status", e.target.value)} className="pr-8 border border-border-strong rounded-lg px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-brand-yellow bg-white">
                  <option value="">미지정</option>
                  {legacyCallStatus && <option value={callStatus}>{callStatus}</option>}
                  {CALL_STATUS_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold text-gray-400" title="지금 일할 수 있는 상태인지 — 값이 같아도 재확인하면 확인 시점이 갱신돼요">
                  가용성
                  {a.availability_updated_at && <span className="font-medium"> · 확인: {relTime(a.availability_updated_at)}</span>}
                </span>
                <select value={String(val("availability") ?? "")} onChange={(e) => setField("availability", e.target.value)} className="pr-8 border border-border-strong rounded-lg px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-brand-yellow bg-white">
                  <option value="">미확인</option>
                  {AVAILABILITY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            </div>

            {/* 선탑(동승) 이력 — 예정→완료 2단계 원장. 완료 기록 시 배지 + 새 공고 안내 S그룹(최우선). */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-gray-400" title="선탑 = 현장을 미리 경험한 프리보딩. 예정→완료→투입 단계로 남겨 전환율을 추적해요">선탑(동승) 이력</span>
                {!suntopFormOpen ? (
                  <div className="flex items-center gap-2">
                    <button onClick={() => openSuntopForm("scheduled")} className="text-[11.5px] font-bold text-yellow-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow rounded">+ 예정</button>
                    <button onClick={() => openSuntopForm("done")} className="text-[11.5px] font-bold text-success-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow rounded">+ 완료</button>
                  </div>
                ) : (
                  <button onClick={() => setSuntopFormOpen(false)} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-[11.5px] font-bold text-muted-foreground hover:underline rounded">닫기</button>
                )}
              </div>
              {/* 3단계 진행 표시 — 예정 → 완료 → 투입(status='확정인력') */}
              <div className="flex items-center gap-1 mt-1.5 text-[11px] font-bold">
                {([["예정", !!detail.suntop?.scheduled], ["완료", !!detail.suntop?.done], ["투입", a.status === "확정인력"]] as [string, boolean][]).map(([label, on], i) => (
                  <span key={label} className="flex items-center gap-1">
                    {i > 0 && <span className="text-gray-300">→</span>}
                    <span className={`px-2 py-0.5 rounded-full border ${on ? "bg-success-soft text-success-strong border-success/25" : "bg-background text-gray-400 border-border-strong"}`}>
                      {on ? "✓ " : ""}{label}
                    </span>
                  </span>
                ))}
              </div>
              {(detail.suntop?.events?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {detail.suntop!.events.map((ev) => {
                    const isSched = ev.stage === "scheduled";
                    const when = isSched && ev.meta?.scheduled_at ? ev.meta.scheduled_at : new Date(ev.created_at).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
                    return (
                      <span key={ev.id} className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11.5px] font-bold border ${isSched ? "bg-yellow-50 text-yellow-700 border-yellow-200" : "bg-success-soft text-success-strong border-success/25"}`}>
                        {isSched ? "예정" : "완료"} · {[ev.meta?.client, ev.meta?.line].filter(Boolean).join(" ") || "선탑"} · {when}
                        <button onClick={() => removeSuntop(ev.id)} title="기록 삭제(오기록 정정)" className="hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow rounded"><X size={11} /></button>
                      </span>
                    );
                  })}
                </div>
              )}
              {suntopFormOpen && (
                <div className="mt-2 space-y-1.5 p-2 rounded-lg bg-background border border-border-strong">
                  <div className="text-[11px] font-bold text-gray-700">{suntopStage === "scheduled" ? "선탑 예정 등록" : "선탑 완료 기록"}</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    <input value={suntopClient} onChange={(e) => setSuntopClient(e.target.value)} placeholder="화주사 (예: 도시락)" className="border border-border-strong rounded-xl px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-brand-yellow" />
                    <input value={suntopLine} onChange={(e) => setSuntopLine(e.target.value)} placeholder="라인·지역 (예: 강남)" className="border border-border-strong rounded-xl px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-brand-yellow" />
                  </div>
                  {suntopStage === "scheduled" && (
                    <input type="date" value={suntopSchedAt} onChange={(e) => setSuntopSchedAt(e.target.value)} className="w-full border border-border-strong rounded-xl px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-brand-yellow" />
                  )}
                  <button onClick={recordSuntop} disabled={busy} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full py-1.5 rounded-lg text-[12px] font-bold text-white disabled:opacity-50 flex justify-center items-center gap-1.5 ${suntopStage === "scheduled" ? "bg-yellow-700 hover:bg-warning-strong" : "bg-success-strong hover:bg-success-strong"}`}>
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {suntopStage === "scheduled" ? "선탑 예정으로 기록" : "선탑 완료로 기록"}
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={!!val("guide_sent")} onChange={(e) => setField("guide_sent", e.target.checked)} className="accent-brand-yellow w-4 h-4" />
                <span className="text-[12px] font-semibold text-gray-700">{detailInternal ? "앱 안내 전달" : "가이드 전달"}</span>
              </label>
              {/* 카카오 채널 친구는 배민 온보딩 단계 — internal 라인엔 표시하지 않는다. */}
              {!detailInternal && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!val("kakao_channel_friend")} onChange={(e) => setField("kakao_channel_friend", e.target.checked)} className="accent-brand-yellow w-4 h-4" />
                  <span className="text-[12px] font-semibold text-gray-700">카카오 채널 친구</span>
                </label>
              )}
            </div>

            <button onClick={saveFields} disabled={!dirty || busy} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full bg-foreground hover:bg-gray-800 text-white py-2 rounded-xl text-[12.5px] font-bold flex justify-center items-center gap-1.5 disabled:opacity-40 transition-colors">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 저장
            </button>
          </div>
        </CollapsibleSection>
      </div>

      {/* 확정 후속 안내 발송 모달 — 미리보기·편집·발송(공용 send 라우트).
          defaultStartDate: 지원자 시작일이 없으면 확정 공고의 시작일로 시드 — 큐에서 확정하면
          지원자 start_date가 비어 있을 수 있어 만남장소 미리보기가 빈 날짜로 열리던 마찰 제거. */}
      {followup && (
        <FollowupSendModal
          applicantId={a.id}
          applicantName={a.name}
          jobId={confirmedJobId}
          kind={followup}
          defaultStartDate={a.start_date ?? followupCand?.job_start_date ?? null}
          onClose={() => setFollowup(null)}
          onSent={reload}
        />
      )}

      {/* 확정 모달 — 확정 시점에 슬롯을 함께 지정해 슬롯 보드 정확도를 확보 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{a.name}님을 확정인력으로</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              어느 공고에 확정하는지·시작일을 함께 지정하면 충원율·통계가 그 공고에 정확히 반영되고, 다른 공고의 진행 후보는 자동 정리됩니다.
              {a.work_hours ? `\n희망 시간대: ${a.work_hours}` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* 확정 대상 공고 — 비마감·비시스템 후보(서버 검증과 동일 기준). 중단된 대화도 확정 가능하되 표시한다. */}
          <div>
            <span className="text-[11px] font-bold text-gray-400">확정 공고</span>
            {confirmableCands.length === 0 ? (
              <p className="text-[11.5px] text-error mt-1.5 leading-relaxed">
                확정할 수 있는 공고가 없어요 — 연결된 공고가 마감됐거나 아직 어떤 공고에도 후보로 없어요.
                채용공고 탭에서 이 지원자를 공고 후보로 추가한 뒤 확정해 주세요.
              </p>
            ) : confirmableCands.length === 1 ? (
              <div className="mt-1.5 px-3 py-2 rounded-lg bg-success-soft border border-success/25 text-[12.5px] font-bold text-success-strong flex items-center gap-1.5 flex-wrap">
                {confirmableCands[0].job_title ?? `공고 #${confirmableCands[0].job_id}`}
                {confirmableCands[0].agent_stage === "abort" && (
                  <span className="text-[10.5px] font-bold text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-1.5 py-0.5">중단된 대화</span>
                )}
              </div>
            ) : (
              <div className="flex gap-1.5 flex-wrap mt-1.5">
                {confirmableCands.map((c) => (
                  <button
                    key={c.job_id}
                    type="button"
                    onClick={() => pickConfirmJob(c.job_id)}
                    className={`px-2.5 py-1.5 rounded-md text-[12px] font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow ${confirmJobId === c.job_id ? "bg-brand-yellow text-foreground" : "bg-background border border-border-strong text-muted-foreground"}`}
                  >
                    {c.job_title ?? `공고 #${c.job_id}`}
                    {c.agent_stage === "abort" && <span className="ml-1 text-[10px] text-yellow-700">중단</span>}
                  </button>
                ))}
              </div>
            )}
            {/* 중단된 대화로도 확정은 되지만(서버 수락), 매니저가 모르고 누르지 않게 한 줄로 알린다. */}
            {confirmTargetAborted && (
              <p className="text-[11px] text-yellow-700 mt-1.5 leading-relaxed">
                이 공고 대화는 중단(abort) 상태예요. 그래도 이 공고로 확정하면 충원율·라인 경험은 정상 반영돼요.
              </p>
            )}
          </div>

          <div className={(!confirmTargetInternal && (confirmBranchNames.length > 0 || confirmBranch.trim() !== "")) ? "grid grid-cols-1 sm:grid-cols-2 gap-3" : ""}>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-bold text-gray-400">근무 시작일</span>
              <input type="date" value={confirmStartDate} onChange={(e) => setConfirmStartDate(e.target.value)} className="border border-border-strong rounded-xl px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:border-brand-yellow" />
            </label>
            {/* 확정 지점 — 등록 지점 드롭다운(자유입력 폐지 → 오타 집계 누락 방지). 지점 개념 라인·등록 지점 있을 때만. */}
            {!confirmTargetInternal && (confirmBranchNames.length > 0 || confirmBranch.trim() !== "") && (
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold text-gray-400">확정 지점(선택)</span>
                <select value={confirmBranch} onChange={(e) => setConfirmBranch(e.target.value)} className="pr-8 border border-border-strong rounded-lg px-2.5 py-1.5 text-[12.5px] bg-white focus:outline-none focus:border-brand-yellow">
                  <option value="">미지정</option>
                  {confirmBranchNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  {confirmBranch.trim() !== "" && !confirmBranchNames.includes(confirmBranch) && <option value={confirmBranch}>{confirmBranch} (미등록)</option>}
                </select>
              </label>
            )}
          </div>

          {/* 확정 슬롯 — 시간대 슬롯 개념이 있는 라인(배민/비마트)만. internal 정기배송 라인은 숨김. */}
          {!confirmTargetInternal && (
            <div>
              <span className="text-[11px] font-bold text-gray-400">확정 슬롯 (복수 선택 가능)</span>
              <div className="flex gap-1.5 flex-wrap mt-1.5">
                {SLOTS.map((s) => {
                  const on = confirmSlots.includes(s);
                  const hoped = matchesSlot(a.work_hours, s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => toggleConfirmSlot(s)}
                      className={`px-2.5 py-1.5 rounded-md text-[12px] font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow ${on ? "bg-brand-yellow text-foreground" : "bg-background border border-border-strong text-muted-foreground"}`}
                    >
                      {s}{hoped && !on ? " ·희망" : ""}
                    </button>
                  );
                })}
              </div>
              {confirmSlots.length === 0 && (
                <p className="text-[11.5px] text-yellow-600 mt-2 leading-relaxed">
                  슬롯 미선택 시 슬롯 보드에서는 희망 시간대로 <b>추정 표시</b>됩니다. 가능하면 슬롯을 지정해 주세요.
                </p>
              )}
            </div>
          )}

          {/* 확정 후 옹고잉 앱 안내 발송(옵션) — 문구는 두뇌 탭 'ongoing_app_guide'에서 관리 */}
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={confirmSendAppGuide} onChange={(e) => setConfirmSendAppGuide(e.target.checked)} className="accent-success-strong w-4 h-4 mt-0.5" />
            <span className="text-[12.5px] text-gray-700 leading-snug">
              확정 후 <b>옹고잉 앱 설치·가이드 안내</b> 문자 보내기
              <span className="block text-[11px] text-gray-400">문구는 에이전트 두뇌 탭 &lsquo;ongoing_app_guide&rsquo;에서 편집 — 설정 전이면 자리표시 문구가 나가니 주의</span>
            </span>
          </label>

          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl" disabled={busy}>취소</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); commitConfirm(); }} disabled={busy || confirmJobId == null} className="rounded-xl">
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
            <AlertDialogAction onClick={(e) => { e.preventDefault(); commitExclude(); }} disabled={busy} className="rounded-xl bg-error hover:bg-error-strong">
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
  autoOpenConfirm,
  onAutoOpenConfirmConsumed,
  docked = false,
  dockedClassName = "right-4 top-[92px] bottom-4 w-[520px] z-40",
}: {
  isOpen: boolean;
  onClose: () => void;
  applicantId: number | null;
  jobId?: number | null;
  onChanged?: () => void;
  /** 열 때 처음 보여줄 탭 — ‘내가 답할 차례’ 큐처럼 바로 대화로 들어가고 싶을 때 "chat" */
  initialTab?: "detail" | "chat";
  /**
   * 스플릿 뷰 — 스크림을 깔지 않고 옆에 붙는다. 목록이 살아 있어 다음 사람을
   * 바로 누를 수 있다(568명을 순서대로 검토할 때 자리를 잃지 않는다).
   * 부르는 화면이 본문에 오른쪽 여백을 줘서 패널이 목록을 덮지 않게 해야 한다.
   */
  docked?: boolean;
  /**
   * docked일 때의 위치·크기. 기본은 셸 오른쪽 끝에 떠 있는 520px.
   * 공고 화면처럼 이미 오른쪽에 다른 패널이 있으면 그 왼쪽으로 밀어 넣는다.
   */
  dockedClassName?: string;
  /** 열면서 확정 모달까지 바로 띄우는 신호 — 공고 탭 보드의 '확정' 버튼용(본문 컴포넌트로 그대로 전달). */
  autoOpenConfirm?: { id: number; n: number; jobId?: number | null } | null;
  onAutoOpenConfirmConsumed?: () => void;
}) {
  const [tab, setTab] = useState<"detail" | "chat">(initialTab);
  const { detail, reload } = useApplicantDetail(isOpen ? applicantId : null);
  // 표시 기준 공고를 드로어가 들고 있는다 — 상세 탭에서 공고를 바꾼 뒤 '대화 내역'으로 넘어가면
  // 예전엔 부르는 화면이 준 jobId로 되돌아가, 매니저가 보고 있는 공고와 **다른 공고로 답장**이 적재됐다.
  const [focusJobId, setFocusJobId] = useState<number | null>(jobId);
  useEffect(() => { setFocusJobId(jobId); }, [applicantId, jobId]);

  // 전역 킬스위치 — 드로어 대화 탭에서 'AI 응대 중' 오표시·수동 발송 잠금이 남지 않도록
  // LiveConsole과 동일 판정을 전달 (env 강제 중단 포함). 코파일럿(draft) 모드도 함께 전달.
  const [globalKill, setGlobalKill] = useState(false);
  const [copilotMode, setCopilotMode] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/admin/agent/kill-switch")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j) {
          const kill = j.disabled === true || j.env_forced === true;
          setGlobalKill(kill);
          setCopilotMode(!kill && j.mode === "draft");
        }
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
      {/* 스플릿 뷰에서는 스크림을 깔지 않는다 — 목록을 계속 만질 수 있어야 한다. */}
      {!docked && (
        <AnimatePresence>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 bg-black/30 z-40 backdrop-blur-[2px]" />
        </AnimatePresence>
      )}
      <AnimatePresence>
        <motion.div
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", damping: 26, stiffness: 220 }}
          className={
            docked
              ? // 셸과 같은 언어로 떠 있는 패널. 위치·크기는 부르는 화면이 정한다.
                `fixed ${dockedClassName} max-w-[94vw] bg-glass-3 backdrop-blur-xl shadow-[var(--shadow-xl)] flex flex-col rounded-[24px] border border-white overflow-hidden`
              : "fixed top-0 right-0 w-[560px] max-w-[94vw] h-full bg-glass-3 backdrop-blur-xl shadow-[-10px_0_30px_rgba(0,0,0,0.1)] z-50 flex flex-col border-l border-white"
          }
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-border-strong flex justify-between items-start bg-background shrink-0">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-2xl bg-muted text-gray-700 flex items-center justify-center font-bold text-[18px] shadow-inner">{a?.name?.charAt(0) ?? "?"}</div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-[19px] font-extrabold text-foreground">{a?.name ?? "지원자"}</h2>
                  {age && <span className="text-[12px] font-medium text-muted-foreground bg-white px-2 py-0.5 rounded-full border border-border-strong">{age}세</span>}
                  {a && <span className="text-[12px] font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: `${STATUS_COLORS[a.status] ?? "#9CA3AF"}1A`, color: STATUS_COLORS[a.status] ?? "#374151" }}>{a.status}</span>}
                </div>
                <div className="text-[12px] text-gray-400 font-mono">
                  #{applicantId} ·{" "}
                  {a?.phone ? (
                    <a href={`tel:${a.phone.replace(/[^0-9+]/g, "")}`} className="text-info hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40">{a.phone}</a>
                  ) : (
                    "연락처 없음"
                  )}
                  {a?.sigungu && <> · {a.sigungu}</>}
                </div>
              </div>
            </div>
            <button aria-label="지원자 상세 닫기" onClick={onClose} className="after:absolute after:-inset-2 after:content-[''] relative outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background p-2 hover:bg-gray-200 rounded-lg transition-colors text-gray-400 hover:text-foreground"><X size={20} /></button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-border-strong bg-white shrink-0 px-3">
            {[
              { id: "detail" as const, label: "상세 정보", icon: <Check size={14} /> },
              { id: "chat" as const, label: "대화 내역", icon: <MessageSquare size={14} /> },
            ].map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex items-center gap-1.5 px-4 py-3 text-[13px] font-bold border-b-2 -mb-px transition-colors ${tab === t.id ? "border-brand-yellow text-foreground" : "border-transparent text-gray-400 hover:text-muted-foreground"}`}>{t.icon} {t.label}</button>
            ))}
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 flex flex-col">
            {tab === "detail" ? (
              <ApplicantDetailContent
                applicantId={applicantId}
                jobId={jobId}
                focusJobId={focusJobId}
                onFocusJobChange={setFocusJobId}
                variant="drawer"
                detail={detail}
                reload={() => { reload(); onChanged?.(); }}
                onChanged={onChanged}
                autoOpenConfirm={autoOpenConfirm}
                onAutoOpenConfirmConsumed={onAutoOpenConfirmConsumed}
              />
            ) : a ? (
              <ConversationThread
                key={`${applicantId}:${focusJobId ?? "all"}`}
                applicantId={applicantId}
                applicantName={a.name}
                phone={a.phone}
                jobId={focusJobId}
                smsOptOutAt={a.sms_opt_out_at}
                globalKill={globalKill}
                copilotMode={copilotMode}
                onChanged={() => { reload(); onChanged?.(); }}
                className="flex-1 min-h-0"
              />
            ) : (
              <div className="p-6 text-[13px] text-gray-400 text-center">불러오는 중…</div>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </>
  );
}
