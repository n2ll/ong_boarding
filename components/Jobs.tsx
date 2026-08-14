import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Filter, Briefcase, Eye, MapPin, CheckCircle2, Copy, CopyPlus, Edit2, Megaphone, MoreHorizontal, Play, Pause, PauseCircle, Sparkles, Loader2, Wand2, X, Save, Users, ChevronRight, UserPlus, RefreshCw } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { ApplicantDetailPanel } from "./ApplicantDetailPanel";
import { useConfirm } from "./ConfirmDialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuItem } from "./ui/dropdown-menu";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { sourceLabel } from "@/lib/applicant-source";
import { isJobEffectivelyClosed, isSystemJobTitle, stripSystemPrefix } from "@/lib/jobs";
import { ExposureEditor, EMPTY_EXPOSURE, ruleToDraft, draftToRule, type ExposureDraft } from "./ExposureEditor";
import { DEFAULT_DISTANCE_BASIS, DISTANCE_BASIS_LABEL, normalizeDistanceBasis, type DistanceBasis } from "@/lib/geo";

interface JobRow {
  id: string;
  title: string;
  branch: string;
  branchId: number | null;
  clientId: number | null;
  role: string;
  status: "active" | "closed";
  recruitMode: RecruitMode;
  // 지정 노출(targeted) 여부 — 카드 '지정 노출' 배지.
  targetedExposure: boolean;
  candidates: number;
  newCandidates: number;
  confirmed: number;
  // 진행 중(exploration/screening/onboarding/active) 후보 수 — 마감 시 AI 응대가 멈추는 대상.
  inProgress: number;
  capacity: number;
  automation: boolean;
  created: string;
  workPeriod: string | null;
  closesAt: string | null;
  // status='active'라도 closes_at이 지났으면 실질 마감 — 배지·AI 현황·통계를 이걸로 판단(마감 텍스트와 일치).
  effectivelyClosed: boolean;
  // pull '관심 있음' 클릭 인원(distinct) — 행 '관심 N' 칩.
  interestCount: number;
}

interface ApiJob {
  id: number;
  title: string;
  branch: string | null;
  branch_id: number | null;
  client_id: number | null;
  status: string;
  recruit_mode: string | null;
  exposure?: string | null;
  exposure_rule?: unknown;
  vehicle_required: boolean;
  capacity: number | null;
  created_at: string;
  closed_at: string | null;
  work_period: string | null;
  closes_at: string | null;
  counts: Record<string, number>;
  // 매니저 명시 확정(applicants.status='확정인력') 수 — 충원율 게이지의 분자.
  confirmed_count?: number;
  // pull '관심 있음' 클릭 인원(distinct) — 행 '관심 N' 칩.
  interest_count?: number;
}

interface ClientOpt { id: number; name: string; uses_slots?: boolean }
interface BranchOpt { id: number; name: string; client_id: number | null }
interface SiteManagerOpt { id: number; name: string; active?: boolean }

interface JobCand {
  id: number;
  applicant_id: number;
  agent_stage: string | null;
  closed_reason: string | null;
  sent_at: string | null;
  // 공고(상차지·마지막 경유지 중 가까운 쪽)와의 거리 — API가 haversine으로 계산해 내려준다.
  distance_km?: number | null;
  applicants: {
    id: number;
    name: string;
    phone: string | null;
    branch1: string | null;
    work_hours: string | null;
    own_vehicle: string | null;
    status: string;
    source: string | null;
    confirmed_slot: string | null;
    confirmed_branch: string | null;
    availability: string | null;
    applied_at: string | null;
    last_message_at: string | null;
  } | null;
}

interface PoolApplicant {
  id: number;
  name: string | null;
  phone: string | null;
  branch1: string | null;
  work_hours: string | null;
  own_vehicle: string | null;
  status: string | null;
  source: string | null;
  current_job_id: number | null;
}

const SLOT_KEYS = [
  { key: "평일오전", label: "평일 오전" },
  { key: "평일오후", label: "평일 오후" },
  { key: "주말오전", label: "주말 오전" },
  { key: "주말오후", label: "주말 오후" },
];

/**
 * 근무 시간대 입력 — **칩(멀티선택) + 상세 시간(자유 텍스트)**.
 *
 * 왜 둘로 나누나: 예전엔 `jobs.slot` 한 칸이 '사람이 읽는 문장'과 '기계가 맞추는 값'을 겸해서,
 * 매칭을 하려면 문장을 파싱해야 했다. 그 파싱이 두 번 오판했다 —
 * `평일 오전~오후`에서 앞만 읽어 **오후도 되는 공고를 오후 가능한 분에게 접었고**(M4 게이트),
 * 제목의 시간대 낱말이 **답장 라우팅 근거로 샜다**(M6 게이트). 매니저에게 '평일오전, 평일오후'처럼
 * 기계용 토큰을 대신 적으라고 요구하던 것도 그 때문이다(2026-08-05 철회).
 * 칩 = 매칭용(`slot_keys`) · 상세 = 표시·AI 안내용(`slot`). 노출 규칙·조건 바와 어휘가 같다.
 */
