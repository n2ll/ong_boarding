import { useState, useEffect, useMemo, useRef } from "react";
import useSWR from "swr";
import { useSearchParams } from "next/navigation";
import { Filter, Search, MoreHorizontal, MessageCircle, Calendar, Check, X, UserX, Download, LayoutGrid, Layers, List as ListIcon, Columns, ArrowRight, UserPlus, FileDown, Tags, Mail, Loader2, Briefcase, Map as MapIcon, Funnel, RefreshCw, Zap, Eye, ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuCheckboxItem } from "./ui/dropdown-menu";
import { Modal } from "./ui/modal";
import { PipelineMap, type MapApplicant, type MapJob } from "./PipelineMap";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { toast } from "sonner";
import { ApplicantDetailPanel } from "./ApplicantDetailPanel";
import { useConfirm } from "./ConfirmDialog";
import { motion, AnimatePresence } from "motion/react";
import { Applicant, calcAge, SLOTS, SLOT_LABEL, SLOT_UNKNOWN, applicantAvailableSlots, type SlotKey } from "@/lib/admin/types";
import { distanceToJobKm, jobAnchors, type GeoJob } from "@/lib/geo";
import { useBranchScope, matchesBranchScope } from "@/lib/branch-scope";
import { normalizeVehicleOwned } from "@/lib/exposure";
import { summarizeLinks, type LiveJobLink } from "@/lib/candidate-links";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

// SMS 비용 대략치(SOLAPI): 90바이트 이하 SMS(단문) ~20원, 초과 LMS(장문) ~33원. 한글=2바이트.
function estimateSmsCost(text: string): { sms_type: "SMS" | "LMS"; cost_krw: number; bytes: number } {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) bytes += text.charCodeAt(i) > 0x7f ? 2 : 1;
  const sms_type = bytes <= 90 ? "SMS" : "LMS";
  return { sms_type, cost_krw: sms_type === "SMS" ? 20 : 33, bytes };
}