function SlotKeysField({
  keys,
  onToggleKey,
  detail,
  onDetailChange,
}: {
  keys: string[];
  /** 칩 하나를 뒤집는다 — 부모가 **함수형 갱신**으로 처리한다.
   *  다음 배열을 여기서 만들어 넘기면, 빠르게 두 개를 연달아 누를 때 두 번째 클릭이 낡은 배열을
   *  덮어써서 첫 선택이 사라진다(리허설에서 실제로 재현: 평일오전+평일오후 → {평일오후}만 저장). */
  onToggleKey: (key: string) => void;
  detail: string;
  onDetailChange: (next: string) => void;
}) {
  return (
    <div>
      <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">
        근무 시간대 <span className="text-muted-foreground font-semibold">— 고른 시간대로 맞는 분을 찾아요</span>
      </label>
      <div className="flex gap-1.5 flex-wrap">
        {SLOT_KEYS.map((s) => {
          const on = keys.includes(s.key);
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={on}
              onClick={() => onToggleKey(s.key)}
              className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow ${
                on ? "bg-brand-yellow text-foreground" : "bg-background border border-border-strong text-muted-foreground hover:bg-muted"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      <input
        value={detail}
        onChange={(e) => onDetailChange(e.target.value)}
        placeholder="상세 시간(선택) — 예: 월~금 07:00~12:00"
        className="min-h-11 mt-2 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
      />
      <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
        상세 시간은 지원자 카드에 그대로 보이고 AI 안내에 쓰여요. <b className="text-muted-foreground">맞는 분 찾기는 위 칩</b>으로만 합니다 —
        칩을 비워두면 시간대로 걸러내지 않습니다.
      </p>
    </div>
  );
}

// 단계 그룹 표시 순서 — 'interest'는 agent_stage NULL(관심 표시·AI 응대 시작 전)의 가상 키.
// 관심자가 'AI 탐색 중'으로 오표기되지 않게 exploration과 분리해 최상단에 둔다.
const STAGE_ORDER = ["interest", "exploration", "screening", "onboarding", "active", "paused", "abort"];

function slotMatch(confirmed: string | null | undefined, key: string): boolean {
  if (!confirmed) return false;
  const day = key.startsWith("평일") ? "평일" : "주말";
  const time = key.endsWith("오전") ? "오전" : "오후";
  return confirmed.split(",").some((p) => p.includes(day) && p.includes(time));
}

// 표시 라벨만 실무 언어로 통일(LiveConsole·ApplicantDetailPanel·Dashboard와 동일 단어) — DB 값(agent_stage)은 그대로.
const STAGE_KO: Record<string, string> = {
  interest: "관심 표시",
  exploration: "초기 대화", screening: "스크리닝", onboarding: "온보딩",
  active: "활동 중", paused: "수동 응대", abort: "중단",
};
const STAGE_COLOR: Record<string, string> = {
  interest: "bg-warning-soft text-warning-strong",
  exploration: "bg-muted text-gray-700",
  screening: "bg-yellow-100 text-warning-strong",
  onboarding: "bg-copilot-soft text-copilot-strong",
  active: "bg-success-soft text-success-strong",
  paused: "bg-muted text-muted-foreground",
  abort: "bg-error-soft text-error-strong",
};

// 공고 마감 안내 문구 — #{이름}/#{맞춤링크}는 bulk-send가 수신자별 치환, #{공고명}은 발송 시점에 치환.
// 맞춤링크(/p/[token])가 활성 공고를 자동으로 보여주므로 타 공고 안내는 링크 하나로 끝난다.
// 톤: 진행 중이던 지원자가 이탈하지 않도록 죄송·친절 우선(지원자 경험 원칙, 2026-07-14) —
// 배송 라인은 결원이 금방 생기고 비슷한 공고가 계속 올라오므로 '먼저 안내' 약속으로 관계를 잇는다.
// '먼저 안내'까지만 — 확정·배정 뉘앙스 금지(AGENTS.md 절대 규칙).
const JOB_CLOSED_NOTICE = `#{이름}님, '#{공고명}'에 관심 가져주시고 함께해 주셔서 진심으로 감사합니다.
안내드리는 사이에 이번 자리가 먼저 채워졌어요. 기다리시게 해서 정말 죄송합니다.

배송 라인은 결원이 금방 생기기도 하고, 비슷한 공고도 계속 올라올 예정이에요.
새 자리가 나오는 대로 이 번호로 가장 먼저 안내드릴게요.

지금 모집 중인 다른 공고는 여기서 보실 수 있어요: #{맞춤링크}`;

// 일반 라인(internal) 마감 안내에만 덧붙는 선탑 제안 — 답장하면 AI '마감 안내 모드'가 받아
// 선탑 가능 시간대를 수집하고 매니저에게 인계한다. (선탑≠투입 확정 — '우선순위' 표현까지만)
const JOB_CLOSED_SUNTOP_LINE = `
그동안 선탑(동승)으로 현장을 미리 경험해두실 수도 있어요. 비슷한 라인 투입 때 우선순위가 생깁니다. 원하시면 이 번호로 '선탑'이라고 답장 주세요.`;

// 마감 안내 최종 본문 — internal 공고면 선탑 제안 포함. 모달 미리보기와 실제 발송이 같은 본문을 쓴다.
const closeNoticeBody = (job: JobRow) =>
  (JOB_CLOSED_NOTICE + (job.recruitMode === "internal" ? JOB_CLOSED_SUNTOP_LINE : ""))
    .replace(/#\{공고명\}/g, stripSystemPrefix(job.title));

// 마감 안내 발송 대상(미선발 관심자) — interested API(detail=1)가 수신거부·확정인력·기수신자 등을 걸러 내려준다.
interface CloseNotifyTarget {
  id: number;
  name: string | null;
  phone: string;
  access_token: string;
}

// 새 공고 안내 문구 — #{이름}/#{맞춤링크}는 bulk-send가 수신자별 치환, {공고명}은 발송 전 모달에서
// 치환(smsJobTitle 단가 괄호 제거본 — announce-targets가 내려준다).
// '조건 확인'까지만 — 확정·배정 뉘앙스 금지(AGENTS.md 절대 규칙). '그만' 회신 안내로 수신거부 경로 유지.
const NEW_JOB_NOTICE = `#{이름}님, 새 배송 건이 올라왔어요!\n{공고명}\n\n조건 확인: #{맞춤링크}\n(안내 중단: '그만' 회신)`;

// 새 공고 안내 대상 — announce-targets API 응답. group은 S 선탑 완료 > A 약속자 > B 알림 신청 > C 조건 매칭(상위 우선 중복 제거).
type AnnounceGroup = "suntop" | "promised" | "requested" | "matched";
const ANNOUNCE_GROUP_LABEL: Record<AnnounceGroup, string> = {
  suntop: "선탑 완료(최우선)",
  promised: "먼저 안내 약속",
  requested: "알림 신청",
  matched: "조건 맞는 최근 관심",
};
interface AnnounceTarget {
  id: number;
  name: string | null;
  phone: string;
  access_token: string;
  group: AnnounceGroup;
}
interface AnnounceGroups { suntop: number; promised: number; requested: number; matched: number }
interface AnnounceTargetsRes {
  groups: AnnounceGroups;
  targets: AnnounceTarget[];
  night: boolean;
  sms_title: string;
  /** 'targeted'면 이 공고는 노출 명단 밖에 있는 사람에게 안내를 보내지 않는다. */
  exposure?: "all" | "targeted";
  /** 노출 명단 때문에 빠진 수 — promised는 그중 '먼저 안내 약속'·선탑 완료자(약속을 어기는 쪽). */
  dropped_by_exposure?: { total: number; promised: number };
  dropped_by_fatigue?: { total: number; promised: number };
  fatigue_days?: number;
}

// 추천순 정렬의 가용성 우선순위 — 즉시가능 > 이번주가능 > 그 외(휴면·미입력).
function availabilityRank(v: string | null | undefined): number {
  if (v === "즉시가능") return 0;
  if (v === "이번주가능") return 1;
  return 2;
}

// ISO → "YYYY-MM" — 후보 카드 메타의 '지원 2026-06' 표기.
function fmtYM(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// 저장 응답의 좌표 유무로 지오코딩 성공/실패를 토스트에 병기 — 주소를 넣었는데 좌표가 null이면
// 거리 정렬·거리 메타가 동작하지 않으므로 실패를 저장 시점에 바로 알린다.
function geocodeResultNote(
  job: { pickup_lat?: number | null; dropoff_lat?: number | null } | null | undefined,
  pickupAddress: string,
  dropoffAddress: string
): string | undefined {
  if (!job) return undefined;
  const parts: string[] = [];
  if (pickupAddress.trim()) parts.push(typeof job.pickup_lat === "number" ? "상차지 좌표 ✓" : "상차지 좌표 실패");
  if (dropoffAddress.trim()) parts.push(typeof job.dropoff_lat === "number" ? "경유지 좌표 ✓" : "경유지 좌표 실패");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// abort(공고 단위 종료) 카드의 결과 구분 — closed_reason으로 '보류'·'공고부적합'·그 외 '중단'을 색·라벨로 나눈다.
// 모두 인력풀은 유지된다(재활용 원칙). '보류'는 되살릴 여지, '부적합'은 이 공고 부적격, 그 외는 AI abort 등.
type ClosedKind = { label: string; badge: string };
function closedKind(closedReason: string | null | undefined): ClosedKind {
  const r = closedReason ?? "";
  if (r.includes("보류")) return { label: "보류", badge: "bg-muted text-muted-foreground" };
  if (r.includes("부적합")) return { label: "공고부적합", badge: "bg-error-soft text-error-strong" };
  return { label: "중단", badge: "bg-yellow-50 text-warning" };
}

type RecruitMode = "external" | "internal" | "both";
// 표시 라벨은 확정 용어집(docs/실무자-UX개편-계획-2026-07-25.md)대로 — DB 값(external/internal/both)은 그대로.
// aiNote — 이 값은 '누구에게 보여줄까'만이 아니라 AI 응대 흐름(lib/agent/general-line.isGeneralLineJob)까지 바꾼다.
// 예전엔 화면 어디에도 그 사실이 없어 고르는 사람이 알 수 없었다 → 선택 카드에 한 줄로 적는다.
const RECRUIT_MODE_META: Record<RecruitMode, { label: string; desc: string; aiNote: string; badge: string }> = {
  external: { label: "새로 모집", desc: "지원 폼·광고로 새 지원자를 받아요 (우리 인력의 맞춤 공고 링크에는 안 보여요)", aiNote: "AI는 배민 앱 가입 안내 흐름으로 응대해요", badge: "bg-info-soft text-info-strong border-info/25" },
  internal: { label: "우리 인력에게", desc: "이미 등록된 인력에게만 맞춤 공고 링크로 보여줘요", aiNote: "AI는 일반 배송 라인 흐름(선탑 일정은 매니저가 연락)으로 응대해요", badge: "bg-copilot-soft text-copilot-strong border-copilot-soft" },
  both: { label: "둘 다", desc: "새로 모집 + 우리 인력에게 동시에 보여줘요", aiNote: "AI는 배민 앱 가입 안내 흐름으로 응대해요", badge: "bg-success-soft text-success-strong border-success/25" },
};
// '둘 다'(both)는 선택지에서 감춘다 — 사용 공고 0건인데 노출만 internal과 같고 AI 응대·확정 후속·지표는
// external(배민) 기준이라, 골랐을 때만 어긋나는 함정 값이다. DB 값·목록 배지는 그대로 두고(옛 데이터 표시),
// 이미 'both'인 공고를 수정할 때는 그 값이 화면에서 사라지지 않게 선택지에 다시 넣는다.
const HIDDEN_RECRUIT_MODE: RecruitMode = "both";
// 기본값 — 파일럿 배포 채널이 맞춤 공고 링크뿐이라 '우리 인력에게'가 아니면 등록해도 지원자에게 안 보인다.
// 이 상수를 프론트 기본값 3곳(등록 useState·resetNewJobForm·openEdit 플레이스홀더)이 공유한다.
const DEFAULT_RECRUIT_MODE: RecruitMode = "internal";
function asRecruitMode(v: unknown): RecruitMode {
  return v === "internal" || v === "both" ? v : "external";
}

/** 수정 모달 폼 — 접이식 섹션 헤더 요약 함수에서도 쓰려고 이름을 붙였다. */
interface EditJobForm {
  id: string;
  title: string;
  body: string;
  clientId: number | "";
  branchId: number | "";
  siteManagerId: number | "";
  capacity: number;
  vehicleRequired: boolean;
  payInfo: string;
  policyNotes: string;
  payType: string;
  payAmount: number | "";
  aiFacts: string;
  recruitMode: RecruitMode;
  workPeriod: string;
  closesAt: string;
  slot: string;
  slotKeys: string[];
  startDate: string;
  pickupAddress: string;
  dropoffAddress: string;
  /** 거리 계산 기준 — 라인마다 집결지·경유지 관계가 달라 공고마다 고른다(lib/geo). */
  distanceBasis: DistanceBasis;
  exposureDraft: ExposureDraft;
  /**
   * 모달을 열던 시점의 노출 값 — 저장 시 '내가 노출을 건드렸는지' 판정용.
   * 파이프라인 '이 명단에게만 노출'이 같은 두 컬럼(exposure·exposure_rule)을 쓰기 때문에,
   * 노출을 만지지도 않은 저장이 그 결과를 통째로 되돌리는 lost update가 생긴다
   * (전환이 취소되고, 되돌릴 수 없다며 지운 규칙이 부활한다). 안 만졌으면 아예 전송하지 않는다.
   */
  exposureBaseline: ExposureDraft;
}

// ── 수정 모달 접이식 섹션 요약 ──
// 접힌 섹션에 값이 들어있는지 알 수 없어(쉐브론 하나뿐) 매번 펼쳐 확인하거나 이미 저장된 값을
// 미입력으로 오인하던 문제(E17 후속) → 닫힌 헤더에 한 줄 요약을 띄운다.
function payLabel(f: EditJobForm): string | null {
  if (f.payType === "협의") return "급여 협의";
  if (f.payType) return f.payAmount === "" ? `급여 ${f.payType}` : `급여 ${f.payType} ${Number(f.payAmount).toLocaleString()}원`;
  return f.payInfo.trim() ? "급여 정보 있음" : null;
}
function basicSummary(f: EditJobForm, clientLabel?: string | null, branchLabel?: string | null): string {
  return [clientLabel ?? null, branchLabel ?? null, RECRUIT_MODE_META[f.recruitMode].label, `${f.capacity}명 모집`, f.vehicleRequired ? "차량 필요" : null, payLabel(f) ?? "급여 미입력"]
    .filter(Boolean)
    .join(" · ");
}
function exposureSummary(f: EditJobForm): string {
  if (f.exposureDraft.exposure !== "targeted") return "전체 인재풀에 보여줘요";
  const r = f.exposureDraft.rule;
  const rule = draftToRule(r);
  // radiusIncludeUnknown은 반경 조건의 부속 옵션 — 따로 세면 '조건 2개'로 부풀어 보인다.
  const conds = rule ? Object.keys(rule).filter((k) => k !== "radiusIncludeUnknown").length : 0;
  return conds > 0 ? `지정 대상에게만 · 조건 ${conds}개` : "지정 대상에게만";
}
function workSummary(f: EditJobForm): string {
  const parts = [
    f.slot.trim() ? `근무시간 ${f.slot.trim()}` : null,
    f.startDate ? `시작 ${f.startDate}` : null,
    f.pickupAddress.trim() ? "집결지 있음" : null,
    f.dropoffAddress.trim() ? "경유지 있음" : null,
    f.policyNotes.trim() || f.aiFacts.trim() ? "AI 응대 근거 있음" : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "미입력";
}
/** '더보기' 메뉴 라벨 — 실제로 들어가는 항목에서 파생한다(없는 항목을 툴팁이 약속하면 그 기능을 찾아 헤맨다). */
function moreActionsLabel(job: { effectivelyClosed: boolean; recruitMode: RecruitMode }): string {
  const canAnnounce = !job.effectivelyClosed && job.recruitMode !== "external";
  return [...(canAnnounce ? ["대기자에게 안내"] : []), job.effectivelyClosed ? "다시 열기" : "마감"].join(" · ");
}

function bodySummary(f: EditJobForm): string {
  const n = f.body.trim().length;
  return n > 0 ? `${n}자` : "본문 없음";
}

/** 수정 모달 접이식 섹션 껍데기 — 4개 섹션이 헤더 마크업(요약·aria-expanded·쉐브론)을 공유한다. */
function EditSection({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-border-strong rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
      >
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-foreground">{title}</div>
          {!open && <div className="text-[11.5px] text-muted-foreground truncate mt-0.5">{summary}</div>}
        </div>
        <ChevronRight size={18} className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="px-5 pb-5 flex flex-col gap-4 border-t border-muted pt-4">{children}</div>}
    </div>
  );
}

/**
 * 모집 방식 선택 — 등록·수정 모달 공용.
 * 같은 값을 등록은 드롭다운, 수정은 3칸 카드로 묻던 불일치를 한 컨트롤로 합쳤다.
 * 기본값('우리 인력에게')이면 한 줄 요약 + '바꾸기'로 접어둔다 — 첫 등록에서 세 개념을 먼저 고르게 하지 않기 위해서다(B4 정책).
 * 기본값이 아니면 항상 펼친다: 고른 값이 접혀서 안 보이면 안 된다.
 */
function RecruitModeField({ value, onChange }: { value: RecruitMode; onChange: (m: RecruitMode) => void }) {
  const [open, setOpen] = useState(value !== DEFAULT_RECRUIT_MODE);
  const modeOptions = (Object.keys(RECRUIT_MODE_META) as RecruitMode[]).filter(
    (m) => m !== HIDDEN_RECRUIT_MODE || value === HIDDEN_RECRUIT_MODE
  );
  // 수정 모달은 공고 값을 나중에(GET 응답) 받는다 — 기본값이 아닌 값이 들어오면 그때 펼친다.
  useEffect(() => {
    if (value !== DEFAULT_RECRUIT_MODE) setOpen(true);
  }, [value]);

  return (
    <div>
      <label className="block text-[13px] font-bold text-gray-700 mb-2">모집 방식</label>
      {!open ? (
        <div className="flex items-center gap-2 px-4 py-3 border border-border-strong rounded-xl bg-background">
          <span className="text-[13px] font-bold text-foreground shrink-0">{RECRUIT_MODE_META[value].label}</span>
          <span className="text-[11.5px] text-muted-foreground truncate" title={`${RECRUIT_MODE_META[value].desc} · ${RECRUIT_MODE_META[value].aiNote}`}>{RECRUIT_MODE_META[value].desc}</span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            title="모집 방식 바꾸기 — '새로 모집'(지원 폼·광고로 새 지원자)도 고를 수 있어요"
            className="ml-auto shrink-0 text-[12px] font-bold text-info hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40"
          >
            바꾸기
          </button>
        </div>
      ) : (
        <div role="radiogroup" aria-label="모집 방식" className={`grid gap-2 ${modeOptions.length > 2 ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" : "grid-cols-1 sm:grid-cols-2"}`}>
          {modeOptions.map((m) => {
            const sel = value === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={sel}
                onClick={() => onChange(m)}
                className={`text-left p-3 rounded-xl border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow ${sel ? "border-foreground bg-white ring-1 ring-foreground" : "border-border-strong bg-white hover:border-gray-300"}`}
              >
                <div className={`text-[13px] font-bold ${sel ? "text-foreground" : "text-gray-700"}`}>{RECRUIT_MODE_META[m].label}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{RECRUIT_MODE_META[m].desc}</div>
                <div className="text-[11px] text-warning-strong mt-1 leading-snug">{RECRUIT_MODE_META[m].aiNote}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// 단가 형태 옵션 — 등록/수정 모달 급여 그룹 공용(서버 pay_type enum과 일치, app/api/admin/jobs POST/PATCH 검증).
const PAY_TYPES = ["건당", "일당", "주급", "월급", "혼합", "협의"] as const;

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

function toJobRow(j: ApiJob): JobRow {
  const total = Object.values(j.counts ?? {}).reduce((a, b) => a + b, 0);
  return {
    id: String(j.id),
    title: j.title,
    branch: j.branch ?? "-",
    branchId: j.branch_id ?? null,
    clientId: j.client_id ?? null,
    role: j.vehicle_required ? "배송원" : "도보 배달",
    status: j.status === "active" ? "active" : "closed",
    recruitMode: asRecruitMode(j.recruit_mode),
    // 지정 노출 여부 — 카드 배지용. 미지 값은 안전 방향(전체 노출 취급 아님 — 배지만 안 띄움).
    targetedExposure: j.exposure === "targeted",
    candidates: total,
    // "sent"는 agent_stage NULL의 집계 키(관심 표시·미발송 등 AI 응대 시작 전).
    // 키를 바꾸면 jobs/[id] GET·Recommendations 등 다른 소비처가 깨져 키는 유지하고 라벨만 정합.
    newCandidates: j.counts?.["sent"] ?? 0,
    // 충원율 분자 = 매니저 확정(status='확정인력')만. agent_stage='active'(자동 전이)는 확정이 아니다.
    // 보드의 '확정 슬롯 분포'(status==='확정인력')와 같은 소스라 두 지표가 어긋나지 않는다.
    confirmed: j.confirmed_count ?? 0,
    // 진행 중 후보 = AI가 응대 중인 단계. 마감하면 이들 응대가 멈추므로 마감 확인 모달에서 경고한다.
    inProgress: ["exploration", "screening", "onboarding", "active"].reduce((a, s) => a + (j.counts?.[s] ?? 0), 0),
    capacity: j.capacity ?? 0,
    automation: j.status === "active",
    created: fmtDate(j.created_at),
    workPeriod: j.work_period ?? null,
    closesAt: j.closes_at ?? null,
    effectivelyClosed: isJobEffectivelyClosed(j.status, j.closes_at),
    interestCount: j.interest_count ?? 0,
  };
}

// 모집 기간(work_period) 배지 — 하루/단기=노랑, 정기=초록
const PERIOD_BADGE: Record<string, string> = {
  하루: "bg-yellow-50 text-warning-strong border-yellow-200",
  단기: "bg-yellow-50 text-warning-strong border-yellow-200",
  정기: "bg-success-soft text-success-strong border-success/25",
};

// 마감시각(closes_at) → "M/D HH시 마감" (로컬=KST)
function fmtCloses(iso: string): string {
  const d = new Date(iso);
  const m = d.getMinutes();
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}시${m ? ` ${m}분` : ""} 마감`;
}

// ISO → datetime-local 입력값 (로컬 기준)
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 현재 시각의 datetime-local 값 — 마감시각 입력 min으로 과거 선택을 막는다(E1-5).
function nowLocalInput(): string {
  return isoToLocalInput(new Date().toISOString());
}

/** 오늘 날짜(YYYY-MM-DD, 로컬=KST) — date input의 min·과거 시작일 검증용. */
function todayLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 긴급 건 권역/차종(자유 텍스트) → 파이프라인 필터 파라미터 매핑.
//   region: 수도권 키워드(서울/경기/인천 + 주요 서울 구)가 있으면 capital, 아니면 미전달(파이프라인 지역 필터는 capital 1칩뿐).
//   vehicle: 차종 값이 있으면 배송 라인 백업이므로 차량 보유(vehicle)로 좁힌다.
const CAPITAL_KEYWORDS = ["서울", "경기", "인천", "강서", "강남", "강동", "강북", "송파", "마포", "영등포", "부천", "고양", "성남", "수원"];
function sosToPipelineParams(region: string | null, vehicle: string | null): URLSearchParams {
  const p = new URLSearchParams();
  if (region && CAPITAL_KEYWORDS.some((k) => region.includes(k))) p.set("region", "capital");
  if (vehicle && vehicle.trim()) p.set("vehicle", "vehicle");
  return p;
}

export function Jobs() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const confirm = useConfirm();
  const [activeTab, setActiveTab] = useState('active');
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  // 초안이 나온 뒤에는 프롬프트 카드를 한 줄로 접는다 — 이 카드(입력 100px + 버튼 + 힌트 ≈ 250px)가
  // 모달(max-h 90vh) 상단을 차지해서, 초안 편집칸(260px)이 1280×720 기준 **70px만 보였다**.
  // 실측: 초안 textarea box=(y=534, h=260) / 스크롤 영역 하단 ≈ 604 → "생성했는데 안 보인다"의 실제 원인.
  const [promptOpen, setPromptOpen] = useState(true);
  const [postingTitle, setPostingTitle] = useState("");
  const [channelDrafts, setChannelDrafts] = useState<{ danggeun: string; albamon: string; sms: string } | null>(null);
  const [activeChannel, setActiveChannel] = useState<"danggeun" | "albamon" | "sms">("danggeun");
  const [aiSource, setAiSource] = useState<"ai" | "mock" | null>(null);
  const [registering, setRegistering] = useState(false);
  const [query, setQuery] = useState("");
  const [clientFilter, setClientFilter] = useState<number | "">("");
  const [branchFilter, setBranchFilter] = useState<number | "">("");
  const [newJobClientId, setNewJobClientId] = useState<number | "">("");
  const [newJobBranchId, setNewJobBranchId] = useState<number | "">("");
  // 현장매니저(site_manager) — external 만남장소·첫날 안내 발송 담당. 서버 POST/PATCH가 site_manager_id 수용.
  const [newJobSiteManagerId, setNewJobSiteManagerId] = useState<number | "">("");
  // 기본 internal — 파일럿 배포 채널이 pull(맞춤링크) 전용이라, external 기본이면 등록해도 지원자에게 안 보이는 함정이 된다.
  const [newJobMode, setNewJobMode] = useState<RecruitMode>(DEFAULT_RECRUIT_MODE);
  // 복제 원본 제목 — 복제본은 제목·본문에 원본 권역이 그대로 남아 있어, 그 사실을 초안 위에 밝힌다
  // (권역만 다른 라인을 6~7개 만드는 것이 기본 사용법이라 '안 고치고 등록'이 실제 사고다).
  const [duplicatedFrom, setDuplicatedFrom] = useState<string | null>(null);
  // 복제로 채워진 채널 초안 여부 — 당근·문자 탭이 '원본에 저장돼 있던 내용'임을 안내하는 데만 쓴다.
  const [channelDraftsFromCopy, setChannelDraftsFromCopy] = useState(false);
  // 수정 모달에서 화주사를 바꿔 '떨어져 나간' 지점 — 지점 셀렉트는 그 순간 화면에서 사라지므로(해당 화주사에 지점이 없으면)
  // 무슨 일이 벌어졌는지 배너·확인 모달로 남긴다. 화주사를 원래대로 되돌리면 지점도 복원한다.
  const [editDroppedBranch, setEditDroppedBranch] = useState<{ id: number; name: string } | null>(null);
  const [newJobCapacity, setNewJobCapacity] = useState(1);
  const [newJobPayType, setNewJobPayType] = useState("");
  const [newJobPayAmount, setNewJobPayAmount] = useState<number | "">("");
  const [newJobPeriod, setNewJobPeriod] = useState("");
  const [newJobClosesAt, setNewJobClosesAt] = useState("");
  // 근무 상세 — pull(/p/[token]) 카드가 표시하는 필드. slot은 컨벤션상 4개 enum(평일오전 등), start_date는 date, pickup_address는 text.
  const [newJobSlot, setNewJobSlot] = useState("");
  // 시간대 매칭용 칩 값(4슬롯) — 사람이 읽는 newJobSlot(상세 시간)과 분리.
  const [newJobSlotKeys, setNewJobSlotKeys] = useState<string[]>([]);
  const [newJobStartDate, setNewJobStartDate] = useState("");
  const [newJobPickupAddress, setNewJobPickupAddress] = useState("");
  // 마지막 경유지(배송 종료 지점) — 상차지와 함께 후보↔공고 거리 정렬(가까운 쪽 기준)에 쓰인다.
  const [newJobDropoffAddress, setNewJobDropoffAddress] = useState("");
  const [newJobVehicleRequired, setNewJobVehicleRequired] = useState(true);
  // AI 응대 근거(급여·정책) — 등록 단계에서 접이식으로 함께 입력해 편집 모달 2단계 강제를 없앤다.
  const [newJobPayInfo, setNewJobPayInfo] = useState("");
  const [newJobPolicyNotes, setNewJobPolicyNotes] = useState("");
  const [newJobAiFacts, setNewJobAiFacts] = useState("");
  const [newJobExtraOpen, setNewJobExtraOpen] = useState(false);
  // J 타겟 노출 — 노출 대상(전체/지정) + 자동 규칙 draft. 등록 POST에 exposure·exposure_rule로 실림.
  const [newJobExposure, setNewJobExposure] = useState<ExposureDraft>(EMPTY_EXPOSURE);
  // 긴급 건(SOS)에서 넘어온 공고 — 등록 시 sos_request_id로 저장 + 등록 후 '대상 선별' CTA용 권역/차종 보관.
  const [newJobSosId, setNewJobSosId] = useState<string | null>(null);
  const [newJobSosRegion, setNewJobSosRegion] = useState<string | null>(null);
  const [newJobSosVehicle, setNewJobSosVehicle] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditJobForm | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  // E17 · 수정 모달 접이식 섹션 열림 상태. 자주 고치는 제목·기간·마감은 접이식 밖 상단 상시 표시,
  // 나머지는 섹션으로 접어 ~2,100px 평면 스크롤을 없앤다. 기본 정보만 열고 시작.
  const [editOpenSections, setEditOpenSections] = useState({ basic: true, exposure: false, work: false, content: false });
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  // 마감 확인 모달 — 미선발 관심자 안내 발송 체크박스(send, 기본 ON)와 대상(targets)을 함께 관리.
  const [closeModal, setCloseModal] = useState<{ job: JobRow; targets: CloseNotifyTarget[]; loading: boolean; send: boolean } | null>(null);
  const [closing, setClosing] = useState(false);
  // 새 공고 안내 모달 — 등록 직후(대상 ≥1이면 자동)와 행 '대기자에게 안내'(수동)가 같은 모달을 쓴다.
  // night=true(KST 21~08)면 발송 버튼 비활성 — 아침 9시 이후 행 메뉴에서 다시 열어 보낸다.
  const [announceModal, setAnnounceModal] = useState<{ jobId: number; smsTitle: string; targets: AnnounceTarget[]; groups: AnnounceGroups; night: boolean; dropped?: { total: number; promised: number } } | null>(null);
  const [announcing, setAnnouncing] = useState(false);
  const [announceBusyId, setAnnounceBusyId] = useState<string | null>(null);
  // 전역 AI 응답 on/off (kill-switch). 공고별 AI 자동 스크리닝 적용 여부 표시에 사용.
  const [aiGlobalOn, setAiGlobalOn] = useState(true);

  // 공고별 지원자 보드
  const [candPanel, setCandPanel] = useState<{ jobId: number; title: string; recruitMode: RecruitMode } | null>(null);
  const [candidates, setCandidates] = useState<JobCand[]>([]);
  const [candLoading, setCandLoading] = useState(false);
  // 보드 정렬 — 추천순(즉시가능 → 거리 → 지원일) / 최신순(API 순서 = created_at desc).
  const [candSort, setCandSort] = useState<"recommended" | "recent">("recommended");
  const [selectedApplicantId, setSelectedApplicantId] = useState<number | null>(null);
  // 확정 모달 자동 오픈 신호 — 보드 카드의 '확정' 버튼이 지원자 상세를 열면서 확정 모달까지 바로 띄운다.
  // (예전엔 보드 → 카드 → 상세 → 핵심 액션 '확정' 3홉이라 공고 화면에서 확정이 보이지 않았다.)
  // 확정 대기 큐(LiveConsole)와 같은 규약: n은 단조 증가 시퀀스(신호가 소비되어 null이 돼도 되돌아가지 않게
  // ref로 센다 — prev 기반이면 항상 1이 되어 두 번째 확정이 '이미 소비한 n'으로 무시된다), jobId는 오귀속 방지 시드.
  const confirmSignalSeq = useRef(0);
  const [confirmSignal, setConfirmSignal] = useState<{ id: number; n: number; jobId?: number | null } | null>(null);
  const openConfirmFor = (applicantId: number, jobId: number | null) => {
    setSelectedApplicantId(applicantId);
    confirmSignalSeq.current += 1;
    setConfirmSignal({ id: applicantId, n: confirmSignalSeq.current, jobId });
    // 확정 모달은 상세 드로어 안에 있어, 상세 조회가 실패하면 아무 일도 안 일어난 것처럼 보인다.
    // 잠시 뒤에도 안 열렸으면 원인을 알려주고 신호를 버린다(잔존 신호가 나중에 저절로 모달을 여는 것도 막는다).
    window.setTimeout(() => {
      setConfirmSignal((cur) => {
        if (!cur || cur.n !== confirmSignalSeq.current) return cur; // 이미 소비됐거나 더 최신 신호가 있음
        toast.error("상세를 불러오지 못해 확정 창을 열 수 없었어요. 새로고침 후 다시 시도해 주세요.");
        return null;
      });
    }, 6000);
  };
  const [candBusyId, setCandBusyId] = useState<number | null>(null);
  const [dispatching, setDispatching] = useState(false);
  // 인재풀에서 후보 추가(피커)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pool, setPool] = useState<PoolApplicant[]>([]);
  const [poolLoading, setPoolLoading] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);

  const loadCandidates = useCallback(async (jobId: number) => {
    setCandLoading(true);
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/candidates`);
      const json = await res.json();
      setCandidates((json.candidates ?? []) as JobCand[]);
    } catch {
      toast.error("지원자 목록을 불러오지 못했어요");
    } finally {
      setCandLoading(false);
    }
  }, []);

  // 후보 단건 매니저 액션 (응대 정지/재개·부적합·단계 변경)
  const patchCandidate = async (cid: number, body: Record<string, unknown>, okMsg: string) => {
    if (!candPanel) return;
    setCandBusyId(cid);
    try {
      const res = await fetch(`/api/admin/jobs/${candPanel.jobId}/candidates/${cid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "처리에 실패했어요");
        return;
      }
      toast.success(okMsg);
      loadCandidates(candPanel.jobId);
      loadJobs();
    } catch {
      toast.error("처리에 실패했어요");
    } finally {
      setCandBusyId(null);
    }
  };

  // 종료(abort) 카드 되돌리기 — 잘못 누른 '보류'·'부적합'을 진행 단계(탐색)로 복원.
  // exploration으로 되돌리면 API가 closed_at·closed_reason을 클리어한다. applicants.status는 건드리지 않는다(인력풀 유지).
  const resumeCandidate = async (c: JobCand) => {
    const name = c.applicants?.name ?? `#${c.applicant_id}`;
    const ok = await confirm({
      title: "이 공고에 다시 올릴까요?",
      description: `'${name}'님을 이 공고 후보로 되살립니다(초기 대화 단계부터). 인력풀 상태는 그대로예요.`,
      confirmText: "재개하기",
    });
    if (!ok) return;
    await patchCandidate(c.id, { agent_stage: "exploration" }, "이 공고 후보로 되살렸어요");
  };

  // 미발송 후보에게 공고 본문 일괄 SMS 발송 (스크리닝 시작)
  const dispatchUnsent = async () => {
    if (!candPanel) return;
    // 실제 SMS 대량 발송 — 확인 없이 원클릭이면 오클릭 사고. 같은 화면의 마감/새공고 안내처럼 확인 거친다.
    const ok = await confirm({
      title: `미발송 ${unsentCount}명에게 스크리닝 문자를 보낼까요?`,
      description: "이 공고의 미발송 후보 전원에게 공고 본문 문자가 즉시 발송돼요. 되돌릴 수 없어요.",
      confirmText: "발송",
    });
    if (!ok) return;
    setDispatching(true);
    try {
      const res = await fetch(`/api/admin/jobs/${candPanel.jobId}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "발송에 실패했어요");
        return;
      }
      if (json.sent === 0 && json.skipped === 0) {
        toast.info("발송할 미발송 후보가 없어요");
      } else {
        const r = json.skip_reasons ?? {};
        const reasons = [
          r.conflict ? `다른 공고 진행 중 ${r.conflict}명` : "",
          r.no_consent ? `수신 미동의 ${r.no_consent}명` : "",
          r.opt_out ? `수신거부 ${r.opt_out}명` : "",
          r.no_phone ? `연락처 없음 ${r.no_phone}명` : "",
          r.no_token ? `맞춤 공고 링크 토큰 없음 ${r.no_token}명` : "",
          r.send_fail ? `발송 실패 ${r.send_fail}명` : "",
        ].filter(Boolean);
        toast.success(`${json.sent}명에게 발송 완료`, {
          description: reasons.length ? `제외 ${json.skipped}명 — ${reasons.join(" · ")}` : undefined,
          duration: reasons.length ? 7000 : 4000,
        });
      }
      loadCandidates(candPanel.jobId);
      loadJobs();
    } catch {
      toast.error("발송에 실패했어요");
    } finally {
      setDispatching(false);
    }
  };

  const openCandidates = (job: JobRow) => {
    setCandPanel({ jobId: Number(job.id), title: job.title, recruitMode: job.recruitMode });
    setCandidates([]);
    setConfirmSignal(null); // 이전 보드에서 남은 확정 신호가 이 보드의 카드에 붙지 않게
    loadCandidates(Number(job.id));
    // 마감시각이 지난 공고를 '진행 중' 스냅샷으로 들고 있으면 보드의 '확정' 버튼이 남는다 → 열 때 목록도 갱신.
    loadJobs();
  };

  // 인재풀에서 후보 추가 — 피커 열기(전체 인재풀 로드)
  const openPicker = async () => {
    setPickerOpen(true);
    setPicked(new Set());
    setPickerQuery("");
    setPoolLoading(true);
    try {
      const res = await fetch("/api/admin/applicants");
      const json = await res.json();
      setPool((json.data ?? []) as PoolApplicant[]);
    } catch {
      toast.error("인재풀을 불러오지 못했어요");
    } finally {
      setPoolLoading(false);
    }
  };

  // 선택한 인재풀 후보를 공고에 추가 — '미발송' 상태로만 들어가고, 발송은 별도(컨택은 매니저 판단)
  const addFromPool = async () => {
    if (!candPanel || picked.size === 0) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/admin/jobs/${candPanel.jobId}/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_ids: [...picked] }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "후보 추가에 실패했어요");
        // partial = 후보는 이미 추가됐고 뒤 단계만 실패 — 화면이 DB와 어긋나면 재시도가 '0명 추가'로 보인다.
        if (json.partial) {
          setPickerOpen(false);
          loadCandidates(candPanel.jobId);
          loadJobs();
        }
        return;
      }
      toast.success(`${json.added ?? 0}명을 후보로 추가했어요`, {
        description: "미발송 상태로 추가됨 — 위 ‘스크리닝 문자 발송’으로 컨택하세요",
      });
      setPickerOpen(false);
      loadCandidates(candPanel.jobId);
      loadJobs();
    } catch {
      toast.error("후보 추가에 실패했어요");
    } finally {
      setAdding(false);
    }
  };

  const unsentCount = candidates.filter((c) => !c.sent_at).length;

  // 피커에 띄울 인재풀 — 이미 이 공고 후보인 사람·부적합·이탈 제외 + 검색어 매칭
  const existingCandIds = new Set(candidates.map((c) => c.applicant_id));
  const pq = pickerQuery.trim();
  const pickablePool = pool.filter((p) => {
    if (existingCandIds.has(p.id)) return false;
    if (p.status === "부적합" || p.status === "이탈") return false;
    if (pq && !((p.name ?? "").includes(pq) || (p.phone ?? "").includes(pq) || (p.branch1 ?? "").includes(pq))) return false;
    return true;
  });

  // 전화번호 복사 — 킬스위치 중 수동 응대(직접 전화·문자)의 최소 동선.
  const copyPhone = async (phone: string) => {
    try {
      await navigator.clipboard.writeText(phone);
      toast.success("전화번호를 복사했어요");
    } catch {
      toast.error("복사에 실패했어요");
    }
  };

  // 공고별 요약 집계 (단계/채널/확정 슬롯) — agent_stage NULL은 'interest'(관심 표시)로 분리(오표기 방지).
  const stageCounts = candidates.reduce<Record<string, number>>((acc, c) => {
    const s = c.agent_stage ?? "interest";
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const channelCounts = candidates.reduce<Record<string, number>>((acc, c) => {
    const s = c.applicants?.source ?? "direct";
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const confirmedCands = candidates.filter((c) => c.applicants?.status === "확정인력");
  const slotFill = SLOT_KEYS.map((s) => ({
    ...s,
    // 확정 슬롯이 비면 희망 시간대(work_hours)로 폴백 — confirmed_slot 미입력 확정인력도 집계.
    count: confirmedCands.filter((c) => slotMatch(c.applicants?.confirmed_slot || c.applicants?.work_hours, s.key)).length,
  }));
  const hasConfirmedSlot = slotFill.some((s) => s.count > 0);
  // 추천순 = 즉시가능 > 이번주가능 > 그 외 → 공고 거리 asc(없으면 뒤) → 원지원일 desc. 최신순 = API 순서 유지.
  const sortedCandidates = useMemo(() => {
    if (candSort === "recent") return candidates;
    return [...candidates].sort((x, y) => {
      const ar = availabilityRank(x.applicants?.availability) - availabilityRank(y.applicants?.availability);
      if (ar !== 0) return ar;
      const dx = typeof x.distance_km === "number" ? x.distance_km : Infinity;
      const dy = typeof y.distance_km === "number" ? y.distance_km : Infinity;
      if (dx !== dy) return dx - dy;
      const tx = x.applicants?.applied_at ? Date.parse(x.applicants.applied_at) : 0;
      const ty = y.applicants?.applied_at ? Date.parse(y.applicants.applied_at) : 0;
      return ty - tx;
    });
  }, [candidates, candSort]);
  const stageGroups = STAGE_ORDER
    .map((stage) => ({ stage, items: sortedCandidates.filter((c) => (c.agent_stage ?? "interest") === stage) }))
    .filter((g) => g.items.length > 0);

  // 헤더 '공고 등록' 버튼 → /jobs?new=1 로 진입하면 실제 작성 모달 자동 오픈 (진입점 일원화)
  // 긴급 건 카드 '공고로 만들기' → /jobs?new=1&line=&region=&vehicle=&period= 로 진입하면 등록 폼 프리필
  // 헤더 글로벌 검색 → /jobs?q=제목 으로 진입하면 검색어 프리필
  useEffect(() => {
    const newParam = searchParams.get("new");
    const qParam = searchParams.get("q");
    if (newParam === "1") {
      const line = searchParams.get("line")?.trim() ?? "";
      const region = searchParams.get("region")?.trim() ?? "";
      const vehicle = searchParams.get("vehicle")?.trim() ?? "";
      const period = searchParams.get("period")?.trim() ?? "";
      const sosId = searchParams.get("sos_id");
      // 긴급 건에서 넘어온 경우 라인·권역·차종·기간을 등록 폼에 프리필해 재입력을 없앤다.
      if (line || region || vehicle || period || sosId) {
        if (line) setPostingTitle(`${line} 긴급 백업`);
        if (period) setNewJobPeriod(period);
        if (sosId) setNewJobSosId(sosId);
        // 등록 후 '대상 선별' CTA에서 파이프라인 필터로 매핑하기 위해 권역/차종 원문을 보관.
        if (region) setNewJobSosRegion(region);
        if (vehicle) setNewJobSosVehicle(vehicle);
        // 권역/차종은 등록 폼에 전용 입력이 없어 본문 초안 첫 줄에 삽입한다.
        const extra = [region && `권역: ${region}`, vehicle && `차종: ${vehicle}`].filter(Boolean).join(" / ");
        if (extra || line) {
          const body = [line && `${line} 긴급 백업 모집`, extra].filter(Boolean).join("\n");
          setChannelDrafts({ danggeun: body, albamon: body, sms: body });
          setActiveChannel("albamon");
        }
      }
      setAiModalOpen(true);
      router.replace("/jobs");
    } else if (qParam) {
      setQuery(qParam);
      router.replace("/jobs");
    }
  }, [searchParams, router]);

  // 공고 목록은 SWR 캐시로 — 탭 재방문 시 즉시 표시. 변경 후 갱신은 loadJobs(=mutate)로.
  const { data: jobsApi, error: jobsError, isLoading: jobsLoading, mutate: mutateJobs } = useSWR<{ jobs?: ApiJob[] }>("/api/admin/jobs?status=all");
  const jobs = useMemo(
    () => (jobsApi?.jobs ?? []).filter((j) => !isSystemJobTitle(j.title)).map(toJobRow),
    [jobsApi]
  );
  // 마감(실질) 공고는 확정 대상에서 제외된다(지원자 상세의 확정 대상 판정과 동일) → 보드에서도 '확정' 버튼을 숨긴다.
  const boardJobClosed = candPanel ? jobs.find((j) => Number(j.id) === candPanel.jobId)?.effectivelyClosed ?? false : false;
  // 로딩/에러를 빈 상태와 구분 — 미구분 시 느린 로딩·500에서 '공고 0건'으로 오인된다.
  const jobsFirstLoad = jobsLoading && !jobsApi;
  const loadJobs = useCallback(() => { void mutateJobs(); }, [mutateJobs]);

  // 필터용 메타데이터(화주사/지점) — 실패해도 조용히 무시.
  const { data: clientsApi } = useSWR<{ data?: ClientOpt[] }>("/api/admin/clients");
  const { data: branchesApi } = useSWR<{ data?: BranchOpt[] }>("/api/admin/branches");
  const { data: siteManagersApi } = useSWR<{ data?: SiteManagerOpt[] }>("/api/admin/site-managers");
  const clients = useMemo(() => (clientsApi?.data ?? []).map((c) => ({ id: c.id, name: c.name, uses_slots: c.uses_slots })), [clientsApi]);
  const branches = useMemo(() => (branchesApi?.data ?? []).map((b) => ({ id: b.id, name: b.name, client_id: b.client_id })), [branchesApi]);
  const siteManagers = useMemo(() => (siteManagersApi?.data ?? []).map((m) => ({ id: m.id, name: m.name, active: m.active ?? true })), [siteManagersApi]);
  // 편집 모달 지점 셀렉터 노출 — 지점 개념 화주사(슬롯/지점보유)이거나, 이미 지점이 붙은 공고(고아 방지)면 노출.
  const editShowBranch = !!editForm && (
    Boolean(clients.find((c) => c.id === editForm.clientId)?.uses_slots) ||
    branches.some((b) => b.client_id === editForm.clientId) ||
    editForm.branchId !== ""
  );

  const handleGenerateJD = async () => {
    if (!aiPrompt.trim()) return toast.error("채용 조건을 입력해주세요.");
    setIsGenerating(true);
    setChannelDrafts(null);
    setAiSource(null);
    try {
      const res = await fetch("/api/admin/jobs/generate-posting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 선택된 화주사·지점을 함께 보내 서버가 마스터(화주사명·지점 집결지/시급)를 초안에 반영(D2).
        body: JSON.stringify({
          prompt: aiPrompt.trim(),
          ...(newJobClientId !== "" ? { client_id: newJobClientId } : {}),
          ...(newJobBranchId !== "" ? { branch_id: newJobBranchId } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.posting) {
        toast.error(json.error || "공고 생성에 실패했어요");
        return;
      }
      const p = json.posting as {
        title: string;
        fields?: { pay?: string; schedule?: string };
        danggeun: { body: string };
        albamon: { body: string };
        sms: { body: string };
      };
      setPostingTitle(p.title ?? "");
      setChannelDrafts({
        danggeun: p.danggeun?.body ?? "",
        albamon: p.albamon?.body ?? "",
        sms: p.sms?.body ?? "",
      });
      // AI 초안이 뽑아낸 급여·근무 정보로 참고정보 필드를 프리필해 재입력을 줄인다(사용자가 비운 필드만).
      const payText = p.fields?.pay?.trim();
      const schedText = p.fields?.schedule?.trim();
      // pay_info는 항상 보이는 '급여' 그룹이라 채우기만 하면 됨. ai_facts는 접이식 안이라 값이 있을 때만 펼친다.
      if (payText) setNewJobPayInfo((prev) => prev || payText);
      if (schedText) {
        setNewJobAiFacts((prev) => prev || `근무: ${schedText}`);
        setNewJobExtraOpen(true);
      }
      setActiveChannel("danggeun");
      setPromptOpen(false); // 초안이 화면 위쪽에 오게 — 조건 입력은 '조건 수정'으로 다시 펼친다
      setAiSource(json.source === "mock" ? "mock" : "ai");
      toast.success(json.source === "mock" ? "초안을 생성했어요 (오프라인 템플릿)." : "AI가 채널별 공고 초안을 완성했어요.");
    } catch {
      toast.error("공고 생성에 실패했어요");
    } finally {
      setIsGenerating(false);
    }
  };

  const copyChannel = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} 공고를 복사했어요.`);
    } catch {
      toast.error("복사에 실패했어요");
    }
  };

  // 등록 모달 입력 초기화 — 등록 성공·모달 닫기에서 공통 사용.
  const resetNewJobForm = () => {
    setAiPrompt("");
    setPromptOpen(true);
    setChannelDrafts(null);
    setAiSource(null);
    setPostingTitle("");
    setNewJobClientId("");
    setNewJobBranchId("");
    setNewJobSiteManagerId("");
    setNewJobMode(DEFAULT_RECRUIT_MODE);
    setChannelDraftsFromCopy(false);
    setDuplicatedFrom(null);
    setNewJobCapacity(1);
    setNewJobPayType("");
    setNewJobPayAmount("");
    setNewJobPeriod("");
    setNewJobClosesAt("");
    setNewJobSlot("");
    setNewJobSlotKeys([]);
    setNewJobStartDate("");
    setNewJobPickupAddress("");
    setNewJobDropoffAddress("");
    setNewJobVehicleRequired(true);
    setNewJobPayInfo("");
    setNewJobPolicyNotes("");
    setNewJobAiFacts("");
    setNewJobExposure(EMPTY_EXPOSURE);
    setNewJobExtraOpen(false);
    setNewJobSosId(null);
    setNewJobSosRegion(null);
    setNewJobSosVehicle(null);
  };

  // 등록에 쓸 본문이 실제로 있나 — '직접 작성'으로 빈 편집칸만 열어둔 상태와 구분한다.
  // (AI 초안 없이도 등록할 수 있게 하면서, 빈 공고가 등록되는 것은 계속 막는다.)
  const draftBody = channelDrafts ? (channelDrafts.albamon || channelDrafts.danggeun || channelDrafts.sms).trim() : "";

  // 등록 모달 닫기 — 작성 중이면 확인 후 파기. 무확인 즉시 초기화로 10분 작업이
  // 통째 사라지던 문제 방지. 본문 유무를 '작업 있음' 프록시로 사용(빈 편집칸은 확인 없이 닫는다).
  const closeRegisterModal = async () => {
    if (draftBody) {
      const ok = await confirm({
        title: "작성 중인 내용을 버릴까요?",
        description: "생성한 AI 초안과 입력한 내용이 모두 사라져요. 등록하지 않고 닫으면 복구할 수 없어요.",
        confirmText: "버리고 닫기",
        destructive: true,
      });
      if (!ok) return;
    }
    setAiModalOpen(false);
    resetNewJobForm();
  };

  // 공고 복제 — 기존 공고를 프리필한 등록 모달을 연다(후보·마감시각·id는 비움).
  // 정기 라인 재모집 시 반복 입력을 없앤다. 등록은 기존 POST를 그대로 재사용.
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const duplicateJob = async (jobId: string) => {
    setDuplicatingId(jobId);
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}`);
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "공고를 불러오지 못했어요");
        return;
      }
      const j = json.job;
      resetNewJobForm();
      const body = (j.body ?? "").trim();
      // 채널별 본문이 저장돼 있으면 채널 특화를 보존해 복제(D1). 없으면(레거시) 캐논 본문으로 3채널 채움.
      const cb = (j.channel_bodies ?? null) as { danggeun?: string; albamon?: string; sms?: string } | null;
      // 당근·문자 탭에 저장본을 쓰면 그 뒤 수정 모달로 고친 본문이 반영되지 않는다 → 그 사실을 화면에 밝힌다.
      setChannelDraftsFromCopy(Boolean(cb?.danggeun || cb?.sms));
      setDuplicatedFrom((j.title ?? "").slice(0, 24) || "원본 공고");
      setChannelDrafts({
        danggeun: cb?.danggeun || body,
        // 알바몬=캐논 채널이라 항상 현재 body(편집 모달 수정 반영)를 사용 — 편집 후 복제 시 stale channel_bodies로 수정분이 유실되지 않게.
        albamon: body,
        sms: cb?.sms || body,
      });
      setActiveChannel("albamon");
      setPromptOpen(false);
      setPostingTitle((j.title ?? "").slice(0, 80));
      setNewJobClientId(typeof j.client_id === "number" ? j.client_id : "");
      setNewJobBranchId(typeof j.branch_id === "number" ? j.branch_id : "");
      setNewJobSiteManagerId(typeof j.site_manager_id === "number" ? j.site_manager_id : "");
      const dupExternal = asRecruitMode(j.recruit_mode) === "external";
      setNewJobMode(asRecruitMode(j.recruit_mode));
      // 노출 설정도 복제 — 정기 라인 재모집 시 같은 타깃 규칙 재사용(수동 명단은 공고별이라 복제 안 됨).
      // 단 external은 pull 미노출 → 지정 노출이 고아로 복제되지 않게 전체 노출로 리셋(D10 일관성).
      const dupRule = ruleToDraft(j.exposure_rule);
      // 반경은 복제하지 않는다 — 등록 모달엔 반경을 보거나 끌 UI가 없어(공고 저장 후에만 설정 가능),
      // 보이지 않는 규칙이 등록 가드(집결지 좌표 필요)에 걸리면 원인을 알 수 없는 등록 실패가 된다.
      const dupHadRadius = dupRule.radiusKm !== "";
      dupRule.radiusKm = "";
      dupRule.radiusIncludeUnknown = false;
      setNewJobExposure(
        dupExternal ? EMPTY_EXPOSURE : { exposure: j.exposure === "targeted" ? "targeted" : "all", rule: dupRule }
      );
      if (!dupExternal && dupHadRadius) {
        toast.info("원본의 거리 반경 조건은 복제되지 않아요 — 등록 후 공고 수정에서 다시 설정하세요(집결지 좌표가 잡힌 뒤에 가능).");
      }
      // 수동 명단 전용(규칙 없는) 지정 노출 공고를 복제하면 노출 0명 공고가 될 수 있어 경고.
      if (!dupExternal && j.exposure === "targeted" && !draftToRule(dupRule)) {
        toast.info("지정 노출 공고예요 — 수동 지정 명단은 복제되지 않아요. 등록 후 파이프라인에서 노출 대상을 다시 지정하세요.");
      }
      setNewJobCapacity(typeof j.capacity === "number" && j.capacity > 0 ? j.capacity : 1);
      setNewJobPayType(j.pay_type ?? "");
      setNewJobPayAmount(typeof j.pay_amount === "number" ? j.pay_amount : "");
      setNewJobPeriod(j.work_period ?? "");
      setNewJobSlot(j.slot ?? "");
      setNewJobSlotKeys(Array.isArray(j.slot_keys) ? j.slot_keys.filter((k: unknown): k is string => typeof k === "string") : []);
      // 시작일은 복제하지 않는다 — 원본의 지난 날짜가 그대로 실려 지원자 화면과 만남장소 문자('일시')에 나간다.
      // 마감시각을 복제하지 않는 것과 같은 이유(라인별로 다시 정해야 하는 값).
      setNewJobStartDate("");
      setNewJobPickupAddress(j.pickup_address ?? "");
      setNewJobDropoffAddress(j.dropoff_address ?? "");
      setNewJobVehicleRequired(j.vehicle_required !== false);
      setNewJobPayInfo(j.pay_info ?? "");
      setNewJobPolicyNotes(j.policy_notes ?? "");
      setNewJobAiFacts(j.ai_facts ?? "");
      // 접이식(근무상세·정책)은 그 안 필드가 있을 때만 연다. pay_info는 항상 보이는 급여 그룹이라 트리거에서 제외.
      if (j.policy_notes || j.ai_facts || j.slot || j.start_date || j.pickup_address || j.dropoff_address) setNewJobExtraOpen(true);
      setAiModalOpen(true);
    } catch {
      toast.error("공고를 불러오지 못했어요");
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleRegisterJob = async () => {
    if (!channelDrafts || registering) return;
    // 등록 시 알바몬(정형) 본문을 공고 원문으로 저장 — AI 스크리닝이 참조하는 캐논 본문.
    const body = draftBody;
    if (!body) return;
    // '__' 예약 프리픽스로 시작하면 목록·pull에서 숨겨져 사라진 것처럼 보이므로 제거(서버도 400으로 방어).
    // 제목 폴백은 **실제 저장되는 본문**의 첫 줄에서 뽑는다(알바몬 탭이 비고 당근 탭만 쓴 경우 대비).
    const title = stripSystemPrefix((postingTitle || body.split("\n")[0] || "새 공고").trim()).slice(0, 80) || "새 공고";
    // 마감시각을 과거로 넣으면 등록 즉시 pull에서 '마감됨'으로 빠져 혼란 — 저장 전 경고.
    if (newJobClosesAt && new Date(newJobClosesAt).getTime() <= Date.now()) {
      toast.error("마감시각이 과거입니다. 현재 이후 시각으로 설정해주세요.");
      return;
    }
    // 시작일도 과거면 막는다 — 이 값은 지원자 화면 카드와 확정 후속 '만남장소' 문자의 일시로 그대로 나간다.
    if (newJobStartDate && newJobStartDate < todayLocalDate()) {
      toast.error("시작일이 지난 날짜입니다. 오늘 이후 날짜로 설정해주세요.");
      return;
    }
    // resetNewJobForm()이 SOS 상태를 지우기 전에, 등록 후 CTA용으로 스냅샷을 잡아둔다.
    const sosSnapshot = { id: newJobSosId, region: newJobSosRegion, vehicle: newJobSosVehicle };
    // 선택 화주사에 실제 속한 지점만 유효 지점으로 취급(숨겨졌거나 타 화주사에 속한 stale 지점은 무시).
    const effNewJobBranchId =
      newJobBranchId !== "" && branches.some((b) => b.id === newJobBranchId && b.client_id === newJobClientId)
        ? newJobBranchId
        : "";
    setRegistering(true);
    try {
      const res = await fetch("/api/admin/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          // 채널별 초안 본문(당근/알바몬/SMS) 부가 저장 — body는 캐논 유지(D1 반자동 초안 인프라).
          ...(channelDrafts ? { channel_bodies: channelDrafts } : {}),
          // 긴급 건에서 파생된 공고면 sos_request_id로 연결 저장(자동 해결 연동은 범위 밖).
          ...(newJobSosId && /^\d+$/.test(newJobSosId) ? { sos_request_id: Number(newJobSosId) } : {}),
          // 선택 화주사에 실제 속한 지점만 유효로 취급 — 복제 등으로 남은 타 화주사 stale 지점이 숨겨진 채 재전송돼 조용히 다른 화주사로 귀속되는 것을 막는다.
          // 지점 미선택이어도 화주사만 고르면 client_id를 실어 필터 유실을 막는다(지점 선택 시 서버가 소속 화주사로 역채움).
          branch_id: effNewJobBranchId === "" ? null : effNewJobBranchId,
          ...(effNewJobBranchId === "" && newJobClientId !== "" ? { client_id: newJobClientId } : {}),
          ...(newJobSiteManagerId !== "" ? { site_manager_id: newJobSiteManagerId } : {}),
          recruit_mode: newJobMode,
          exposure: newJobExposure.exposure,
          exposure_rule: draftToRule(newJobExposure.rule),
          capacity: newJobCapacity,
          vehicle_required: newJobVehicleRequired,
          pay_type: newJobPayType || null,
          // 금액은 단가형태가 있고 '협의'가 아닐 때만 저장. '협의'/미지정이면 화면에 숨긴 stale 금액이 실려
          // AI 응대에 '협의 3,500원' 같은 모순 단가가 주입되지 않게 null 정규화(등록·수정 공통 규칙).
          pay_amount: newJobPayType && newJobPayType !== "협의" && newJobPayAmount !== "" ? Number(newJobPayAmount) : null,
          pay_info: newJobPayInfo.trim() || null,
          policy_notes: newJobPolicyNotes.trim() || null,
          ai_facts: newJobAiFacts.trim() || null,
          slot: newJobSlot || null,
          slot_keys: newJobSlotKeys,
          start_date: newJobStartDate || null,
          pickup_address: newJobPickupAddress.trim() || null,
          dropoff_address: newJobDropoffAddress.trim() || null,
          // datetime-local 값은 로컬(KST) 기준 → ISO(UTC)로 변환해 전송. 빈 값이면 미전송.
          ...(newJobPeriod ? { work_period: newJobPeriod } : {}),
          ...(newJobClosesAt ? { closes_at: new Date(newJobClosesAt).toISOString() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "공고 등록에 실패했어요");
        return;
      }
      // 지오코딩 결과 병기 — 주소를 넣었는데 좌표가 안 잡히면 거리 정렬이 안 되므로 저장 시점에 알린다.
      const geoNote = geocodeResultNote(json.job, newJobPickupAddress, newJobDropoffAddress);
      // 긴급 건에서 파생된 공고면 '이 조건으로 대상 선별' CTA를 붙여 탭 이동 단절을 없앤다(SOS→공고→선별 브릿지).
      if (sosSnapshot.id) {
        const params = sosToPipelineParams(sosSnapshot.region, sosSnapshot.vehicle);
        params.set("status", "스크리닝 전");
        toast.success("새 공고가 등록되었어요.", {
          description: [geoNote, "이 조건에 맞는 인력풀에서 다시 연락할 대상을 선별하세요."].filter(Boolean).join(" · "),
          action: {
            label: "이 조건으로 대상 선별 →",
            onClick: () => router.push(`/pipeline?${params.toString()}`),
          },
          duration: 8000,
        });
      } else {
        // 배치 등록 동선 — 목록에서 카드를 찾아 복제하러 가는 왕복을 없앤다(권역만 다른 라인 6~7개가 기본).
        const registeredId = typeof json.job?.id === "number" ? String(json.job.id) : null;
        toast.success("새 공고가 등록되었어요.", {
          ...(geoNote ? { description: geoNote } : {}),
          ...(registeredId
            ? {
                action: {
                  label: "복제해서 하나 더 →",
                  onClick: () => void duplicateJob(registeredId),
                },
                duration: 10000,
              }
            : {}),
        });
      }
      setAiModalOpen(false);
      resetNewJobForm();
      await loadJobs();
      // 새 공고를 기다리던 사람들(안내 약속·알림 신청·조건 맞는 최근 관심) 원클릭 안내 — 대상 ≥1일 때만 모달.
      // 조회 실패는 등록 흐름에 영향 없음(행 '대기자에게 안내'로 나중에 가능).
      const newJobId = typeof json.job?.id === "number" ? json.job.id : null;
      if (newJobId !== null) {
        try {
          const at = await fetchAnnounceTargets(newJobId);
          if (at.targets.length > 0) {
            setAnnounceModal({ jobId: newJobId, smsTitle: at.sms_title, targets: at.targets, groups: at.groups, night: at.night, dropped: at.dropped_by_exposure });
          } else if ((at.dropped_by_fatigue?.total ?? 0) > 0) {
            // **두 번째 공고부터의 침묵을 없앤다** — 대상 0명의 이유가 '이력 없음'이 아니라
            // '최근 N일 안에 다른 공고 안내를 이미 받음'이다. 그분들 맞춤 링크에는 이 공고도 함께 보인다.
            const f = at.dropped_by_fatigue!;
            toast.info("따로 안내 문자를 보낼 대상은 없어요", {
              description:
                `최근 ${at.fatigue_days ?? 7}일 안에 다른 공고 안내를 이미 받은 ${f.total}명이 있어 이번엔 빠졌어요` +
                `${f.promised > 0 ? `(그중 ${f.promised}명은 '먼저 안내드릴게요' 약속)` : ""}. ` +
                `문자를 또 보내지 않는 것이 맞고, 그분들 맞춤 공고 링크에는 이 공고도 함께 보입니다.`,
              duration: 9000,
            });
          } else if ((at.dropped_by_exposure?.total ?? 0) > 0) {
            // 대상 0명이 '이력이 없어서'가 아니라 '노출 명단이 좁아서'인 경우 — 등록 경로에서도 침묵하지 않는다.
            toast.info("안내할 대기자가 없어요", {
              description: `이 공고는 지정 노출이라 명단 밖 ${at.dropped_by_exposure?.total}명이 대상에서 빠졌어요${
                (at.dropped_by_exposure?.promised ?? 0) > 0 ? `(그중 ${at.dropped_by_exposure?.promised}명은 '먼저 안내드릴게요' 약속)` : ""
              }. 명단을 넓히거나 인재풀에서 직접 문자를 보내세요.`,
            });
          }
        } catch {
          /* noop */
        }
      }
    } catch {
      toast.error("공고 등록에 실패했어요");
    } finally {
      setRegistering(false);
    }
  };

  const q = query.trim();
  const filteredJobs = jobs.filter(job => {
    // 탭은 실질 마감(effectivelyClosed) 기준 — 마감시각이 지난 공고는 status='active'여도 '마감됨' 탭으로(행 상태 pill과 일치).
    if (activeTab === 'active' && job.effectivelyClosed) return false;
    if (activeTab === 'closed' && !job.effectivelyClosed) return false;
    if (clientFilter !== "" && job.clientId !== clientFilter) return false;
    if (branchFilter !== "" && job.branchId !== branchFilter) return false;
    if (q && !(job.title.includes(q) || job.branch.includes(q))) return false;
    return true;
  });

  const branchOptions = clientFilter === "" ? branches : branches.filter(b => b.client_id === clientFilter);

  const openEdit = useCallback(async (id: string) => {
    setEditDroppedBranch(null);
    setEditForm({ id, title: "", body: "", clientId: "", branchId: "", siteManagerId: "", capacity: 1, vehicleRequired: true, payInfo: "", policyNotes: "", payType: "", payAmount: "", aiFacts: "", recruitMode: DEFAULT_RECRUIT_MODE, workPeriod: "", closesAt: "", slot: "", slotKeys: [], startDate: "", pickupAddress: "", dropoffAddress: "", distanceBasis: DEFAULT_DISTANCE_BASIS, exposureDraft: EMPTY_EXPOSURE, exposureBaseline: EMPTY_EXPOSURE });
    setEditOpenSections({ basic: true, exposure: false, work: false, content: false });
    setEditLoading(true);
    try {
      const res = await fetch(`/api/admin/jobs/${id}`);
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "공고를 불러오지 못했어요");
        setEditForm(null);
        return;
      }
      const j = json.job;
      setEditForm({
        id,
        title: j.title ?? "",
        body: j.body ?? "",
        clientId: typeof j.client_id === "number" ? j.client_id : "",
        branchId: j.branch_id ?? "",
        siteManagerId: typeof j.site_manager_id === "number" ? j.site_manager_id : "",
        capacity: j.capacity ?? 1,
        vehicleRequired: !!j.vehicle_required,
        payInfo: j.pay_info ?? "",
        policyNotes: j.policy_notes ?? "",
        payType: j.pay_type ?? "",
        payAmount: typeof j.pay_amount === "number" ? j.pay_amount : "",
        aiFacts: j.ai_facts ?? "",
        recruitMode: asRecruitMode(j.recruit_mode),
        workPeriod: j.work_period ?? "",
        closesAt: isoToLocalInput(j.closes_at ?? null),
        slot: j.slot ?? "",
        slotKeys: Array.isArray(j.slot_keys) ? j.slot_keys.filter((k: unknown): k is string => typeof k === "string") : [],
        startDate: j.start_date ?? "",
        pickupAddress: j.pickup_address ?? "",
        dropoffAddress: j.dropoff_address ?? "",
        distanceBasis: normalizeDistanceBasis(j.distance_basis),
        exposureDraft: {
          exposure: j.exposure === "targeted" ? "targeted" : "all",
          rule: ruleToDraft(j.exposure_rule),
        },
        // 같은 값을 기준선으로 보관 — 저장 시 이 값과 같으면 노출 필드를 전송하지 않는다.
        exposureBaseline: {
          exposure: j.exposure === "targeted" ? "targeted" : "all",
          rule: ruleToDraft(j.exposure_rule),
        },
      });
    } catch {
      toast.error("공고를 불러오지 못했어요");
      setEditForm(null);
    } finally {
      setEditLoading(false);
    }
  }, []);

  // 두뇌 'AI 지식 현황' 등에서 /jobs?edit=<id> 로 진입하면 해당 공고 편집 모달 자동 오픈
  useEffect(() => {
    const editParam = searchParams.get("edit");
    if (editParam) {
      openEdit(editParam);
      router.replace("/jobs");
    }
  }, [searchParams, router, openEdit]);

  const handleEditSave = async () => {
    if (!editForm) return;
    const title = editForm.title.trim();
    if (!title) return toast.error("공고 제목을 입력해주세요.");
    // 마감시각을 과거로 저장하면 pull에서 즉시 '마감됨' 처리 — 저장 전 경고.
    if (editForm.closesAt && new Date(editForm.closesAt).getTime() <= Date.now()) {
      return toast.error("마감시각이 과거입니다. 현재 이후 시각으로 설정해주세요.");
    }
    // 화주사를 바꿔 지점이 떨어져 나간 상태 — 지점 연결과 지점명이 함께 지워지므로 확인을 받는다.
    // 대체 지점을 골랐으면 지워지는 게 없으므로 확인을 묻지 않는다(거짓 경고 방지).
    if (editDroppedBranch && editForm.branchId === "") {
      const ok = await confirm({
        title: "지점 연결을 지우고 저장할까요?",
        description: `'${editDroppedBranch.name}' 지점 연결과 이 공고의 지점명이 지워져요.\n지원 폼 지점 프리필·현장 안내 문자·화주사 집계에 쓰이는 값이라, 새 화주사의 지점을 다시 고르는 편이 안전해요.`,
        confirmText: "지점 지우고 저장",
      });
      if (!ok) return;
    }
    // 노출을 이 창에서 실제로 바꿨는지 — 안 바꿨으면 노출 필드를 아예 보내지 않는다.
    // 파이프라인 '이 명단에게만 노출'이 같은 컬럼을 쓰기 때문에, 급여만 고친 저장이 방금 좁힌 노출을
    // 되돌리거나(전환 취소) 되돌릴 수 없다며 지운 규칙을 부활시키는 사고가 난다.
    // 배열 원소 **순서**는 규칙의 의미가 아니다 — 칩을 껐다 켜서 순서만 달라진 걸 '바꿨다'로 보면
    // 불필요한 노출 전송·보호 쓰기·낯선 안내가 뜬다. 비교 전에 배열을 정렬한다.
    const ruleFingerprint = (d: ExposureDraft) => {
      const r = draftToRule(d.rule);
      if (!r) return "null";
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(r).sort()) {
        const v = r[k];
        sorted[k] = Array.isArray(v) ? [...v].map(String).sort() : v;
      }
      return JSON.stringify(sorted);
    };
    const exposureChanged =
      editForm.exposureDraft.exposure !== editForm.exposureBaseline.exposure ||
      ruleFingerprint(editForm.exposureDraft) !== ruleFingerprint(editForm.exposureBaseline);
    // 바꿨다면, 그 사이 다른 화면(파이프라인)에서 노출이 바뀌었는지 확인하고 덮어쓸지 묻는다.
    if (exposureChanged) {
      let serverState: { exposure: "all" | "targeted"; rule: string } | null = null;
      try {
        const cur = await fetch(`/api/admin/jobs/${editForm.id}`).then((r) => (r.ok ? r.json() : null));
        const j = cur?.job as { exposure?: string | null; exposure_rule?: unknown } | undefined;
        if (j) {
          serverState = {
            exposure: j.exposure === "targeted" ? "targeted" : "all",
            rule: ruleFingerprint({ exposure: "all", rule: ruleToDraft(j.exposure_rule) }),
          };
        }
      } catch {
        /* 아래에서 fail-closed로 처리 */
      }
      if (!serverState) {
        // 확인할 수 없으면 조용히 덮어쓰지 않는다 — 이 확인이 '되돌릴 수 없이 지운 규칙 부활'의 유일한 방어선이다.
        const ok = await confirm({
          title: "지금 저장된 노출 설정을 확인할 수 없어요",
          description:
            "이 창의 노출 값으로 덮어쓰면, 그 사이 다른 화면(인재풀 '이 명단에게만 노출')에서 바꾼 전환·규칙이 사라질 수 있어요.\n확실하지 않으면 취소하고 창을 닫았다 다시 열어 주세요.",
          confirmText: "그래도 덮어쓰기",
          destructive: true,
        });
        if (!ok) return;
      } else if (
        serverState.exposure !== editForm.exposureBaseline.exposure ||
        serverState.rule !== ruleFingerprint(editForm.exposureBaseline)
      ) {
        const ok = await confirm({
          title: "이 공고의 노출 설정이 방금 다른 화면에서 바뀌었어요",
          description: `지금 서버: ${serverState.exposure === "targeted" ? "지정 노출" : "전체 노출"}${
            serverState.rule === "null" ? " · 자동 규칙 없음" : " · 자동 규칙 있음"
          }\n이 창의 값으로 덮어쓰면 그 변경(노출 명단 전환·규칙)이 사라질 수 있어요.`,
          confirmText: "이 창 값으로 덮어쓰기",
          destructive: true,
        });
        if (!ok) return;
      }
    }
    setEditSaving(true);
    try {
      const res = await fetch(`/api/admin/jobs/${editForm.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body: editForm.body,
          branch_id: editForm.branchId === "" ? null : editForm.branchId,
          // 화주사 — 지점이 있으면 서버가 지점 소속으로 역채움한다(지점이 기준).
          client_id: editForm.clientId === "" ? null : editForm.clientId,
          site_manager_id: editForm.siteManagerId === "" ? null : editForm.siteManagerId,
          capacity: editForm.capacity,
          vehicle_required: editForm.vehicleRequired,
          pay_info: editForm.payInfo.trim() || null,
          policy_notes: editForm.policyNotes.trim() || null,
          pay_type: editForm.payType || null,
          // '협의'/미지정이면 pay_amount=null 정규화 — 조건부로 숨긴 금액칸의 stale 값이 저장돼 AI가 모순 단가를
          // 인용하는 것을 막고, 레거시 '협의+금액' 데이터도 다음 저장 시 자동 교정된다(등록 POST와 동일 규칙).
          pay_amount: editForm.payType && editForm.payType !== "협의" && editForm.payAmount !== "" ? Number(editForm.payAmount) : null,
          ai_facts: editForm.aiFacts.trim() || null,
          recruit_mode: editForm.recruitMode,
          // 노출은 이 창에서 바꿨을 때만 전송 — 서버는 본문에 없는 필드를 건드리지 않는다.
          ...(exposureChanged
            ? {
                exposure: editForm.exposureDraft.exposure,
                exposure_rule: draftToRule(editForm.exposureDraft.rule),
              }
            : {}),
          work_period: editForm.workPeriod || null,
          closes_at: editForm.closesAt ? new Date(editForm.closesAt).toISOString() : null,
          slot: editForm.slot || null,
          slot_keys: editForm.slotKeys,
          start_date: editForm.startDate || null,
          pickup_address: editForm.pickupAddress.trim() || null,
          dropoff_address: editForm.dropoffAddress.trim() || null,
          distance_basis: editForm.distanceBasis,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "수정에 실패했어요");
        return;
      }
      // 지오코딩 결과 병기 — 주소를 넣었는데 좌표가 안 잡히면 거리 정렬이 안 되므로 저장 시점에 알린다.
      const geoNote = geocodeResultNote(json.job, editForm.pickupAddress, editForm.dropoffAddress);
      // 노출을 좁혔다면 서버가 이미 연결된 인원을 명단에 남긴다 — 그 사실을 알려준다(확정·배정이 아니다).
      const autoNote =
        typeof json.auto_included === "number" && json.auto_included > 0
          ? `이미 이 공고로 연결된 ${json.auto_included}명은 노출 명단에 남겼어요(직접 제외한 분은 그대로 제외).`
          : "";
      const desc = [geoNote, autoNote].filter(Boolean).join(" ");
      toast.success("공고를 수정했어요.", desc ? { description: desc } : undefined);
      setEditForm(null);
      await loadJobs();
    } catch {
      toast.error("수정에 실패했어요");
    } finally {
      setEditSaving(false);
    }
  };

  const handleToggleClose = async (job: JobRow) => {
    // 실질 마감(effectivelyClosed) 기준으로 분기 — status='active'라도 마감시각이 지났으면 이미
    // 마감 상태라, 이 버튼은 '재개'여야 한다(예전엔 raw status로 판단해 이미 마감된 걸 또 마감).
    if (!job.effectivelyClosed) {
      // 마감 확인은 전용 모달 — 마감이 "떨어진 분들이 아무 연락도 못 받는" 순간이 되지 않게
      // 미선발 관심자 안내 발송 체크박스(기본 ON)와 문구 미리보기를 함께 보여준다.
      setCloseModal({ job, targets: [], loading: true, send: true });
      try {
        const res = await fetch(`/api/admin/pool-events/interested?job_id=${job.id}&detail=1`);
        const json = await res.json();
        const targets: CloseNotifyTarget[] = res.ok && Array.isArray(json?.targets) ? json.targets : [];
        // 조회 중 모달이 닫혔거나 다른 공고로 바뀌었으면 반영하지 않는다.
        setCloseModal((prev) => (prev && prev.job.id === job.id ? { ...prev, targets, loading: false } : prev));
      } catch {
        // 대상 조회 실패 — 체크박스 없이 마감만 가능(발송은 부가 동작).
        setCloseModal((prev) => (prev && prev.job.id === job.id ? { ...prev, targets: [], loading: false } : prev));
      }
      return;
    }
    // 재개 — 마감시각이 지나 있으면 status만 active로 바꿔도 여전히 '실질 마감'이라 재개가 무효다.
    // 이 경우 마감시각을 함께 해제(closes_at=null)해 정말로 다시 진행되게 한다(수정 모달로 가서
    // 마감시각을 지워야 하던 숨은 단계 제거).
    const closesPast = !!job.closesAt && new Date(job.closesAt).getTime() <= Date.now();
    // 메뉴 항목('공고 다시 열기')과 같은 동사로 통일 — 방금 누른 말과 확인 화면의 말이 달라 헷갈렸다.
    const ok = await confirm({
      title: "이 공고를 다시 열까요?",
      description: closesPast
        ? `'${job.title}' 공고를 다시 엽니다. 마감시각이 이미 지나 있어 함께 해제돼요(상시 진행). 필요하면 수정에서 새 마감시각을 정하세요.`
        : `'${job.title}' 공고를 다시 엽니다.`,
      confirmText: "다시 열기",
    });
    if (!ok) return;
    setStatusBusyId(job.id);
    try {
      const res = await fetch(`/api/admin/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active", ...(closesPast ? { closes_at: null } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "변경에 실패했어요");
        return;
      }
      toast.success("공고를 다시 진행합니다.");
      // 결원 우선 안내 연결고리 — 마감/충원 안내(waitlist_notice)를 받은 대기자 수를 힌트로 알린다.
      try {
        const r = await fetch(`/api/admin/pool-events/interested?job_id=${job.id}&detail=1`);
        const j = await r.json();
        const n = r.ok && typeof j?.waitlistNotifiedCount === "number" ? j.waitlistNotifiedCount : 0;
        if (n > 0) {
          toast.info(`이 공고 대기자 ${n}명 — 파이프라인에서 '공고 관심자 선택'으로 우선 안내할 수 있어요.`);
        }
      } catch {
        /* 힌트 조회 실패는 재개 흐름에 영향 없음 */
      }
      await loadJobs();
    } catch {
      toast.error("변경에 실패했어요");
    } finally {
      setStatusBusyId(null);
    }
  };

  // 안내 문자 청크 발송 + Sonner 구분 보고 — 마감 안내(job_closed)·새 공고 안내(new_job) 공용.
  // bulk-send 재사용으로 수신거부·인력풀 제외·10분 중복 가드는 서버가 재차 방어한다.
  const sendBulkNotices = async (
    targets: { id: number; phone: string }[],
    body: string,
    purpose: string,
    jobId: number,
    label: string,
    zeroSentNote?: string
  ) => {
    let sent = 0;
    const failErrors: string[] = [];
    let chunkFailed = 0;
    // bulk-send 1회 상한 50명 → 청크 발송. 한 청크가 실패해도 나머지는 계속(서버 중복 가드가 재발송 방지).
    for (let i = 0; i < targets.length; i += 50) {
      const chunk = targets.slice(i, i + 50);
      try {
        const res = await fetch("/api/admin/messages/bulk-send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipients: chunk.map((t) => ({ phone: t.phone, applicant_id: t.id })),
            body,
            purpose,
            job_id: jobId,
          }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          chunkFailed += chunk.length;
          continue;
        }
        sent += typeof json?.sent === "number" ? json.sent : 0;
        for (const r of (json?.results ?? []) as Array<{ success: boolean; error?: string }>) {
          if (!r.success) failErrors.push(r.error ?? "");
        }
      } catch {
        chunkFailed += chunk.length;
      }
    }
    // 결과 구분 보고 — 가드에 걸린 인원(수신거부·인력풀 제외·중복 방지·토큰 없음)은 '실패'가 아니라 의도된 제외.
    const guarded = failErrors.filter((e) =>
      e.includes("수신거부") || e.includes("인력풀 제외") || e.includes("중복 방지") || e.includes("토큰 없음")
    ).length;
    const failed = failErrors.length - guarded + chunkFailed;
    const parts = [`${sent}명 발송`];
    if (guarded) parts.push(`가드 제외 ${guarded}명`);
    if (failed) parts.push(`실패 ${failed}명`);
    (sent > 0 ? toast.success : toast.error)(
      `${label}: ${parts.join(" · ")}`,
      sent === 0 && zeroSentNote
        ? { description: zeroSentNote }
        : failed > 0
          ? { description: "실패분은 파이프라인 캠페인 발송으로 다시 보낼 수 있어요." }
          : undefined
    );
  };

  // 미선발 관심자 마감 안내 발송 — purpose='job_closed'로 보내면 서버가
  // pool_events(waitlist_notice, trigger:'job_closed')를 남겨 이후 '결원 시 우선 안내' 대상 역조회의 근거가 된다.
  const sendCloseNotices = async (job: JobRow, targets: CloseNotifyTarget[]) => {
    await sendBulkNotices(targets, closeNoticeBody(job), "job_closed", Number(job.id), "마감 안내", "발송은 실패했지만 공고 마감은 완료됐어요.");
  };

  // 지원자 화면 미리보기 — 테스트 지원자(설정: pull_preview_token)의 맞춤링크를 새 탭에 연다.
  // 등록·수정한 공고가 지원자에게 어떻게 보이는지(카드·마감 처리·관심 버튼)를 그대로 확인하는 동선.
  const [previewLoading, setPreviewLoading] = useState(false);
  const openApplicantPreview = async () => {
    if (previewLoading) return;
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/admin/pull-preview");
      const json = await res.json();
      if (!res.ok || !json.token) throw new Error(json?.error || "미리보기 토큰을 가져오지 못했어요");
      window.open(`/p/${json.token}`, "_blank", "noopener");
      toast.success(`${json.name ?? "테스트 지원자"}님 시점으로 열었어요`, {
        description: json.source === "fallback" ? "테스트 지원자가 지정되지 않아 최신 지원자 링크로 열었어요." : undefined,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "미리보기를 열지 못했어요");
    } finally {
      setPreviewLoading(false);
    }
  };

  // 새 공고 안내 대상 조회 — 등록 직후(자동)와 행 '대기자에게 안내'(수동) 공용.
  const fetchAnnounceTargets = async (jobId: number): Promise<AnnounceTargetsRes> => {
    const res = await fetch(`/api/admin/jobs/${jobId}/announce-targets`);
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || "대상 조회 실패");
    return json as AnnounceTargetsRes;
  };

  // 행 '대기자에게 안내' — 등록 직후 모달을 놓쳤거나 야간이라 미뤘을 때 같은 모달을 다시 연다.
  const openAnnounce = async (job: JobRow) => {
    if (announceBusyId) return;
    setAnnounceBusyId(job.id);
    try {
      const at = await fetchAnnounceTargets(Number(job.id));
      const dropped = at.dropped_by_exposure?.total ?? 0;
      const fatigued = at.dropped_by_fatigue?.total ?? 0;
      if (at.targets.length === 0) {
        toast.info("안내할 대기자가 없어요", {
          // 0명의 이유가 '이력 없음'이 아니라 '노출 명단이 좁아서'일 수 있다 — 원인을 바꿔 말하지 않는다.
          description:
            fatigued > 0
              ? `최근 ${at.fatigue_days ?? 7}일 안에 다른 공고 안내를 이미 받은 ${fatigued}명이 있어 이번엔 빠졌어요` +
                `${(at.dropped_by_fatigue?.promised ?? 0) > 0 ? `(그중 ${at.dropped_by_fatigue?.promised}명은 '먼저 안내드릴게요' 약속)` : ""}. ` +
                `문자를 또 보내지 않는 것이 맞고, 그분들 맞춤 공고 링크에는 이 공고도 함께 보입니다.`
              : dropped > 0
                ? `이 공고는 지정 노출이라 노출 명단 밖 ${dropped}명이 대상에서 빠졌어요. 명단을 넓히거나 인재풀에서 직접 문자를 보내세요.`
                : "먼저 안내 약속·알림 신청·최근 관심 이력에서 발송 가능한 대상이 없습니다.",
        });
        return;
      }
      setAnnounceModal({ jobId: Number(job.id), smsTitle: at.sms_title, targets: at.targets, groups: at.groups, night: at.night, dropped: at.dropped_by_exposure });
    } catch {
      toast.error("안내 대상을 불러오지 못했어요");
    } finally {
      setAnnounceBusyId(null);
    }
  };

  // 새 공고 안내 발송 — purpose='new_job'이 ping_sent meta에 {purpose, job_id}로 기록돼
  // announce-targets의 '최근 7일 수신자 제외'(주 1회 피로도 상한)의 근거가 된다.
  const sendAnnounce = async () => {
    if (!announceModal || announcing || announceModal.night) return;
    const { jobId, smsTitle, targets } = announceModal;
    setAnnouncing(true);
    try {
      await sendBulkNotices(targets, NEW_JOB_NOTICE.replace("{공고명}", smsTitle), "new_job", jobId, "새 공고 안내");
      setAnnounceModal(null);
    } finally {
      setAnnouncing(false);
    }
  };

  // 마감 확정 — 마감(PATCH)이 성공해야만 안내 발송하고, 발송 실패는 마감에 영향 없음(발송은 부가 동작).
  const confirmClose = async () => {
    if (!closeModal || closing) return;
    const { job, targets, send } = closeModal;
    setClosing(true);
    setStatusBusyId(job.id);
    try {
      const res = await fetch(`/api/admin/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "closed" }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "변경에 실패했어요");
        return;
      }
      setCloseModal(null);
      toast.success("공고를 마감했어요.");
      await loadJobs();
      if (send && targets.length > 0) {
        await sendCloseNotices(job, targets);
      }
    } catch {
      toast.error("변경에 실패했어요");
    } finally {
      setClosing(false);
      setStatusBusyId(null);
    }
  };

  // AI 자동 스크리닝은 공고 단위 토글이 아니라 전역 AI 스위치(에이전트 두뇌) + 공고 진행 상태로 결정된다.
  // 진행 중 공고의 후보에게만 AI가 응대하며, 전역 중지 시 모든 공고가 멈춘다.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/agent/kill-switch");
        const json = await res.json();
        setAiGlobalOn(!json.disabled && !json.env_forced);
      } catch {
        /* 표시용이므로 실패 시 기본 on 유지 */
      }
    })();
  }, []);

  // 채널별 게시 링크 — source 파라미터로 유입을 게시 채널에 귀속시킨다 (외부 게시 = 이중 인입의 ② 트랙).
  const PUBLISH_CHANNELS: { source: string; label: string }[] = [
    { source: "albamon", label: "알바몬" },
    { source: "jobkorea", label: "잡코리아" },
    { source: "openchat", label: "오픈카톡(용차방)" },
    { source: "referral", label: "지인 추천" },
    { source: "direct", label: "기타" },
  ];

  const copyJobLink = async (job: JobRow, source: string) => {
    const base = typeof window !== "undefined" ? window.location.origin : "";
    const params = new URLSearchParams({ source, job: job.id });
    if (job.branch && job.branch !== "-") params.set("branch", job.branch);
    const url = `${base}/apply?${params.toString()}`;
    try {
      await navigator.clipboard.writeText(url);
      const label = PUBLISH_CHANNELS.find((c) => c.source === source)?.label ?? source;
      toast.success(`${label} 게시용 지원 링크를 복사했어요. 유입이 '${label}' 채널로 집계됩니다.`);
    } catch {
      toast.error(`링크 복사 실패 — 직접 복사: ${url}`);
    }
  };

  return (
    <div className="p-8 pb-12">
      {/* Stats Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        {[
          { label: "전체 공고", value: jobs.length, unit: "건" },
          { label: "진행 중인 공고", value: jobs.filter(j => !j.effectivelyClosed).length, unit: "건", highlight: true },
          { label: "AI 자동 응대 공고", value: aiGlobalOn ? jobs.filter(j => !j.effectivelyClosed).length : 0, unit: "건", color: "text-info" },
          { label: "응대 시작 전(관심·미발송)", value: jobs.reduce((a, j) => a + j.newCandidates, 0), unit: "명", color: "text-success" }
        ].map((stat, i) => (
          <div key={i} className="bg-white border border-border-strong rounded-2xl p-5 shadow-sm flex flex-col justify-between">
            <div className="text-[13px] font-bold text-muted-foreground mb-2">{stat.label}</div>
            <div className="flex items-baseline gap-1">
              <span className={`text-[28px] font-extrabold tracking-tight leading-none ${stat.highlight ? 'text-warning-strong' : stat.color || 'text-foreground'}`}>
                {stat.value}
              </span>
              <span className="text-sm font-semibold text-muted-foreground">{stat.unit}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white border border-border-strong rounded-2xl shadow-sm overflow-x-auto flex flex-col min-h-[600px]">
        {/* Toolbar */}
        <div className="p-5 border-b border-border-strong flex flex-wrap items-center justify-between gap-4">
          <div className="flex gap-1.5">
            <button aria-selected={activeTab === 'all'} role="tab"
              onClick={() => setActiveTab('all')}
              className={`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeTab === 'all' ? 'bg-foreground text-white' : 'bg-white border border-border-strong text-gray-700 hover:bg-background'}`}
            >
              전체
            </button>
            <button aria-selected={activeTab === 'active'} role="tab"
              onClick={() => setActiveTab('active')}
              className={`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeTab === 'active' ? 'bg-foreground text-white' : 'bg-white border border-border-strong text-gray-700 hover:bg-background'}`}
            >
              진행 중 <span className="opacity-60 ml-1 font-medium">{jobs.filter(j => !j.effectivelyClosed).length}</span>
            </button>
            <button aria-selected={activeTab === 'closed'} role="tab"
              onClick={() => setActiveTab('closed')}
              className={`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeTab === 'closed' ? 'bg-foreground text-white' : 'bg-white border border-border-strong text-gray-700 hover:bg-background'}`}
            >
              마감됨 <span className="opacity-60 ml-1 font-medium">{jobs.filter(j => j.effectivelyClosed).length}</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 bg-background border border-border-strong rounded-xl px-2 py-1">
              <Filter size={15} className="text-muted-foreground ml-1" />
              <select
                value={clientFilter}
                onChange={(e) => {
                  const v = e.target.value === "" ? "" : Number(e.target.value);
                  setClientFilter(v);
                  setBranchFilter("");
                }}
                className="pr-8 bg-transparent text-sm font-semibold text-gray-700 py-1.5 pr-1 focus:outline-none cursor-pointer"
                aria-label="화주사로 목록 좁히기"
                title="화주사로 목록 좁히기"
              >
                <option value="">전체 화주사</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <span className="text-muted-foreground">›</span>
              <select
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value === "" ? "" : Number(e.target.value))}
                className="pr-8 bg-transparent text-sm font-semibold text-gray-700 py-1.5 pr-1 focus:outline-none cursor-pointer"
                aria-label="지점으로 목록 좁히기"
                title="지점으로 목록 좁히기"
              >
                <option value="">전체 지점</option>
                {branchOptions.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="공고명, 지점 검색"
                aria-label="공고명·지점 검색"
                className="pl-9 pr-4 py-2 border border-border-strong rounded-xl text-sm w-[220px] focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
              />
            </div>
            <Button
              variant="secondary"
              onClick={openApplicantPreview}
              isLoading={previewLoading}
              title="테스트 지원자의 맞춤 공고 링크를 새 탭에 열어 지원자에게 보이는 화면을 그대로 확인해요"
            >
              {!previewLoading && <Eye size={16} />} 지원자 화면
            </Button>
            <Button variant="brand" onClick={() => setAiModalOpen(true)}>
              <Wand2 size={16} /> 새 공고
            </Button>
          </div>
        </div>

        {/* Table Header */}
        <div className="grid min-w-[1040px] grid-cols-[1.9fr_0.9fr_0.9fr_1.4fr_1fr_minmax(175px,1fr)] items-center px-6 py-3.5 border-b border-border-strong bg-background text-[13px] font-bold text-muted-foreground">
          <div>공고 정보</div>
          <div>지점 / 직무</div>
          <div>모집 기간</div>
          <div>지원자 관리 (AI 현황)</div>
          <div>상태</div>
          <div className="text-right">관리</div>
        </div>

        {/* Table Body */}
        <div className="flex flex-col flex-1">
          {jobsError ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-12">
              <div className="w-16 h-16 bg-error-soft rounded-full flex items-center justify-center mb-4">
                <Briefcase size={24} className="text-error-strong" />
              </div>
              <h3 className="text-[16px] font-bold text-foreground mb-2">공고를 불러오지 못했어요</h3>
              <p className="text-[14px] text-muted-foreground mb-6">일시적인 문제일 수 있어요. 다시 시도해주세요.</p>
              <Button variant="secondary" size="lg" onClick={() => mutateJobs()}>
                <RefreshCw size={16} /> 다시 시도
              </Button>
            </div>
          ) : jobsFirstLoad ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-12 text-muted-foreground">
              <Loader2 size={28} className="animate-spin mb-3" />
              <div className="text-[14px] font-bold">공고를 불러오는 중…</div>
            </div>
          ) : filteredJobs.length > 0 ? (
            filteredJobs.map(job => (
              <div key={job.id} className="grid min-w-[1040px] grid-cols-[1.9fr_0.9fr_0.9fr_1.4fr_1fr_minmax(175px,1fr)] items-center px-6 py-5 border-b border-muted hover:bg-background transition-colors">
                <div className="flex flex-col gap-1.5 min-w-0 pr-4">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {/* 제목 클릭 = 지원자 보드 열기. 예전엔 div+onClick이라 키보드로는 들어갈 수 없었다. */}
                    <button
                      type="button"
                      onClick={() => openCandidates(job)}
                      title="지원자 보드 열기 — 이 공고의 지원자를 확정·보류·부적합 처리합니다"
                      className="text-left text-[15px] font-bold text-foreground truncate hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40"
                    >
                      {job.title}
                    </button>
                    {job.workPeriod && PERIOD_BADGE[job.workPeriod] && (
                      <span className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10.5px] font-bold border ${PERIOD_BADGE[job.workPeriod]}`}>{job.workPeriod}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] text-muted-foreground font-mono">{job.id}</span>
                    <span className={`px-1.5 py-0.5 rounded-full text-[10.5px] font-bold border ${RECRUIT_MODE_META[job.recruitMode].badge}`}>{RECRUIT_MODE_META[job.recruitMode].label}</span>
                    {job.targetedExposure && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10.5px] font-bold border bg-yellow-50 text-warning border-warning-soft" title="지정 노출 — 노출 대상(규칙·수동 지정)에게만 맞춤 공고 링크에 표시됩니다">지정 노출</span>
                    )}
                  </div>
                  {/* 충원율 게이지는 진행 중 공고에만 — 마감 공고는 서버가 확정 계상을 제외(이중계상 방지)해
                      0/N으로 왜곡 표시되므로 숨긴다(마감 배지가 상태를 대신 전달). */}
                  {job.capacity > 0 && !job.effectivelyClosed && (() => {
                    const pct = Math.min(100, Math.round((job.confirmed / job.capacity) * 100));
                    const done = job.confirmed >= job.capacity;
                    return (
                      <div className="mt-1 pr-2" title={`매니저 확정 ${job.confirmed}명 / 정원 ${job.capacity}명 (확정인력으로 지정된 후보 기준)`}>
                        <div className="flex items-center justify-between text-[11px] font-bold mb-0.5">
                          <span className="text-muted-foreground">충원율</span>
                          <span className={done ? "text-success" : "text-gray-700"}>{job.confirmed}/{job.capacity}{done && " ✓"}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className={`h-full rounded-full ${done ? "bg-success" : "bg-brand-yellow"}`} style={{ width: `${Math.max(pct, job.confirmed > 0 ? 6 : 0)}%` }} />
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5 text-[13.5px] font-semibold text-gray-700">
                    <MapPin size={14} className="text-muted-foreground" /> {job.branch}
                  </div>
                  <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                    <Briefcase size={14} className="text-muted-foreground" /> {job.role}
                  </div>
                </div>

                <div className="flex flex-col gap-1 text-[13px] text-gray-700">
                  <div>{job.created} ~</div>
                  {!job.closesAt ? (
                    <div className="font-bold text-gray-800">상시</div>
                  ) : new Date(job.closesAt).getTime() <= Date.now() ? (
                    <span className="w-fit px-1.5 py-0.5 rounded-full text-[11px] font-bold bg-muted text-muted-foreground border border-border-strong">마감됨</span>
                  ) : (
                    <div className={`font-bold ${new Date(job.closesAt).getTime() - Date.now() <= 24 * 60 * 60 * 1000 ? "text-warning" : "text-gray-800"}`}>{fmtCloses(job.closesAt)}</div>
                  )}
                </div>

                <div className="flex items-center gap-4">
                  {/* 보드 진입 — 화살표를 상시 표시(예전엔 hover 때만 나타나 클릭 가능한지 알 수 없었다). */}
                  <button
                    type="button"
                    onClick={() => openCandidates(job)}
                    title="지원자 보드 열기 — 이 공고의 지원자를 확정·보류·부적합 처리합니다"
                    className="flex flex-col items-start group/cand rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/40"
                  >
                    <div className="text-[13px] text-muted-foreground flex items-center gap-1 group-hover/cand:text-info-strong">총 지원자 <ChevronRight size={13} className="text-muted-foreground group-hover/cand:text-info-strong" /></div>
                    <div className="text-[15px] font-extrabold text-foreground group-hover/cand:text-info-strong">{job.candidates}명 {job.newCandidates > 0 && <span className="text-[12px] font-bold text-warning-strong ml-1" title="관심 표시·미발송 등 AI 응대 시작 전">+{job.newCandidates}</span>}</div>
                    {/* 관심 표시 인원 — 맞춤 공고 링크에서 '관심 있음'을 누른 사람. 클릭하면 후보 보드가 열린다. */}
                    {job.interestCount > 0 && (
                      <div className="flex items-center gap-1 mt-1">
                        <span className="px-1.5 py-0.5 rounded-full text-[10.5px] font-bold bg-success-soft text-success-strong border border-success/25" title="맞춤 공고 링크에서 '관심 있음'을 누른 인원">관심 {job.interestCount}</span>
                      </div>
                    )}
                  </button>
                  <div className="w-px h-8 bg-gray-200"></div>
                  <div className="flex flex-col gap-1">
                    <div className="text-[12px] font-bold text-muted-foreground">AI 자동 스크리닝</div>
                    {!aiGlobalOn ? (
                      <Link href="/brain" title="에이전트 두뇌에서 전역 AI 상태를 관리하세요" className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-bold bg-error-soft text-error-strong border border-error-soft w-fit">
                        <span className="w-1.5 h-1.5 rounded-full bg-error"></span> 전역 중지됨
                      </Link>
                    ) : !job.effectivelyClosed ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-bold bg-info-soft text-info-strong border border-info/25 w-fit">
                        <span className="w-1.5 h-1.5 rounded-full bg-info"></span> 자동 응대 중
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-bold bg-muted text-muted-foreground border border-border-strong w-fit">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span> 중지
                      </span>
                    )}
                  </div>
                </div>

                {/* 상태 — 지금 상태(진행 중/마감됨)는 항상 보여주고, 충원 완료 시 마감 권유를 그 아래에 덧붙인다.
                    예전엔 초록 CTA가 '진행 중' pill을 대체해, 정원이 찬 행만 상태 표시가 사라졌다. */}
                <div className="flex flex-col items-start gap-1.5">
                  {!job.effectivelyClosed ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold bg-success-soft text-success-strong border border-success/25">
                      <Play size={12} className="fill-current" /> 진행 중
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold bg-muted text-muted-foreground border border-border-strong">
                      <Pause size={12} className="fill-current" /> 마감됨
                    </span>
                  )}
                  {!job.effectivelyClosed && job.capacity > 0 && job.confirmed >= job.capacity && (
                    // 충원 완료(확정≥정원) — 바로 마감으로 잇는 권유. 기존 확인 모달(handleToggleClose)을 그대로 탄다.
                    <Button
                      size="chip"
                      variant="primary"
                      onClick={() => handleToggleClose(job)}
                      isLoading={statusBusyId === job.id}
                      className="px-3 py-1.5 text-[12px] rounded-lg bg-success hover:bg-success-strong text-white shadow-none focus-visible:ring-success"
                      title={`매니저 확정 ${job.confirmed}명으로 정원(${job.capacity}명)이 찼어요 — 마감하면 발송·관심 접수가 멈춰요${job.recruitMode === "internal" ? " (AI 응대는 마감 안내 모드로 전환)" : ""}`}
                    >
                      {statusBusyId !== job.id && <CheckCircle2 size={12} />} 충원 완료 — 마감하기
                    </Button>
                  )}
                </div>

                <div className="flex justify-end gap-1">
                  {job.recruitMode !== "internal" && (
                    // shadcn(Radix) DropdownMenu — 바깥 클릭·ESC 닫기·충돌 회피 포지셔닝·포털 렌더(행 잘림 방지)를 위임.
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="toolbar" className="whitespace-nowrap" title="채널별 게시 링크 복사 — 유입이 해당 채널로 집계됩니다">
                          <Copy size={14} /> 게시 링크
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[170px] rounded-xl border-border-strong">
                        <DropdownMenuLabel className="text-[11px] font-bold text-muted-foreground">게시 채널 선택</DropdownMenuLabel>
                        {PUBLISH_CHANNELS.map((ch) => (
                          <DropdownMenuItem key={ch.source} onSelect={() => copyJobLink(job, ch.source)} className="text-[12.5px] font-semibold text-gray-700">
                            {ch.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  {/* 수정은 가장 자주 쓰는 액션이라 글자 라벨로 남긴다. 나머지는 '더보기' 메뉴에서 글자 라벨로 고른다
                      — 예전엔 확성기·복제·연필·일시정지 아이콘 4개가 라벨 없이 나란히 있어서, 특히 마감/재개가
                      아이콘만 바뀌는 같은 자리 토글이라 무엇을 누르는지 알 수 없었다. */}
                  <Button
                    variant="ghost"
                    size="toolbar"
                    onClick={() => openEdit(job.id)}
                    className="whitespace-nowrap"
                    title="공고 수정 — 제목·정원·마감시각·급여 등"
                  >
                    <Edit2 size={14} /> 수정
                  </Button>
                  {/* 복제를 카드 전면으로 — 권역만 다른 라인 여러 개를 만드는 것이 기본 사용법이라
                      '더보기' 안에 두면 배치 등록마다 메뉴를 열어야 한다(사장님 지시 2026-08-05). */}
                  <Button
                    variant="ghost"
                    size="toolbar"
                    onClick={() => void duplicateJob(job.id)}
                    isLoading={duplicatingId === job.id}
                    className="whitespace-nowrap"
                    title="이 공고를 복제해 새 공고 등록 — 제목·본문·노출 규칙이 프리필됩니다"
                  >
                    {duplicatingId !== job.id && <CopyPlus size={14} />} 복제
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="toolbar"
                        aria-label={`${job.title} 더보기 — ${moreActionsLabel(job)}`}
                        title={`더보기 — ${moreActionsLabel(job)}`}
                      >
                        {announceBusyId === job.id || duplicatingId === job.id || statusBusyId === job.id ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={16} />}
                      </Button>
                    </DropdownMenuTrigger>
                    {/* 항목 실행을 다음 틱으로 미룬다 — 메뉴가 닫히며 트리거로 포커스를 되돌리는 사이에
                        확인 모달(Radix AlertDialog)이 열리면 포커스를 서로 빼앗는다. */}
                    <DropdownMenuContent align="end" className="w-[230px] rounded-xl border-border-strong">
                      {/* 대기자에게 안내 — 진행 중 + 맞춤 공고 링크에 뜨는 공고(우리 인력에게·둘 다)만. '새로 모집'은
                          맞춤 공고 링크에 안 떠서 안내 문자의 링크가 죽은 링크가 되므로 항목 자체를 숨긴다(게시 링크 규칙과 대칭). */}
                      {!job.effectivelyClosed && job.recruitMode !== "external" && (
                        <DropdownMenuItem
                          onSelect={() => setTimeout(() => openAnnounce(job), 0)}
                          disabled={announceBusyId === job.id}
                          className="text-[12.5px] font-semibold text-gray-700 gap-2"
                        >
                          <Megaphone size={14} className="text-muted-foreground" /> 대기자에게 안내
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onSelect={() => setTimeout(() => void handleToggleClose(job), 0)}
                        disabled={statusBusyId === job.id}
                        className="text-[12.5px] font-semibold text-gray-700 gap-2"
                      >
                        {job.effectivelyClosed ? <Play size={14} className="text-muted-foreground" /> : <Pause size={14} className="text-muted-foreground" />}
                        {job.effectivelyClosed ? "공고 다시 열기" : "공고 마감하기"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-12">
              <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
                <Briefcase size={24} className="text-muted-foreground" />
              </div>
              <h3 className="text-[16px] font-bold text-foreground mb-2">이 상태의 공고가 없어요</h3>
              <p className="text-[14px] text-muted-foreground mb-6">위 상태 필터를 바꿔 보거나, 아래 버튼으로 새 공고를 만들면 AI가 채널별 초안까지 만들어 드려요.</p>
              <Button variant="brand" size="lg" onClick={() => setAiModalOpen(true)}>
                새 공고 등록하기
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* AI JD Generator Modal */}
      {aiModalOpen && (
        <Modal bare open={aiModalOpen} onClose={closeRegisterModal} size="xl"
               title="AI 맞춤형 공고 작성"
               closeOnOutside={false}
               className="max-w-[800px] sm:max-w-[800px]">
            <div className="flex items-center justify-between px-7 py-5 border-b border-border-strong">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-yellow-50 flex items-center justify-center text-warning-strong">
                  <Wand2 size={18} />
                </div>
                <div>
                  <h2 className="text-[18px] font-extrabold text-foreground tracking-tight">AI 맞춤형 공고 작성</h2>
                  <p className="text-[13px] text-muted-foreground mt-0.5">간단한 조건만 입력하면 시니어에 최적화된 공고 초안을 생성합니다.</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" aria-label="공고 등록 창 닫기" onClick={closeRegisterModal}>
                <X size={24} />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-7 flex flex-col gap-6 bg-background">
              {/* Prompt Input — 초안이 나오면 한 줄로 접힌다(아래 promptOpen 주석 참고). */}
              {promptOpen ? (
                <div className="bg-white border border-border-strong rounded-2xl p-5 shadow-sm">
                  <label className="block text-[13px] font-bold text-gray-700 mb-2">어떤 포지션을 찾고 계신가요?</label>
                  <textarea
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="예: 스타벅스 성수점 매장 청소 및 테이블 관리, 주 3일 오전반, 시급 1.1만원, 60대 우대"
                    className="w-full bg-background border border-border-strong rounded-xl px-4 py-3.5 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand-yellow min-h-[100px] resize-none"
                  />
                  <div className="flex justify-end mt-3">
                    {/* 직접 작성 — 예전엔 AI 초안이 없으면 등록 버튼이 아예 안 눌려서, 본문을 직접 쓰거나
                        다른 데서 복사해 붙이려면 AI를 한 번 돌려야 했다(사장님 지시 2026-08-05). */}
                    {!channelDrafts && !isGenerating && (
                      <Button
                    variant="secondary"
                    onClick={() => {
                      setChannelDrafts({ danggeun: "", albamon: "", sms: "" });
                      setChannelDraftsFromCopy(false);
                      setActiveChannel("albamon");
                      setPromptOpen(false);
                    }}
                    title="AI를 쓰지 않고 본문을 직접 쓰거나 붙여넣습니다"
                  >직접 작성</Button>
                    )}
                    <Button variant="primary" onClick={handleGenerateJD} disabled={!aiPrompt} isLoading={isGenerating}>
                    {!isGenerating && <Sparkles size={16} className="text-brand-yellow" />}
                    {isGenerating ? 'JD 생성 중...' : 'AI 초안 생성'}
                  </Button>
                  </div>
                  <p className="text-[11.5px] text-muted-foreground mt-2 leading-relaxed">💡 아래 <b className="text-muted-foreground">공고 설정</b>에서 화주사·지점을 먼저 고르면 집결지·시급 등 등록 정보가 초안에 자동 반영돼요.</p>
                </div>

              ) : (
                /* 접힌 상태 — 초안 편집칸을 첫 화면에 올리려고 접는다. 조건은 언제든 다시 펼칠 수 있다. */
                <div className="bg-white border border-border-strong rounded-2xl px-5 py-3.5 shadow-sm flex items-center gap-3">
                  <Wand2 size={15} className="text-warning-strong shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-bold text-gray-700">
                      {aiPrompt.trim() ? "AI 초안 생성 조건" : "본문을 직접 편집하는 중"}
                    </div>
                    <div className="text-[12.5px] text-muted-foreground truncate">
                      {aiPrompt.trim() || "조건을 입력하면 AI가 채널별 초안을 다시 써줍니다"}
                    </div>
                  </div>
                  <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setPromptOpen(true)}>조건 수정 · 다시 생성</Button>
                </div>
              )}

              {/* ⚠️ 초안·제목은 **생성 버튼 바로 아래**에 둔다. 예전엔 '공고 설정' 폼(모집방식·화주사·정원·
                  근무시간·노출까지 약 160줄) 아래에 있어서, 버튼을 눌러도 로딩 표시와 완성된 초안이 모두
                  화면 밖에서 만들어졌다 — 토스트만 뜨고 화면은 그대로여서 "초안이 안 보인다"가 됐다.
                  복제로 열었을 때도 같은 이유로 원본 제목·본문이 안 보였다(지역명을 안 고치고 등록하는 사고). */}
              {/* Generated Result — 채널별 초안 (당근/알바몬/SMS) */}
              {(isGenerating || channelDrafts) && (
                <div className="bg-white border border-brand-yellow rounded-2xl p-5 shadow-sm relative overflow-hidden">
                  {isGenerating && (
                    <div className="absolute inset-0 bg-white/60 backdrop-blur-sm z-10 flex flex-col items-center justify-center">
                      <Wand2 size={28} className="text-warning-strong animate-bounce mb-3" />
                      <div className="text-[14px] font-bold text-foreground">AI 옹봇이 채널별 공고를 작성하고 있습니다...</div>
                      <div className="text-[12px] text-muted-foreground mt-1">당근 · 알바몬 · 문자 형식으로 각각 최적화하는 중</div>
                    </div>
                  )}
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-[13px] font-bold text-warning-strong flex items-center gap-1.5">
                      <Sparkles size={14} /> {draftBody ? "채널별 공고 초안" : "채널별 공고 본문 — 직접 작성"}
                      {aiSource === "mock" && <span className="text-[10.5px] font-bold bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full">오프라인 템플릿</span>}
                    </label>
                    <span className="text-[11px] text-muted-foreground">탭별로 수정·복사할 수 있어요</span>
                  </div>
                  {duplicatedFrom && (
                    <div className="mb-3 px-3 py-2 rounded-lg bg-error-soft border border-error/30 text-[11.5px] font-bold text-error-strong leading-relaxed">
                      복제한 공고예요 — <b>제목·본문에 원본({duplicatedFrom})의 권역·단가가 그대로 남아 있어요.</b> 바꿀 곳을 고치고 등록하세요.
                    </div>
                  )}
                  {channelDraftsFromCopy && (
                    <div className="mb-3 px-3 py-2 rounded-lg bg-yellow-50 border border-yellow-200 text-[11.5px] font-semibold text-warning-strong leading-relaxed">
                      당근·문자 탭은 <b>원본 공고에 저장돼 있던 초안</b>이에요. 원본을 등록한 뒤 수정 모달에서 본문을 고쳤다면 그 내용은 알바몬 탭에만 반영돼 있어요 — 필요하면 여기서 직접 손봐 주세요.
                    </div>
                  )}

                  {channelDrafts && (
                    <>
                      {/* 채널 탭 */}
                      <div className="flex gap-1.5 mb-3">
                        {([
                          { id: "danggeun", label: "당근알바" },
                          { id: "albamon", label: "알바몬" },
                          { id: "sms", label: "문자(SMS)" },
                        ] as const).map((ch) => (
                          <button aria-pressed={activeChannel === ch.id} key={ch.id} onClick={() => setActiveChannel(ch.id)} className={`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3.5 py-1.5 rounded-lg text-[12.5px] font-bold transition-colors ${activeChannel === ch.id ? "bg-foreground text-white" : "bg-muted text-muted-foreground hover:bg-gray-200"}`}>{ch.label}</button>
                        ))}
                        <div className="flex-1" />
                        <Button size="chip" variant="brand" className="px-3 py-1.5 text-[12.5px] rounded-lg bg-yellow-50 border border-brand-yellow text-warning-strong hover:bg-yellow-100 shadow-none" onClick={() => copyChannel(channelDrafts[activeChannel], activeChannel === "danggeun" ? "당근알바" : activeChannel === "albamon" ? "알바몬" : "문자")}><Copy size={14} /> 복사</Button>
                      </div>
                      <textarea
                        value={channelDrafts[activeChannel]}
                        onChange={(e) => setChannelDrafts({ ...channelDrafts, [activeChannel]: e.target.value })}
                        className="w-full bg-yellow-50 border-0 rounded-xl px-4 py-3.5 text-[13.5px] text-gray-800 leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-yellow min-h-[260px] font-medium resize-none whitespace-pre-wrap"
                      />
                      <div className="mt-2 text-[11.5px] text-muted-foreground">등록 시 <b className="text-muted-foreground">알바몬 형식</b> 본문이 공고 원문으로 저장되어 AI 스크리닝이 참조합니다.</div>
                    </>
                  )}
                </div>
              )}

              {/* E15 · 공고 제목 — 맞춤 공고 링크 카드·안내 문자에 그대로 나가므로 명시적으로 편집(예전엔 본문 첫 줄에서 몰래 결정). */}
              {channelDrafts && (
                <div className="bg-white border border-border-strong rounded-2xl shadow-sm p-5">
                  <label className="block text-[13px] font-bold text-gray-700 mb-2">공고 제목 <span className="text-muted-foreground font-semibold">— 맞춤 공고 링크 화면·안내 문자에 그대로 표시돼요</span></label>
                  <input value={postingTitle} onChange={(e) => setPostingTitle(e.target.value)} placeholder="예: 성수동 새벽 배송 기사 모집" className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-sm focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow" />
                </div>
              )}

              {/* E16 · 공고 설정 — 예전엔 라벨 없는 푸터 컨트롤 벽(정원 스피너·화주사 누락 빈발)이었다. 라벨 붙은 본문 섹션으로 승격(푸터엔 닫기/등록만).
                  모집방식을 최상단에 둬, 이 값에 의존하는 근무시간 형태·노출 대상 섹션의 역순 배치를 바로잡는다(옵션 A). 화주사·지점은 초안 생성(D2)에 쓰이므로 항상 표시. */}
              <div className="bg-white border border-border-strong rounded-2xl shadow-sm p-5 flex flex-col gap-4">
                <div className="text-[13px] font-bold text-foreground">공고 설정</div>

                {/* 모집 방식 — 먼저 고른다: 아래 근무시간 형태·노출 대상이 이 값에 따라 달라진다.
                    기본값이면 접힌 한 줄로만 보여준다(B4) — 첫 등록에서 개념 3개를 먼저 고르게 하지 않는다. */}
                <RecruitModeField
                  value={newJobMode}
                  onChange={(m) => {
                    setNewJobMode(m);
                    // external은 맞춤링크(pull) 미노출 → 지정 노출이 켜진 채 고아가 되지 않게 전체 노출로 리셋(D10).
                    if (m === "external") setNewJobExposure(EMPTY_EXPOSURE);
                  }}
                />

                {/* 화주사 → 지점 2단 선택 — 지점 미선택이어도 화주사만 고르면 client_id를 실어 필터 유실을 방어. 화주사·지점은 초안 생성에 반영(D2). */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">화주사</label>
                    <select
                      value={newJobClientId}
                      onChange={(e) => {
                        const v = e.target.value === "" ? "" : Number(e.target.value);
                        setNewJobClientId(v);
                        // 화주사 변경 시 하위와 맞지 않는 지점 선택은 해제
                        if (newJobBranchId !== "" && branches.find((b) => b.id === newJobBranchId)?.client_id !== (v === "" ? undefined : v)) {
                          setNewJobBranchId("");
                        }
                      }}
                      className="pr-8 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                    >
                      <option value="">화주사 선택</option>
                      {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  {/* 지점 셀렉터는 지점 개념이 있는 화주사에만(확정슬롯이거나 등록 지점 존재). 대부분 화주사는 지점이 없어 숨겨진다. */}
                  {(clients.find((c) => c.id === newJobClientId)?.uses_slots || branches.some((b) => b.client_id === newJobClientId)) && (
                    <div>
                      <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">지점 <span className="text-muted-foreground font-semibold">(선택)</span></label>
                      <select
                        value={newJobBranchId}
                        onChange={(e) => {
                          const v = e.target.value === "" ? "" : Number(e.target.value);
                          setNewJobBranchId(v);
                          // 지점 선택 시 소속 화주사를 상위 셀렉트에 동기화
                          if (v !== "") {
                            const cid = branches.find((b) => b.id === v)?.client_id;
                            if (typeof cid === "number") setNewJobClientId(cid);
                          }
                        }}
                        className="pr-8 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                      >
                        <option value="">지점 선택</option>
                        {branches.filter((b) => b.client_id === newJobClientId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </div>
                  )}
                  {/* 현장매니저 — 만남장소·첫날 안내 발송 담당(선택). 목록 관리는 설정 › 팀·권한. */}
                  <div>
                    <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">현장매니저 <span className="text-muted-foreground font-semibold">(선택)</span></label>
                    <select
                      value={newJobSiteManagerId}
                      onChange={(e) => setNewJobSiteManagerId(e.target.value === "" ? "" : Number(e.target.value))}
                      className="pr-8 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                    >
                      <option value="">미지정</option>
                      {siteManagers.filter((m) => m.active || m.id === newJobSiteManagerId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </div>
                </div>

                {/* 정원 · 기간 · 마감시각 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">모집 인원</label>
                    <input
                      type="number"
                      min={1}
                      value={newJobCapacity}
                      onChange={(e) => setNewJobCapacity(Math.max(1, Number(e.target.value) || 1))}
                      className="min-h-11 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                    />
                  </div>
                  <div>
                    <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">모집 기간</label>
                    <select
                      value={newJobPeriod}
                      onChange={(e) => setNewJobPeriod(e.target.value)}
                      className="pr-8 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                    >
                      <option value="">기간 미지정</option>
                      <option value="하루">하루(당일 단기)</option>
                      <option value="단기">단기(며칠~몇 주)</option>
                      <option value="정기">정기(상시 라인)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">모집 마감시각</label>
                    <input
                      type="datetime-local"
                      value={newJobClosesAt}
                      min={nowLocalInput()}
                      onChange={(e) => setNewJobClosesAt(e.target.value)}
                      className="min-h-11 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                    />
                  </div>
                </div>
                {/* 하루/단기인데 마감시각이 비면(특히 복제 시) 상시 게시로 남는 함정 — 등록 전 힌트. */}
                {(newJobPeriod === "하루" || newJobPeriod === "단기") && !newJobClosesAt && (
                  <span className="text-[11.5px] font-bold text-warning-strong bg-yellow-50 border border-yellow-200 rounded-lg px-2.5 py-1.5 self-start">
                    마감시각 미설정 — 상시 게시됩니다
                  </span>
                )}

                {/* 차량 필요 — 맞춤 공고 링크 카드에 표시. 수정 모달과 같은 토글 카드로 통일(예전엔 등록만 체크박스). */}
                <div className="flex items-center justify-between p-4 bg-background border border-border-strong rounded-xl">
                  <div className="text-[13px] font-bold text-foreground">차량(이륜/사륜) 필요</div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={newJobVehicleRequired}
                    aria-label="차량(이륜/사륜) 필요"
                    onClick={() => setNewJobVehicleRequired(!newJobVehicleRequired)}
                    className={`after:absolute after:-inset-2 after:content-[''] w-12 h-7 rounded-full relative transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow ${newJobVehicleRequired ? "bg-success" : "bg-gray-300"}`}
                  >
                    <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform ${newJobVehicleRequired ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                </div>

                {/* E18 · 급여 (선택) — 예전엔 단가형태·금액(푸터)과 정산정보(접이식)로 분산. 한 그룹으로 일원화. 채우면 AI가 단가·정산 문의에 직접 답한다. */}
                <div className="p-4 bg-background border border-border-strong rounded-xl flex flex-col gap-4">
                  <div className="text-[12px] font-bold text-gray-700">급여 (선택) — 채우면 단가·정산 문의를 AI가 직접 안내합니다</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">대표 단가 형태</label>
                      <select
                        value={newJobPayType}
                        onChange={(e) => setNewJobPayType(e.target.value)}
                        className="pr-8 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                      >
                        <option value="">미지정</option>
                        {PAY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    {newJobPayType && newJobPayType !== "협의" && (
                      <div>
                        <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">대표 금액(원)</label>
                        <input
                          type="number"
                          min={0}
                          value={newJobPayAmount}
                          onChange={(e) => setNewJobPayAmount(e.target.value === "" ? "" : Math.max(0, Number(e.target.value) || 0))}
                          placeholder="예: 3500"
                          className="min-h-11 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                        />
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">급여·정산 정보</label>
                    <textarea value={newJobPayInfo} onChange={(e) => setNewJobPayInfo(e.target.value)} rows={2} placeholder="예: 건당/일당 금액 · 정산 주기(주급/익월5일 등) · 특이사항" className="min-h-11 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] leading-relaxed bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow resize-none" />
                  </div>
                </div>

                {/* 긴급 건(SOS)에서 파생된 공고 추적용 — 화면 비표시(향후 공고↔긴급건 연결) */}
                {newJobSosId && <input type="hidden" name="sos_id" value={newJobSosId} readOnly />}
              </div>

              {/* 근무 상세 + AI 응대 근거 — 접이식. pull 카드 표시 필드(근무시간·시작일·집결지)와
                  단가·정책 참고정보를 등록 단계에서 함께 채워 편집 모달 2단계 강제를 없앤다. */}
              {channelDrafts && (
                <div className="bg-white border border-border-strong rounded-2xl shadow-sm overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setNewJobExtraOpen((v) => !v)}
                    className="w-full flex items-center justify-between px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow"
                  >
                    <div>
                      <div className="text-[13px] font-bold text-foreground">근무 상세 · AI 응대 근거 (선택)</div>
                      <div className="text-[11.5px] text-muted-foreground mt-0.5">근무시간·시작일·집결지와 정책·참고정보를 채우면 맞춤 공고 링크에 표시되고 AI가 문의에 직접 답합니다.</div>
                    </div>
                    <ChevronRight size={18} className={`text-muted-foreground transition-transform ${newJobExtraOpen ? "rotate-90" : ""}`} />
                  </button>
                  {newJobExtraOpen && (
                    <div className="px-5 pb-5 flex flex-col gap-4 border-t border-muted pt-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <SlotKeysField
                          keys={newJobSlotKeys}
                          onToggleKey={(key) =>
                            setNewJobSlotKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
                          }
                          detail={newJobSlot}
                          onDetailChange={setNewJobSlot}
                        />
                        <div>
                          <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">시작일</label>
                          <input
                            type="date"
                            value={newJobStartDate}
                            min={todayLocalDate()}
                            onChange={(e) => setNewJobStartDate(e.target.value)}
                            className="min-h-11 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">집결지</label>
                        <input
                          type="text"
                          value={newJobPickupAddress}
                          onChange={(e) => setNewJobPickupAddress(e.target.value)}
                          placeholder="예: 성수동 물류센터 3번 게이트"
                          className="min-h-11 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                        />
                      </div>
                      <div>
                        <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">마지막 경유지(배송 종료 지점)</label>
                        <input
                          type="text"
                          value={newJobDropoffAddress}
                          onChange={(e) => setNewJobDropoffAddress(e.target.value)}
                          placeholder="예: 하남 미사강변도시 일대"
                          className="min-h-11 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                        />
                      </div>
                      <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-xl flex flex-col gap-4">
                        <div className="text-[12px] font-bold text-warning-strong">AI 응대 근거 — 채우면 정책·근무 문의를 AI가 직접 안내해 매니저가 직접 답해야 하는 일이 줄어듭니다 (급여는 ‘공고 설정’의 ‘급여’ 그룹에서)</div>
                        <div>
                          <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">고용·정책 안내</label>
                          <textarea value={newJobPolicyNotes} onChange={(e) => setNewJobPolicyNotes(e.target.value)} rows={2} placeholder="예: 프리랜서(3.3%) 계약, 4대보험 미적용 · 본인 명의 정산" className="min-h-11 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] leading-relaxed bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow resize-none" />
                        </div>
                        <div>
                          <label className="block text-[12.5px] font-bold text-gray-700 mb-1.5">기타 참고정보 (근무·차량 정책 등)</label>
                          <textarea value={newJobAiFacts} onChange={(e) => setNewJobAiFacts(e.target.value)} rows={3} placeholder="예: 주말·공휴일 근무 있음(월 2회 로테이션) · 오전+오후 동시 진행 가능 · 렌트/리스 차량 가능(1톤 이하) · 풀타임 불가" className="min-h-11 w-full px-3.5 py-2.5 border border-border-strong rounded-xl text-[13.5px] leading-relaxed bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow resize-none" />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {/* J 타겟 노출 — 접이식 밖 독립 섹션(D9): 등록 시에도 항상 보이게. internal/both만(external은 pull 미노출). */}
              {channelDrafts && newJobMode !== "external" && (
                <div className="bg-white border border-border-strong rounded-2xl shadow-sm p-5">
                  <div className="text-[13px] font-bold text-foreground mb-0.5">노출 대상 — 이 공고를 누구에게 보여줄까요</div>
                  <div className="text-[11.5px] text-muted-foreground mb-3">맞춤 공고 링크에서 전체 인재풀에게 보일지, 지정 대상에게만 보일지 정합니다.</div>
                  <ExposureEditor value={newJobExposure} onChange={setNewJobExposure} />
                </div>
              )}
            </div>

            {/* E16 · 푸터 — 라벨 없는 컨트롤 벽은 본문 '공고 설정'으로 승격. 여기는 닫기/등록만. */}
            <div className="flex items-center justify-end gap-3 px-7 py-5 border-t border-border-strong bg-white">
              <Button variant="ghost" size="lg" onClick={closeRegisterModal}>닫기</Button>
              <Button variant="brand" size="lg" onClick={handleRegisterJob} disabled={!draftBody} isLoading={registering}>
                {!registering && <CheckCircle2 size={16} />}
                {registering ? "등록 중..." : "이 내용으로 공고 등록"}
              </Button>
            </div>
        </Modal>
      )}

      {/* 공고 수정 모달 — backdrop 클릭으로 닫지 않는다(긴 편집 중 오클릭 한 번에 수정분이 소리 없이
          날아가던 문제). 닫기는 명시적으로 X·취소 버튼으로만. */}
      {editForm && (
        <Modal bare open={Boolean(editForm)} onClose={() => { setEditForm(null); setEditDroppedBranch(null); }} size="lg"
               title="공고 수정"
               closeOnOutside={false}
               className="max-w-[640px] sm:max-w-[640px]">
            <div className="flex items-center justify-between px-7 py-5 border-b border-border-strong">
              <h2 className="text-[18px] font-extrabold text-foreground">공고 수정</h2>
              <Button variant="ghost" size="icon" aria-label="공고 수정 창 닫기" onClick={() => { setEditForm(null); setEditDroppedBranch(null); }}><X size={22} /></Button>
            </div>
            {editLoading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 size={20} className="animate-spin mr-2" /> 불러오는 중…</div>
            ) : (
              <div className="flex-1 overflow-y-auto p-7 flex flex-col gap-4">
                {/* 상단 상시 표시(E17) — 가장 자주 고치는 제목·기간·마감을 접이식 밖 최상단으로. */}
                <div>
                  <label className="block text-[13px] font-bold text-gray-700 mb-2">
                    공고 제목 <span className="text-error">*</span>
                    {/* 등록 모달에만 있던 안내 — 제목이 어디에 그대로 노출되는지 알려준다. */}
                    <span className="block text-[11.5px] font-semibold text-muted-foreground mt-0.5">맞춤 공고 링크 화면·안내 문자에 그대로 표시돼요</span>
                  </label>
                  <input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} placeholder="예: 성수동 새벽 배송 기사 모집" className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-sm focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[13px] font-bold text-gray-700 mb-2">모집 기간</label>
                    <select value={editForm.workPeriod} onChange={(e) => setEditForm({ ...editForm, workPeriod: e.target.value })} className="pr-8 w-full px-4 py-3 border border-border-strong rounded-xl text-sm bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow">
                      <option value="">미지정</option>
                      <option value="하루">하루(당일 단기)</option>
                      <option value="단기">단기(며칠~몇 주)</option>
                      <option value="정기">정기(상시 라인)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-gray-700 mb-2">모집 마감시각</label>
                    <input type="datetime-local" value={editForm.closesAt} min={nowLocalInput()} onChange={(e) => setEditForm({ ...editForm, closesAt: e.target.value })} className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-sm focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow" />
                    <p className="text-[11px] text-muted-foreground mt-1">지나면 지원자 페이지에서 자동 마감</p>
                  </div>
                </div>

                {/* 지점 해제 경고 — 접이식 밖 상시 영역에 둔다(섹션을 접으면 경고가 사라지면 안 된다). */}
                {editDroppedBranch && editForm.branchId === "" && (
                  <div className="px-3 py-2 rounded-lg bg-yellow-50 border border-yellow-200 text-[12px] font-semibold text-warning-strong leading-relaxed">
                    지점 <b>{editDroppedBranch.name}</b> 연결이 해제됐어요 — 이대로 저장하면 이 공고의 <b>지점명도 지워집니다</b>(지원 폼 지점 프리필·현장 안내 문자·화주사 집계에 쓰이는 값). 화주사를 원래대로 되돌리거나 새 화주사의 지점을 고르면 지워지지 않아요.
                  </div>
                )}

                {/* 공고 설정 [접이식, 기본 열림] — 섹션명·필드 순서를 등록 모달의 '공고 설정'과 맞춘다(모집방식 → 지점·정원 → 현장매니저 → 차량 → 급여). */}
                <EditSection
                  title="공고 설정"
                  summary={basicSummary(
                    editForm,
                    editForm.clientId === "" ? "화주사 미지정" : clients.find((c) => c.id === editForm.clientId)?.name ?? null,
                    editForm.branchId === "" ? null : branches.find((b) => b.id === editForm.branchId)?.name ?? null
                  )}
                  open={editOpenSections.basic}
                  onToggle={() => setEditOpenSections((s) => ({ ...s, basic: !s.basic }))}
                >
                    <>
                      {/* 모집 방식 — 등록 모달과 같은 컨트롤·같은 위치(섹션 최상단). 아래 근무시간 형태·노출 대상이 이 값에 따라 달라진다. */}
                      <RecruitModeField
                        value={editForm.recruitMode}
                        onChange={(m) => setEditForm({ ...editForm, recruitMode: m, ...(m === "external" ? { exposureDraft: EMPTY_EXPOSURE } : {}) })}
                      />
                      {/* 화주사 — 등록 모달과 같은 위치·같은 컨트롤. 예전엔 수정 모달에 없어서
                          잘못 귀속된 공고(화주사 오선택)를 화면에서 바로잡을 수 없었다. 서버가 화주사↔지점 정합을 검증한다. */}
                      <div>
                        <label className="block text-[13px] font-bold text-gray-700 mb-2">화주사</label>
                        <select
                          value={editForm.clientId}
                          onChange={(e) => {
                            const v = e.target.value === "" ? "" : Number(e.target.value);
                            const target = v === "" ? null : v;
                            // 되돌리기 — 방금 떨어져 나간 지점의 화주사로 다시 바꾸면 지점도 복원한다.
                            if (editDroppedBranch && branches.find((b) => b.id === editDroppedBranch.id)?.client_id === target) {
                              setEditForm({ ...editForm, clientId: v, branchId: editDroppedBranch.id });
                              setEditDroppedBranch(null);
                              return;
                            }
                            const cur = editForm.branchId === "" ? null : branches.find((b) => b.id === editForm.branchId);
                            // 지점 목록이 아직 안 왔으면 소속을 판단할 수 없다 — 조용히 지점을 떼지 않고 잠시 뒤 다시 고르게 한다.
                            if (editForm.branchId !== "" && !cur) {
                              toast.info("지점 목록을 불러오는 중이에요. 잠시 뒤 다시 선택해 주세요.");
                              return;
                            }
                            // 새 화주사에 속하지 않는 지점 선택은 해제한다(다른 화주사 지점이 붙은 채 저장되지 않게).
                            const keepBranch = !!cur && cur.client_id === target;
                            if (cur && !keepBranch) setEditDroppedBranch({ id: cur.id, name: cur.name });
                            setEditForm({ ...editForm, clientId: v, branchId: keepBranch ? editForm.branchId : "" });
                          }}
                          className="pr-8 w-full px-4 py-3 border border-border-strong rounded-xl text-sm bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                        >
                          <option value="">미지정</option>
                          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </div>
                      <div className={editShowBranch ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" : ""}>
                        {/* 지점 셀렉터는 지점 개념이 있는 화주사(슬롯/지점보유)이거나 이미 지점이 붙은 공고에만. */}
                        {editShowBranch && (
                        <div className="col-span-2">
                          <label className="block text-[13px] font-bold text-gray-700 mb-2">지점 <span className="text-muted-foreground font-semibold">(선택)</span></label>
                          <select
                            value={editForm.branchId}
                            onChange={(e) => {
                              const v = e.target.value === "" ? "" : Number(e.target.value);
                              // 지점을 직접 비우는 것도 지점명이 지워지는 동작이라 같은 게이트(배너·저장 확인)를 태운다.
                              if (v === "") {
                                const cur = editForm.branchId === "" ? null : branches.find((b) => b.id === editForm.branchId);
                                setEditDroppedBranch(cur ? { id: cur.id, name: cur.name } : null);
                              } else {
                                setEditDroppedBranch(null);
                              }
                              setEditForm({ ...editForm, branchId: v });
                            }}
                            className="pr-8 w-full px-4 py-3 border border-border-strong rounded-xl text-sm bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                          >
                            <option value="">미지정</option>
                            {branches.filter((b) => b.client_id === editForm.clientId || b.id === editForm.branchId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                        </div>
                        )}
                        <div>
                          <label className="block text-[13px] font-bold text-gray-700 mb-2">모집 인원</label>
                          <input type="number" min={1} value={editForm.capacity} onChange={(e) => setEditForm({ ...editForm, capacity: Math.max(1, Number(e.target.value) || 1) })} className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-sm focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow" />
                        </div>
                      </div>
                      {/* 현장매니저 — 만남장소·첫날 안내 발송 담당(선택). 목록은 설정 › 팀·권한. */}
                      <div>
                        <label className="block text-[13px] font-bold text-gray-700 mb-2">현장매니저 <span className="text-muted-foreground font-semibold">(선택)</span></label>
                        <select value={editForm.siteManagerId} onChange={(e) => setEditForm({ ...editForm, siteManagerId: e.target.value === "" ? "" : Number(e.target.value) })} className="pr-8 w-full px-4 py-3 border border-border-strong rounded-xl text-sm bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow">
                          <option value="">미지정</option>
                          {siteManagers.filter((m) => m.active || m.id === editForm.siteManagerId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                      </div>
                      <div className="flex items-center justify-between p-4 bg-background border border-border-strong rounded-xl">
                        <div className="text-[13px] font-bold text-foreground">차량(이륜/사륜) 필요</div>
                        <button type="button" role="switch" aria-checked={editForm.vehicleRequired} aria-label="차량(이륜/사륜) 필요" onClick={() => setEditForm({ ...editForm, vehicleRequired: !editForm.vehicleRequired })} className={`after:absolute after:-inset-2 after:content-[''] w-12 h-7 rounded-full relative transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow ${editForm.vehicleRequired ? "bg-success" : "bg-gray-300"}`}>
                          <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform ${editForm.vehicleRequired ? "translate-x-6" : "translate-x-1"}`} />
                        </button>
                      </div>
                      {/* E18 · 급여 (선택) — 등록 모달과 같은 그룹·같은 섹션 위치로 올렸다.
                          예전엔 '공고 본문·급여·AI 근거' 접이식 안 2단 깊이라, 등록 때는 0클릭이던 급여가 수정 때는 펼쳐야 보였다. */}
                      <div className="p-4 bg-background border border-border-strong rounded-xl flex flex-col gap-4">
                        <div className="text-[12px] font-bold text-gray-700">급여 (선택) — 채우면 단가·정산 문의를 AI가 직접 안내합니다</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-[13px] font-bold text-gray-700 mb-2">대표 단가 형태</label>
                            <select value={editForm.payType} onChange={(e) => setEditForm({ ...editForm, payType: e.target.value })} className="pr-8 w-full px-4 py-3 border border-border-strong rounded-xl text-sm bg-white focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow">
                              <option value="">미지정</option>
                              {PAY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                          {editForm.payType && editForm.payType !== "협의" && (
                            <div>
                              <label className="block text-[13px] font-bold text-gray-700 mb-2">대표 금액(원)</label>
                              <input type="number" min={0} value={editForm.payAmount} onChange={(e) => setEditForm({ ...editForm, payAmount: e.target.value === "" ? "" : Math.max(0, Number(e.target.value) || 0) })} placeholder="예: 3500" className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-sm focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow bg-white" />
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="block text-[13px] font-bold text-gray-700 mb-2">급여·정산 정보</label>
                          <textarea value={editForm.payInfo} onChange={(e) => setEditForm({ ...editForm, payInfo: e.target.value })} rows={2} placeholder="예: 건당/일당 금액 · 정산 주기(주급/익월5일 등) · 특이사항" className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-[13.5px] leading-relaxed focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow resize-none bg-white" />
                        </div>
                      </div>
                    </>
                </EditSection>

                {/* 노출 대상 [접이식] — internal/both일 때만(맞춤 공고 링크 노출 채널). external은 게시 링크 유통이라 섹션 자체 비노출. */}
                {editForm.recruitMode !== "external" && (
                  <EditSection
                    title="노출 대상"
                    summary={exposureSummary(editForm)}
                    open={editOpenSections.exposure}
                    onToggle={() => setEditOpenSections((s) => ({ ...s, exposure: !s.exposure }))}
                  >
                    <>
                      {/* 등록 모달과 같은 설명 한 줄 — 수정에만 없어서 같은 섹션이 다르게 읽혔다. */}
                      <p className="text-[11.5px] text-muted-foreground -mt-1">맞춤 공고 링크에서 전체 인재풀에게 보일지, 지정 대상에게만 보일지 정합니다.</p>
                      <ExposureEditor
                        value={editForm.exposureDraft}
                        onChange={(next) => setEditForm({ ...editForm, exposureDraft: next })}
                        jobId={Number(editForm.id)}
                        /* 방금 고른 거리 기준으로 미리보기 계산 — 저장된 기준으로 재면 같은 모달에서 296명을 보고 190명을 저장하게 된다 */
                        distanceBasis={editForm.distanceBasis}
                      />
                    </>
                  </EditSection>
                )}

                {/* 근무 상세 · AI 응대 근거 (선택) [접이식] — 섹션명·구성을 등록 모달의 같은 섹션과 맞춘다(맞춤 공고 링크 카드 표시 + AI 응대 근거). */}
                <EditSection
                  title="근무 상세 · AI 응대 근거 (선택)"
                  summary={workSummary(editForm)}
                  open={editOpenSections.work}
                  onToggle={() => setEditOpenSections((s) => ({ ...s, work: !s.work }))}
                >
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <SlotKeysField
                          keys={editForm.slotKeys}
                          onToggleKey={(key) =>
                            setEditForm((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    slotKeys: prev.slotKeys.includes(key)
                                      ? prev.slotKeys.filter((k) => k !== key)
                                      : [...prev.slotKeys, key],
                                  }
                                : prev
                            )
                          }
                          detail={editForm.slot}
                          onDetailChange={(next) => setEditForm((prev) => (prev ? { ...prev, slot: next } : prev))}
                        />
                        <div>
                          <label className="block text-[13px] font-bold text-gray-700 mb-2">시작일</label>
                          <input type="date" value={editForm.startDate} onChange={(e) => setEditForm({ ...editForm, startDate: e.target.value })} className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-sm focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[13px] font-bold text-gray-700 mb-2">집결지</label>
                        <input type="text" value={editForm.pickupAddress} onChange={(e) => setEditForm({ ...editForm, pickupAddress: e.target.value })} placeholder="예: 성수동 물류센터 3번 게이트" className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-sm focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow" />
                      </div>
                      <div>
                        <label className="block text-[13px] font-bold text-gray-700 mb-2">마지막 경유지(배송 종료 지점)</label>
                        <input type="text" value={editForm.dropoffAddress} onChange={(e) => setEditForm({ ...editForm, dropoffAddress: e.target.value })} placeholder="예: 하남 미사강변도시 일대" className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-sm focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow" />
                      </div>
                      {/* 거리 기준 — 노출 반경 규칙·거리 정렬·'대기자에게 안내' 조건 매칭이 **모두 이 값**을 쓴다.
                          집결지=경유지인 라인은 차이가 없지만, 멀리 떨어진 라인은 대상 수가 크게 갈린다
                          (실측: 용산·한남 라인은 15km 대상이 190명 ↔ 296명). */}
                      <div>
                        <label className="block text-[13px] font-bold text-gray-700 mb-2">거리를 어디에서 재나요</label>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {(Object.keys(DISTANCE_BASIS_LABEL) as DistanceBasis[]).map((b) => {
                            const sel = editForm.distanceBasis === b;
                            return (
                              <button aria-checked={sel} role="radio"
                                key={b}
                                type="button"
                                onClick={() => setEditForm({ ...editForm, distanceBasis: b })}
                                className={`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-left p-3 rounded-xl border transition-colors ${sel ? "border-foreground bg-white ring-1 ring-foreground" : "border-border-strong bg-white hover:border-gray-300"}`}
                              >
                                <div className={`text-[13px] font-bold ${sel ? "text-foreground" : "text-gray-700"}`}>
                                  {b === "pickup" ? "집결지만" : "가까운 곳 아무거나"}
                                </div>
                                <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                                  {b === "pickup"
                                    ? "매일 출근하는 곳 기준. 지원자가 보는 '집에서 약 N km'와 같아요."
                                    : "집결지·마지막 경유지 중 가까운 쪽. 대상이 더 넓어져요(기본)."}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
                          노출 반경 규칙 · 거리 정렬 · &lsquo;대기자에게 안내&rsquo;의 15km 조건이 모두 이 기준을 씁니다.
                        </p>
                      </div>
                      {/* AI 응대 근거 — 정책·근무 문의(급여는 위 '공고 설정'의 급여 그룹에서). 등록 모달과 같은 섹션에 둔다. */}
                      <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-xl flex flex-col gap-4">
                        <div className="text-[12px] font-bold text-warning-strong">AI 응대 근거 — 채우면 정책·근무 문의를 AI가 직접 안내해 매니저가 직접 답해야 하는 일이 줄어듭니다 (급여는 ‘공고 설정’의 ‘급여’ 그룹에서)</div>
                        <div>
                          <label className="block text-[13px] font-bold text-gray-700 mb-2">고용·정책 안내</label>
                          <textarea value={editForm.policyNotes} onChange={(e) => setEditForm({ ...editForm, policyNotes: e.target.value })} rows={2} placeholder="예: 프리랜서(3.3%) 계약, 4대보험 미적용 · 본인 명의 정산" className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-[13.5px] leading-relaxed focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow resize-none bg-white" />
                        </div>
                        <div>
                          <label className="block text-[13px] font-bold text-gray-700 mb-2">기타 참고정보 (근무·차량 정책 등)</label>
                          <textarea value={editForm.aiFacts} onChange={(e) => setEditForm({ ...editForm, aiFacts: e.target.value })} rows={3} placeholder={"예: 주말·공휴일 근무 있음(월 2회 로테이션) · 오전+오후 동시 진행 가능 · 렌트/리스 차량 가능(1톤 이하) · 풀타임 불가"} className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-[13.5px] leading-relaxed focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow resize-none bg-white" />
                        </div>
                      </div>
                    </>
                </EditSection>

                {/* 공고 본문 [접이식] — 급여·AI 근거를 각자 제자리로 옮겨 이 섹션은 본문만 남는다. */}
                <EditSection
                  title="공고 본문"
                  summary={bodySummary(editForm)}
                  open={editOpenSections.content}
                  onToggle={() => setEditOpenSections((s) => ({ ...s, content: !s.content }))}
                >
                      <div>
                        <label className="block text-[13px] font-bold text-gray-700 mb-2">공고 내용</label>
                        <textarea value={editForm.body} onChange={(e) => setEditForm({ ...editForm, body: e.target.value })} rows={10} className="min-h-11 w-full px-4 py-3 border border-border-strong rounded-xl text-[13.5px] leading-relaxed focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow resize-none" />
                      </div>
                </EditSection>
              </div>
            )}
            <div className="flex items-center justify-end gap-3 px-7 py-5 border-t border-border-strong bg-white">
              <Button variant="ghost" size="lg" disabled={editSaving} onClick={() => { setEditForm(null); setEditDroppedBranch(null); }}>취소</Button>
              <Button variant="primary" size="lg" onClick={handleEditSave} disabled={editLoading} isLoading={editSaving}>
                  {!editSaving && <Save size={16} />} 저장
                </Button>
            </div>
        </Modal>
      )}

      {/* 공고 마감 확인 모달 — 미선발 관심자 안내 발송 옵션 포함 */}
      {closeModal && (
        <Modal bare open={Boolean(closeModal)} onClose={() => setCloseModal(null)} size="md"
               title="공고 마감"
               className="">
            <div className="px-7 pt-6 pb-2">
              <h2 className="text-[18px] font-extrabold text-foreground">공고를 마감할까요?</h2>
              <p className="text-[13.5px] text-muted-foreground mt-2 leading-relaxed">
                {`'${closeModal.job.title}' 공고를 마감합니다. 마감 후에도 언제든 재개할 수 있어요.`}
              </p>
              {/* 마감하면 dispatch·pull 관심표시가 막힌다. 진행 중 후보의 AI 응대는:
                  internal(일반 라인) = '마감 안내 모드'로 전환(충원완료 안내+결원 우선 약속+선탑 제안, 응대 지속)
                  external/both = AI가 마감을 인지하지 못한 채 응대할 수 있음 — 직접 안내 권고(E2-2). */}
              {closeModal.job.inProgress > 0 && (
                closeModal.job.recruitMode === "internal" ? (
                  <div className="mt-3 px-3 py-2 rounded-lg bg-yellow-50 border border-warning-soft text-[12.5px] font-bold text-warning-strong">
                    💬 진행 중인 후보 {closeModal.job.inProgress}명의 AI 응대는 &lsquo;마감 안내 모드&rsquo;로 전환돼요 — 충원 완료 안내, 결원 시 먼저 안내 약속, 선탑(동승) 제안까지 응대를 이어갑니다.
                  </div>
                ) : (
                  <div className="mt-3 px-3 py-2 rounded-lg bg-error-soft border border-error-soft text-[12.5px] font-bold text-error-strong">
                    ⚠️ 진행 중인 후보 {closeModal.job.inProgress}명이 있어요. 마감 후 답장에는 AI가 마감을 인지하지 못한 채 응대할 수 있으니 직접 안내를 권해요.
                  </div>
                )
              )}
              {closeModal.loading ? (
                <div className="mt-4 flex items-center gap-2 text-[12.5px] text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> 미선발 관심자 확인 중…
                </div>
              ) : closeModal.targets.length > 0 ? (
                <div className="mt-4">
                  <label className="flex items-center gap-2 text-[13.5px] font-bold text-gray-800 cursor-pointer" title="이 공고에 관심을 표시했거나 진행 중이었지만 확정되지 않은 인원(수신거부·기수신자 제외)">
                    <input
                      type="checkbox"
                      checked={closeModal.send}
                      onChange={(e) => setCloseModal({ ...closeModal, send: e.target.checked })}
                      className="accent-brand-yellow"
                    />
                    미선발 관심자 {closeModal.targets.length}명에게 안내 문자 발송
                  </label>
                  {closeModal.send && (
                    <>
                      <div className="mt-2 px-3 py-2.5 rounded-lg bg-background border border-border-strong text-[11.5px] text-muted-foreground leading-relaxed whitespace-pre-line">
                        {closeNoticeBody(closeModal.job)}
                      </div>
                      <p className="mt-1.5 text-[11px] text-muted-foreground">{"#{이름}·#{맞춤링크}는 수신자별로 자동 치환돼요. 확정이 아닌 정보성 안내 문자입니다."}</p>
                    </>
                  )}
                </div>
              ) : null}
            </div>
            <div className="flex items-center justify-end gap-3 px-7 py-5">
              <Button variant="ghost" size="lg" disabled={closing} onClick={() => setCloseModal(null)}>취소</Button>
              <Button
                  size="lg"
                  variant={closeModal.job.inProgress > 0 ? "destructive" : "primary"}
                  onClick={confirmClose}
                  disabled={closeModal.loading}
                  isLoading={closing}
                >
                  {!closing && <Pause size={16} />}
                  {!closeModal.loading && closeModal.send && closeModal.targets.length > 0
                    ? `마감 + ${closeModal.targets.length}명 안내 발송`
                    : "마감하기"}
                </Button>
            </div>
        </Modal>
      )}

      {/* 새 공고 안내 확인 모달 — 등록 직후(대상 ≥1) 자동 + 행 '대기자에게 안내' 재사용.
          "먼저 안내드릴게요" 약속(waitlist_notice)·알림 신청(notify_request) 이행을 게시 순간 원클릭으로. */}
      {announceModal && (
        <Modal bare open={Boolean(announceModal)} onClose={() => setAnnounceModal(null)} size="md"
               title="공고 안내 발송"
               className="">
            <div className="px-7 pt-6 pb-2">
              <h2 className="text-[18px] font-extrabold text-foreground">새 공고를 기다리던 분들에게 안내할까요?</h2>
              <p className="text-[13.5px] text-muted-foreground mt-2 leading-relaxed">
                {`'${announceModal.smsTitle}' 공고를 ${announceModal.targets.length}명에게 문자로 안내합니다.`}
              </p>
              {/* 그룹별 인원 — A 약속 > B 알림 신청 > C 조건 매칭, 상위 그룹 우선으로 중복 제거된 수 */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(Object.keys(ANNOUNCE_GROUP_LABEL) as AnnounceGroup[])
                  .filter((g) => announceModal.groups[g] > 0)
                  .map((g) => (
                    <span key={g} className="px-2 py-0.5 rounded-full text-[11.5px] font-bold bg-success-soft text-success-strong border border-success/25">
                      {ANNOUNCE_GROUP_LABEL[g]} {announceModal.groups[g]}
                    </span>
                  ))}
              </div>
              <div className="mt-3 px-3 py-2.5 rounded-lg bg-background border border-border-strong text-[11.5px] text-muted-foreground leading-relaxed whitespace-pre-line">
                {NEW_JOB_NOTICE.replace("{공고명}", announceModal.smsTitle)}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">{"#{이름}·#{맞춤링크}는 수신자별로 자동 치환돼요. 확정이 아닌 정보성 안내 문자입니다."}</p>
              {/* 지정 노출로 좁힌 공고는 명단 밖 대기자에게 안내를 보내지 않는다 —
                  '먼저 안내드릴게요' 약속은 공고 무관이라, 이 수를 숨기면 약속이 조용히 깨진다. */}
              {(announceModal.dropped?.total ?? 0) > 0 && (
                <div className="mt-3 px-3 py-2 rounded-lg bg-yellow-50 border border-warning/35 text-[12px] text-warning-strong leading-relaxed">
                  이 공고는 <b>지정 노출</b>이라 노출 명단 밖 <b>{announceModal.dropped?.total}명</b>이 대상에서 빠졌어요
                  {(announceModal.dropped?.promised ?? 0) > 0 && <> — 그중 <b>{announceModal.dropped?.promised}명</b>은 &lsquo;먼저 안내드릴게요&rsquo; 약속·선탑 완료자예요</>}.
                  이분들께도 알리려면 노출 명단을 넓히거나 인재풀에서 직접 문자를 보내세요.
                </div>
              )}
              {/* 야간(KST 21~08)엔 발송하지 않는다 — engage와 동일 원칙(isNightKst). */}
              {announceModal.night && (
                <div className="mt-3 px-3 py-2 rounded-lg bg-yellow-50 border border-yellow-200 text-[12.5px] font-bold text-warning-strong">
                  야간에는 발송하지 않아요 — 아침 9시 이후 이 공고의 관리 메뉴에서 보낼 수 있어요
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 px-7 py-5">
              <Button variant="ghost" size="lg" disabled={announcing} onClick={() => setAnnounceModal(null)}>건너뛰기</Button>
              <Button variant="brand" size="lg" onClick={sendAnnounce} disabled={announceModal.night} isLoading={announcing}>
                  {!announcing && <Megaphone size={16} />}
                  {announcing ? "발송 중..." : `${announceModal.targets.length}명에게 안내 발송`}
                </Button>
            </div>
        </Modal>
      )}

      {/* 공고별 지원자 보드 (슬라이드) */}
      <AnimatePresence>
        {candPanel && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => { setCandPanel(null); setConfirmSignal(null); }} className="fixed inset-0 bg-black/30 z-40 backdrop-blur-[2px]" />
            <motion.div
              initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 26, stiffness: 220 }}
              className="fixed top-0 right-0 w-[480px] max-w-[92vw] h-full bg-glass-3 backdrop-blur-xl shadow-[-10px_0_30px_rgba(0,0,0,0.1)] z-40 flex flex-col border-l border-white"
            >
              <div className="px-6 py-4 border-b border-border-strong bg-background shrink-0">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[12px] font-bold text-muted-foreground mb-1"><Users size={13} /> 공고별 지원자</div>
                    <h2 className="text-[17px] font-extrabold text-foreground truncate">{candPanel.title}</h2>
                    <div className="text-[12px] text-muted-foreground mt-0.5">{candidates.length}명 지원 · 미발송 {unsentCount}명</div>
                  </div>
                  <Button variant="ghost" size="icon" aria-label="지원자 보드 닫기" onClick={() => { setCandPanel(null); setConfirmSignal(null); }}><X size={20} /></Button>
                </div>
                <Button variant="secondary" onClick={openPicker} className="mt-3 w-full"><UserPlus size={15} /> 인재풀에서 후보 추가</Button>
                {unsentCount > 0 && (
                  <>
                    {/* 킬스위치 ON이어도 발송 자체는 막지 않는다 — 다만 답장에 AI가 응대하지 않음을 발송 전에 알린다. */}
                    {!aiGlobalOn && (
                      <div className="mt-3 px-3 py-2 rounded-lg bg-yellow-50 border border-yellow-200 text-[11.5px] font-bold text-warning-strong">
                        전역 AI 중지 중 — 답장은 수동 응대해야 해요
                      </div>
                    )}
                    <Button variant="primary" onClick={dispatchUnsent} isLoading={dispatching} className="mt-3 w-full">
                        {!dispatching && <Sparkles size={15} />} 미발송 {unsentCount}명에게 스크리닝 문자 발송
                      </Button>
                  </>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {candLoading && <div className="text-[13px] text-muted-foreground text-center py-8">불러오는 중…</div>}
                {!candLoading && candidates.length === 0 && <div className="text-[13px] text-muted-foreground text-center py-8">아직 지원자가 없어요</div>}

                {!candLoading && candidates.length > 0 && (
                  <div className="bg-background border border-border-strong rounded-xl p-3.5 space-y-3">
                    {/* 단계 분포 */}
                    <div>
                      <div className="text-[11px] font-bold text-muted-foreground mb-1.5">진행 단계</div>
                      <div className="flex flex-wrap gap-1.5">
                        {STAGE_ORDER.filter((s) => stageCounts[s]).map((s) => (
                          <span key={s} className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${STAGE_COLOR[s] ?? "bg-muted text-gray-700"}`}>{STAGE_KO[s] ?? s} {stageCounts[s]}</span>
                        ))}
                      </div>
                    </div>
                    {/* 채널 유입 */}
                    <div>
                      <div className="text-[11px] font-bold text-muted-foreground mb-1.5">유입 채널</div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(channelCounts).sort((a, b) => b[1] - a[1]).map(([src, n]) => (
                          <span key={src} className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-white border border-border-strong text-gray-700">{sourceLabel(src)} {n}</span>
                        ))}
                      </div>
                    </div>
                    {/* 확정 슬롯 분포 — 슬롯은 비마트 배차 개념이라 internal 정기배송 라인은 표시하지 않는다. */}
                    {hasConfirmedSlot && candPanel?.recruitMode !== "internal" && (
                      <div>
                        <div className="text-[11px] font-bold text-muted-foreground mb-1.5" title="매니저가 '확정인력'으로 지정한 후보의 시간대 분포 — 충원율 게이지와 같은 기준">확정 슬롯 분포</div>
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-1.5">
                          {slotFill.map((s) => (
                            <div key={s.key} className={`text-center rounded-md py-1.5 ${s.count > 0 ? "bg-success-soft border border-success/25" : "bg-white border border-border-strong"}`}>
                              <div className="text-[10px] font-bold text-muted-foreground">{s.label}</div>
                              <div className={`text-[14px] font-extrabold ${s.count > 0 ? "text-success" : "text-muted-foreground"}`}>{s.count}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 정렬 토글 — 그룹 내 카드 순서에 적용. 추천순은 즉시가능·거리·지원일로 컨택 우선순위를 만든다. */}
                {!candLoading && candidates.length > 0 && (
                  <div className="flex items-center gap-1.5 px-0.5">
                    <span className="text-[11px] font-bold text-muted-foreground mr-0.5">정렬</span>
                    <button aria-pressed={candSort === "recommended"}
                      onClick={() => setCandSort("recommended")}
                      title="즉시가능 → 공고와 가까운 순 → 지원일 최신순"
                      className={`px-2.5 py-1 rounded-full text-[11.5px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow ${candSort === "recommended" ? "bg-foreground text-white" : "bg-muted text-muted-foreground hover:bg-gray-200"}`}
                    >
                      추천순
                    </button>
                    <button aria-pressed={candSort === "recent"}
                      onClick={() => setCandSort("recent")}
                      title="후보 추가 최신순"
                      className={`px-2.5 py-1 rounded-full text-[11.5px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow ${candSort === "recent" ? "bg-foreground text-white" : "bg-muted text-muted-foreground hover:bg-gray-200"}`}
                    >
                      최신순
                    </button>
                  </div>
                )}

                {stageGroups.map((group) => (
                  <div key={group.stage} className="space-y-2">
                    <div className="flex items-center gap-2 px-0.5">
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${STAGE_COLOR[group.stage] ?? "bg-muted text-gray-700"}`}>{STAGE_KO[group.stage] ?? group.stage}</span>
                      <span className="text-[11px] text-muted-foreground font-bold">{group.items.length}명</span>
                      <div className="flex-1 h-px bg-muted" />
                    </div>
                    {group.items.map((c) => {
                      const a = c.applicants;
                      const stage = c.agent_stage ?? "";
                      const busy = candBusyId === c.id;
                      // 이미 확정된 사람에게는 '확정' 버튼을 띄우지 않는다(확정 취소는 지원자 상세에서).
                      const alreadyConfirmed = a?.status === "확정인력";
                      const isPaused = stage === "paused";
                      const isClosed = stage === "abort";
                      const phone = a?.phone ?? null;
                      // 우선순위 메타 — 가용성 · 공고 거리 · 원지원일. 없는 값은 생략(추천순 정렬 근거와 동일 소스).
                      const metaLine = [
                        a?.availability,
                        typeof c.distance_km === "number" ? `${c.distance_km.toFixed(1)}km` : null,
                        a?.applied_at ? `지원 ${fmtYM(a.applied_at)}` : null,
                      ].filter(Boolean).join(" · ");
                      return (
                        <div
                          key={c.id}
                          /* 지금 상세로 보고 있는 후보 — 나란히 뜬 패널과 명단을 눈으로 잇는다 */
                          className={`bg-white border rounded-xl p-3.5 transition-all ${
                            c.applicant_id === selectedApplicantId
                              ? "border-foreground shadow-[inset_3px_0_0_0_var(--foreground)]"
                              : "border-border-strong hover:border-gray-300"
                          }`}
                        >
                          <button aria-current={c.applicant_id === selectedApplicantId ? "true" : undefined} onClick={() => setSelectedApplicantId(c.applicant_id)} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full text-left">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className="w-9 h-9 rounded-lg bg-muted text-gray-700 flex items-center justify-center font-bold text-[14px] shrink-0">{a?.name?.charAt(0) ?? "?"}</div>
                                <div className="min-w-0">
                                  <div className="text-[14px] font-bold text-foreground flex items-center gap-1.5">
                                    {a?.name ?? `#${c.applicant_id}`}
                                    {alreadyConfirmed && (
                                      <span
                                        className="text-[10.5px] font-bold px-1.5 py-0.5 rounded-full bg-success-soft text-success-strong border border-success/25"
                                        title="인력풀 상태가 '확정인력'이에요(다른 라인 확정도 포함). 이 공고 확정 여부는 카드를 눌러 상세에서 확인하세요."
                                      >
                                        확정인력
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11.5px] text-muted-foreground truncate">{a?.source ? sourceLabel(a.source) + " · " : ""}{a?.branch1 ?? "-"} · {a?.work_hours ?? "-"}{!c.sent_at && <span className="ml-1 text-warning-strong font-bold">· 미발송</span>}</div>
                                  {metaLine && <div className="text-[11px] text-muted-foreground truncate">{metaLine}</div>}
                                </div>
                              </div>
                              {/* 종료 카드는 결과(보류/공고부적합/중단)를 closed_reason으로 구분해 배지로 보여준다. */}
                              {stage && (
                                isClosed ? (
                                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${closedKind(c.closed_reason).badge}`}>{closedKind(c.closed_reason).label}</span>
                                ) : (
                                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${STAGE_COLOR[stage] ?? "bg-muted text-gray-700"}`}>{STAGE_KO[stage] ?? stage}</span>
                                )
                              )}
                            </div>
                          </button>
                          {/* 전화번호 + 복사 — 카드 본문 버튼(상세 열기)과 분리해 중첩 버튼을 피한다. 수동 응대 동선. */}
                          {phone && (
                            <div className="flex items-center gap-1 mt-2 text-[11.5px] font-semibold text-gray-700">
                              <span className="font-mono">{phone}</span>
                              <Button variant="ghost" size="chip" aria-label="전화번호 복사" title="전화번호 복사" onClick={() => copyPhone(phone)} className="px-1"><Copy size={12} /></Button>
                            </div>
                          )}
                          {isClosed ? (
                            <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-muted">
                              {/* 되돌리기 — 잘못 종료한 카드를 이 공고 후보로 복원(확인 모달). 인력풀은 건드리지 않는다. */}
                              <Button variant="ghost" size="chip" onClick={() => resumeCandidate(c)} isLoading={busy} className="text-info-strong hover:bg-info-soft hover:text-info-strong">
                                    {!busy && <Play size={12} />} 재개
                                  </Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-muted flex-wrap">
                              {/* 확정 — 이 화면의 핵심 결과 액션. 지원자 상세를 열면서 확정 모달까지 바로 띄운다(공고를 시드해 오귀속 방지).
                                  확정 자체는 상세의 확정 모달에서 지점·시간대·시작일을 받아 처리된다(단일 경로 유지). */}
                              {alreadyConfirmed && (
                                <span className="text-[11px] text-muted-foreground">이미 확정된 분 — 이 공고로 바꾸려면 상세에서 확정을 취소하고 다시 확정하세요</span>
                              )}
                              {!alreadyConfirmed && !boardJobClosed && (
                                <Button variant="primary" size="chip" onClick={() => openConfirmFor(c.applicant_id, candPanel?.jobId ?? null)} disabled={busy} className="px-2.5 bg-success-strong hover:bg-success-strong text-white shadow-none focus-visible:ring-success-strong" title="이 공고에 확정 — 확정 정보를 확인한 뒤 확정합니다">
                                      <CheckCircle2 size={12} /> 확정
                                    </Button>
                              )}
                              {isPaused ? (
                                <Button variant="ghost" size="chip" onClick={() => patchCandidate(c.id, { agent_stage: "screening" }, "AI 응대를 재개했어요")} isLoading={busy} className="text-info-strong hover:bg-info-soft hover:text-info-strong">
                                      {!busy && <Play size={12} />} 응대 재개
                                    </Button>
                              ) : (
                                <Button variant="ghost" size="chip" onClick={() => patchCandidate(c.id, { agent_stage: "paused", paused_reason: "manager: 수동 전환" }, "AI 응대를 정지했어요. 이제 매니저가 직접 답장합니다.")} isLoading={busy}>
                                      {!busy && <Pause size={12} />} 응대 정지
                                    </Button>
                              )}
                              {/* 공고 단위 결과 — 둘 다 이 공고 후보만 닫고, 지원자는 인력풀에 유지된다(다른 공고엔 여전히 후보).
                                  인력풀 전체 제외는 지원자 상세의 '인력풀 제외'에서만. */}
                              <Button variant="ghost" size="chip" onClick={() => patchCandidate(c.id, { agent_stage: "abort", closed_reason: "manager: 보류" }, "이 공고 보류했어요 (인력풀에는 유지)")} disabled={busy} className="ml-auto">
                                    <PauseCircle size={12} /> 보류
                                  </Button>
                              <Button variant="ghost" size="chip" onClick={() => patchCandidate(c.id, { agent_stage: "abort", closed_reason: "manager: 공고부적합" }, "이 공고 부적합 처리했어요 (인력풀에는 유지)")} disabled={busy} className="text-error-strong hover:bg-error-soft hover:text-error-strong">
                                    <X size={12} /> 부적합
                                  </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* 인재풀에서 후보 추가 — 피커 모달 */}
      {pickerOpen && (
        <Modal bare open={pickerOpen} onClose={() => setPickerOpen(false)} size="md"
               title="대상 추가"
               className="">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border-strong">
              <div>
                <h2 className="text-[17px] font-extrabold text-foreground flex items-center gap-2"><UserPlus size={18} className="text-copilot" /> 인재풀에서 후보 추가</h2>
                <p className="text-[12px] text-muted-foreground mt-0.5">선택한 분들을 <b>미발송 후보</b>로 추가합니다. 컨택(문자 발송)은 이후 매니저가 진행해요.</p>
              </div>
              <Button variant="ghost" size="icon" aria-label="인재풀 선택 창 닫기" onClick={() => setPickerOpen(false)}><X size={22} /></Button>
            </div>
            <div className="px-6 py-3 border-b border-muted">
              <div className="relative">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  placeholder="이름, 연락처, 지점 검색"
                  className="min-h-11 w-full pl-9 pr-3 py-2.5 border border-border-strong rounded-xl text-sm focus:outline-none focus:border-brand-yellow focus:ring-1 focus:ring-brand-yellow"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
              {poolLoading && <div className="text-[13px] text-muted-foreground text-center py-10">불러오는 중…</div>}
              {!poolLoading && pickablePool.length === 0 && <div className="text-[13px] text-muted-foreground text-center py-10">추가할 수 있는 인재풀 후보가 없어요</div>}
              {!poolLoading && pickablePool.map((p) => {
                const sel = picked.has(p.id);
                const conflict = p.current_job_id != null && p.current_job_id !== candPanel?.jobId;
                return (
                  <button
                    key={p.id}
                    onClick={() => setPicked((prev) => { const n = new Set(prev); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}
                    className={`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full flex items-center gap-3 text-left px-3 py-2.5 rounded-xl border transition-colors ${sel ? "border-copilot bg-copilot-soft" : "border-border-strong bg-white hover:border-gray-300"}`}
                  >
                    <span className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${sel ? "bg-copilot border-copilot" : "border-gray-300"}`}>
                      {sel && <CheckCircle2 size={14} className="text-white" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-bold text-foreground flex items-center gap-1.5">
                        {p.name ?? `#${p.id}`}
                        {conflict && <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded-full bg-yellow-50 text-warning border border-warning-soft">다른 공고 진행 중</span>}
                      </div>
                      <div className="text-[11.5px] text-muted-foreground truncate">{(p.source ? sourceLabel(p.source) + " · " : "")}{p.branch1 ?? "-"} · {p.work_hours ?? "-"}{p.status ? " · " + p.status : ""}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-border-strong bg-white">
              <div className="text-[13px] font-bold text-gray-700">{picked.size}명 선택</div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="lg" disabled={adding} onClick={() => setPickerOpen(false)}>취소</Button>
                <Button variant="primary" size="lg" onClick={addFromPool} disabled={picked.size === 0} isLoading={adding}>
                {!adding && <UserPlus size={16} />} 후보로 추가
              </Button>
              </div>
            </div>
        </Modal>
      )}

      <ApplicantDetailPanel
        isOpen={selectedApplicantId != null}
        /* 후보 보드에서 열었을 때는 보드를 흐리지 않고 그 왼쪽에 나란히 붙인다 —
           후보를 하나씩 확인하며 확정/보류를 누르는 작업이라, 볼 때마다 보드가
           닫히거나 흐려지면 명단에서 자리를 잃는다. */
        docked={candPanel != null}
        dockedClassName="right-[496px] top-4 bottom-4 w-[480px] z-50"
        onClose={() => { setSelectedApplicantId(null); setConfirmSignal(null); }}
        applicantId={selectedApplicantId}
        jobId={candPanel?.jobId ?? null}
        autoOpenConfirm={confirmSignal}
        onAutoOpenConfirmConsumed={() => setConfirmSignal(null)}
        onChanged={() => { if (candPanel) loadCandidates(candPanel.jobId); loadJobs(); }}
      />
    </div>
  );
}