// 비용 추정용 대표 샘플 치환 — 치환자 원문이 아니라 실제 발송 길이 기준으로 계산해야 SMS/LMS 판정이 맞다.
// 링크는 실제 발송 URL(base + /p/ + UUID 36자)과 같은 길이의 더미, 이름은 한글 3자.
const SAMPLE_PULL_LINK = "https://ong-boarding-pi.vercel.app/p/00000000-0000-0000-0000-000000000000";
function fillSampleVars(text: string): string {
  return text.replace(/#\{이름\}/g, "홍길동").replace(/#\{맞춤링크\}/g, SAMPLE_PULL_LINK);
}

const SEGMENTS_KEY = "ong_pipeline_segments";

/** KST 21시~익일 08시 — 야간 판정. 서버 규칙(lib/agent/engage.isNightKst)과 같은 식을 클라이언트에서 쓴다.
 *  이 화면 벌크 발송은 야간에도 막지 않고(긴급 결원 대응) 확인 모달에서 경고만 한다. */
function isNightKstNow(d: Date = new Date()): boolean {
  const kstHour = (d.getUTCHours() + 9) % 24;
  return kstHour >= 21 || kstHour < 8;
}

interface SavedSegment {
  id: string;
  name: string;
  channels: string[];
  vehicle: "all" | "vehicle" | "walk" | "unknown";
  slots: string[];
  query: string;
  // v2 확장 — 구버전 저장분은 undefined (하위호환)
  statuses?: string[];
  availability?: string[];
  region?: "all" | "capital" | "seoul";
  // v3 확장 — '발송 준비' 묶음과 나머지 조건. 예전엔 저장되지 않아 '현재 필터 저장'이라 적힌 것과 달리
  // 재적용하면 대상 인원이 달라졌다. 구버전 저장분은 undefined → 적용 시 false로 떨어진다.
  excludeActive?: boolean;
  excludeRecentPing?: boolean;
  geoConfirmedOnly?: boolean;
  recentAppliedOnly?: boolean;
  reactionOnly?: boolean;
  optOutOnly?: boolean;
  showExcluded?: boolean;
}

// Types
type VehicleClass = "확정" | "도보" | "미확인";

// pool_events 반응 요약 — /api/admin/pool-events/summary 응답의 지원자별 항목.
// 반응 배지(열람/관심/답장)·'마지막 연락 N일 전' 배지·'반응 있음' 필터·'반응 최신순' 정렬의 근거.
interface PoolEventSummary {
  last_ping_at: string | null;
  last_link_view_at: string | null;
  last_interest: { job_id: number | null; at: string; immediate: boolean } | null;
  last_reply_at: string | null;
}

// 반응 시각 max — '반응 최신순' 정렬 키. 반응(열람/관심/답장) 없으면 null(정렬 시 뒤).
function lastReactionAt(s: PoolEventSummary | undefined): number | null {
  if (!s) return null;
  const ts = [s.last_link_view_at, s.last_interest?.at ?? null, s.last_reply_at]
    .filter((v): v is string => !!v)
    .map((v) => new Date(v).getTime())
    .filter((t) => !Number.isNaN(t));
  return ts.length ? Math.max(...ts) : null;
}

// 캠페인 퍼널 보드 — /api/admin/campaign-funnel 응답. 코호트(기간 내 ping_sent) 멤버별 최고 단계.
type FunnelStage = "sent" | "viewed" | "interested" | "replied";

interface FunnelMember {
  applicant_id: number;
  name: string | null;
  sigungu: string | null;
  availability: string | null;
  stage: FunnelStage;
  opted_out: boolean;
  last_event_at: string | null;
  interest_job_id: number | null;
  interest_job_title: string | null;
  immediate: boolean;
}

interface CampaignFunnelRes {
  window_days: number;
  members: FunnelMember[];
}

interface CardData {
  id: string;
  name: string;
  age: number;
  channel: string;
  branch: string;
  slot: string;
  /** 희망 시간대 판정 결과(정규 키) — 조건 바·노출 규칙이 같은 함수를 쓰게 하기 위한 값. */
  slotKeys: SlotKey[];
  tag: string;
  vehicleClass: VehicleClass;
  region: string;
  exp: string;
  lastActive: string;
  phone: string | null;
  agentStage: string | null;
  agentStageUpdatedAt: string | null;
  /** 지금 붙어 있는 공고들(관심 포함). 배지 건수 = 상세 패널에서 보이는 공고 탭 수여야 한다. */
  jobLinks: LiveJobLink[];
  status: string;
  availability: string | null;
  smsOptOutAt: string | null;
  sido: string | null;
  createdAtIso: string | null;
  lastMessageAtIso: string | null;
  /** 맞춤 공고 링크가 만들어져 있는지. 목록은 토큰 원문을 받지 않는다(존재 여부만). */
  hasCustomLink: boolean;
  appliedAtIso: string | null;
  geoPrecision: string | null;
  lat: number | null;
  lng: number | null;
}

// 표시 라벨만 실무 언어로 통일(LiveConsole·Jobs·Dashboard와 동일 단어) — DB 값(agent_stage)은 그대로.
const STAGE_KO: Record<string, string> = {
  exploration: "초기 대화", screening: "스크리닝", onboarding: "온보딩",
  active: "활동 중", paused: "수동 응대", abort: "중단",
};

const CHANNEL_LABEL: Record<string, string> = {
  danggeun: "당근",
  baemin: "배민",
  manual: "수기 등록",
  direct: "직접 지원",
  danggeun_practice: "연습",
};

function channelLabel(source: string | null | undefined): string {
  if (!source) return "기타";
  return CHANNEL_LABEL[source] ?? source;
}

// 다시 연락 A안 (2026-07-10 다이어트, 전체 기본) — 지원 시점 뭉갬(오래된 지원자 안전), 문의 답장 유도, 짧게.
// 치환: #{이름}, #{맞춤링크}. 제목은 bulk-send subject로 분리(인사말 중복 방지). 확정 뉘앙스 금지·정보성.
const DEFAULT_BULK_BODY = `[옹고잉] #{이름}님, 안녕하세요. 예전에 배송 지원 설문을 남겨주셔서 연락드려요.

지금 #{이름}님께 맞는 배송 건이 있어요. 아래에서 조건(단가)을 보시고 괜찮으면 '관심 있음'만 눌러주세요. 매니저가 확인 후 연락드립니다.

#{맞춤링크}

궁금하시면 이 문자로 편하게 답장 주세요. (안내 중단: '그만' 회신)`;

// 다시 연락 B안 (최근 6개월 이내 지원자용 — 더 짧게)
const RECONTACT_B_BODY = `[옹고잉] #{이름}님, 안녕하세요. 얼마 전 남겨주신 배송 지원 설문 보고 연락드려요. 지금 맞는 배송 건이 있어요 — 아래에서 조건 확인 후 '관심 있음'만 눌러주세요. 매니저가 연락드립니다.

#{맞춤링크}

궁금하면 답장 주세요. (중단: '그만')`;

// 관심 대기 안내 (사후관리) — '관심 있음'을 눌렀지만 자리가 부족해 바로 배정 안내를 못 하는 인원용.
// 확정 뉘앙스 금지 — '먼저 연락드릴게요'까지만, 배정·확정을 약속하지 않는다.
const WAITLIST_BODY = `#{이름}님, 관심 감사합니다. 현재 순차적으로 안내드리고 있어요. 자리가 정리되는 대로 먼저 연락드릴게요! (안내 중단: '그만' 회신)`;

interface ColumnData {
  id: string;
  title: string;
  count: number;
  color: string;
  cards: CardData[];
}

const ITEM_TYPE = "CANDIDATE_CARD";

// 실제 운영 단계: 스크리닝 전 → 스크리닝 중 → 스크리닝 완료(온보딩·배민ID) → 확정인력.
// 면접/캘린더 단계는 이 제품에 존재하지 않는다(SMS 스크리닝 후 매니저 확정).
const COLUMN_DEFS: { id: string; title: string; color: string }[] = [
  { id: "applied", title: "지원 접수 / 대기", color: "bg-gray-300" },
  { id: "screening", title: "AI 스크리닝 중", color: "bg-yellow-300" },
  { id: "interview", title: "스크리닝 완료", color: "bg-success" },
  { id: "passed", title: "확정 인력", color: "bg-info" },
];

// recruitment status → 칸반 컬럼. 부적합/이탈/기타는 보드에서 제외한다.
const STATUS_TO_COLUMN: Record<string, string> = {
  "스크리닝 전": "applied",
  대기자: "applied",
  "스크리닝 중": "screening",
  "스크리닝 완료": "interview",
  확정인력: "passed",
};

// 컬럼 → status. 드래그/일괄 변경은 매니저 행위이므로 수동 상태(확정인력) 설정을 허용한다.
const COLUMN_TO_STATUS: Record<string, string> = {
  applied: "스크리닝 전",
  screening: "스크리닝 중",
  interview: "스크리닝 완료",
  passed: "확정인력",
};

const BULK_LABEL_TO_STATUS: Record<string, string> = {
  "지원 접수 / 대기": "스크리닝 전",
  "AI 스크리닝 중": "스크리닝 중",
  "스크리닝 완료": "스크리닝 완료",
  // '확정 인력'은 일괄 매핑에서 제외 — 확정은 상세 모달 단일 경로(공고 결속 필요). 방어적으로 미매핑.
  부적합: "부적합",
};

function relTime(iso: string | null): string {
  if (!iso) return "-";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금 전";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function vehicleTag(a: Applicant): string {
  if (a.vehicle_type && a.vehicle_type.trim()) return a.vehicle_type.trim();
  if (a.own_vehicle === "있음") return "차량 보유";
  return "도보";
}

// 자차 3값 판정 — 노출 규칙의 차량 축과 **같은 함수**를 쓴다(lib/exposure.normalizeVehicleOwned).
// 파이프라인에서 '차량 보유'로 고른 집합과 공고 노출 규칙 '있음'이 다른 사람을 가리키면 안 된다.
function vehicleClassOf(a: Applicant): VehicleClass {
  const n = normalizeVehicleOwned(a.own_vehicle);
  return n === "있음" ? "확정" : n === "없음" ? "도보" : "미확인";
}

// 수도권 판별 — sido 원문("서울특별시"/"경기도"/"인천광역시" 등) 접두 매칭
const CAPITAL_SIDO_PREFIXES = ["서울", "경기", "인천"];
function isCapitalArea(sido: string | null): boolean {
  return !!sido && CAPITAL_SIDO_PREFIXES.some((p) => sido.startsWith(p));
}
// 서울 판별 — sido 원문("서울특별시" 등) 접두 매칭
function isSeoul(sido: string | null): boolean {
  return !!sido && sido.startsWith("서울");
}

// 두 좌표 간 거리(km) — 하버사인 (pool route와 동일 공식)
function distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 6개월 경계 — 원지원 코호트 필터/템플릿 판단용
const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 182;
// 14일 경계 — '최근 14일 다시 연락 제외' 필터 기준
const FOURTEEN_DAYS_MS = 1000 * 60 * 60 * 24 * 14;

// 발송 가능 여부 판정 — 연락처·맞춤 공고 링크(access_token)·수신거부 3조건. 불가 사유를 함께 도출.
// 캠페인 발송이 서버에서 차단되는 상태 — app/api/admin/messages/bulk-send(EXCLUDED_POOL_STATUS)와 **같은 집합**이어야 한다.
// '기타'는 서버가 막지 않으므로 여기서도 막지 않는다(막으면 화면에만 안 보이는 조용한 제외가 된다).
const POOL_EXCLUDED_STATUS = new Set(["부적합", "이탈"]);

function sendableOf(c: CardData): { sendable: boolean; reason: string | null } {
  if (!c.phone) return { sendable: false, reason: "연락처 없음" };
  if (!c.hasCustomLink) return { sendable: false, reason: "맞춤 공고 링크 없음" };
  if (c.smsOptOutAt) return { sendable: false, reason: "수신거부" };
  if (POOL_EXCLUDED_STATUS.has(c.status)) return { sendable: false, reason: `인력풀 제외(${c.status})` };
  return { sendable: true, reason: null };
}

// 원지원일 표기 — 'YYYY-MM' (연락 이력 relTime과 구분)
function appliedMonth(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// 목록 API가 추가로 내려주는 컬럼 — 공용 Applicant 타입엔 아직 없어 로컬 확장으로 소비.
type ApplicantRow = Applicant & {
  agent_stage_updated_at?: string | null;
  sms_opt_out_at?: string | null;
  has_access_token?: boolean;
  applied_at?: string | null;
  /** 지금 붙어 있는 공고들(관심 포함) — 상세 패널의 공고 목록·응대 화면 탭과 같은 집합(lib/candidate-links). */
  job_links?: LiveJobLink[] | null;
};

function toCard(a: ApplicantRow): CardData {
  const branch = a.confirmed_branch?.trim() || a.branch1?.trim() || a.branch?.trim() || "-";
  // 조건 바 '희망 근무' 판정 — 표시용 문자열 포함 검사(예전 방식)는 자유 입력 171명을 통째로 놓쳤다.
  // 노출 규칙과 같은 함수를 쓴다(confirmed_slot은 비마트 전용 개념이라 제외).
  const slotJudgment = applicantAvailableSlots({
    work_hours: a.work_hours,
    available_slots: (a as { available_slots?: string[] | null }).available_slots ?? null,
  });
  const slotKeys = slotJudgment.slots;
  // **표시도 같은 판정으로** — 예전엔 confirmed_slot(비마트 확정 슬롯)을 보여주면서 필터는 다른 값으로
  // 판정해, 카드에 '평일 오전'이 적힌 사람이 '평일 오전' 조건에서 빠지는 모순이 났다(실측 30명 중 14명).
  const slot = slotKeys.length
    ? slotKeys.map((k) => SLOT_LABEL[k]).join(", ") + (slotJudgment.source === "self" ? " (본인 확인)" : "")
    : slotJudgment.partial
      ? "미확인(요일만)"
      : "미확인";
  return {
    id: String(a.id),
    name: a.name ?? "-",
    age: calcAge(a.birth_date) ?? 0,
    channel: channelLabel(a.source),
    branch,
    slot,
    slotKeys,
    tag: vehicleTag(a),
    vehicleClass: vehicleClassOf(a),
    region: a.sigungu ?? a.location ?? "-",
    exp: a.experience?.trim() ? a.experience.trim() : "신입",
    // created_at 폴백은 '활동'으로 오독됨 — 발신/수신 이력이 없으면 없다고 표기
    lastActive: a.last_message_at ? relTime(a.last_message_at) : "연락 이력 없음",
    phone: a.phone ?? null,
    agentStage: a.agent_stage ?? null,
    agentStageUpdatedAt: a.agent_stage_updated_at ?? null,
    jobLinks: a.job_links ?? [],
    status: a.status,
    availability: a.availability ?? null,
    smsOptOutAt: a.sms_opt_out_at ?? null,
    sido: a.sido ?? null,
    createdAtIso: a.created_at ?? null,
    lastMessageAtIso: a.last_message_at ?? null,
    hasCustomLink: Boolean(a.has_access_token),
    appliedAtIso: a.applied_at ?? null,
    geoPrecision: a.geo_precision ?? null,
    lat: a.lat ?? null,
    lng: a.lng ?? null,
  };
}

function mapApplicantsToColumns(apps: Applicant[]): ColumnData[] {
  const cols: ColumnData[] = COLUMN_DEFS.map((d) => ({ ...d, count: 0, cards: [] }));
  const byId = new Map(cols.map((c) => [c.id, c]));
  for (const a of apps) {
    const colId = STATUS_TO_COLUMN[a.status];
    if (!colId) continue;
    byId.get(colId)?.cards.push(toCard(a));
  }
  for (const c of cols) c.count = c.cards.length;
  return cols;
}

export function Pipeline() {
  const [columns, setColumns] = useState<ColumnData[]>(() =>
    COLUMN_DEFS.map((d) => ({ ...d, count: 0, cards: [] }))
  );
  const searchParams = useSearchParams();
  const { branch: scopeBranch } = useBranchScope();
  // 상세 패널 선택 — **사람과 공고를 한 값으로 묶는다.** 두 state로 두면 사람은 바뀌었는데 공고가
  // 남아 엉뚱한 공고 기준으로 확정·발송이 열릴 수 있다. wantJobId는 '이 공고 기준으로 열어라'는 요청이고,
  // 그 공고에 결속이 없으면 패널이 기본(최신)으로 되돌린다.
  const [sel, setSel] = useState<{ applicantId: number; wantJobId: number | null } | null>(null);
  const selectedApplicantId = sel?.applicantId ?? null;
  const openApplicant = (id: number, wantJobId: number | null = null) => setSel({ applicantId: id, wantJobId });
  const [view, setView] = useState<"kanban" | "list" | "map" | "funnel">("list");
  // 목록 밀도 — 568명을 훑을 때 한 화면에 몇 명이 보이는지가 곧 처리 속도다.
  // 매번 다시 고르게 하면 안 쓰게 되므로 브라우저에 기억시킨다.
  const [density, setDensity] = useState<"cozy" | "compact">("cozy");
  useEffect(() => {
    const saved = typeof window === "undefined" ? null : window.localStorage.getItem("pipeline.density");
    if (saved === "compact" || saved === "cozy") setDensity(saved);
  }, []);
  const pickDensity = (next: "cozy" | "compact") => {
    setDensity(next);
    try {
      window.localStorage.setItem("pipeline.density", next);
    } catch {
      /* 사파리 프라이빗 모드 등 — 기억만 못 할 뿐 화면은 정상 동작 */
    }
  };
  // 스플릿 뷰 — 상세를 열어도 목록이 살아 있어 다음 사람을 바로 누를 수 있다.
  // 순서대로 검토하는 작업에서 "어디까지 봤는지"를 잃지 않는 것이 핵심이다.
  const [splitView, setSplitView] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setSplitView(window.localStorage.getItem("pipeline.splitView") === "1");
  }, []);
  const toggleSplitView = () => {
    const next = !splitView;
    setSplitView(next);
    try {
      window.localStorage.setItem("pipeline.splitView", next ? "1" : "0");
    } catch {
      /* 저장이 막힌 환경 — 기억만 못 하고 동작은 정상 */
    }
  };
  // 표시 행 수 — 568명을 한 번에 다 그리면 DOM 노드의 93%가 표가 되고, 선택·필터마다
  // 그 전부가 다시 그려진다. 매니저는 목록을 끝까지 훑지 않고 조건으로 좁힌 뒤 고르므로,
  // 처음엔 한 화면 분량만 그리고 아래로 내려가면 이어서 붙인다.
  // 선택·발송·CSV는 그려진 행이 아니라 filteredCards(조건에 맞는 전원)를 대상으로 하므로
  // 여기서 자르는 것은 '보이는 양'뿐이고 동선은 그대로다.
  const ROWS_PER_CHUNK = 100;
  const [visibleCount, setVisibleCount] = useState(ROWS_PER_CHUNK);
  const moreRef = useRef<HTMLTableRowElement | null>(null);
  const [rawApplicants, setRawApplicants] = useState<Applicant[]>([]);
  // 스플릿 패널이 실제로 옆에 붙어 있는 상태 — 리스트 뷰에서 상세가 열려 있을 때만.
  const splitPanelActive = splitView && view === "list" && selectedApplicantId != null;

  // 지원자 목록은 SWR 캐시로 관리 — 탭 재방문 시 즉시 표시 + 대시보드와 중복 호출 dedup.
  // 칸반 컬럼은 드래그로 낙관적 변경되는 로컬 상태라, SWR 데이터가 갱신될 때만 동기화한다.
  const { data: applicantsData, isLoading, mutate: mutateApplicants } = useSWR<{ data?: Applicant[] }>("/api/admin/applicants", { refreshInterval: 60_000 }); // 살아있는 갱신
  const loading = isLoading && rawApplicants.length === 0;
  useEffect(() => {
    if (applicantsData?.data) {
      setRawApplicants(applicantsData.data as Applicant[]);
      setColumns(mapApplicantsToColumns(applicantsData.data as Applicant[]));
    }
  }, [applicantsData]);
  // 변경 후 목록 갱신(낙관적 변경 롤백/상세 패널 변경 반영)은 SWR 재검증으로 처리.
  const loadApplicants = () => { void mutateApplicants(); };

  // 활성 공고는 한 번만 호출해 공고 픽커(activeJobs)와 지도 오버레이(mapJobs)에 함께 사용.
  const { data: jobsData, mutate: mutateJobs } = useSWR<{ jobs?: Array<{ id: number; title: string; branch: string | null; exposure?: string | null; pickup_lat?: number | null; pickup_lng?: number | null; pickup_address?: string | null; dropoff_lat?: number | null; dropoff_lng?: number | null; dropoff_address?: string | null; distance_basis?: string | null }> }>("/api/admin/jobs?status=active");
  const visibleJobs = useMemo(() => (jobsData?.jobs ?? []).filter((j) => !String(j.title).startsWith("__")), [jobsData]);
  const activeJobs = useMemo(() => visibleJobs.map((j) => ({ id: j.id, title: j.title, branch: j.branch ?? null, exposure: j.exposure ?? "all" })), [visibleJobs]);
  const mapJobs = useMemo<MapJob[]>(() => visibleJobs.map((j) => ({ id: j.id, title: j.title, pickup_lat: j.pickup_lat ?? null, pickup_lng: j.pickup_lng ?? null, pickup_address: j.pickup_address ?? null })), [visibleJobs]);

  // 캠페인 퍼널 보드 — 퍼널 뷰에서만 조회(조건부 key). 기간(7/14/30일)은 캠페인 코호트 윈도우.
  const [funnelDays, setFunnelDays] = useState(14);
  const {
    data: funnelData,
    error: funnelError,
    mutate: mutateFunnel,
    isValidating: funnelValidating,
  } = useSWR<CampaignFunnelRes>(view === "funnel" ? `/api/admin/campaign-funnel?days=${funnelDays}` : null, { refreshInterval: 60_000 }); // 살아있는 갱신
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [query, setQuery] = useState("");

  // 헤더 글로벌 검색에서 ?q= 로 진입하면 검색어 프리필.
  // 대시보드 '지도에서 보기'에서 ?view=map 으로 진입하면 지도 분포 뷰로 시작.
  // 공고 등록 성공 후 '이 조건으로 대상 선별' CTA(SOS→공고→선별 브릿지)에서
  //   ?region=capital&vehicle=vehicle&status=..&recent=1 로 진입하면 해당 필터를 프리필한다.
  useEffect(() => {
    const q = searchParams.get("q");
    if (q) setQuery(q);
    const v = searchParams.get("view");
    if (v === "map" || v === "kanban" || v === "list" || v === "funnel") setView(v);
    const region = searchParams.get("region");
    if (region === "capital") setRegionFilter("capital");
    const vehicle = searchParams.get("vehicle");
    if (vehicle === "vehicle" || vehicle === "walk" || vehicle === "unknown") setVehicleFilter(vehicle);
    const status = searchParams.get("status");
    if (status) setStatusFilter(new Set(status.split(",").map((s) => s.trim()).filter(Boolean)));
    if (searchParams.get("recent") === "1") setRecentAppliedOnly(true);
    // 프리필된 조건(지역·차량·진행 단계·최근 지원)은 모두 조건 바에 상시 보이므로 패널을 열지 않는다.
  }, [searchParams]);
  const [channelFilter, setChannelFilter] = useState<Set<string>>(new Set());
  const [vehicleFilter, setVehicleFilter] = useState<"all" | "vehicle" | "walk" | "unknown">("all");
  const [slotFilter, setSlotFilter] = useState<Set<string>>(new Set());
  // 진행 단계(status)·가용성 필터 — 적체 트리아지의 핵심 동선 (예: '스크리닝 전'만 격리 → 벌크 처리)
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [availabilityFilter, setAvailabilityFilter] = useState<Set<string>>(new Set());
  // 지역(sido) 필터 — 전체/수도권(서울·경기·인천)/서울 3상태 세그먼트
  const [regionFilter, setRegionFilter] = useState<"all" | "capital" | "seoul">("all");
  // 부적합/이탈/기타는 칸반 보드에서 제외되지만, 리스트에서는 토글로 복구·재검토 가능해야 한다.
  const [showExcluded, setShowExcluded] = useState(false);
  // 원지원 6개월 이내 필터 — 다시 연락 B안(짧은 템플릿) 대상 격리용
  const [recentAppliedOnly, setRecentAppliedOnly] = useState(false);
  // 주소 확정(지오코딩) 필터 — geo_precision in exact/approx (지도·경로 매칭 신뢰 인원)
  const [geoConfirmedOnly, setGeoConfirmedOnly] = useState(false);
  // 옹매니징 활동 중 제외 필터 — 켜면 현재 활동 중(activeSet) 인원을 리스트에서 제외
  const [excludeActive, setExcludeActive] = useState(false);
  // '최근 14일 다시 연락 제외' 필터 — 켜면 해당 기간 내 ping_sent 이력이 있는 인원을 리스트에서 제외(중복 연락 방지)
  const [excludeRecentPing, setExcludeRecentPing] = useState(false);
  // 반응 있음 필터 — 열람/관심/답장 중 1건이라도 있는 인원만 (summaryById 의존 → base 이후 단계 적용, 순환 방지)
  const [reactionOnly, setReactionOnly] = useState(false);
  // 수신거부만 필터 — sms_opt_out_at 있는 카드만 (컴플라이언스 확인용, 카드 자체 속성이라 base 단계 적용)
  const [optOutOnly, setOptOutOnly] = useState(false);
  // 리스트 정렬 — '방치 오래된 순'이 적체 트리아지용 (last_message_at 없음 → 최상단)
  const [sortMode, setSortMode] = useState<"recent" | "oldest" | "active" | "neglected" | "applied_recent" | "applied_old" | "distance" | "reaction_recent">("recent");
  // 거리 기준 공고 — 선택 공고의 상차지·마지막경유지 중 가까운 쪽 기준 근거리순 정렬용. null이면 미선택.
  const [distanceJobId, setDistanceJobId] = useState<number | null>(null);
  // 상위 N명 선택 입력 (기본 50 = bulk-send 1회 상한과 동일)
  const [topN, setTopN] = useState(50);
  // 옹매니징 현재 활동 중 인원 id 집합 — 리스트 레벨 상시 배지/제외 필터용 (디바운스 조회)
  const [activeSet, setActiveSet] = useState<Set<number>>(new Set());
  // 지원자별 pool_events 반응 요약 — 반응 배지·'마지막 연락 N일 전' 배지·반응 필터/정렬의 근거 (디바운스 배치 조회)
  const [summaryById, setSummaryById] = useState<Record<number, PoolEventSummary>>({});
  // 벌크 발송 성공 후 요약 재조회 트리거 — 방금 나간 ping_sent가 '14일 제외' 필터에 바로 반영되게.
  const [summaryVersion, setSummaryVersion] = useState(0);
  // '공고 관심자 선택'으로 고른 공고 id — 대기 안내 프리셋 발송 시 purpose='waitlist'와 함께 서버로 전달.
  // 선택이 통째로 바뀌는 동선(필터 변경·상위 N·전체 토글 등)에서는 초기화(개별 해제는 유지).
  const [waitlistJobId, setWaitlistJobId] = useState<number | null>(null);
  const [interestPickLoading, setInterestPickLoading] = useState(false);

  // 거리 기준 공고 옵션 — 상차지(pickup) 또는 마지막 경유지(dropoff) 좌표가 있는 활성 공고. 둘 다 없으면 거리 계산 불가라 제외.
  const distanceJobs = useMemo(
    () =>
      visibleJobs.filter(
        (j) =>
          (typeof j.pickup_lat === "number" && typeof j.pickup_lng === "number") ||
          (typeof j.dropoff_lat === "number" && typeof j.dropoff_lng === "number")
      ),
    [visibleJobs]
  );
  // 선택된 거리 기준 공고 — 정렬은 그 공고가 정한 기준(distance_basis)을 그대로 따른다(lib/geo 단일 공식).
  // 예전엔 여기서 min(상차지, 경유지)를 하드코딩해, '집결지만' 기준 공고의 노출 대상과 정렬 순위가 어긋났다.
  const distanceJob = useMemo(() => {
    if (distanceJobId === null) return null;
    const j = distanceJobs.find((x) => x.id === distanceJobId);
    if (!j) return null;
    const geo: GeoJob = {
      pickup_lat: j.pickup_lat ?? null,
      pickup_lng: j.pickup_lng ?? null,
      dropoff_lat: j.dropoff_lat ?? null,
      dropoff_lng: j.dropoff_lng ?? null,
      distance_basis: j.distance_basis ?? null,
    };
    return jobAnchors(geo).length > 0 ? geo : null;
  }, [distanceJobId, distanceJobs]);

  // 조건·검색이 바뀌면 선택 해제 — 화면에서 사라진 인원에게 벌크 발송이 나가는 사고 방지.
  // 거리 기준 공고 변경도 정렬 순서를 바꿔 '상위 N'의 대상이 달라지므로 함께 초기화한다.
  // 지점 스코프(헤더)도 포함 — 스코프를 좁히면 표시 집합이 줄어드는데 선택만 남아 '80명 선택됨'이 거짓이 됐다.
  useEffect(() => {
    setSelectedRows(new Set());
    setWaitlistJobId(null);
  }, [channelFilter, vehicleFilter, slotFilter, statusFilter, availabilityFilter, regionFilter, showExcluded, recentAppliedOnly, geoConfirmedOnly, excludeActive, excludeRecentPing, reactionOnly, optOutOnly, sortMode, distanceJobId, query, scopeBranch]);

  // 저장된 대상 묶음(필터 조합 프리셋) — 브라우저(localStorage)에 저장. 자주 쓰는 필터를 1클릭 재적용.
  const [segments, setSegments] = useState<SavedSegment[]>([]);
  const [segNameDraft, setSegNameDraft] = useState("");
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SEGMENTS_KEY);
      if (raw) setSegments(JSON.parse(raw) as SavedSegment[]);
    } catch {
      /* 손상된 값이면 무시 */
    }
  }, []);
  const persistSegments = (next: SavedSegment[]) => {
    setSegments(next);
    try { localStorage.setItem(SEGMENTS_KEY, JSON.stringify(next)); } catch { /* 용량 초과 등 무시 */ }
  };
  const saveCurrentSegment = () => {
    const name = segNameDraft.trim();
    if (!name) return;
    const seg: SavedSegment = {
      id: `${Date.now()}`,
      name,
      channels: Array.from(channelFilter),
      vehicle: vehicleFilter,
      slots: Array.from(slotFilter),
      query: query.trim(),
      statuses: Array.from(statusFilter),
      availability: Array.from(availabilityFilter),
      region: regionFilter,
      excludeActive,
      excludeRecentPing,
      geoConfirmedOnly,
      recentAppliedOnly,
      reactionOnly,
      optOutOnly,
      showExcluded,
    };
    persistSegments([seg, ...segments.filter((s) => s.name !== name)]);
    setSegNameDraft("");
    toast.success(`대상 묶음 '${name}'을 저장했어요`);
  };
  const applySegment = (seg: SavedSegment) => {
    setChannelFilter(new Set(seg.channels));
    setVehicleFilter(seg.vehicle);
    // 예전 저장본은 라벨('평일 오전')이 들어 있다 — 공백을 지워 정규 키로 흡수한다(적용이 조용히 0명 되는 것 방지).
    setSlotFilter(new Set((seg.slots ?? []).map((v) => v.replace(/\s/g, ""))));
    setQuery(seg.query ?? "");
    setStatusFilter(new Set(seg.statuses ?? []));
    setAvailabilityFilter(new Set(seg.availability ?? []));
    setRegionFilter(seg.region ?? "all");
    setExcludeActive(seg.excludeActive ?? false);
    setExcludeRecentPing(seg.excludeRecentPing ?? false);
    setGeoConfirmedOnly(seg.geoConfirmedOnly ?? false);
    setRecentAppliedOnly(seg.recentAppliedOnly ?? false);
    setReactionOnly(seg.reactionOnly ?? false);
    setOptOutOnly(seg.optOutOnly ?? false);
    setShowExcluded(seg.showExcluded ?? false);
    toast.info(`'${seg.name}' 대상 묶음을 적용했어요`);
  };
  const deleteSegment = (id: string) => persistSegments(segments.filter((s) => s.id !== id));

  // Modals state
  const confirm = useConfirm();
  const [bulkMsgModalOpen, setBulkMsgModalOpen] = useState(false);
  // **발송 실패 명단** — 예전엔 "실패 N명"이 토스트로 4초 뜨고 사라져, 누가·왜 실패했는지 실무자가
  // 확인할 방법이 없었다(서버 로그를 열어야 했다). 565명 발송이 15~28분 걸리는데 그 정보가
  // 발송 순간에 사라지므로 나중에 만들 수 없다. 모달에 남기고 '실패한 N명만 다시 보내기'를 준다.
  const [bulkFailures, setBulkFailures] = useState<{ applicantId: number; name: string; phone: string; error: string }[]>([]);
  const [bulkStageModalOpen, setBulkStageModalOpen] = useState(false);
  const [bulkMsgBody, setBulkMsgBody] = useState(DEFAULT_BULK_BODY);
  const [bulkSending, setBulkSending] = useState(false);

  // 옹매니징 '현재 활동 중' 대조 — 벌크 문자 모달이 열릴 때 선택 인원을 1회 조회.
  // configured=false면 미연동(대조 불가, 발송은 허용), active[]는 현재 활동 중인 인원.
  type ActiveCheck = { configured: boolean; checked: number; active: { id: number; name: string; reasons: string[] }[]; unchecked?: number };
  const [activeCheck, setActiveCheck] = useState<ActiveCheck | null>(null);
  const [activeCheckLoading, setActiveCheckLoading] = useState(false);
  useEffect(() => {
    if (!bulkMsgModalOpen) { setActiveCheck(null); return; }
    const ids = Array.from(selectedRows).map(Number).filter((n) => Number.isFinite(n)).slice(0, 500);
    if (ids.length === 0) { setActiveCheck(null); return; }
    let cancelled = false;
    setActiveCheckLoading(true);
    setActiveCheck(null);
    fetch("/api/admin/ongmanaging/active-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicantIds: ids }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((json: ActiveCheck) => { if (!cancelled) setActiveCheck(json); })
      .catch(() => { /* 대조 실패는 발송을 막지 않음 — 서버가 최종 가드 */ })
      .finally(() => { if (!cancelled) setActiveCheckLoading(false); });
    return () => { cancelled = true; };
    // 모달이 열리는 시점의 선택 인원으로 1회만 조회 (열린 뒤 선택 변경은 없음)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkMsgModalOpen]);

  // 활동 중 인원 전원을 발송 대상(selectedRows)에서 제거 — 자동 아님, 매니저 판단으로 실행.
  const excludeActiveFromSelection = () => {
    if (!activeCheck || activeCheck.active.length === 0) return;
    const removeIds = new Set(activeCheck.active.map((a) => String(a.id)));
    setSelectedRows((prev) => new Set([...prev].filter((id) => !removeIds.has(id))));
    setActiveCheck((prev) => (prev ? { ...prev, active: [] } : prev));
    toast.success(`활동 중 ${removeIds.size}명을 발송 대상에서 제외했어요`);
  };

  // 대상 묶음 → 공고 후보 전환: 선택된 지원자를 공고 후보로 일괄 추가
  const [jobPickerOpen, setJobPickerOpen] = useState(false);
  const [addingJobId, setAddingJobId] = useState<number | null>(null);

  // J 타겟 노출 — 선택 인원을 여러 공고의 노출 대상(include/exclude)으로 한 번에 배정.
  // 후보 추가(job_candidates)와 별개 레이어: 노출은 '공고를 보여줄 사람'일 뿐 스크리닝 후보가 아니다.
  const [exposurePickerOpen, setExposurePickerOpen] = useState(false);
  const [exposureJobIds, setExposureJobIds] = useState<Set<number>>(new Set());
  const [exposureMode, setExposureMode] = useState<"include" | "exclude">("include");
  const [exposureSaving, setExposureSaving] = useState(false);
  // 전체 노출 공고를 '지정 노출'로 함께 전환할지 — 없으면 명단만 저장되고 아무 효력이 없다.
  // (예전엔 저장 뒤 토스트로만 알려주고, 매니저가 공고 수정 모달로 다시 들어가 노출 방식을 바꿔야 했다.)
  const [exposureMakeTargeted, setExposureMakeTargeted] = useState(true);
  // 저장된 자동 노출 규칙 처리 — **기본값 없음**(반드시 고르게 한다). 규칙 소거를 조용히 하지 않는다.
  const [exposureRuleAction, setExposureRuleAction] = useState<"keep" | "clear" | null>(null);

  // 공고별 노출 현황(현재 노출 방식·저장된 규칙·규칙 해당 인원·이미 연결된 인원) — 모달을 열 때 한 번 조회.
  // 특히 전체 노출 공고에 남아 있는 예전 규칙을 보여줘야 한다(전환만 하면 고르지 않은 인원에게도 보인다).
  const { data: exposureImpact, error: exposureImpactError, mutate: mutateExposureImpact } = useSWR<{
    total_pool: number;
    jobs: {
      id: number;
      title: string;
      exposure: "all" | "targeted";
      rule_conditions: number;
      rule_labels: string[];
      rule_matched: number;
      include_count: number;
      exclude_count: number;
      linked: number;
      /** false면 맞춤 공고 링크에 애초에 안 뜨는 공고(external) — 노출 명단이 효력을 갖지 않는다. */
      pull_exposed: boolean;
    }[];
  }>(
    exposurePickerOpen && activeJobs.length > 0
      ? `/api/admin/exposure/impact?job_ids=${activeJobs.map((j) => j.id).join(",")}`
      : null,
    { revalidateOnFocus: false }
  );
  const impactById = useMemo(
    () => new Map((exposureImpact?.jobs ?? []).map((j) => [j.id, j])),
    [exposureImpact]
  );

  // 모달을 열 때마다 공고 선택·선택지를 초기화 — 직전에 고른 공고가 남아 있으면 엉뚱한 공고에 적용된다.
  useEffect(() => {
    if (!exposurePickerOpen) return;
    setExposureJobIds(new Set());
    // 진입 버튼이 '이 명단에게만 노출'(추가)을 약속한다 — 직전에 쓴 '노출 제외'가 남아 있으면
    // 고른 명단이 그대로 제외되어 의도의 정반대가 된다(제외는 규칙·명단보다 우선).
    setExposureMode("include");
    setExposureMakeTargeted(true);
    setExposureRuleAction(null);
  }, [exposurePickerOpen]);

  const exposureSelectedJobs = activeJobs.filter((j) => exposureJobIds.has(j.id));
  // 현황을 아직 못 읽은 공고 — 규칙이 있는지 알 수 없으므로 적용을 막는다(서버도 400으로 막는다).
  const exposureUnknownJobs = exposureSelectedJobs.filter((j) => !impactById.has(j.id));
  // 전체 노출 → 지정 노출 전환 대상. 전환하면 '인재풀 전원'에게 보이던 공고가 명단에게만 보인다.
  // external(새로 모집)은 맞춤 공고 링크에 애초에 안 뜨므로 전환 대상이 아니다(명단도 효력 없음).
  const exposureFlipJobs = exposureSelectedJobs.filter((j) => {
    const im = impactById.get(j.id);
    return (im?.exposure ?? j.exposure) !== "targeted" && (im?.pull_exposed ?? true);
  });
  // 저장된 규칙이 있는 공고 — 규칙을 두면 '규칙 해당 인원 + 이 명단', 지우면 '이 명단만'.
  const exposureRuleJobs = exposureSelectedJobs.filter((j) => (impactById.get(j.id)?.rule_conditions ?? 0) > 0);
  const exposureWillFlip = exposureMode === "include" && exposureMakeTargeted && exposureFlipJobs.length > 0;
  const exposureWillClear = exposureMode === "include" && exposureRuleAction === "clear" && exposureRuleJobs.length > 0;
  // 노출이 좁아지는 공고에서 이미 연결된(관심·후보) 인원 — 이분들은 명단에 자동으로 남는다.
  // 공고별 합계라 한 분이 여러 공고에 연결되면 중복으로 세어진다 → 문구는 '명'이 아니라 '건'으로 쓴다.
  const exposureNarrowingIds = [
    ...new Set([
      ...(exposureWillFlip ? exposureFlipJobs.map((j) => j.id) : []),
      ...(exposureWillClear ? exposureRuleJobs.map((j) => j.id) : []),
    ]),
  ];
  const exposureLinkedProtected = exposureNarrowingIds.reduce(
    (n, id) => n + (impactById.get(id)?.linked ?? 0),
    0
  );

  // 지금 걸린 조건을 조건 바의 라벨 그대로 — 노출을 지정할 때 '어떤 조건으로 고른 명단인지'가
  // 명단 자체보다 중요하다(나중에 왜 이 사람들인지 되짚을 수 있어야 한다).
  const conditionLabels: string[] = [];
  // 지점 스코프는 '지점 없는 라인'(도시락 등)을 항상 함께 포함한다(matchesBranchScope) —
  // '지점 X'만 적으면 명단 절반 이상이 왜 들어왔는지 설명되지 않는다.
  if (scopeBranch) conditionLabels.push(`지점 ${scopeBranch}(지점 없는 분 포함)`);
  if (statusFilter.size > 0) conditionLabels.push(`진행 단계 ${[...statusFilter].join("·")}`);
  if (regionFilter !== "all") conditionLabels.push(regionFilter === "capital" ? "수도권(서울·경기·인천)" : "서울");
  if (vehicleFilter !== "all")
    conditionLabels.push(
      vehicleFilter === "vehicle" ? "차량 보유" : vehicleFilter === "walk" ? "도보" : "차량 미확인"
    );
  if (channelFilter.size > 0) conditionLabels.push(`지원 채널 ${[...channelFilter].join("·")}`);
  if (slotFilter.size > 0)
    conditionLabels.push(
      `희망 근무 ${[...slotFilter].map((k) => (k === SLOT_UNKNOWN ? "미확인" : SLOT_LABEL[k as SlotKey] ?? k)).join("·")}`
    );
  if (availabilityFilter.size > 0) conditionLabels.push(`가용성 ${[...availabilityFilter].join("·")}`);
  if (excludeActive) conditionLabels.push("이미 일하는 분 제외");
  if (excludeRecentPing) conditionLabels.push("최근 14일 캠페인 문자 보낸 분 제외");
  if (geoConfirmedOnly) conditionLabels.push("주소가 확인된 분만");
  if (recentAppliedOnly) conditionLabels.push("6개월 안에 지원한 분만");
  if (reactionOnly) conditionLabels.push("반응 있음(열람/관심/답장)");
  if (optOutOnly) conditionLabels.push("수신거부한 분만");
  if (showExcluded) conditionLabels.push("부적합·이탈·기타도 표시");
  if (query.trim()) conditionLabels.push(`검색 "${query.trim()}"`);

  const assignExposure = async () => {
    const applicantIds = Array.from(selectedRows).map(Number).filter((n) => Number.isFinite(n));
    const jobIds = Array.from(exposureJobIds);
    if (applicantIds.length === 0 || jobIds.length === 0 || exposureSaving) return;
    // 현황을 못 읽은 공고가 섞여 있으면 규칙 유무를 알 수 없다 — 서버가 400으로 막기 전에 여기서 멈춘다.
    if (exposureMode === "include" && exposureUnknownJobs.length > 0) {
      toast.error("공고 노출 현황을 아직 못 읽었어요 — 잠시 뒤 다시 시도해 주세요.");
      void mutateExposureImpact();
      return;
    }
    // 규칙이 있는 공고엔 2택을 반드시 고르게 한다(서버도 같은 가드 — code:'rule_action_required').
    if (exposureMode === "include" && exposureRuleJobs.length > 0 && exposureRuleAction === null) {
      toast.error("자동 노출 규칙이 있는 공고예요 — 규칙을 둘지 지울지 먼저 골라 주세요.");
      return;
    }
    // 대량 '노출 제외'도 노출을 끊는 조작이다 — 이야기 중인 분이 섞여 있으면 확인을 받는다
    // (명단 화면의 1건 제외에는 확인이 있는데 여기엔 없어, 더 큰 조작이 더 조용했다).
    if (exposureMode === "exclude") {
      const linkedTotal = exposureSelectedJobs.reduce((n, j) => n + (impactById.get(j.id)?.linked ?? 0), 0);
      const lines = [
        `고른 ${applicantIds.length}명을 공고 ${jobIds.length}개의 노출에서 제외합니다(제외는 규칙·명단보다 우선).`,
      ];
      if (linkedTotal > 0) {
        lines.push(
          `이 공고들엔 이미 연결된 분이 ${linkedTotal}건 있어요 — 그중 제외되는 분은 본인 화면에서 이 공고를 볼 수 없게 되고 AI 응대는 계속됩니다.`
        );
      }
      if (
        !(await confirm({
          title: "이 분들을 노출에서 제외할까요?",
          description: lines.join("\n"),
          confirmText: "제외",
          destructive: true,
        }))
      )
        return;
    }
    if (exposureWillFlip || exposureWillClear) {
      const lines: string[] = [];
      if (exposureWillFlip) {
        lines.push(
          `'지정 노출'로 전환: ${exposureFlipJobs.map((j) => j.title).join(" / ")}`,
          `→ 지금은 인재풀 전원(${exposureImpact?.total_pool ?? "?"}명)의 맞춤 공고 링크에 보여요. 전환하면 노출 명단에게만 보입니다.`
        );
      }
      // 규칙을 두는 선택이면 '명단에게만'이 아니다 — 규칙 해당 인원도 그대로 본다는 사실을 명시한다.
      if (exposureMode === "include" && exposureRuleAction === "keep" && exposureRuleJobs.length > 0) {
        lines.push(
          `자동 노출 규칙은 그대로 둡니다 — ${exposureRuleJobs
            .map((j) => `${j.title}(규칙 해당 ${impactById.get(j.id)?.rule_matched ?? 0}명)`)
            .join(" / ")}도 함께 보게 됩니다.`
        );
      }
      if (exposureWillClear) {
        lines.push(
          `자동 노출 규칙을 지웁니다(되돌릴 수 없어요):`,
          ...exposureRuleJobs.map(
            (j) =>
              `· ${j.title} — ${(impactById.get(j.id)?.rule_labels ?? []).join(" / ")} (해당 ${impactById.get(j.id)?.rule_matched ?? 0}명)`
          )
        );
      }
      if (exposureLinkedProtected > 0) {
        lines.push(
          exposureNarrowingIds.length === 1
            ? `이미 이 공고로 연결된 ${exposureLinkedProtected}명은 명단에 자동으로 남겨요 — 이야기 중인 공고가 본인 화면에서 사라지지 않게요(직접 제외해둔 분은 그대로 제외).`
            : `이미 연결된 ${exposureLinkedProtected}건(공고별 합계)은 명단에 자동으로 남겨요 — 이야기 중인 공고가 본인 화면에서 사라지지 않게요(직접 제외해둔 분은 그대로 제외).`
        );
      }
      lines.push(`노출 명단에 넣을 인원: 지금 고른 ${applicantIds.length}명`);
      if (
        !(await confirm({
          // 제목이 실제로 일어나는 일과 어긋나지 않게 3갈래로 나눈다.
          //  · 규칙을 두면 '명단에게만'이 아니다(규칙 해당 인원도 본다)
          //  · 전환을 안 하면 노출 범위는 그대로고 규칙만 지워진다
          title:
            exposureRuleAction === "keep" && exposureRuleJobs.length > 0
              ? "규칙 해당 인원 + 이 명단에게 보이도록 바꿀까요?"
              : exposureWillClear && !exposureWillFlip
                ? "자동 노출 규칙을 지울까요? (노출 방식은 그대로)"
                : "이 명단에게만 보이도록 바꿀까요?",
          description: lines.join("\n"),
          confirmText: "적용",
          destructive: true,
        }))
      )
        return;
    }
    setExposureSaving(true);
    try {
      const res = await fetch("/api/admin/exposure/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_ids: jobIds,
          applicant_ids: applicantIds,
          mode: exposureMode,
          ...(exposureMode === "include"
            ? {
                make_targeted: exposureMakeTargeted,
                // 화면이 '전체 노출'로 보여주고 확인까지 받은 공고만 전환 — 낡은 화면이 몰래 다른 공고를 좁히지 않게.
                flip_job_ids: exposureMakeTargeted ? exposureFlipJobs.map((j) => j.id) : [],
                ...(exposureRuleJobs.length > 0
                  ? {
                      rule_action: exposureRuleAction ?? "keep",
                      // 규칙 삭제는 되돌릴 수 없다 — 확인 창에 나열한 공고 스냅샷을 서버가 대조한다.
                      rule_jobs: exposureRuleJobs.map((j) => j.id),
                    }
                  : {}),
              }
            : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "노출 배정에 실패했어요");
        // 부분 적용(명단은 저장, 전환·규칙 삭제 실패) · 스냅샷 불일치 · 규칙 선택 필요 —
        // 모두 화면이 실제 상태를 다시 읽어야 매니저가 무엇을 고를지 볼 수 있다.
        if (json.partial || json.code === "rule_snapshot_stale" || json.code === "rule_action_required") {
          void mutateJobs();
          void mutateExposureImpact();
        }
        return;
      }
      const nonTargeted: number[] = json.non_targeted ?? [];
      const flipped: number[] = json.flipped ?? [];
      const cleared: number[] = json.rule_cleared ?? [];
      const skippedExternal: number[] = json.skipped_flip_external ?? [];
      const skippedNoGeo: number[] = json.skipped_flip_no_geo ?? [];
      toast.success(
        `${applicantIds.length}명을 공고 ${jobIds.length}개에 ${exposureMode === "include" ? "노출 대상으로 추가" : "노출 제외로 지정"}했어요` +
          (flipped.length > 0 ? ` · 공고 ${flipped.length}개를 '지정 노출'로 전환` : "") +
          (cleared.length > 0 ? ` · 규칙 ${cleared.length}개 삭제` : "") +
          (json.auto_included > 0 ? ` · 이미 연결된 ${json.auto_included}건 자동 포함` : "") +
          (skippedExternal.length > 0
            ? ` — ${skippedExternal.length}개 공고는 '새로 모집'이라 전환하지 않았어요(맞춤 공고 링크에 뜨지 않는 공고예요)`
            : "") +
          (skippedNoGeo.length > 0
            ? ` — ${skippedNoGeo.length}개 공고는 거리 반경 규칙이 있는데 집결지 좌표가 없어 전환하지 않았어요(공고 수정에서 주소를 먼저 저장하세요)`
            : "") +
          (nonTargeted.length > 0
            ? ` — ${nonTargeted.length}개 공고는 아직 '지정 노출'이 아니에요(공고 수정에서 전환 필요)`
            : "")
      );
      setExposurePickerOpen(false);
      setExposureJobIds(new Set());
      // 전환·규칙 삭제로 공고 상태가 바뀌었으니 목록·현황을 다시 읽는다(다음에 열 때 옛 배지가 보이지 않게).
      void mutateJobs();
      void mutateExposureImpact();
    } finally {
      setExposureSaving(false);
    }
  };

  const addSelectedToJob = async (jobId: number) => {
    const ids = Array.from(selectedRows).map(Number).filter((n) => Number.isFinite(n));
    if (ids.length === 0) return;
    setAddingJobId(jobId);
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicant_ids: ids }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "공고 후보 추가에 실패했어요");
        // partial = 후보는 이미 추가됨(뒤 단계만 실패) — 모달을 닫고 목록을 맞춰 재시도 오해를 없앤다.
        if (json.partial) {
          setJobPickerOpen(false);
          loadApplicants();
        }
        return;
      }
      toast.success(`${json.added ?? ids.length}명을 공고 후보로 추가했어요. (이미 추가된 인원은 제외)`);
      setJobPickerOpen(false);
      setSelectedRows(new Set());
      setWaitlistJobId(null);
    } catch {
      toast.error("공고 후보 추가에 실패했어요");
    } finally {
      setAddingJobId(null);
    }
  };

  const allCards = columns.flatMap(c => c.cards.map(card => ({ ...card, stage: c.title, stageColor: c.color, stageId: c.id })));

  // 칸반 컬럼에 매핑되지 않는 status(부적합/이탈/기타) — 리스트 뷰 '제외 인원 표시' 토글 전용.
  // 벌크 부적합 처리의 실수 복구·재검토 동선 확보 (기존엔 화면에서 완전히 사라졌음).
  const excludedCards = rawApplicants
    .filter((a) => !STATUS_TO_COLUMN[a.status])
    .map((a) => ({ ...toCard(a), stage: a.status, stageColor: "bg-gray-400", stageId: "excluded" }));

  // 부적합·이탈 표시는 뷰와 무관하게 반영한다 — 리스트·지도가 같은 모집단을 쓰게(칸반엔 해당 컬럼이 없어 영향 없음).
  const listCards = showExcluded ? [...allCards, ...excludedCards] : allCards;

  // 선택 인원 중 수신거부(sms_opt_out_at) 수 — 벌크 문자 모달 경고용(서버가 발송 시 자동 제외)
  const selectedOptOutCount = listCards.filter((c) => selectedRows.has(c.id) && c.smsOptOutAt).length;
  // 선택 인원 중 이미 확정된 사람 — 서버는 막지 않는다(운행이 중단됐다가 재확정되는 케이스가 실제로 있어
  // '다른 라인 안내'가 정당한 발송일 수 있다). 다만 모르고 보내면 안 되므로 모달에서 수를 알려준다.
  const selectedConfirmedCount = listCards.filter((c) => selectedRows.has(c.id) && c.status === "확정인력").length;

  // 템플릿↔대상 정합성 — B안(최근 6개월용)을 골랐는데 선택 대상에 원지원 6개월 초과자가 섞였으면 경고(발송은 막지 않음).
  const bBodySelected = bulkMsgBody.trim() === RECONTACT_B_BODY.trim();
  const bCohortMismatchCount = bBodySelected
    ? listCards.filter((c) => {
        if (!selectedRows.has(c.id)) return false;
        // appliedAtIso가 없으면(원지원일 미상) 최신 코호트로 볼 수 없어 초과 취급.
        if (!c.appliedAtIso) return true;
        return Date.now() - new Date(c.appliedAtIso).getTime() > SIX_MONTHS_MS;
      }).length
    : 0;

  const availableChannels = Array.from(new Set(allCards.map((c) => c.channel))).sort();

  const STATUS_TOKENS = ["스크리닝 전", "대기자", "스크리닝 중", "스크리닝 완료", "확정인력"];
  const EXCLUDED_STATUS_TOKENS = ["부적합", "이탈", "기타"];
  const AVAILABILITY_TOKENS = ["즉시가능", "이번주가능", "휴면", "미확인"];

  const toggleSetValue = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, value: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  // 조건 바의 묶음별 개수 — 트리거 배지에 그대로 쓴다.
  // '발송 준비' = 문자 보내기 전에 대상을 빼는 조건 / '조건 더보기' = 접혀 있는 나머지 조건.
  const sendPrepCount =
    (excludeActive ? 1 : 0) + (excludeRecentPing ? 1 : 0) + (geoConfirmedOnly ? 1 : 0) + (recentAppliedOnly ? 1 : 0);
  // showExcluded(부적합·이탈 표시)도 목록 구성을 바꾸는 조건이라 개수·초기화에 포함한다
  // (예전엔 개수에서 빠지고 '초기화'로도 안 꺼져서, 부적합이 섞여 보이는데 '조건 0개'로 표시됐다).
  const moreFilterCount =
    channelFilter.size + slotFilter.size + availabilityFilter.size +
    (reactionOnly ? 1 : 0) + (optOutOnly ? 1 : 0) + (showExcluded ? 1 : 0);
  const activeFilterCount =
    statusFilter.size + (vehicleFilter !== "all" ? 1 : 0) + (regionFilter !== "all" ? 1 : 0) +
    sendPrepCount + moreFilterCount;

  const resetFilters = () => {
    setChannelFilter(new Set());
    setVehicleFilter("all");
    setSlotFilter(new Set());
    setStatusFilter(new Set());
    setAvailabilityFilter(new Set());
    setRegionFilter("all");
    setRecentAppliedOnly(false);
    setGeoConfirmedOnly(false);
    setExcludeActive(false);
    setExcludeRecentPing(false);
    setReactionOnly(false);
    setOptOutOnly(false);
    setShowExcluded(false);
  };

  // 활동중·최근연락·반응 조회가 필요한 때 — 리스트는 배지에 쓰고, 다른 뷰에서도 그 조건을 켰으면 실제로 걸리게 조회한다.
  // (옹매니징 외부 DB 호출이라 필요 없을 때는 돌리지 않는다. 단계별 현황 뷰는 별도 API라 제외.)
  // 활동중 조회(옹매니징 외부 DB)는 '이미 일하는 분 제외'를 켠 때만 — 행 배지가 없어져 다른 소비처가 없다.
  const needsActiveCheck = view !== "funnel" && excludeActive;
  // 반응 요약은 리스트 배지(반응 신호)에 상시 쓰고, 다른 뷰에서는 관련 조건을 켰을 때만.
  const needsSummary = view === "list" || (view !== "funnel" && (excludeRecentPing || reactionOnly));

  const q = query.trim().toLowerCase();
  const sixMonthsAgo = Date.now() - SIX_MONTHS_MS;
  // 활동중 제외를 뺀 '기준' 필터 — active-check 입력을 이 집합으로 잡아야 activeSet↔filteredCards 순환(무한 재조회)을 피한다.
  const baseFilteredCards = listCards.filter((c) => {
    if (!matchesBranchScope(c.branch, scopeBranch)) return false;
    if (q && ![c.name, c.phone ?? "", c.branch, c.region, c.channel, c.tag].some((v) => v.toLowerCase().includes(q))) return false;
    if (channelFilter.size && !channelFilter.has(c.channel)) return false;
    if (vehicleFilter === "vehicle" && c.vehicleClass !== "확정") return false;
    if (vehicleFilter === "walk" && c.vehicleClass !== "도보") return false;
    if (vehicleFilter === "unknown" && c.vehicleClass !== "미확인") return false;
    // 정규 키 비교 — 라벨('평일 오전')이 아니라 키('평일오전')로 판정한다(노출 규칙과 동일 집합).
    if (slotFilter.size) {
      // 판정된 슬롯이 없는 분(미확인)은 4칩으로는 절대 안 걸린다 — '미확인' 칩으로만 고를 수 있다.
      const hit = c.slotKeys.length
        ? c.slotKeys.some((k) => slotFilter.has(k))
        : slotFilter.has(SLOT_UNKNOWN);
      if (!hit) return false;
    }
    if (statusFilter.size && !statusFilter.has(c.status)) return false;
    if (availabilityFilter.size && !availabilityFilter.has(c.availability ?? "미확인")) return false;
    if (regionFilter === "capital" && !isCapitalArea(c.sido)) return false;
    if (regionFilter === "seoul" && !isSeoul(c.sido)) return false;
    if (recentAppliedOnly && !(c.appliedAtIso && new Date(c.appliedAtIso).getTime() >= sixMonthsAgo)) return false;
    if (geoConfirmedOnly && !(c.geoPrecision === "exact" || c.geoPrecision === "approx")) return false;
    // 수신거부만 — 카드 자체 속성이라 base 단계 적용 가능(조회 입력 순환 없음)
    if (optOutOnly && !c.smsOptOutAt) return false;
    return true;
  });
  // active-check·last-ping 입력 — 활동중/재컨택 제외 필터와 무관한 기준 집합으로 잡아 순환(무한 재조회)을 방지.
  const visibleIdsKey = baseFilteredCards.slice(0, 500).map((c) => c.id).join(",");
  // 활동중 제외 + 최근 14일 재컨택 제외 + 반응 있음을 순차 적용 — 셋 다 조회 결과(activeSet/summaryById)에
  // 의존하므로 baseFilteredCards 이후 단계여야 조회 입력(visibleIdsKey) 순환이 없다.
  const pingCutoff = Date.now() - FOURTEEN_DAYS_MS;
  const postFilteredCards = baseFilteredCards.filter((c) => {
    if (excludeActive && activeSet.has(Number(c.id))) return false;
    const summary = summaryById[Number(c.id)];
    if (excludeRecentPing) {
      const last = summary?.last_ping_at;
      if (last && new Date(last).getTime() >= pingCutoff) return false;
    }
    if (reactionOnly && lastReactionAt(summary) === null) return false;
    return true;
  });
  // 카드별 거리(km) — 정렬 키는 공고가 정한 기준(distance_basis)의 distanceToJobKm.
  //   distDetailByCardId: 배지용 개별 거리(집결지·경유지 각각, 있는 것만) — 정렬 근거를 눈으로 확인하는 용도.
  const distByCardId: Record<string, number> = {};
  const distDetailByCardId: Record<string, { pickup: number | null; dropoff: number | null }> = {};
  if (sortMode === "distance" && distanceJob) {
    for (const c of postFilteredCards) {
      if (typeof c.lat !== "number" || typeof c.lng !== "number") continue;
      const km = distanceToJobKm({ lat: c.lat, lng: c.lng }, distanceJob);
      if (km === null) continue;
      distByCardId[c.id] = km;
      const pickup =
        typeof distanceJob.pickup_lat === "number" && typeof distanceJob.pickup_lng === "number"
          ? distKm(c.lat, c.lng, distanceJob.pickup_lat, distanceJob.pickup_lng)
          : null;
      const dropoff =
        typeof distanceJob.dropoff_lat === "number" && typeof distanceJob.dropoff_lng === "number"
          ? distKm(c.lat, c.lng, distanceJob.dropoff_lat, distanceJob.dropoff_lng)
          : null;
      distDetailByCardId[c.id] = { pickup, dropoff };
    }
  }
  const filteredCards = postFilteredCards.sort((a, b) => {
    const created = (c: typeof a) => (c.createdAtIso ? new Date(c.createdAtIso).getTime() : 0);
    const lastMsg = (c: typeof a) => (c.lastMessageAtIso ? new Date(c.lastMessageAtIso).getTime() : 0);
    // 원지원일 정렬 — null은 항상 뒤로 밀어 코호트 상단이 유효값으로 채워지게.
    const applied = (c: typeof a) => (c.appliedAtIso ? new Date(c.appliedAtIso).getTime() : null);
    switch (sortMode) {
      case "distance": {                                             // 근거리순 = min(상차지, 마지막경유지) (좌표 없음/공고 미선택은 뒤)
        const av = distByCardId[a.id], bv = distByCardId[b.id];
        const aok = av !== undefined, bok = bv !== undefined;
        if (!aok && !bok) return 0;
        if (!aok) return 1;
        if (!bok) return -1;
        return av - bv;
      }
      case "oldest": return created(a) - created(b);
      case "active": return lastMsg(b) - lastMsg(a);                 // 최근 활동순 (무활동은 뒤)
      case "neglected": return lastMsg(a) - lastMsg(b);              // 방치 오래된 순 (무활동=0 → 최상단)
      case "applied_recent": {                                       // 원지원 최신순 (null은 뒤)
        const av = applied(a), bv = applied(b);
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return bv - av;
      }
      case "applied_old": {                                          // 원지원 오래된순 (null은 뒤)
        const av = applied(a), bv = applied(b);
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return av - bv;
      }
      case "reaction_recent": {                                      // 반응 최신순 = max(열람, 관심, 답장) desc (반응 없음은 뒤)
        const av = lastReactionAt(summaryById[Number(a.id)]);
        const bv = lastReactionAt(summaryById[Number(b.id)]);
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return bv - av;
      }
      default: return created(b) - created(a);                       // 최근 등록순 (API 기본 순서와 동일)
    }
  });

  // 조건을 통과한 카드 id — 칸반 컬럼·지도가 리스트와 같은 모집단을 쓰게 한다(정렬 전 집합이라 순서 무관).
  const filteredIdSet = new Set(postFilteredCards.map((c) => c.id));

  // 칸반 표시용 컬럼 — 조건 결과(filteredIdSet)에 든 카드만. 컬럼 카운트도 함께 줄어든다.
  const kanbanColumns = columns.map((col) => {
    const cards = col.cards.filter((c) => filteredIdSet.has(c.id));
    return { ...col, cards, count: cards.length };
  });

  // 조건 바 '표시 N명' — 뷰에 실제로 보이는 수. 칸반은 부적합·이탈 컬럼이 없어 컬럼 합계로 센다.
  const visibleCards = filteredCards.slice(0, visibleCount);
  const hiddenCount = filteredCards.length - visibleCards.length;
  // 조건·검색·정렬이 바뀌면 처음 분량으로 되돌린다(좁혀 놓고 아래를 계속 붙이는 건 의미가 없다).
  const filterSignature = `${filteredCards.length}:${filteredCards[0]?.id ?? ""}:${sortMode}`;
  useEffect(() => {
    setVisibleCount(ROWS_PER_CHUNK);
  }, [filterSignature]);
  // 목록 끝이 화면에 들어오면 다음 분량을 붙인다.
  useEffect(() => {
    const el = moreRef.current;
    if (!el || hiddenCount <= 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisibleCount((v) => v + ROWS_PER_CHUNK);
      },
      { rootMargin: "400px" } // 끝에 닿기 전에 미리 붙여 끊김을 없앤다
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hiddenCount, visibleCount]);

  const shownCount = view === "kanban" ? kanbanColumns.reduce((n, c) => n + c.count, 0) : filteredCards.length;

  // 발송 가능 인원 수 — 조건 바 카운트("발송가능 N / 표시 M")
  const sendableCount = filteredCards.filter((c) => sendableOf(c).sendable).length;

  // 선택 인원 중 지금 조건 밖에 있는 수 — 노출 지정 모달이 '조건으로 고른 명단'이라고 말할 때
  // 실제로는 직접 고른 사람이 섞였을 수 있다는 사실을 숨기지 않기 위해.
  const selectedOutsideCondition = [...selectedRows].filter((id) => !filteredIdSet.has(id)).length;

  // 발송 모달 실제 수신 대상 — 화면 표시(filteredCards) ∩ 선택 ∩ 연락처 보유. handleBulkSend의 발송 대상과 동일 기준.
  // selectedRows.size 그대로 쓰면 필터로 화면에서 빠진 인원까지 세어 인원·비용이 부풀려진다.
  const modalRecipientCount = filteredCards.filter((c) => selectedRows.has(c.id) && c.phone).length;
  const modalExcludedCount = selectedRows.size - modalRecipientCount;

  // 리스트 레벨 옹매니징 활동중 조회 — 기준 집합 id(최대 500)로 디바운스(~400ms) 1회 조회.
  // 발송 모달 로직과 별개(중복 조회 허용). 실패는 조용히 무시(서버가 최종 가드).
  useEffect(() => {
    if (!needsActiveCheck) { setActiveSet(new Set()); return; }
    const ids = visibleIdsKey ? visibleIdsKey.split(",").map(Number).filter((n) => Number.isFinite(n)) : [];
    if (ids.length === 0) { setActiveSet(new Set()); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch("/api/admin/ongmanaging/active-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicantIds: ids }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((json: ActiveCheck) => {
          if (cancelled) return;
          if (json.configured) setActiveSet(new Set(json.active.map((a) => a.id)));
          else setActiveSet(new Set());
        })
        .catch(() => { /* 대조 실패는 표시/발송을 막지 않음 */ });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey, needsActiveCheck]);

  // 리스트 레벨 pool_events 반응 요약 조회 — 기준 집합 id(최대 500)로 디바운스(~400ms) 1회 조회.
  // '마지막 연락 N일 전'·반응 배지와 '최근 14일 다시 연락 제외'·'반응 있음' 필터, '반응 최신순' 정렬의 근거.
  // 실패는 조용히 무시(배지/필터는 부가정보). summaryVersion은 벌크 발송 직후 재조회 트리거.
  useEffect(() => {
    if (!needsSummary) return;
    const ids = visibleIdsKey ? visibleIdsKey.split(",").map(Number).filter((n) => Number.isFinite(n)) : [];
    if (ids.length === 0) { setSummaryById({}); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch("/api/admin/pool-events/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicantIds: ids }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((json: { summaryById?: Record<number, PoolEventSummary> }) => {
          if (!cancelled) setSummaryById(json.summaryById ?? {});
        })
        .catch(() => { /* 배지/제외는 부가정보 — 실패해도 리스트는 보여준다 */ });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey, needsSummary, summaryVersion]);

  // 지도 뷰용 — 리스트와 **같은 조건 결과**를 쓴다(예전엔 지점 스코프·검색만 걸려, 조건을 걸어도 지도는 그대로였다).
  const mapApplicants: MapApplicant[] = rawApplicants
    .filter((a) => {
      if (!filteredIdSet.has(String(a.id))) return false;
      const branch = a.confirmed_branch?.trim() || a.branch1?.trim() || a.branch?.trim() || "";
      if (!matchesBranchScope(branch, scopeBranch)) return false;
      if (q && ![a.name ?? "", a.phone ?? "", a.sigungu ?? "", a.location ?? ""].some((v) => v.toLowerCase().includes(q))) return false;
      return true;
    })
    .map((a) => ({
      id: a.id, name: a.name, lat: a.lat, lng: a.lng,
      sigungu: a.sigungu, sido: a.sido, geo_precision: a.geo_precision, status: a.status,
    }));

  const exportCardsCsv = (cards: CardData[], stageOf: (c: CardData) => string, fileLabel: string) => {
    if (cards.length === 0) return toast.error("내보낼 지원자가 없어요.");
    const headers = ["ID", "이름", "나이", "진행단계", "지원채널", "근무지", "희망근무", "차량", "지역", "연락처", "최근활동"];
    const rows = cards.map((c) => [
      c.id, c.name, c.age, stageOf(c), c.channel, c.branch, c.slot, c.tag, c.region, c.phone ?? "", c.lastActive,
    ]);
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileLabel}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${cards.length}명을 CSV로 내보냈어요.`);
  };

  const exportCsv = () => exportCardsCsv(filteredCards, (c) => (c as CardData & { stage?: string }).stage ?? "", "지원자");

  const handleColumnExport = (column: ColumnData) => exportCardsCsv(column.cards, () => column.title, column.title);

  const handleColumnBulkMessage = (column: ColumnData) => {
    if (column.cards.length === 0) return toast.error("이 단계에 지원자가 없어요.");
    setSelectedRows(new Set(column.cards.map((c) => c.id)));
    setWaitlistJobId(null);
    setBulkFailures([]);
    setBulkMsgModalOpen(true);
  };

  const moveCard = (cardId: string, sourceColId: string, destColId: string) => {
    if (sourceColId === destColId) return;

    // 확정은 드래그로 처리하지 않는다 — status만 바뀌면 공고 미결속·AI 미정지의 '반쪽 확정'이 된다.
    // 상세 패널을 열어 정식 확정 모달(대상 공고·시작일·지점)로 유도한다(단일 경로 수렴).
    if (COLUMN_TO_STATUS[destColId] === "확정인력") {
      openApplicant(Number(cardId));
      toast.info("확정은 상세에서 대상 공고를 지정해 완료해요 — 상세 패널을 열었어요.");
      return;
    }

    setColumns(prev => {
      const sourceCol = prev.find(col => col.id === sourceColId);
      const destCol = prev.find(col => col.id === destColId);
      if (!sourceCol || !destCol) return prev;

      const cardToMove = sourceCol.cards.find(c => c.id === cardId);
      if (!cardToMove) return prev;

      const newColumns = prev.map(col => {
        if (col.id === sourceColId) return { ...col, cards: col.cards.filter(c => c.id !== cardId), count: col.count - 1 };
        if (col.id === destColId) return { ...col, cards: [cardToMove, ...col.cards], count: col.count + 1 };
        return col;
      });

      setTimeout(() => {
        toast.success(`${cardToMove.name}님의 상태가 [${destCol.title}]로 변경되었습니다.`);
      }, 100);

      return newColumns;
    });

    const newStatus = COLUMN_TO_STATUS[destColId];
    if (newStatus) {
      fetch(`/api/admin/applicants/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      })
        .then((r) => {
          if (!r.ok) {
            toast.error("상태 변경 저장에 실패했어요");
            loadApplicants();
            return;
          }
          // 진행 단계 조건이 걸려 있으면 옮긴 카드가 조건에서 빠진다 — 60초 뒤 조용히 사라지지 않게
          // 곧바로 재동기화하고 왜 사라지는지 알려준다.
          if (statusFilter.size > 0 && !statusFilter.has(newStatus)) {
            toast.info("지금 걸린 '진행 단계' 조건에서 빠져 보드에서 사라져요 — 조건을 풀면 다시 보여요.");
          }
          loadApplicants();
        })
        .catch(() => {
          toast.error("상태 변경 저장에 실패했어요");
          loadApplicants();
        });
    }
  };

  const toggleRow = (id: string) => {
    const newSet = new Set(selectedRows);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedRows(newSet);
  };

  const toggleAll = () => {
    if (selectedRows.size === filteredCards.length) setSelectedRows(new Set());
    else setSelectedRows(new Set(filteredCards.map(c => c.id)));
    setWaitlistJobId(null);
  };

  // 현재 정렬 순서 상단에서 '발송 가능한' N명만 골라 선택 — 재컨택 배치 발송 진입 단축.
  const selectTopN = () => {
    const n = Math.max(1, Math.floor(topN) || 0);
    const ids = filteredCards.filter((c) => sendableOf(c).sendable).slice(0, n).map((c) => c.id);
    if (ids.length === 0) return toast.error("발송 가능한 인원이 없어요.");
    setSelectedRows(new Set(ids));
    setWaitlistJobId(null);
    toast.success(`발송 가능한 상위 ${ids.length}명을 선택했어요.`);
  };

  // 공고 관심자 원클릭 선택 — 해당 공고에 interest_click을 남긴 지원자 중 확정인력을 제외하고
  // 현재 화면(filteredCards)에 있는 인원만 선택. '관심 대기 안내' 사후관리 발송의 진입 동선.
  const selectJobInterested = async (jobId: number) => {
    if (interestPickLoading) return;
    setInterestPickLoading(true);
    try {
      const res = await fetch(`/api/admin/pool-events/interested?job_id=${jobId}`);
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error || "관심자 조회에 실패했어요");
        return;
      }
      const interestedIds: number[] = Array.isArray(json?.applicantIds) ? json.applicantIds : [];
      if (interestedIds.length === 0) return toast.info("이 공고에 관심을 표시한 인원이 아직 없어요.");
      const interestedSet = new Set(interestedIds.map(String));
      // 확정인력은 이미 배정 판단이 끝난 인원 — 대기 안내 대상에서 제외.
      const eligible = filteredCards.filter((c) => interestedSet.has(c.id) && c.status !== "확정인력");
      if (eligible.length === 0) {
        return toast.info(`관심자 ${interestedIds.length}명이 모두 확정인력이거나 지금 조건 밖이에요.`);
      }
      setSelectedRows(new Set(eligible.map((c) => c.id)));
      setWaitlistJobId(jobId);
      const excluded = interestedIds.length - eligible.length;
      toast.success(
        `공고 관심자 ${eligible.length}명을 선택했어요. 이전 선택은 해제됐어요.${excluded > 0 ? ` (확정인력·조건 제외 ${excluded}명)` : ""}`
      );
    } catch {
      toast.error("관심자 조회에 실패했어요");
    } finally {
      setInterestPickLoading(false);
    }
  };

  const handleBulkStageChange = async (stageName: string) => {
    setBulkStageModalOpen(false);
    const status = BULK_LABEL_TO_STATUS[stageName];
    const ids = Array.from(selectedRows);
    if (!status || ids.length === 0) {
      setSelectedRows(new Set());
      return;
    }

    // 벌크 전용 API — 단일 쿼리 갱신 + 부수효과(hired_at/churned_at/confirmed_branch) 서버 보장.
    // API 상한(500건/호출)에 맞춰 나눠 호출하고 합산 리포트.
    let requested = 0;
    let updated = 0;
    let apiError: string | null = null;
    try {
      for (let i = 0; i < ids.length; i += 500) {
        const res = await fetch("/api/admin/applicants/bulk-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: ids.slice(i, i + 500).map(Number), status }),
        });
        const json = await res.json().catch(() => null);
        if (res.ok && json?.success) {
          requested += json.requested as number;
          updated += json.updated as number;
        } else {
          apiError = json?.error || "일괄 상태 변경에 실패했어요";
          requested += ids.slice(i, i + 500).length;
        }
      }
    } catch {
      apiError = "일괄 상태 변경에 실패했어요";
    }

    if (!apiError && updated === requested) {
      toast.success(`선택한 ${updated}명의 지원자가 [${stageName}] 단계로 일괄 이동되었습니다.`);
    } else if (updated > 0) {
      toast.error(`일괄 이동 결과: ${updated}건 성공, ${requested - updated}건 실패했어요`);
    } else {
      toast.error(apiError ?? "일괄 상태 변경에 실패했어요");
    }

    // 성공/실패와 무관하게 서버 상태 기준으로 목록 재동기화 (칸반 드래그 롤백 패턴과 동일)
    loadApplicants();
    setSelectedRows(new Set());
    setWaitlistJobId(null);
  };

  const handleBulkSend = async () => {
    if (bulkSending) return;
    const text = bulkMsgBody.trim();
    if (!text) return toast.error("메시지 내용을 입력해주세요.");

    // 발송 대상 = 현재 화면 표시분(filteredCards)과 선택의 교집합 — 화면에 없는 인원 오발송 방지.
    const selected = filteredCards.filter((c) => selectedRows.has(c.id) && c.phone);
    const recipients = selected.map((c) => ({
      phone: c.phone as string,
      applicant_id: Number(c.id),
    }));
    // 실패 명단에 이름을 붙이기 위한 조회표(전화번호 → 이름) — 서버 결과는 phone만 돌려준다.
    const nameByPhone = new Map<string, string>(selected.map((c) => [String(c.phone), c.name]));
    if (recipients.length === 0) return toast.error("발송 가능한 연락처가 없어요.");

    // 대기 안내 프리셋이면 purpose='waitlist'(+ 공고 관심자 선택으로 고른 공고 id)를 실어 발송 이력을 남긴다.
    const isWaitlist = text === WAITLIST_BODY.trim();
    // 비용은 치환자 원문이 아닌 대표 샘플 치환 후 기준 — SMS/LMS 판정 오차 방지.
    const est = estimateSmsCost(fillSampleVars(text));
    const night = isNightKstNow();
    if (!(await confirm({
      title: `${recipients.length}명에게 문자를 발송할까요?`,
      description:
        `실제 SMS가 즉시 발송됩니다. 되돌릴 수 없어요.\n예상 비용: ${est.sms_type} · 약 ${(est.cost_krw * recipients.length).toLocaleString()}원 (1인 ${est.cost_krw}원 × ${recipients.length}명)` +
        (night ? "\n\n⚠️ 지금은 심야(21~08시)예요. 시니어 대상 심야 문자는 민원이 되기 쉬워요 — 급하지 않으면 아침 9시 이후에 보내는 걸 권합니다." : ""),
      confirmText: `${recipients.length}명 발송`,
    }))) return;

    setBulkSending(true);
    try {
      let sent = 0;
      const failErrors: string[] = [];
      const failedRows: { applicantId: number; name: string; phone: string; error: string }[] = [];
      // 청크 실패 집계 — 실패한 청크 대상 인원 수(chunkFailed)로 부분 발송을 가시화.
      let chunkFailed = 0;
      let chunkErrorMsg: string | null = null;
      // bulk-send 엔드포인트는 1회 최대 50명 → 50명씩 끊어서 발송.
      // 한 청크가 실패해도 return하지 않고 continue로 나머지 청크를 계속 발송한다
      // (재시도 시 이미 나간 앞 청크의 재발송 위험 회피 — 서버 10분 중복 가드와 별개).
      for (let i = 0; i < recipients.length; i += 50) {
        const chunk = recipients.slice(i, i + 50);
        let res: Response;
        try {
          res = await fetch("/api/admin/messages/bulk-send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipients: chunk,
              body: text,
              ...(isWaitlist
                ? { purpose: "waitlist", ...(waitlistJobId !== null ? { job_id: waitlistJobId } : {}) }
                : {}),
            }),
          });
        } catch {
          chunkFailed += chunk.length;
          chunkErrorMsg = chunkErrorMsg ?? "네트워크 오류";
          for (const c of chunk) {
            failedRows.push({
              applicantId: c.applicant_id,
              name: nameByPhone.get(String(c.phone)) || "이름 미상",
              phone: String(c.phone),
              error: "미시도 — 네트워크 오류",
            });
          }
          continue;
        }
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          chunkFailed += chunk.length;
          const why = json?.error || "발송 실패";
          chunkErrorMsg = chunkErrorMsg ?? why;
          for (const c of chunk) {
            failedRows.push({
              applicantId: c.applicant_id,
              name: nameByPhone.get(String(c.phone)) || "이름 미상",
              phone: String(c.phone),
              error: `미시도 — ${why}`,
            });
          }
          continue;
        }
        sent += json.sent ?? 0;
        for (const r of (json.results ?? []) as Array<{ success: boolean; error?: string; phone?: string; applicant_id?: number }>) {
          if (r.success) continue;
          failErrors.push(r.error ?? "");
          const phone = String(r.phone ?? "");
          failedRows.push({
            applicantId: typeof r.applicant_id === "number" ? r.applicant_id : 0,
            name: nameByPhone.get(phone) || "이름 미상",
            phone,
            error: r.error ?? "사유 미기록",
          });
        }
      }
      // 서버 results[].error 집계 — 수신거부/인력풀 제외/중복/링크토큰 없음은 '실패'가 아니라 의도된 제외로 구분 표기
      const optOut = failErrors.filter((e) => e.includes("수신거부")).length;
      const poolExcluded = failErrors.filter((e) => e.includes("인력풀 제외")).length;
      const recentDup = failErrors.filter((e) => e.includes("중복 방지")).length;
      const noToken = failErrors.filter((e) => e.includes("토큰 없음")).length;
      const failed = failErrors.length - optOut - poolExcluded - recentDup - noToken;
      const skipped = selectedRows.size - recipients.length;
      const parts = [`${sent}명 발송`];
      if (optOut) parts.push(`수신거부 ${optOut}명 제외`);
      if (poolExcluded) parts.push(`인력풀 제외 ${poolExcluded}명`);
      if (recentDup) parts.push(`중복 방지 ${recentDup}명`);
      if (noToken) parts.push(`맞춤 공고 링크 없음 ${noToken}명 제외`);
      if (skipped) parts.push(`연락처 없음 ${skipped}명 제외`);
      if (failed) parts.push(`실패 ${failed}명`);
      // 청크 단위 실패는 개별 결과가 없어 대상 인원 수를 '미시도'로 별도 표기(부분 발송 가시화).
      if (chunkFailed) parts.push(`미시도 ${chunkFailed}명${chunkErrorMsg ? ` (${chunkErrorMsg})` : ""}`);
      // 하나라도 나갔으면 성공 토스트(부분 발송이라도 진행분을 인지), 전부 실패면 에러 토스트.
      (sent > 0 ? toast.success : toast.error)(parts.join(" · "));
      if (sent > 0) {
        // 방금 나간 ping_sent가 배지·'14일 제외' 필터에 바로 반영되게 요약 재조회.
        setSummaryVersion((v) => v + 1);
        // '14일 제외'가 꺼져 있으면 켜기를 제안 — 자동으로 켜지 않고 매니저가 결정(액션 버튼).
        if (!excludeRecentPing) {
          toast.info("방금 발송한 인원이 리스트에 그대로 남아 있어요. 같은 사람에게 또 보내지 않으려면 '최근 14일 다시 연락 제외'를 켜세요.", {
            action: { label: "14일 제외 켜기", onClick: () => setExcludeRecentPing(true) },
          });
        }
      }
      // 실패·미시도가 하나라도 있으면 **명단을 모달에 남기고 창을 닫지 않는다.**
      // 예전엔 전량 실패 시 창이 닫히며 골라둔 명단까지 초기화됐다(가장 있을 법한 대량 실패가
      // 문자 잔액 부족인데, 그때 누구에게 안 갔는지 복구할 방법이 없었다).
      setBulkFailures(failedRows);
      if (failedRows.length > 0) return;
      setBulkMsgModalOpen(false);
      setSelectedRows(new Set());
      setWaitlistJobId(null);
      setBulkMsgBody(DEFAULT_BULK_BODY);
    } catch {
      toast.error("발송에 실패했어요");
    } finally {
      setBulkSending(false);
    }
  };

  return (
    <DndProvider backend={HTML5Backend}>
      <div
        className={`flex flex-col h-full overflow-hidden transition-[padding] duration-300 ${
          splitPanelActive ? "lg:pr-[552px]" : ""
        }`}
      >
        {/* 제목은 탑바가 정본 — 이 화면은 헤더 밴드 없이 툴바부터 시작한다(이중 제목 금지).
            루트도 배경을 칠하지 않는다: 종이 배경이 밴드 사이로 이어져야
            공고↔파이프라인 탭 전환 때 배경이 점프하지 않는다. */}
        {/* Toolbar & Filters */}
        <div className="px-8 py-4 flex items-center gap-3 border-b border-border-strong bg-white shrink-0 flex-wrap z-10 shadow-sm">
          <div className="flex bg-muted rounded-lg p-1 border border-border-strong">
            <button aria-selected={view === "list"} role="tab" onClick={() => setView("list")} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-bold transition-all ${view === "list" ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-gray-700"}`}>
              <ListIcon size={16} /> 리스트 뷰 (대량 관리)
            </button>
            <button aria-selected={view === "kanban"} role="tab" onClick={() => setView("kanban")} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-bold transition-all ${view === "kanban" ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-gray-700"}`}>
              <LayoutGrid size={16} /> 칸반 보드
            </button>
            <button aria-selected={view === "map"} role="tab" onClick={() => setView("map")} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-bold transition-all ${view === "map" ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-gray-700"}`}>
              <MapIcon size={16} /> 지도 분포
            </button>
            <button aria-selected={view === "funnel"} role="tab" onClick={() => setView("funnel")} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-bold transition-all ${view === "funnel" ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-gray-700"}`}>
              <Funnel size={16} /> 캠페인 단계별 현황
            </button>
          </div>

          {/* 스플릿 뷰 — 상세를 옆에 붙여 목록을 살려둔다 */}
          {view === "list" && (
            <button
              type="button"
              aria-pressed={splitView}
              onClick={toggleSplitView}
              title={splitView ? "끄면 상세가 화면을 덮고, 밖을 누르면 닫힙니다" : "켜면 상세가 옆에 붙어 목록에서 다음 사람을 바로 누를 수 있어요"}
              className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px] font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                splitView
                  ? "border-foreground bg-foreground text-white"
                  : "border-border-strong bg-white text-muted-foreground hover:text-foreground"
              }`}
            >
              <Columns size={14} /> {splitView ? "스플릿 뷰 켜짐" : "스플릿 뷰"}
            </button>
          )}

          {/* 밀도 — 리스트 뷰에서만 의미가 있다(칸반·지도·퍼널은 행이 없다) */}
          {view === "list" && (
            <div role="group" aria-label="목록 밀도" className="flex shrink-0 rounded-full border border-border-strong bg-white p-1">
              {([
                { key: "cozy", icon: Layers, label: "쾌적하게", hint: "보조 정보까지 모두 보여줍니다" },
                { key: "compact", icon: ListIcon, label: "빽빽하게", hint: "근무지·경력·희망시간대를 접어 한 화면에 더 많은 사람을 봅니다" },
              ] as const).map(({ key, icon: Icon, label, hint }) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={density === key}
                  title={hint}
                  onClick={() => pickDensity(key)}
                  className={`flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[12px] font-bold transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                    density === key ? "bg-foreground text-white shadow-xs" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
          )}

          <Button variant="secondary" className="ml-auto" onClick={exportCsv} title={`지금 조건에 맞는 ${filteredCards.length}명이 파일로 나갑니다 (전체 인재풀이 아니라 화면에 적용된 조건 기준)`}>
            <FileDown size={16} /> CSV로 내보내기 <span className="font-semibold text-muted-foreground">({filteredCards.length}명)</span>
          </Button>
        </div>

        {/* 조건 바 — 자주 쓰는 조건(진행 단계·지역·차량)은 여기서 바로, 발송 전 좁히기는 한 묶음, 나머지는 '조건 더보기'.
            예전엔 조건 20여 개가 접이식 패널 한 줄에 쏟아져 무엇이 무슨 축인지 알 수 없었다.
            리스트·칸반·지도에 같은 조건이 적용된다(예전엔 리스트에만 적용돼 칸반에서 검색·필터가 무반응이었다). */}
        {view !== "funnel" ? (
          <div className="px-8 py-3 flex items-center gap-2 border-b border-border-strong bg-white shrink-0 flex-wrap z-10 shadow-sm">
            {/* 대상 좁히기 — 검색·정렬·거리기준을 조건과 같은 줄에 모았다.
                예전엔 정렬이 위층에 혼자, 거리 기준 공고가 위층 오른쪽 끝에 떨어져 있어
                "누구를 볼지" 고르는 도구가 두 층에 흩어져 있었다. */}
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} type="text" aria-label="이름·연락처·근무지·지역 검색" placeholder="이름, 연락처, 근무지, 지역 검색" className="pl-9 pr-4 py-2 min-h-[38px] w-full max-w-[280px] sm:w-[280px] bg-card border border-border-strong rounded-2xl text-[13px] outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring shadow-sm" />
            </div>
            {view === "list" && (
              <select
                value={distanceJobId === null ? "" : String(distanceJobId)}
                onChange={(e) => setDistanceJobId(e.target.value ? Number(e.target.value) : null)}
                className={`pr-8 px-3 py-2 bg-card border rounded-2xl text-[13px] font-semibold text-gray-700 outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring shadow-sm cursor-pointer ${sortMode === "distance" && distanceJobId === null ? "border-warning ring-1 ring-warning" : "border-border-strong"}`}
                title="거리 기준 공고 — 상차지 또는 마지막경유지 좌표가 있는 활성 공고만 선택할 수 있어요"
              >
                <option value="">거리 기준 공고 선택…</option>
                {distanceJobs.map((j) => (
                  <option key={j.id} value={String(j.id)}>{j.title}</option>
                ))}
                {/* 빈 이유를 정확히 말한다 — 예전엔 활성 공고가 0개여도 "좌표가 없어요"라고 해서,
                    실무자가 멀쩡한 주소를 다시 입력하러 가게 만들었다(좌표는 있었고 공고가 마감된 것). */}
                {distanceJobs.length === 0 && (
                  <option value="" disabled>
                    {visibleJobs.length === 0
                      ? "진행 중인 공고가 없어요 — 공고를 먼저 등록하세요"
                      : "진행 중인 공고에 상차지·경유지 주소(좌표)가 없어요"}
                  </option>
                )}
              </select>
            )}

            {view === "list" && (
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
                className={`pr-8 px-3 py-2 bg-card border rounded-2xl text-[13px] font-semibold text-gray-700 outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring shadow-sm cursor-pointer ${sortMode === "distance" && distanceJobId === null ? "border-warning ring-1 ring-warning" : "border-border-strong"}`}
                title={sortMode === "distance" && distanceJobId === null ? "거리순 정렬을 쓰려면 왼쪽에서 거리 기준 공고를 먼저 선택하세요" : "리스트 정렬"}
              >
                <option value="recent">최근 등록순</option>
                <option value="oldest">오래된 등록순</option>
                <option value="active">최근 활동순</option>
                <option value="neglected">방치 오래된 순</option>
                <option value="applied_recent">원지원 최신순</option>
                <option value="applied_old">원지원 오래된순</option>
                <option value="reaction_recent">반응 최신순(열람·관심·답장)</option>
                <option value="distance">공고 근거리순(상차지·종료지점)</option>
              </select>
            )}


            <span aria-hidden="true" className="mx-1 hidden h-6 w-px shrink-0 bg-border-strong sm:block" />

            {/* 진행 단계 — 적체 트리아지의 핵심 동선(예: '스크리닝 전'만 골라 처리). 여러 개 선택 가능해 드롭다운. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={`flex items-center gap-1.5 px-3.5 py-2 rounded-2xl text-[13px] font-bold border whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${statusFilter.size > 0 ? "bg-yellow-50 border-brand-yellow text-warning-strong" : "bg-white border-border-strong text-gray-700 hover:bg-background"}`}
                  title="채용 진행 단계로 목록 좁히기"
                >
                  진행 단계
                  {statusFilter.size > 0 && <span className="bg-brand-yellow text-foreground text-[11px] font-extrabold px-1.5 py-0.5 rounded-full leading-none">{statusFilter.size}</span>}
                  <ChevronDown size={14} className="text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[200px] rounded-2xl border-border-strong">
                <DropdownMenuLabel className="text-[11px] font-bold text-muted-foreground">여러 개 고를 수 있어요</DropdownMenuLabel>
                {[...STATUS_TOKENS, ...(showExcluded ? EXCLUDED_STATUS_TOKENS : [])].map((s) => (
                  <DropdownMenuCheckboxItem
                    key={s}
                    checked={statusFilter.has(s)}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => toggleSetValue(setStatusFilter, s)}
                    className="text-[13px] font-semibold text-gray-700"
                  >
                    {s}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* 지역·차량 — 값이 하나뿐이라 드롭다운 대신 셀렉트(선택값이 접힌 채로도 보인다) */}
            <select
              value={regionFilter}
              onChange={(e) => setRegionFilter(e.target.value as typeof regionFilter)}
              aria-label="사는 지역으로 목록 좁히기"
              title="사는 지역으로 목록 좁히기"
              className={`pr-8 px-3 py-2 rounded-lg text-[13px] font-bold border bg-white outline-none cursor-pointer focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring ${regionFilter !== "all" ? "border-brand-yellow text-warning-strong bg-yellow-50" : "border-border-strong text-gray-700"}`}
            >
              <option value="all">지역 전체</option>
              <option value="capital">수도권(서울·경기·인천)</option>
              <option value="seoul">서울</option>
            </select>
            <select
              value={vehicleFilter}
              onChange={(e) => setVehicleFilter(e.target.value as typeof vehicleFilter)}
              aria-label="차량 보유 여부로 목록 좁히기"
              title="차량 보유 여부로 목록 좁히기 — 공고가 차량을 요구할 때 씁니다"
              className={`pr-8 px-3 py-2 rounded-lg text-[13px] font-bold border bg-white outline-none cursor-pointer focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring ${vehicleFilter !== "all" ? "border-brand-yellow text-warning-strong bg-yellow-50" : "border-border-strong text-gray-700"}`}
            >
              <option value="all">차량 전체</option>
              <option value="vehicle">차량 보유</option>
              <option value="walk">도보</option>
              <option value="unknown">차량 미확인</option>
            </select>

            <div className="w-px h-6 bg-gray-200 mx-1" />

            {/* 발송 준비 — '문자 보내기 전에 빼야 할 사람'을 한 묶음으로. 사람 고르는 조건(위)과 축이 달라 분리했다. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={`flex items-center gap-1.5 px-3.5 py-2 rounded-2xl text-[13px] font-bold border whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${sendPrepCount > 0 ? "bg-yellow-50 border-warning text-warning-strong" : "bg-white border-border-strong text-gray-700 hover:bg-background"}`}
                  title="다시 연락할 대상을 좁히는 조건 — 이미 일하는 분·최근에 연락한 분을 빼고 보냅니다"
                >
                  발송 준비
                  {sendPrepCount > 0 && <span className="bg-warning text-white text-[11px] font-extrabold px-1.5 py-0.5 rounded-full leading-none">{sendPrepCount}</span>}
                  <ChevronDown size={14} className="text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[290px] rounded-2xl border-border-strong">
                <DropdownMenuLabel className="text-[11px] font-bold text-muted-foreground">문자 보내기 전에 대상을 좁혀요</DropdownMenuLabel>
                <DropdownMenuCheckboxItem checked={excludeActive} onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => setExcludeActive((v) => !v)} title="옹매니징 계약·정산 또는 옹고잉 실배차가 있는 분을 뺍니다. 연동이 안 되어 있으면 아무 것도 빼지 않아요." className="text-[13px] font-semibold text-gray-700">
                  이미 일하는 분 제외
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={excludeRecentPing} onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => setExcludeRecentPing((v) => !v)} title="이 화면에서 보낸 일괄 문자(캠페인) 이력 기준이에요 — 개별 문자·확정 안내는 집계되지 않습니다." className="text-[13px] font-semibold text-gray-700">
                  최근 14일 안에 캠페인 문자 보낸 분 제외
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={geoConfirmedOnly} onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => setGeoConfirmedOnly((v) => !v)} title="주소를 지도 좌표로 확인한 분만 봅니다(지오코딩 확정·근사)." className="text-[13px] font-semibold text-gray-700">
                  주소가 확인된 분만
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={recentAppliedOnly} onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => setRecentAppliedOnly((v) => !v)} title="원지원일이 6개월 이내인 분만 봅니다 — 지원일을 모르는 분은 함께 빠집니다." className="text-[13px] font-semibold text-gray-700">
                  6개월 안에 지원한 분만
                </DropdownMenuCheckboxItem>
                {/* 앞 500명만 조회하는 상한 — '이미 일하는 분'·'캠페인 문자' 판정이 그 뒤 인원에는 걸리지 않는다는 사실을 밝힌다. */}
                {baseFilteredCards.length > 500 && (
                  <div className="px-2 py-1.5 text-[11px] leading-relaxed text-warning-strong bg-yellow-50">
                    지금 조건에 {baseFilteredCards.length}명이라 <b>앞 500명만 확인</b>해요. 뒤쪽 인원에는 위 두 조건이 걸리지 않으니, 진행 단계·지역으로 먼저 좁혀 주세요.
                  </div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* 조건 더보기 — 실제로 자주 쓰이지 않는 조건(지원 채널·희망 근무·가용성·반응·수신거부)은 여기 안으로 */}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-2xl text-[13px] font-bold border whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${showFilters || moreFilterCount > 0 ? "bg-yellow-50 border-brand-yellow text-warning-strong" : "bg-white border-border-strong text-gray-700 hover:bg-background"}`}
              aria-expanded={showFilters}
            >
              <Filter size={15} /> 조건 더보기
              {moreFilterCount > 0 && <span className="bg-brand-yellow text-foreground text-[11px] font-extrabold px-1.5 py-0.5 rounded-full leading-none">{moreFilterCount}</span>}
              <ChevronDown size={14} className={`text-muted-foreground transition-transform ${showFilters ? "rotate-180" : ""}`} />
            </button>

            {activeFilterCount > 0 && (
              <button onClick={resetFilters} className="text-[13px] font-bold text-error hover:underline px-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/40">
                조건 초기화
              </button>
            )}

            <div className="flex-1" />

            {/* 지금 보이는 인원 — 한 곳에만 둔다(예전엔 필터 패널·리스트 머리에 같은 숫자가 두 번 있었다) */}
            <span className="text-[13px] font-bold text-gray-700">
              {view === "list" && <>발송가능 <span className="text-success">{sendableCount}</span> / </>}
              조건 {shownCount}명
              {view === "list" && hiddenCount > 0 && (
                <span className="ml-1 font-medium text-muted-foreground" title="화면에 그리는 양만 나눠서 보여줍니다. 선택·발송·CSV는 조건에 맞는 전원이 대상이에요.">
                  (화면에 {visibleCards.length}명)
                </span>
              )}
            </span>
          </div>
        ) : (
          <div className="px-8 py-2.5 border-b border-border-strong bg-white shrink-0 text-[12px] text-muted-foreground">
            이 화면은 최근 <b className="text-gray-700">발송 묶음</b> 기준이라 위 조건은 적용되지 않아요(검색은 이름으로만 적용됩니다). 아래 기간을 바꿔 보세요.
          </div>
        )}

        {/* 적용 중 조건 칩 — 트리거 버튼들의 하이라이트만으론 '무엇으로 좁혔는지'가 흩어져 보인다.
            여기서 한 줄로 읽고, ×로 그 조건만 해제한다(전체 해제는 위 '조건 초기화'). */}
        {view !== "funnel" && activeFilterCount > 0 && (
          <div className="px-8 py-2 flex items-center gap-1.5 flex-wrap border-b border-border-strong bg-background shrink-0">
            <span className="text-[12px] font-bold text-muted-foreground shrink-0">적용 중:</span>
            {query.trim() !== "" && <FilterChip label={`검색 "${query.trim()}"`} onClear={() => setQuery("")} />}
            {statusFilter.size > 0 && (
              <FilterChip
                label={statusFilter.size <= 2 ? `단계: ${[...statusFilter].join(" · ")}` : `진행 단계 ${statusFilter.size}개`}
                onClear={() => setStatusFilter(new Set())}
              />
            )}
            {regionFilter !== "all" && (
              <FilterChip label={regionFilter === "seoul" ? "서울만" : "수도권만"} onClear={() => setRegionFilter("all")} />
            )}
            {vehicleFilter !== "all" && (
              <FilterChip
                label={vehicleFilter === "vehicle" ? "차량 보유" : vehicleFilter === "walk" ? "도보" : "차량 미확인"}
                onClear={() => setVehicleFilter("all")}
              />
            )}
            {sendPrepCount > 0 && (
              <FilterChip
                label={`발송 전 좁히기 ${sendPrepCount}개`}
                onClear={() => { setExcludeActive(false); setExcludeRecentPing(false); setGeoConfirmedOnly(false); setRecentAppliedOnly(false); }}
              />
            )}
            {moreFilterCount > 0 && (
              <FilterChip
                label={`추가 조건 ${moreFilterCount}개`}
                onClear={() => { setChannelFilter(new Set()); setSlotFilter(new Set()); setAvailabilityFilter(new Set()); setReactionOnly(false); setOptOutOnly(false); setShowExcluded(false); }}
              />
            )}
          </div>
        )}

        {/* '조건 더보기' 패널 — 자주 쓰지 않는 조건. 리스트·칸반·지도에 모두 적용된다(단계별 현황 뷰에서는 숨김). */}
        <AnimatePresence>
          {showFilters && view !== "funnel" && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="bg-white border-b border-border-strong shrink-0 overflow-hidden">
              <div className="px-8 py-5 bg-background flex flex-col gap-4">
                <div className="flex flex-wrap gap-8">
                  {/* 지원 채널 */}
                  <div>
                    <label className="block text-[12px] font-bold text-gray-700 mb-2">지원 채널</label>
                    <div className="flex flex-wrap gap-1.5">
                      {availableChannels.length === 0 && <span className="text-[12px] text-muted-foreground">채널 없음</span>}
                      {availableChannels.map((ch) => {
                        const on = channelFilter.has(ch);
                        return (
                          <button aria-pressed={on} key={ch} onClick={() => toggleSetValue(setChannelFilter, ch)} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold border transition-colors ${on ? 'bg-foreground border-foreground text-white' : 'bg-white border-border-strong text-gray-700 hover:bg-muted'}`}>
                            {ch}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 희망 슬롯 */}
                  <div>
                    <label className="block text-[12px] font-bold text-gray-700 mb-2">희망 근무(슬롯)</label>
                    <div className="flex flex-wrap gap-1.5">
                      {[...SLOTS, SLOT_UNKNOWN].map((s) => {
                        const on = slotFilter.has(s);
                        return (
                          <button aria-pressed={on} key={s} onClick={() => toggleSetValue(setSlotFilter, s)}
                            title={s === SLOT_UNKNOWN ? "시간대를 알 수 없는 분(지원 폼에 안 남겼거나 야간·새벽 근무) — 4칩 중 무엇을 골라도 이분들은 안 걸려요" : undefined}
                            className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold border transition-colors ${on ? 'bg-brand-yellow border-brand-yellow text-foreground' : 'bg-white border-border-strong text-gray-700 hover:bg-muted'}`}>
                            {s === SLOT_UNKNOWN ? "미확인" : SLOT_LABEL[s as SlotKey]}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 가용성 — status(채용 단계)와 별개의 공급 축 */}
                  <div>
                    <label className="block text-[12px] font-bold text-gray-700 mb-2" title="가용성 — 지금 일할 수 있는 상태(즉시가능·이번주가능·휴면). 채용 단계와 별개로 관리됩니다">가용성</label>
                    <div className="flex flex-wrap gap-1.5">
                      {AVAILABILITY_TOKENS.map((s) => {
                        const on = availabilityFilter.has(s);
                        return (
                          <button aria-pressed={on} key={s} onClick={() => toggleSetValue(setAvailabilityFilter, s)} className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold border transition-colors ${on ? 'bg-success border-success text-white' : 'bg-white border-border-strong text-gray-700 hover:bg-muted'}`}>
                            {s}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 부적합·이탈(=서버가 캠페인 발송을 막는 상태) + 기타(그 외·발송 가능). 실수 복구·재검토용.
                      칸반에는 이 단계 컬럼이 없어 리스트·지도에만 반영된다. */}
                  <div>
                    <label className="block text-[12px] font-bold text-gray-700 mb-2">단계 밖에 있는 분</label>
                    <button aria-pressed={showExcluded}
                      onClick={() => setShowExcluded((v) => !v)}
                      className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold border transition-colors ${showExcluded ? 'bg-error border-error text-white' : 'bg-white border-border-strong text-gray-700 hover:bg-muted'}`}
                      title="부적합·이탈·기타 상태인 분도 함께 표시합니다. 부적합·이탈은 캠페인 문자가 서버에서 차단되고(목록에 '인력풀 제외' 표시), '기타'는 발송됩니다. 리스트·지도에만 반영 — 칸반에는 이 단계 컬럼이 없어요."
                    >
                      부적합·이탈·기타도 표시 {showExcluded ? "ON" : "OFF"} <span className="font-semibold text-[11px] opacity-70">(리스트·지도)</span>
                    </button>
                  </div>

                  {/* 반응 — 맞춤 공고 링크 열람·관심·답장 이력이 있는 사람만 (실데이터에 아직 이벤트가 적어 '조건 더보기' 안에 둔다) */}
                  <div>
                    <label className="block text-[12px] font-bold text-gray-700 mb-2">반응</label>
                    <button aria-pressed={reactionOnly}
                      onClick={() => setReactionOnly((v) => !v)}
                      className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold border transition-colors ${reactionOnly ? 'bg-success border-success text-white' : 'bg-white border-border-strong text-gray-700 hover:bg-muted'}`}
                      title="맞춤 공고 링크 열람·관심 클릭·답장 중 1건이라도 있는 인원만 표시합니다"
                    >
                      반응 있음(열람/관심/답장) {reactionOnly ? "ON" : "OFF"}
                    </button>
                  </div>

                  {/* 수신거부 확인 — 유일한 '역방향' 조건이라 다른 조건과 섞이지 않게 따로 둔다 */}
                  <div>
                    <label className="block text-[12px] font-bold text-gray-700 mb-2">수신거부 확인</label>
                    <button aria-pressed={optOutOnly}
                      onClick={() => setOptOutOnly((v) => !v)}
                      className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold border transition-colors ${optOutOnly ? 'bg-error border-error text-white' : 'bg-white border-border-strong text-gray-700 hover:bg-muted'}`}
                      title="수신거부('그만' 회신 등) 처리된 인원만 표시합니다 — 다른 조건과 반대로 '발송 불가자만' 보는 조건이에요"
                    >
                      수신거부한 분만 보기 {optOutOnly ? "ON" : "OFF"}
                    </button>
                  </div>
                </div>

                {/* 저장된 대상 묶음 (필터 프리셋) */}
                <div className="border-t border-border-strong pt-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[12px] font-bold text-gray-700">저장된 대상 묶음</span>
                    {segments.length === 0 && <span className="text-[12px] text-muted-foreground">자주 쓰는 조건 조합을 저장해 1클릭으로 재적용하세요.</span>}
                    {segments.map((seg) => (
                      <span key={seg.id} className="group inline-flex items-center gap-1 bg-white border border-border-strong rounded-lg pl-2.5 pr-1 py-1 text-[12px] font-bold text-gray-700 hover:border-brand-yellow">
                        <button onClick={() => applySegment(seg)} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:text-foreground">{seg.name}</button>
                        <button aria-label={`저장한 조건 ${seg.name} 삭제`} onClick={() => deleteSegment(seg.id)} className="after:absolute after:-inset-2 after:content-[''] relative outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-muted-foreground hover:text-error p-0.5 rounded" title="삭제"><X size={12} /></button>
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      value={segNameDraft}
                      onChange={(e) => setSegNameDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveCurrentSegment(); }}
                      placeholder="지금 조건을 이름 붙여 저장 (예: 강남·자차·즉시가능)"
                      className="flex-1 max-w-[340px] px-3 py-1.5 border border-border-strong rounded-2xl text-[13px] focus:outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring bg-white"
                    />
                    <Button variant="brand" size="chip" className="px-3 py-1.5 text-[13px] rounded-lg shadow-none" onClick={saveCurrentSegment} disabled={!segNameDraft.trim()}>지금 조건 저장</Button>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-1">
                  {/* 인원 수는 위 조건 바 한 곳에만 둔다(같은 숫자를 두 번 보여주면 어느 게 기준인지 헷갈린다) */}
                  {activeFilterCount > 0 && (
                    <button onClick={resetFilters} className="rounded text-[13px] font-bold text-error hover:underline outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">조건 초기화</button>
                  )}
                  <div className="flex-1" />
                  <button onClick={() => setShowFilters(false)} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-[13px] font-bold text-info hover:underline px-3 py-1.5 outline-none">닫기</button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main Content Area */}
        <div className="flex-1 overflow-hidden relative">
          {loading && view !== "funnel" && <PipelineSkeleton />}
          {view === "kanban" && (
            <div className="flex gap-6 h-full overflow-x-auto p-8">
              {/* 컬럼은 드래그 낙관 갱신용 원본(columns)을 유지하고, 표시만 조건 결과로 좁힌다 —
                  예전엔 조건·검색이 칸반에 전혀 걸리지 않아 검색창을 쳐도 아무 반응이 없었다. */}
              {kanbanColumns.map((column, idx) => (
                <KanbanColumn key={column.id} column={column} moveCard={moveCard} onCardClick={(id) => openApplicant(Number(id))} columnIndex={idx} onExport={handleColumnExport} onBulkMessage={handleColumnBulkMessage} />
              ))}
            </div>
          )}

          {view === "map" && (
            <PipelineMap applicants={mapApplicants} jobs={mapJobs} />
          )}

          {view === "funnel" && (
            <FunnelBoard
              data={funnelData}
              error={funnelError}
              days={funnelDays}
              onDaysChange={setFunnelDays}
              onRefresh={() => void mutateFunnel()}
              isValidating={funnelValidating}
              query={q}
              onCardClick={(id) => openApplicant(id)}
            />
          )}

          {view === "list" && (
            <div className="h-full overflow-y-auto p-8 relative bg-white">
              {/* Floating Bulk Actions Toolbar */}
              <AnimatePresence>
                {selectedRows.size > 0 && (
                  <motion.div initial={{ y: -50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -50, opacity: 0 }} className="sticky top-0 z-20 flex items-center gap-3 glass-dark backdrop-blur-xl backdrop-saturate-150 rounded-2xl px-6 py-4 mb-6 shadow-glass-dark">
                    <span className="text-[16px] font-extrabold text-white">
                      <span className="text-brand-yellow text-[18px]">{selectedRows.size}명</span> 선택됨
                    </span>
                    <div className="w-px h-6 bg-white/20 mx-2"></div>

                    <Button variant="ghost" onClick={() => setBulkStageModalOpen(true)} className="bg-white/10 hover:bg-white/20 text-white border-0 shadow-none"><Columns size={16} /> 일괄 상태 변경</Button>
                    <Button variant="ghost" onClick={() => setJobPickerOpen(true)} title="이 분들을 공고의 지원자(후보)로 등록해 AI 스크리닝 대상에 넣습니다 — 문자는 나가지 않아요" className="bg-white/10 hover:bg-white/20 text-white border-0 shadow-none"><Briefcase size={16} /> 공고 후보로 추가</Button>
                    <Button variant="ghost" onClick={() => setExposurePickerOpen(true)} title="이 분들에게만 공고가 보이도록 지정합니다(맞춤 공고 링크 노출 명단). 전체 노출 공고는 '지정 노출'로 전환까지 한 번에 — 후보 등록·문자 발송과 별개예요." className="bg-white/10 hover:bg-white/20 text-white border-0 shadow-none"><Eye size={16} /> 이 명단에게만 노출</Button>
                    <Button variant="brand" onClick={() => setBulkMsgModalOpen(true)}><MessageCircle size={16} /> 문자 보내기</Button>

                    <div className="flex-1" />

                    <button aria-label="선택 해제" className="after:absolute after:-inset-2 after:content-[''] relative outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background bg-transparent hover:bg-white/10 text-white/70 hover:text-white rounded-lg p-2 transition-colors" onClick={() => { setSelectedRows(new Set()); setWaitlistJobId(null); }}>
                      <X size={20} />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* 리스트 카운트 + 상위 N명 선택 — 발송 가능 인원 이중 카운트, 배치 발송 진입 단축 */}
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                {/* 인원 수는 위 조건 바에 한 번만 표시한다(같은 숫자를 두 곳에 두면 어느 게 기준인지 헷갈린다) */}
                {/* '수신거부한 분만 보기' ON — 컴플라이언스 확인용 카운트 (표시분 전원이 수신거부) */}
                {optOutOnly && (
                  <span className="text-[13px] font-bold text-error">수신거부 {filteredCards.length}명</span>
                )}
                <div className="flex-1" />
                {/* 공고 관심자 원클릭 선택 — 관심 표시 인원(확정인력 제외)을 선택해 '관심 대기 안내'로 잇는 사후관리 동선 */}
                <select
                  value=""
                  onChange={(e) => { if (e.target.value) void selectJobInterested(Number(e.target.value)); }}
                  disabled={interestPickLoading || activeJobs.length === 0}
                  className="pr-8 px-3 py-1.5 bg-white border border-border-strong rounded-lg text-[13px] font-semibold text-gray-700 outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  title="공고를 고르면 그 공고에 '관심 있음'을 누른 인원(확정인력 제외)이 선택됩니다"
                >
                  <option value="">{interestPickLoading ? "관심자 조회 중…" : "공고 관심자 선택…"}</option>
                  {activeJobs.map((j) => (
                    <option key={j.id} value={String(j.id)}>#{j.id} {j.title}</option>
                  ))}
                </select>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={1}
                    value={topN}
                    onChange={(e) => setTopN(Number(e.target.value))}
                    className="w-[64px] px-2 py-1.5 bg-card border border-border-strong rounded-2xl text-[13px] font-semibold text-gray-700 outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring shadow-sm"
                    title="선택할 상위 인원 수"
                  />
                  <Button variant="secondary" size="chip" className="px-3 py-1.5 text-[13px] rounded-lg" onClick={selectTopN}><Check size={15} /> 상위 {Math.max(1, Math.floor(topN) || 0)}명 선택</Button>
                </div>
              </div>

              {topN > 50 && (
                <p className="-mt-2 mb-4 text-[12px] text-muted-foreground">발송은 1회 최대 50명 — 50명 초과 시 자동으로 50명씩 나눠 발송됩니다.</p>
              )}

              {sortMode === "distance" && distanceJobId === null && (
                <p className="-mt-2 mb-4 text-[12px] font-semibold text-warning-strong">거리순 정렬을 쓰려면 상단에서 &lsquo;거리 기준 공고&rsquo;를 선택하세요. 선택 전에는 기본 순서로 표시됩니다.</p>
              )}

              {/* Data Table */}
              {/* 열 폭을 명시한다. 자동 폭에 맡기면 '보유 차량 / 조건'이 내용이 길어
                  542px를 혼자 가져가고 '거주 지역'·'최근 활동'이 62px로 눌려
                  "부천/시 원/미구"처럼 글자 단위로 쪼개졌다.
                  MASTER.md §4: 표처럼 본질적으로 넓은 것은 페이지가 아니라
                  자기 컨테이너 안에서 가로 스크롤한다. */}
              <div className="border border-border-strong rounded-lg overflow-x-auto shadow-sm">
                <table data-density={density} className="w-full min-w-[1060px] text-left border-collapse">
                  <thead>
                    <tr className="bg-background border-b border-border-strong">
                      <th className="px-5 py-4 w-[50px]">
                        <button aria-checked={selectedRows.size === filteredCards.length && filteredCards.length > 0} role="checkbox" onClick={toggleAll} aria-label={selectedRows.size === filteredCards.length && filteredCards.length > 0 ? "전체 선택 해제" : "표시된 지원자 전체 선택"} aria-pressed={selectedRows.size === filteredCards.length && filteredCards.length > 0} className={`after:absolute after:-inset-3 after:content-[''] relative w-5 h-5 rounded-[6px] border-2 flex items-center justify-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${selectedRows.size === filteredCards.length && filteredCards.length > 0 ? 'bg-brand-yellow border-brand-yellow' : 'border-gray-300 bg-white'}`}>
                          {selectedRows.size === filteredCards.length && filteredCards.length > 0 && <Check size={14} strokeWidth={4} className="text-foreground" />}
                        </button>
                      </th>
                      <th className="px-4 py-4 w-[190px] text-[13px] font-bold text-muted-foreground whitespace-nowrap">지원자 정보</th>
                      <th className="px-4 py-4 w-[150px] text-[13px] font-bold text-muted-foreground whitespace-nowrap">진행 단계</th>
                      <th className="px-4 py-4 w-[130px] text-[13px] font-bold text-muted-foreground whitespace-nowrap">지원 채널 / 근무지</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-muted-foreground whitespace-nowrap">보유 차량 / 조건</th>
                      <th className="px-4 py-4 w-[180px] text-[13px] font-bold text-muted-foreground whitespace-nowrap">거주 지역 / 희망 근무</th>
                      <th className="px-4 py-4 w-[104px] text-[13px] font-bold text-muted-foreground whitespace-nowrap">최근 활동</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleCards.map(c => {
                      const isSelected = selectedRows.has(c.id);
                      const send = sendableOf(c);
                      const appliedLabel = appliedMonth(c.appliedAtIso);
                      const summary = summaryById[Number(c.id)] as PoolEventSummary | undefined;
                      // 반응 배지 — 과밀 방지: 가장 강한 신호 1개만 (관심 > 답장 > 열람).
                      let reactionBadge: { label: string; cls: string; title: string } | null = null;
                      if (summary?.last_interest) {
                        const it = summary.last_interest;
                        const jobTitle = it.job_id !== null ? activeJobs.find((j) => j.id === it.job_id)?.title : undefined;
                        reactionBadge = {
                          label: `${it.immediate ? "⚡ " : ""}관심 표시`,
                          cls: "bg-success-soft text-success-strong",
                          title: `공고${it.job_id !== null ? ` #${it.job_id}` : ""}${jobTitle ? ` ${jobTitle}` : ""} 관심 표시 ${relTime(it.at)}${it.immediate ? " · 즉시 가능 응답" : ""}`,
                        };
                      } else if (summary?.last_reply_at) {
                        reactionBadge = {
                          label: "답장 옴",
                          cls: "bg-info/25 text-info-strong",
                          title: `마지막 답장 ${relTime(summary.last_reply_at)}`,
                        };
                      } else if (summary?.last_link_view_at) {
                        reactionBadge = {
                          label: `열람 ${relTime(summary.last_link_view_at)}`,
                          cls: "bg-muted text-muted-foreground",
                          title: "맞춤 공고 링크 열람",
                        };
                      }
                      // 거리 정렬 활성 시에만 거리 표기. 상차지·마지막경유지 둘 다 있으면 '상차 12/종료 4km', 하나면 그 값만. 좌표 없으면 생략.
                      const distVal = distByCardId[c.id];
                      const distDetail = distDetailByCardId[c.id];
                      const distLabel =
                        distVal === undefined || !distDetail
                          ? null
                          : distDetail.pickup !== null && distDetail.dropoff !== null
                            ? `상차 ${distDetail.pickup.toFixed(0)}/종료 ${distDetail.dropoff.toFixed(0)}km`
                            : distDetail.pickup !== null
                              ? `상차 ${distDetail.pickup.toFixed(1)}km`
                              : `종료 ${(distDetail.dropoff ?? distVal).toFixed(1)}km`;
                      return (
                        <tr
                          key={c.id}
                          onClick={() => openApplicant(Number(c.id))}
                          // 스플릿 뷰에서 지금 상세로 보고 있는 사람 — 목록에서 자리를 잃지 않게 왼쪽에 표시를 남긴다.
                          aria-current={Number(c.id) === selectedApplicantId ? "true" : undefined}
                          className={`border-b border-muted last:border-0 transition-colors hover:bg-background cursor-pointer group ${isSelected ? 'bg-yellow-50 hover:bg-yellow-50' : 'bg-white'} ${Number(c.id) === selectedApplicantId ? 'shadow-[inset_3px_0_0_0_var(--foreground)]' : ''}`}
                        >
                          <td className="px-5 py-4">
                            <button aria-label={`${c.name} 선택`} aria-checked={isSelected} role="checkbox" onClick={(e) => { e.stopPropagation(); toggleRow(c.id); }} className={`after:absolute after:-inset-3 after:content-[''] relative outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-5 h-5 rounded-[6px] border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-brand-yellow border-brand-yellow' : 'border-gray-300 bg-white'}`}>
                              {isSelected && <Check size={14} strokeWidth={4} className="text-foreground" />}
                            </button>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex items-center gap-3">
                              <div data-den="avatar" className="w-10 h-10 rounded-md bg-muted text-gray-700 flex items-center justify-center font-bold text-[16px] shrink-0">
                                {c.name.charAt(0)}
                              </div>
                              <div>
                                <div className="text-[14px] font-bold text-foreground">{c.name}{c.age > 0 && <span className="text-[13px] font-medium text-muted-foreground ml-1">{c.age}세</span>}</div>
                                {/* 이름 아래 한 줄 — 공고가 2건 이상이면 공고별 칩으로 바꾼다.
                                    '공고지원 · 스크리닝' 한 개는 가장 최근 공고 하나만 말해줘서, 여러 자리에
                                    붙은 분이 한 자리만 진행 중인 것처럼 보였다. 칩을 누르면 그 공고 기준으로 상세가 열린다.
                                    (칩 개수 = 상세의 공고 탭 수 — 같은 판정 함수를 쓴다.) */}
                                <div className="flex items-center gap-1 mt-1 flex-wrap">
                                  {c.jobLinks.length > 0 ? (
                                    <>
                                      {c.jobLinks.slice(0, 2).map((l) => {
                                        const interestOnly = l.agent_stage == null;
                                        const paused = l.agent_stage === "paused";
                                        return (
                                          <button
                                            key={l.job_id}
                                            onClick={(e) => { e.stopPropagation(); openApplicant(Number(c.id), l.job_id); }}
                                            title={`${l.title} — ${interestOnly ? "관심만 누른 자리" : STAGE_KO[l.agent_stage ?? ""] ?? l.agent_stage}. 클릭하면 이 공고 기준으로 상세를 엽니다.`}
                                            className={`cursor-pointer text-[11px] font-bold px-1.5 py-0.5 rounded-full max-w-[110px] truncate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                                              interestOnly
                                                ? "bg-yellow-50 text-warning-strong"
                                                : paused
                                                  ? "bg-muted text-gray-700"
                                                  : "bg-info-soft text-info-strong"
                                            }`}
                                          >
                                            {(l.branch && l.branch.trim()) || l.title}
                                          </button>
                                        );
                                      })}
                                      {c.jobLinks.length > 2 && (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); openApplicant(Number(c.id)); }}
                                          title={c.jobLinks.map((l) => l.title).join("\n")}
                                          className="cursor-pointer text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                          +{c.jobLinks.length - 2}
                                        </button>
                                      )}
                                      {(() => {
                                        const s = summarizeLinks(c.jobLinks);
                                        return s.interest > 0 && s.talking + s.paused === 0 ? (
                                          <span className="text-[11px] font-bold text-warning-strong">관심 {s.interest}건</span>
                                        ) : null;
                                      })()}
                                    </>
                                  ) : c.agentStage ? (
                                    /* 살아있는 결속이 0건인데 단계가 남아 있다 = 종료·마감된 공고 이력뿐이다.
                                       예전 '공고지원 · 스크리닝' 표기는 지금 진행 중인 것처럼 읽혀 오해를 낳았다. */
                                    <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground" title="지금 붙어 있는 공고는 없어요 — 지난 공고 이력이에요">지난 공고 · {STAGE_KO[c.agentStage] ?? c.agentStage}</span>
                                  ) : (
                                    <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">순수 인재풀</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1 items-start">
                              {(() => {
                                /* 같은 사람을 두 화면이 다르게 말하던 문제 — 이 배지는 applicants.status를,
                                   인계 큐는 job_candidates.agent_stage를 읽어서, 22일째 사람을 기다리는 분이
                                   여기서는 "AI 스크리닝 중"(노란 배지)으로 보였다. 안심시키는 쪽이 더 자주
                                   보는 화면이라, 큐를 따로 열지 않으면 멈춘 사실을 알 방법이 없었다.
                                   paused 결속이 있으면 상태 배지 대신 '사람 확인 필요 · N일'을 먼저 말한다. */
                                const pausedLink = c.jobLinks.find((l) => l.agent_stage === "paused");
                                // 살아있는 결속에 없어도 최근 단계가 paused면(마감·시스템 공고 건 —
                                // 인계 큐가 그런 건을 의도적으로 담는다) 같은 배지를 보여준다.
                                const pausedAt = pausedLink?.stage_updated_at ?? (c.agentStage === "paused" ? c.agentStageUpdatedAt : null);
                                if (pausedLink || c.agentStage === "paused") {
                                  const days = pausedAt
                                    ? Math.max(0, Math.floor((Date.now() - new Date(pausedAt).getTime()) / 86400000))
                                    : null;
                                  return (
                                    <span
                                      className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-bold px-3 py-1.5 rounded-lg border border-error/40 bg-error-soft text-error-strong"
                                      title="AI가 답을 멈추고 매니저에게 넘긴 대화예요 — 실시간 응대의 '사람 확인 필요' 탭에서 처리하세요"
                                    >
                                      <div className="w-1.5 h-1.5 rounded-full bg-error" />
                                      사람 확인 필요{days != null && days > 0 ? ` · ${days}일` : ""}
                                    </span>
                                  );
                                }
                                return (
                                  <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-bold px-3 py-1.5 rounded-lg border bg-white ${c.stageId === 'applied' ? 'border-border-strong text-gray-700' : c.stageId === 'screening' ? 'border-yellow-300 text-warning-strong bg-yellow-100' : c.stageId === 'interview' ? 'border-success-soft text-success-strong bg-success-soft' : c.stageId === 'excluded' ? 'border-gray-300 text-muted-foreground bg-background' : 'border-info/60 text-info-strong bg-info-soft'}`}>
                                    <div className={`w-1.5 h-1.5 rounded-full ${c.stageColor}`} />
                                    {c.stage}
                                  </span>
                                );
                              })()}
                              {/* 배지는 2개까지만 — '가장 강한 반응 신호' + '문자 발송 불가 사유'.
                                  예전엔 가용성·마지막 연락·활동중·차량 미확인까지 최대 7개가 쌓여 무엇이 중요한지 알 수 없었고
                                  뜻은 마우스를 올려야 보였다. 나머지 값은 행의 다른 열과 지원자 상세에서 그대로 볼 수 있다. */}
                              {(reactionBadge || c.smsOptOutAt || (!send.sendable && send.reason)) && (
                                <div className="flex flex-wrap items-center gap-1">
                                  {reactionBadge && (
                                    <span title={reactionBadge.title} className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${reactionBadge.cls}`}>
                                      {reactionBadge.label}
                                    </span>
                                  )}
                                  {c.smsOptOutAt ? (
                                    <span title={`수신거부 ${relTime(c.smsOptOutAt)} — 문자를 보낼 수 없어요`} className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-error-soft text-error-strong">
                                      수신거부
                                    </span>
                                  ) : (
                                    !send.sendable && send.reason && (
                                      <span title="문자 발송 불가" className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                                        {send.reason}
                                      </span>
                                    )
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1">
                              <span className="inline-flex w-fit items-center text-[12px] font-bold px-2 py-0.5 rounded-full bg-muted text-gray-700">{c.channel}</span>
                              <span data-den="secondary" className="text-[12px] font-medium text-muted-foreground">{c.branch}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1">
                              <span className="text-[13px] font-bold text-gray-700">{c.tag}</span>
                              <span data-den="secondary" className="text-[12px] text-muted-foreground">{c.exp}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[13px] font-medium text-gray-700">{c.region}</span>
                                {distLabel && (
                                  <span title="선택 공고 상차지·마지막경유지까지 직선 거리(가까운 쪽 기준 정렬)" className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-info-soft text-info-strong">
                                    {distLabel}
                                  </span>
                                )}
                              </div>
                              <span data-den="secondary" className="text-[12px] text-muted-foreground">{c.slot}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[13px] text-muted-foreground">{c.lastActive}</span>
                              {appliedLabel && (
                                <span data-den="secondary" className="text-[11px] text-muted-foreground">지원 {appliedLabel}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {hiddenCount > 0 && (
                      // 관찰용 행 — 화면에 들어오면 다음 분량이 붙는다.
                      // 스크립트가 막힌 환경에서도 직접 누를 수 있게 버튼을 둔다.
                      <tr ref={moreRef}>
                        <td colSpan={7} className="px-4 py-5 text-center">
                          <button
                            type="button"
                            onClick={() => setVisibleCount((v) => v + ROWS_PER_CHUNK)}
                            className="min-h-11 rounded-2xl border border-border-strong bg-white px-4 text-[13px] font-bold text-gray-700 outline-none transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          >
                            {hiddenCount}명 더 보기
                          </button>
                          <div className="mt-2 text-[12px] text-muted-foreground">
                            아래로 내리면 저절로 이어집니다 · 선택·발송·CSV는 조건에 맞는 {filteredCards.length}명 전체에 적용돼요
                          </div>
                        </td>
                      </tr>
                    )}
                    {!loading && filteredCards.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-12 text-center text-[13px] text-muted-foreground">
                          {query
                            ? `'${query}' 검색 결과가 없어요. 이름·전화번호를 다시 확인해 보세요.`
                            : activeFilterCount > 0
                              ? "조건에 맞는 지원자가 없어요. 위 조건 바에서 '조건 초기화'를 누르거나 조건을 풀어 보세요."
                              : "표시할 지원자가 없어요. 지원자가 들어오면 여기에 쌓입니다."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {jobPickerOpen && (
        <Modal bare open={jobPickerOpen} onClose={() => setJobPickerOpen(false)} size="sm"
               title="공고 후보로 추가"
               className="max-w-[440px] sm:max-w-[440px]"
        >
            <div className="px-6 py-4 border-b border-border-strong flex items-start justify-between">
              <div>
                <h2 className="text-[16px] font-bold text-foreground">공고 후보로 추가</h2>
                <div className="text-[13px] text-muted-foreground mt-0.5">선택된 {selectedRows.size}명을 추가할 공고를 선택하세요.</div>
              </div>
              <button aria-label="공고 선택 창 닫기" onClick={() => setJobPickerOpen(false)} className="after:absolute after:-inset-2 after:content-[''] relative outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background p-1.5 hover:bg-muted rounded-lg text-muted-foreground"><X size={18} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
              {activeJobs.length === 0 && <div className="text-[13px] text-muted-foreground text-center py-8">진행 중인 공고가 없어요</div>}
              {activeJobs.map((j) => (
                <button
                  key={j.id}
                  onClick={() => addSelectedToJob(j.id)}
                  disabled={addingJobId !== null}
                  className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full text-left flex items-center justify-between gap-3 p-3.5 rounded-2xl border border-border-strong hover:border-brand-yellow hover:bg-yellow-50 disabled:opacity-50 transition-all"
                >
                  <div className="min-w-0">
                    <div className="text-[14px] font-bold text-foreground truncate">{j.title}</div>
                    {j.branch && <div className="text-[12px] text-muted-foreground">{j.branch}</div>}
                  </div>
                  {addingJobId === j.id ? <Loader2 size={16} className="animate-spin text-muted-foreground shrink-0" /> : <ArrowRight size={16} className="text-muted-foreground shrink-0" />}
                </button>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-border-strong text-[12px] text-muted-foreground">
              추가 후 공고 상세에서 일괄 스크리닝 문자를 발송할 수 있어요.
            </div>
        </Modal>
      )}

      {/* J 타겟 노출 — 선택 인원 × 다중 공고 일괄 노출 추가/제외 (후보 등록과 별개 레이어) */}
      {exposurePickerOpen && (
        <Modal bare open={exposurePickerOpen} onClose={() => setExposurePickerOpen(false)} size="md"
               title="노출 대상 지정"
               className="max-w-[520px] sm:max-w-[520px]"
        >
            <div className="px-6 py-4 border-b border-border-strong flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[16px] font-bold text-foreground">노출 대상 지정</h2>
                <div className="text-[13px] text-muted-foreground mt-0.5">선택된 {selectedRows.size}명을 어느 공고의 노출 대상으로 할까요? (여러 공고 선택 가능)</div>
                {/* 조건 요약 — '어떤 조건으로 고른 명단인지'를 남긴다. 명단만 보면 나중에 근거를 되짚을 수 없다. */}
                <div className="mt-2 text-[12px] leading-snug text-gray-700 bg-background border border-border-strong rounded-lg px-2.5 py-1.5">
                  <b className="text-muted-foreground">지금 조건</b> {conditionLabels.length > 0 ? conditionLabels.join(" · ") : "조건 없음(인재풀 전체에서 고름)"}
                  {selectedOutsideCondition > 0 && (
                    <div className="text-warning-strong mt-0.5">선택한 {selectedRows.size}명 중 {selectedOutsideCondition}명은 지금 조건 밖이에요(직접 고르신 분도 그대로 적용됩니다).</div>
                  )}
                </div>
              </div>
              <button aria-label="노출 지정 창 닫기" onClick={() => setExposurePickerOpen(false)} className="after:absolute after:-inset-2 after:content-[''] relative outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background p-1.5 hover:bg-muted rounded-lg text-muted-foreground shrink-0"><X size={18} /></button>
            </div>
            <div className="px-6 py-3 border-b border-muted flex items-center gap-2">
              {([["include", "노출 추가"], ["exclude", "노출 제외"]] as ["include" | "exclude", string][]).map(([m, label]) => (
                <button aria-pressed={exposureMode === m}
                  key={m}
                  onClick={() => setExposureMode(m)}
                  className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background px-3 py-1.5 rounded-lg text-[13px] font-bold border transition-colors ${
                    exposureMode === m
                      ? m === "include" ? "bg-foreground text-white border-foreground" : "bg-error-strong text-white border-error-strong"
                      : "bg-white text-gray-700 border-border-strong hover:border-gray-300"
                  }`}
                >
                  {label}
                </button>
              ))}
              <span className="text-[12px] text-muted-foreground">제외는 규칙보다 우선해요</span>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
              {/* 현황 조회 실패를 '규칙 없음'으로 위장하지 않는다 — 규칙이 있는데 못 읽으면 서버가 400으로 막고,
                  화면엔 2택이 안 떠서 매니저는 막힌 이유를 알 수 없게 된다. */}
              {exposureImpactError && (
                <div className="text-[12px] leading-snug text-error-strong bg-error-soft border border-error/30 rounded-lg px-3 py-2">
                  공고 노출 현황을 불러오지 못했어요 — 저장된 규칙·연결 인원을 확인할 수 없어 적용이 막힐 수 있어요.
                  <button onClick={() => void mutateExposureImpact()} className="ml-1 font-bold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">다시 시도</button>
                </div>
              )}
              {/* 응답은 왔지만 이 공고만 빠진 경우 — 버튼이 이유 없이 비활성으로 보이지 않게 그 공고를 이름으로 지목한다.
                  (조회 상한을 넘겼거나 그새 삭제·시스템 공고로 걸러진 공고) */}
              {!exposureImpactError && exposureImpact && exposureUnknownJobs.length > 0 && (
                <div className="text-[12px] leading-snug text-warning-strong bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
                  이 공고의 노출 현황을 못 읽었어요 — <b>{exposureUnknownJobs.map((j) => j.title).join(", ")}</b>. 규칙이 있는지 알 수 없어 적용할 수 없습니다.
                  <button onClick={() => void mutateExposureImpact()} className="ml-1 font-bold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">다시 시도</button>
                  {" "}또는 선택을 해제하고 진행하세요.
                </div>
              )}
              {activeJobs.length === 0 && <div className="text-[13px] text-muted-foreground text-center py-8">진행 중인 공고가 없어요</div>}
              {activeJobs.map((j) => {
                const on = exposureJobIds.has(j.id);
                const im = impactById.get(j.id);
                // 노출 방식은 조회한 현황을 우선 — 공고 목록 캐시는 전환 직후 옛 값을 들고 있을 수 있다.
                const ex = im?.exposure ?? j.exposure;
                return (
                  <button
                    key={j.id}
                    onClick={() => setExposureJobIds((prev) => { const next = new Set(prev); if (next.has(j.id)) next.delete(j.id); else next.add(j.id); return next; })}
                    className={`outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full text-left flex items-start gap-3 p-3.5 rounded-2xl border transition-all ${on ? "border-foreground ring-1 ring-foreground bg-background" : "border-border-strong hover:border-gray-300"}`}
                  >
                    <span className={`w-4 h-4 mt-0.5 rounded border flex items-center justify-center shrink-0 ${on ? "bg-foreground border-foreground" : "border-gray-300"}`}>
                      {on && <Check size={12} className="text-white" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-bold text-foreground truncate">{j.title}</div>
                      {j.branch && <div className="text-[12px] text-muted-foreground">{j.branch}</div>}
                      {/* 현황 한 줄 — 규칙이 남아 있는지가 핵심(전환만 하면 고르지 않은 인원에게도 보인다) */}
                      <div className="text-[12px] text-muted-foreground mt-0.5 leading-snug">
                        {im ? (
                          <>
                            {im.rule_conditions > 0 ? (
                              <span className="font-bold text-warning-strong">자동 규칙 {im.rule_conditions}개 · 해당 {im.rule_matched}명</span>
                            ) : (
                              <span>자동 규칙 없음</span>
                            )}
                            {im.include_count > 0 && <> · 명단 {im.include_count}명</>}
                            {im.exclude_count > 0 && <> · 제외 {im.exclude_count}명</>}
                            {im.linked > 0 && <> · 이 공고로 연결됨 {im.linked}명</>}
                          </>
                        ) : (
                          <span className="text-muted-foreground">현황 불러오는 중…</span>
                        )}
                      </div>
                    </div>
                    {im && !im.pull_exposed ? (
                      // external(새로 모집) — 맞춤 공고 링크에 애초에 안 뜬다. '전체 노출 = 전원에게 보임'은 거짓이고
                      // 노출 명단도 효력이 없다(전환도 서버가 막는다).
                      <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0" title="이 공고는 공개 게시 링크로만 유통돼요. 맞춤 공고 링크에는 뜨지 않아 노출 명단이 효력을 갖지 않습니다.">새로 모집 — 링크 미노출</span>
                    ) : ex === "targeted" ? (
                      <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-info-soft text-info-strong border border-info/25 shrink-0">지정 노출</span>
                    ) : (
                      <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0" title="지금은 인재풀 전원에게 보이는 공고예요. 아래 '지정 노출로 전환'을 켜면 이 명단에게만 보이게 바뀝니다.">전체 노출</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 원클릭 전환 + 규칙 2택 — 노출을 좁히는 결정은 여기서 명시적으로 고른다(조용한 소거 금지) */}
            {exposureMode === "include" && exposureJobIds.size > 0 && (
              <div className="px-5 py-3 border-t border-muted bg-surface-raised space-y-3">
                {exposureFlipJobs.length > 0 && (
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={exposureMakeTargeted}
                      onChange={(e) => setExposureMakeTargeted(e.target.checked)}
                      className="mt-0.5 accent-foreground"
                    />
                    <span className="text-[13px] font-bold text-foreground leading-snug">
                      전체 노출 공고 {exposureFlipJobs.length}개를 &lsquo;지정 노출&rsquo;로 함께 전환
                      <span className="block text-[12px] font-semibold text-muted-foreground mt-0.5">
                        끄면 명단만 저장돼요 — 공고는 계속 인재풀 전원에게 보입니다(명단이 효력을 갖지 않아요).
                      </span>
                    </span>
                  </label>
                )}
                {exposureRuleJobs.length > 0 && (
                  <div role="radiogroup" aria-label="저장된 자동 노출 규칙 처리">
                    <div className="text-[12px] font-bold text-warning-strong mb-1.5">
                      {exposureRuleJobs.length === 1 ? "이 공고엔" : `고른 공고 ${exposureRuleJobs.length}개엔`} 자동 노출 규칙이 저장돼 있어요 — 어떻게 할까요?
                    </div>
                    {([
                      ["keep", `규칙을 두고 이 ${selectedRows.size}명을 추가`, "규칙 해당 인원 + 이 명단 모두에게 보여요"],
                      ["clear", `규칙을 지우고 이 ${selectedRows.size}명만`, "규칙으로만 들어온 인원은 빠져요. 지운 규칙은 되돌릴 수 없어요."],
                    ] as ["keep" | "clear", string, string][]).map(([k, label, desc]) => (
                      <label key={k} className="flex items-start gap-2 cursor-pointer py-1">
                        <input
                          type="radio"
                          name="exposure-rule-action"
                          checked={exposureRuleAction === k}
                          onChange={() => setExposureRuleAction(k)}
                          className="mt-0.5 accent-foreground"
                        />
                        <span className="text-[13px] font-bold text-foreground leading-snug">
                          {label}
                          <span className="block text-[12px] font-semibold text-muted-foreground mt-0.5">{desc}</span>
                        </span>
                      </label>
                    ))}
                    <div className="text-[11px] text-muted-foreground mt-1 leading-snug">
                      {exposureRuleJobs.map((j) => `${j.title} — ${(impactById.get(j.id)?.rule_labels ?? []).join(" / ")}`).join(" | ")}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="px-5 py-3.5 border-t border-border-strong flex items-center justify-between gap-3">
              <span className="text-[12px] text-muted-foreground leading-snug">
                노출 대상은 후보 등록이 아니에요 — 맞춤 공고 링크에 공고가 보일 뿐, 배정·확정이 아닙니다.
                <br />명단 확인·개별 제외는 공고 수정 → &lsquo;노출 대상 명단&rsquo;에서 할 수 있어요.
              </span>
              <Button variant="primary" size="chip" className="px-4 py-2 text-[13px] rounded-2xl" onClick={assignExposure} isLoading={exposureSaving} disabled={
                      exposureJobIds.size === 0 ||
                      // 규칙 2택을 고르지 않으면 진행 불가 — 기본값으로 조용히 정하지 않는다.
                      (exposureMode === "include" && exposureRuleJobs.length > 0 && exposureRuleAction === null) ||
                      // 현황을 못 읽은 공고가 있으면 규칙 유무를 알 수 없다(서버 400으로 막히는데 화면엔 2택이 없다).
                      (exposureMode === "include" && exposureUnknownJobs.length > 0)
                    }>
                      {!exposureSaving && <Eye size={14} />}
                      {exposureMode === "exclude"
                        ? "노출 제외"
                        : /* 규칙을 두면 '명단에게만'이 아니다(규칙 해당 인원도 함께 본다) — 버튼이 거짓말하지 않게. */
                          exposureWillFlip && !(exposureRuleAction === "keep" && exposureRuleJobs.length > 0)
                          ? "이 명단에게만 노출"
                          : "노출 추가"}{" "}
                      ({exposureJobIds.size})
                    </Button>
            </div>
        </Modal>
      )}

      <ApplicantDetailPanel
        isOpen={selectedApplicantId != null}
        docked={splitPanelActive}
        onClose={() => setSel(null)}
        applicantId={selectedApplicantId}
        /* 표시 기준 공고 — 목록의 공고 배지를 눌러 들어왔으면 그 공고, 아니면 진행 중 공고 포인터.
           (포인터라도 넘겨야 여러 공고 진행자의 AI 토글이 409로 막히지 않는다. 패널 안에서 다시 고를 수 있다.) */
        jobId={
          sel?.wantJobId ??
          ((rawApplicants.find((a) => a.id === selectedApplicantId) as { current_job_id?: number | null } | undefined)
            ?.current_job_id ??
            null)
        }
        onChanged={loadApplicants}
      />

      {/* Modals for Bulk Actions */}
      {/* 1. Bulk Stage Change Modal */}
      {bulkStageModalOpen && (
        <Modal bare open={bulkStageModalOpen} onClose={() => setBulkStageModalOpen(false)} size="md"
               title="일괄 상태 변경"
               className="max-w-[500px] sm:max-w-[500px]"
        >
            <div className="p-5 border-b border-border-strong bg-background flex justify-between items-center">
              <div>
                <h2 className="text-[16px] font-bold text-foreground">일괄 상태(파이프라인) 변경</h2>
                <div className="text-[13px] text-muted-foreground mt-0.5">선택된 {selectedRows.size}명의 지원자를 어떤 단계로 이동시킬까요?</div>
              </div>
              <button aria-label="일괄 상태 변경 창 닫기" onClick={() => setBulkStageModalOpen(false)} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-muted-foreground hover:text-gray-700"><X size={20} /></button>
            </div>
            <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { id: "applied", label: "지원 접수 / 대기", desc: "스크리닝 전" },
                { id: "screening", label: "AI 스크리닝 중", desc: "체크리스트 진행" },
                { id: "interview", label: "스크리닝 완료", desc: "온보딩 진행" },
                // '확정 인력'은 일괄 옵션에서 제외 — 확정은 대상 공고·시작일 결속이 필요해 개인 단위
                // 상세 확정 모달로만 한다(일괄 원클릭 오확정·통계 오염 방지).
                { id: "rejected", label: "부적합", desc: "인력풀 제외 · 전체 공고에서 빠짐" }
              ].map(stage => (
                <button key={stage.id} onClick={() => handleBulkStageChange(stage.label)} className="p-4 border border-border-strong rounded-2xl text-left hover:border-brand-yellow hover:bg-yellow-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <div className="text-[14px] font-bold text-foreground mb-1">{stage.label}</div>
                  <div className="text-[12px] text-muted-foreground">{stage.desc}</div>
                </button>
              ))}
            </div>
        </Modal>
      )}

      {/* 2. Bulk Message/Campaign Modal */}
      {bulkMsgModalOpen && (
        <Modal bare open={bulkMsgModalOpen} onClose={() => setBulkMsgModalOpen(false)} size="lg"
               title="문자 캠페인 발송"
               closeOnOutside={false}
               className="max-w-[600px] sm:max-w-[600px]"
        >
            <div className="p-5 border-b border-border-strong bg-background flex justify-between items-center">
              <div>
                <h2 className="text-[16px] font-bold text-foreground">선택 인원 대상 문자(SMS) 캠페인 발송</h2>
                <div className="text-[13px] text-muted-foreground mt-0.5">실제 발송 대상 {modalRecipientCount}명에게 일괄 발송됩니다.</div>
              </div>
              <button aria-label="문자 보내기 창 닫기" onClick={() => setBulkMsgModalOpen(false)} className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background text-muted-foreground hover:text-gray-700"><X size={20} /></button>
            </div>
            <div className="p-6 space-y-5">
              {/* 선택 대비 실제 수신 차감 경고 — 필터로 화면에서 빠졌거나 연락처가 없는 인원은 발송되지 않는다 */}
              {modalExcludedCount > 0 && (
                <div className="px-4 py-2.5 rounded-2xl bg-yellow-50 border border-warning/35 text-[13px] font-bold text-warning-strong">
                  선택 {selectedRows.size}명 중 {modalExcludedCount}명은 지금 조건에서 벗어났거나 연락처가 없어 제외됩니다.
                </div>
              )}
              {selectedOptOutCount > 0 && (
                <div className="px-4 py-2.5 rounded-2xl bg-error-soft border border-error/30 text-[13px] font-bold text-error-strong">
                  수신거부 {selectedOptOutCount}명은 서버가 자동 제외합니다.
                </div>
              )}
              {/* 확정인력 포함 — 막지 않는다. 운행이 멈춰 대기 중인 확정자에게 다른 라인을 안내하는 건 정당한 발송이다.
                  다만 '지금 근무 중인 분에게 다른 일 권유'가 되는 경우도 있어 수를 밝혀 의식적으로 고르게 한다. */}
              {selectedConfirmedCount > 0 && (
                <div className="px-4 py-2.5 rounded-2xl bg-yellow-50 border border-yellow-300 text-[13px] font-bold text-warning-strong">
                  이미 확정된 분 {selectedConfirmedCount}명이 포함돼 있어요 — 운행이 멈춰 대기 중인 분이라면 보내도 되고, 지금 근무 중인 분이면 진행 단계 조건에서 <b>확정인력</b>을 빼고 보내세요.
                </div>
              )}

              {/* 템플릿↔대상 경고 — B안(최근 6개월용)에 원지원 6개월 초과자가 섞임(발송은 막지 않음, 인지용) */}
              {bCohortMismatchCount > 0 && (
                <div className="px-4 py-2.5 rounded-2xl bg-yellow-50 border border-yellow-300 text-[13px] font-bold text-warning-strong">
                  ⚠️ B안은 최근 6개월 안에 지원한 분들에게 맞는 문구예요 — 현재 대상 중 {bCohortMismatchCount}명이 6개월 초과(원지원일 미상 포함)예요. A안 사용을 검토하세요.
                </div>
              )}

              {/* 옹매니징 현재 활동 중 대조 */}
              {activeCheckLoading && (
                <div className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-background border border-border-strong text-[13px] font-bold text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> 현재 활동 중인 인원을 확인하고 있어요...
                </div>
              )}
              {!activeCheckLoading && activeCheck && !activeCheck.configured && (
                <div className="px-4 py-2.5 rounded-2xl bg-muted border border-border-strong text-[13px] font-bold text-muted-foreground">
                  미연동 — 활동 여부 확인 불가
                </div>
              )}
              {!activeCheckLoading && activeCheck && activeCheck.configured && activeCheck.active.length > 0 && (
                <div className="rounded-2xl bg-yellow-50 border border-yellow-300 p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-[13px] font-extrabold text-warning-strong">
                      현재 활동 중인 인원 {activeCheck.active.length}명이 포함되어 있어요
                    </div>
                    <Button variant="primary" size="chip" className="shrink-0 px-3 py-1.5 text-[12px] rounded-lg bg-warning hover:bg-warning-strong text-white shadow-none focus-visible:ring-warning" onClick={excludeActiveFromSelection}><UserX size={14} /> 활동 중 전원 제외</Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {activeCheck.active.map((p) => {
                      // 사유가 지난달 정산뿐이면(활성 계약 없음) 판단 여지가 커 배지를 약하게 표시.
                      const onlySettlement = p.reasons.length > 0 && p.reasons.every((r) => r === "recent_settlement");
                      return (
                        <span
                          key={p.id}
                          className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-bold border ${onlySettlement ? 'bg-white border-border-strong text-muted-foreground' : 'bg-yellow-100 border-yellow-300 text-warning-strong'}`}
                        >
                          {p.name}
                          {p.reasons.includes("active_contract") && (
                            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-warning-soft text-warning-strong">활성 계약</span>
                          )}
                          {p.reasons.includes("recent_settlement") && (
                            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">지난달 정산</span>
                          )}
                          {p.reasons.includes("tms_active") && (
                            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-warning-soft text-warning-strong">실배차(옹고잉)</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                  <p className="text-[12px] leading-relaxed text-warning-strong">
                    다시 연락(구직 안내) 목적이라면 제외하세요. 현재 라인과 시간대가 겹치지 않는 병행 가능 건이라면 유지해도 됩니다 — 발송 목적에 따라 판단하세요.
                  </p>
                </div>
              )}
              {/* 미확인(TMS 동기 전) / 확인 상한 초과 — '대조했고 0명'이라는 거짓 안심 방지(NULL≠비활동) */}
              {!activeCheckLoading && activeCheck && activeCheck.configured && (() => {
                const unchecked = activeCheck.unchecked ?? 0;
                const truncated = selectedRows.size > 500 ? selectedRows.size - 500 : 0;
                if (unchecked === 0 && truncated === 0) return null;
                return (
                  <div className="px-4 py-2.5 rounded-2xl bg-error-soft border border-error/30 text-[12px] font-semibold text-error-strong leading-relaxed space-y-1">
                    {unchecked > 0 && (
                      <div>· 활동 미확인 {unchecked}명 — TMS 동기화 전이라 아직 대조되지 않았어요. 실제 활동 중일 수 있으니 발송 전 확인하세요.</div>
                    )}
                    {truncated > 0 && (
                      <div>· 선택 {selectedRows.size}명 중 앞 500명만 활동 확인했어요. 나머지 {truncated}명은 미확인이에요.</div>
                    )}
                  </div>
                );
              })()}
              {/* 야간 안내 — 이 화면 벌크 발송에만 야간 게이트가 없었다(공고탭 안내·cron은 KST 21~08 차단).
                  막지는 않는다(긴급 결원 대응). 작성 중에 보이게 여기, 마지막 확인 모달에 한 번 더. */}
              {isNightKstNow() && (
                <div className="px-4 py-2.5 rounded-2xl bg-yellow-50 border border-yellow-300 text-[12px] font-semibold text-warning-strong leading-relaxed">
                  지금은 심야(21~08시)예요. 시니어 대상 심야 문자는 민원이 되기 쉬워요 — 급하지 않으면 아침 9시 이후 발송을 권합니다.
                </div>
              )}
              <div>
                <label className="text-[13px] font-bold text-gray-700 block mb-2">메시지 템플릿</label>
                <select
                  onChange={(e) => { if (e.target.value) setBulkMsgBody(e.target.value); }}
                  className="pr-8 w-full border border-border-strong rounded-2xl px-4 py-3 text-[14px] outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring bg-white"
                >
                  <option value="">직접 입력하기</option>
                  <option value={DEFAULT_BULK_BODY}>다시 연락 A안 (전체 기본)</option>
                  <option value={RECONTACT_B_BODY}>다시 연락 B안 (최근 6개월·짧게)</option>
                  <option value={WAITLIST_BODY}>관심 대기 안내 (사후관리)</option>
                  <option value="안녕하세요, 지원해주셔서 감사합니다! 근무 시작 안내를 위해 본 문자에 답장 부탁드립니다.">근무 시작 안내</option>
                  <option value="지원해주신 내용 중 일부 확인이 필요합니다. 본 문자에 답장 주시면 안내드리겠습니다.">추가 정보 확인 요청</option>
                </select>
              </div>
              <div>
                <label className="text-[13px] font-bold text-gray-700 block mb-2">메시지 본문</label>
                <textarea
                  value={bulkMsgBody}
                  onChange={(e) => setBulkMsgBody(e.target.value)}
                  className="w-full h-[150px] border border-border-strong rounded-2xl p-4 text-[14px] outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring resize-none leading-relaxed text-gray-800 bg-background"
                />
                <p className="mt-1.5 text-[12px] text-muted-foreground">치환자: <b className="text-muted-foreground">#{"{이름}"}</b> 수신자 이름 · <b className="text-muted-foreground">#{"{맞춤링크}"}</b> 본인 전용 맞춤 공고 링크</p>
              </div>
            </div>
            <div className="p-5 border-t border-border-strong bg-white flex justify-between items-center">
              {/* 비용은 대표 샘플(이름 3자·실제 길이 더미 링크) 치환 후 기준 × 실제 수신자 수 */}
              {(() => {
                const est = estimateSmsCost(fillSampleVars(bulkMsgBody));
                return (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-bold text-muted-foreground">예상 비용: {est.sms_type} · 약 {(est.cost_krw * modalRecipientCount).toLocaleString()}원 (1인 {est.cost_krw}원 × {modalRecipientCount}명)</span>
                    {Math.abs(est.bytes - 90) <= 10 && (
                      <span className="text-[12px] font-semibold text-warning-strong">문자 길이가 단문 한도(90바이트)에 걸쳐 있어요 — 수신자 이름 길이에 따라 장문(LMS) 요금으로 나갈 수 있어요.</span>
                    )}
                  </div>
                );
              })()}
              <div className="flex gap-2">
                <Button variant="secondary" size="lg" onClick={() => setBulkMsgModalOpen(false)}>취소</Button>
                {/* **발송 실패 명단** — 창을 닫기 전까지 남는다. 사유가 사람마다 다르므로 그대로 보여준다. */}
                {bulkFailures.length > 0 && (
                  <div className="w-full mb-3 rounded-2xl border border-error/30 bg-error-soft p-3">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <div className="text-[13px] font-bold text-error-strong">
                        못 보낸 {bulkFailures.length}명 — 사유를 확인하고 필요하면 다시 보내세요
                      </div>
                      <Button
                        size="chip"
                        variant="secondary"
                        className="shrink-0 px-3 py-1.5 text-[12px] rounded-lg border-error/30 text-error-strong hover:bg-error-soft"
                        onClick={() => {
                          // 실패한 사람만 선택으로 되돌린다 — 서버 10분 중복 가드가 이미 나간 인원의 재발송을 막는다.
                          setSelectedRows(new Set(bulkFailures.map((f) => String(f.applicantId)).filter((v) => v !== "0")));
                          setBulkFailures([]);
                          toast.info(`실패한 ${bulkFailures.length}명만 선택했어요 — 문구를 확인하고 다시 발송하세요.`);
                        }}
                      >
                        이 {bulkFailures.length}명만 다시 보내기
                      </Button>
                    </div>
                    <div className="max-h-[140px] overflow-y-auto flex flex-col gap-0.5 [&>*]:shrink-0">
                      {bulkFailures.map((f, i) => (
                        <div key={`${f.phone}-${i}`} className="text-[12px] text-error-strong flex items-center gap-2">
                          <span className="font-bold shrink-0">{f.name}</span>
                          <span className="text-muted-foreground shrink-0">{f.phone}</span>
                          <span className="truncate">{f.error}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <Button variant="primary" size="lg" onClick={handleBulkSend} isLoading={bulkSending}>
                  {!bulkSending && <Mail size={16} />} {bulkSending ? "발송 중..." : "캠페인 발송"}
                </Button>
              </div>
            </div>
        </Modal>
      )}

    </DndProvider>
  );
}

// 캠페인 퍼널 보드 — 코호트(기간 내 ping_sent) 멤버를 '최고 단계'별 4컬럼으로 나열.
// 대시보드 캠페인 카드가 숫자 요약이라면, 이 보드는 사람 명단 — 카드 클릭으로 바로 상세(개별 액션)로 잇는다.
// 드래그 없음: 단계는 이벤트 사실(열람/관심/답장)이라 매니저가 옮길 수 있는 상태가 아니다.
const FUNNEL_COLUMN_DEFS: { id: FunnelStage; title: string }[] = [
  { id: "sent", title: "📤 발송됨" },
  { id: "viewed", title: "👀 열람" },
  { id: "interested", title: "⭐ 관심" },
  { id: "replied", title: "💬 답장" },
];
const FUNNEL_STAGE_ORDER: FunnelStage[] = ["sent", "viewed", "interested", "replied"];

// 가용성 배지 톤 — InterestQueueCard와 동일 기준(즉시가능 초록 강조, 이번주가능 연녹, 그 외 회색).
function funnelAvailabilityBadge(availability: string | null): { label: string; cls: string } {
  if (availability === "즉시가능")
    return { label: "즉시가능", cls: "bg-success-soft text-success-strong border-success-soft" };
  if (availability === "이번주가능")
    return { label: "이번주가능", cls: "bg-success-soft text-success-strong border-success/25" };
  if (availability === "휴면")
    return { label: "휴면", cls: "bg-background text-muted-foreground border-border-strong" };
  return { label: availability ?? "미확인", cls: "bg-background text-muted-foreground border-border-strong" };
}

interface FunnelBoardProps {
  data: CampaignFunnelRes | undefined;
  error: unknown;
  days: number;
  onDaysChange: (days: number) => void;
  onRefresh: () => void;
  isValidating: boolean;
  query: string; // 소문자 trim된 검색어 — 이름 매칭만 적용(고급 필터는 이 뷰에 비적용)
  onCardClick: (applicantId: number) => void;
}

function FunnelBoard({ data, error, days, onDaysChange, onRefresh, isValidating, query, onCardClick }: FunnelBoardProps) {
  const members = data?.members ?? [];
  const visible = query ? members.filter((m) => (m.name ?? "").toLowerCase().includes(query)) : members;
  const byStage = new Map<FunnelStage, FunnelMember[]>(FUNNEL_COLUMN_DEFS.map((d) => [d.id, []]));
  for (const m of visible) byStage.get(m.stage)?.push(m);
  const total = visible.length;
  // 발송 대비 % = '이 단계 이상 도달' 누적 기준 (열람률 등 — 대시보드 캠페인 카드와 동일 시맨틱)
  const reachedFrom = (stage: FunnelStage) => {
    const idx = FUNNEL_STAGE_ORDER.indexOf(stage);
    return visible.filter((m) => FUNNEL_STAGE_ORDER.indexOf(m.stage) >= idx).length;
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 상단 컨트롤 — 발송 묶음 요약 + 기간 셀렉트 + 새로고침 */}
      <div className="px-8 pt-6 pb-3 flex items-center gap-3 shrink-0 flex-wrap">
        <span className="text-[13px] font-bold text-gray-700" title="발송 묶음 — 이 기간 안에 다시 연락 문자를 받은 인원">
          최근 {data?.window_days ?? days}일 발송 묶음 <span className="text-info">{members.length}명</span>
          {query && <span className="text-muted-foreground font-semibold"> · 검색 일치 {visible.length}명</span>}
        </span>
        <div className="flex-1" />
        <select
          value={String(days)}
          onChange={(e) => onDaysChange(Number(e.target.value))}
          className="pr-8 px-3 py-1.5 bg-white border border-border-strong rounded-lg text-[13px] font-semibold text-gray-700 outline-none focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-ring shadow-sm cursor-pointer"
          title="발송 묶음 기간 — 이 기간 안에 다시 연락 문자를 받은 인원"
        >
          <option value="7">최근 7일</option>
          <option value="14">최근 14일</option>
          <option value="30">최근 30일</option>
        </select>
        <Button variant="secondary" size="chip" className="px-2.5 py-1.5 text-[13px] rounded-lg" onClick={onRefresh} title="캠페인 단계별 현황 새로고침"><RefreshCw size={13} className={isValidating ? "animate-spin" : ""} /> 새로고침</Button>
      </div>

      {error ? (
        <div className="flex-1 flex items-center justify-center text-[13px] text-error">캠페인 단계별 현황을 불러오지 못했어요. 오른쪽 위 &lsquo;새로고침&rsquo;을 눌러 다시 시도해 주세요.</div>
      ) : !data ? (
        <div className="flex-1 flex items-center justify-center text-[13px] text-muted-foreground">
          <Loader2 size={15} className="animate-spin mr-1.5" /> 불러오는 중…
        </div>
      ) : members.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-8">
          <div className="text-[14px] font-bold text-gray-700">최근 {data.window_days}일 캠페인 발송이 없어요</div>
          <div className="text-[13px] text-muted-foreground">리스트 뷰에서 대상을 골라 다시 연락 문자를 보내면 여기에 단계별로 반응이 쌓여요.</div>
        </div>
      ) : (
        <div className="flex gap-6 flex-1 overflow-x-auto px-8 pb-8">
          {FUNNEL_COLUMN_DEFS.map((col, idx) => {
            const cards = byStage.get(col.id) ?? [];
            const reached = reachedFrom(col.id);
            return (
              <motion.div
                key={col.id}
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: idx * 0.05 }}
                className="flex flex-col w-[300px] shrink-0 bg-muted rounded-lg p-4 border border-border-strong shadow-sm"
              >
                <div className="flex items-center justify-between mb-4 px-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[16px] font-extrabold text-foreground">{col.title}</h2>
                    <span className="text-[12px] font-bold text-muted-foreground bg-gray-200 px-2.5 py-0.5 rounded-full">{cards.length}</span>
                  </div>
                  {col.id !== "sent" && total > 0 && (
                    <span
                      title={`발송 ${total}명 중 이 단계 이상 도달 ${reached}명`}
                      className="text-[11px] font-bold text-muted-foreground bg-white border border-border-strong px-2 py-0.5 rounded-full"
                    >
                      발송 대비 {Math.round((reached / total) * 100)}%
                    </span>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 pb-2 scrollbar-custom">
                  {cards.map((m) => {
                    const badge = funnelAvailabilityBadge(m.availability);
                    return (
                      <button
                        key={m.applicant_id}
                        onClick={() => onCardClick(m.applicant_id)}
                        title="클릭하면 지원자 상세를 엽니다"
                        className={`w-full text-left bg-card border border-border-strong rounded-2xl p-3.5 shadow-sm hover:border-brand-yellow hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${m.opted_out ? "opacity-60 grayscale" : ""}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[14px] font-bold text-foreground truncate">{m.name || "이름 미상"}</span>
                          </div>
                          <span className="text-[11px] text-muted-foreground shrink-0" title="이 단계 마지막 이벤트 시각">{relTime(m.last_event_at)}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1 mt-1.5">
                          {m.sigungu && (
                            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{m.sigungu}</span>
                          )}
                          <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
                          {m.opted_out && (
                            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full border bg-error-soft text-error-strong border-error/30">수신거부</span>
                          )}
                        </div>
                        {m.stage === "interested" && m.interest_job_title && (
                          <div className="flex items-center gap-1.5 mt-1.5 text-[12px] text-gray-700">
                            <span className="font-semibold truncate">{m.interest_job_title}</span>
                            {m.immediate && (
                              <span className="flex items-center gap-0.5 text-success-strong font-bold shrink-0">
                                <Zap size={11} /> 즉시가능
                              </span>
                            )}
                          </div>
                        )}
                      </button>
                    );
                  })}
                  {cards.length === 0 && (
                    <div className="h-[100px] bg-white/40 border-2 border-dashed border-gray-300 rounded-2xl flex items-center justify-center text-[13px] font-bold text-muted-foreground">
                      해당 단계 인원 없음
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// 첫 진입(캐시 없음) 로딩 중 빈 화면 대신 보여주는 목록 스켈레톤. 콘텐츠 영역을 덮는 오버레이.
function PipelineSkeleton() {
  return (
    <div className="absolute inset-0 z-10 bg-white p-8 overflow-hidden">
      <Skeleton className="h-10 w-full rounded-lg mb-3" />
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 py-3 border-b border-muted">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-9 w-9 rounded-full" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
          <div className="flex-1" />
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

// Kanban Column Component
interface KanbanColumnProps {
  column: ColumnData;
  moveCard: (cardId: string, sourceColId: string, destColId: string) => void;
  onCardClick: (id: string) => void;
  columnIndex: number;
  onExport: (column: ColumnData) => void;
  onBulkMessage: (column: ColumnData) => void;
}

/** 적용 중 조건 알약 — 조건 바가 "무엇으로 좁혔나"를 숫자로만 말하던 것을 문장으로. */
function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-brand-yellow bg-yellow-50 py-0.5 pl-2.5 pr-1 text-[12px] font-bold text-warning-strong">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`${label} 조건 해제`}
        className="grid h-5 w-5 place-items-center rounded-full transition-colors hover:bg-brand-yellow/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X size={12} />
      </button>
    </span>
  );
}

function KanbanColumn({ column, moveCard, onCardClick, columnIndex, onExport, onBulkMessage }: KanbanColumnProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [{ isOver }, drop] = useDrop(() => ({
    accept: ITEM_TYPE,
    drop: (item: { id: string; sourceColId: string }) => {
      moveCard(item.id, item.sourceColId, column.id);
    },
    collect: (monitor) => ({
      isOver: !!monitor.isOver()
    })
  }));

  return (
    <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: columnIndex * 0.05 }} ref={drop as any} className={`flex flex-col w-[320px] shrink-0 bg-muted rounded-lg p-4 transition-colors duration-200 border border-border-strong shadow-sm ${isOver ? 'ring-2 ring-brand-yellow bg-yellow-50/50' : ''}`}>
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${column.color}`} />
          <h2 className="text-[16px] font-extrabold text-foreground">{column.title}</h2>
          <span className="text-[12px] font-bold text-muted-foreground bg-gray-200 px-2.5 py-0.5 rounded-full">{column.count}</span>
        </div>
        <div className="relative">
          <button aria-label="이 단계 메뉴 열기" onClick={() => setMenuOpen((v) => !v)} className="text-muted-foreground hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"><MoreHorizontal size={18} /></button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-7 z-30 w-[200px] bg-white border border-border-strong rounded-2xl shadow-lg py-1.5">
                <button
                  onClick={() => { setMenuOpen(false); onExport(column); }}
                  className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] font-bold text-gray-700 hover:bg-background text-left"
                >
                  <FileDown size={15} className="text-muted-foreground" /> 이 단계 CSV 내보내기
                </button>
                <button
                  onClick={() => { setMenuOpen(false); onBulkMessage(column); }}
                  disabled={column.count === 0}
                  className="outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] font-bold text-gray-700 hover:bg-background text-left disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Mail size={15} className="text-muted-foreground" /> 이 단계 일괄 문자
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3 pr-1 pb-2 scrollbar-custom">
        {column.cards.map((card, idx) => (
          <KanbanCard key={card.id} card={card} columnId={column.id} onClick={() => onCardClick(card.id)} cardIndex={idx} />
        ))}
        {column.cards.length === 0 && (
          <div className="h-[120px] bg-white/40 border-2 border-dashed border-gray-300 rounded-2xl flex flex-col items-center justify-center text-muted-foreground gap-2">
            <div className="text-[13px] font-bold text-muted-foreground">대기 중인 지원자 없음</div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// Kanban Card Component
interface KanbanCardProps {
  card: CardData;
  columnId: string;
  onClick: () => void;
  cardIndex: number;
}

function KanbanCard({ card, columnId, onClick, cardIndex }: KanbanCardProps) {
  const [{ isDragging }, drag] = useDrag(() => ({
    type: ITEM_TYPE,
    item: { id: card.id, sourceColId: columnId },
    collect: (monitor) => ({ isDragging: !!monitor.isDragging() })
  }));

  return (
    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.2, delay: Math.min(cardIndex * 0.05, 0.5) + 0.1 }} ref={drag as any} onClick={onClick} className={`bg-card border border-border-strong rounded-2xl p-4 cursor-grab active:cursor-grabbing hover:border-brand-yellow hover:shadow-md transition-all ${isDragging ? 'opacity-50 ring-2 ring-brand-yellow' : 'shadow-sm'}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[14px] font-bold text-foreground">{card.name} <span className="text-[12px] text-muted-foreground font-medium ml-1">{card.age}세</span></div>
        <div className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-muted text-gray-700">{card.channel}</div>
      </div>
      <div className="flex flex-col gap-1.5 mb-3">
        <div className="text-[13px] text-gray-700 flex items-center gap-1.5"><span className="text-muted-foreground">근무지:</span> <b>{card.branch}</b></div>
        <div className="text-[13px] text-gray-700 flex items-center gap-1.5"><span className="text-muted-foreground">수단:</span> {card.tag}</div>
        <div className="text-[13px] text-gray-700 flex items-center gap-1.5"><span className="text-muted-foreground">희망:</span> {card.slot}</div>
      </div>
      <div className="border-t border-muted pt-3 flex justify-between items-center">
        <span className="text-[11px] text-muted-foreground">{card.exp}</span>
        <span className="text-[11px] font-medium text-muted-foreground bg-background px-2 py-1 rounded-full">{card.lastActive}</span>
      </div>
    </motion.div>
  );
}