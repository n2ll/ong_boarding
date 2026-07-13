import { useState, useEffect, useMemo } from "react";
import useSWR from "swr";
import { useSearchParams } from "next/navigation";
import { Filter, Search, MoreHorizontal, MessageCircle, Calendar, Check, X, UserX, Download, LayoutGrid, List as ListIcon, Columns, ArrowRight, UserPlus, FileDown, Tags, Mail, Loader2, Briefcase, Map as MapIcon, Funnel, RefreshCw, Zap } from "lucide-react";
import { PipelineMap, type MapApplicant, type MapJob } from "./PipelineMap";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { toast } from "sonner";
import { ApplicantDetailPanel } from "./ApplicantDetailPanel";
import { useConfirm } from "./ConfirmDialog";
import { motion, AnimatePresence } from "motion/react";
import { Applicant, calcAge, shortWorkHours } from "@/lib/admin/types";
import { useBranchScope, matchesBranchScope } from "@/lib/branch-scope";
import { Skeleton } from "@/components/ui/skeleton";

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
}

// Types
type VehicleClass = "확정" | "도보" | "미확인";

// pool_events 반응 요약 — /api/admin/pool-events/summary 응답의 지원자별 항목.
// 반응 배지(열람/관심/답장)·'재컨택 N일 전' 배지·'반응 있음' 필터·'반응 최신순' 정렬의 근거.
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
  unread_count: number;
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
  tag: string;
  vehicleClass: VehicleClass;
  region: string;
  exp: string;
  lastActive: string;
  phone: string | null;
  agentStage: string | null;
  status: string;
  availability: string | null;
  availabilityUpdatedAtIso: string | null;
  smsOptOutAt: string | null;
  sido: string | null;
  createdAtIso: string | null;
  lastMessageAtIso: string | null;
  accessToken: string | null;
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

// 재컨택 A안 (2026-07-10 다이어트, 전체 기본) — 지원 시점 뭉갬(오래된 코호트 안전), 문의 답장 유도, 짧게.
// 치환: #{이름}, #{맞춤링크}. 제목은 bulk-send subject로 분리(인사말 중복 방지). 확정 뉘앙스 금지·정보성.
const DEFAULT_BULK_BODY = `[옹고잉] #{이름}님, 안녕하세요. 예전에 배송 지원 설문을 남겨주셔서 연락드려요.

지금 #{이름}님께 맞는 배송 건이 있어요. 아래에서 조건(단가)을 보시고 괜찮으면 '관심 있음'만 눌러주세요. 매니저가 확인 후 연락드립니다.

#{맞춤링크}

궁금하시면 이 문자로 편하게 답장 주세요. (안내 중단: '그만' 회신)`;

// 재컨택 B안 (최근 6개월 이내 지원 코호트용 — 더 짧게)
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
  { id: "applied", title: "지원 접수 / 대기", color: "bg-[#CBD5E0]" },
  { id: "screening", title: "AI 스크리닝 중", color: "bg-[#F6E05E]" },
  { id: "interview", title: "스크리닝 완료", color: "bg-[#48BB78]" },
  { id: "passed", title: "확정 인력", color: "bg-[#3182CE]" },
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
  "확정 인력": "확정인력",
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

// 자차 3값 판정 — own_vehicle 원문 기준. 빈값/미지정/null은 '미확인'(발송 판단 시 누수 방지).
function vehicleClassOf(a: Applicant): VehicleClass {
  const v = a.own_vehicle?.trim();
  if (v === "있음" || v === "네" || v === "예") return "확정";
  if (v === "없음" || v === "아니오") return "도보";
  return "미확인";
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
// 14일 경계 — '최근 재컨택 제외' 필터 기준
const FOURTEEN_DAYS_MS = 1000 * 60 * 60 * 24 * 14;

// 발송 가능 여부 판정 — 연락처·맞춤링크(access_token)·수신거부 3조건. 불가 사유를 함께 도출.
function sendableOf(c: CardData): { sendable: boolean; reason: string | null } {
  if (!c.phone) return { sendable: false, reason: "연락처 없음" };
  if (!c.accessToken) return { sendable: false, reason: "맞춤 링크 없음" };
  if (c.smsOptOutAt) return { sendable: false, reason: "수신거부" };
  return { sendable: true, reason: null };
}

// 마지막 재컨택 경과 표기 — '재컨택 오늘/N일 전' (일 단위, 배지용). ping_sent 이력 없으면 null.
function recontactLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "재컨택 오늘";
  return `재컨택 ${days}일 전`;
}

// 원지원일 표기 — 'YYYY-MM' (연락 이력 relTime과 구분)
function appliedMonth(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// 목록 API가 추가로 내려주는 컬럼 — 공용 Applicant 타입엔 아직 없어 로컬 확장으로 소비.
type ApplicantRow = Applicant & { sms_opt_out_at?: string | null; access_token?: string | null; applied_at?: string | null };

function toCard(a: ApplicantRow): CardData {
  const branch = a.confirmed_branch?.trim() || a.branch1?.trim() || a.branch?.trim() || "-";
  const slot = shortWorkHours(a.confirmed_slot || a.work_hours) || "-";
  return {
    id: String(a.id),
    name: a.name ?? "-",
    age: calcAge(a.birth_date) ?? 0,
    channel: channelLabel(a.source),
    branch,
    slot,
    tag: vehicleTag(a),
    vehicleClass: vehicleClassOf(a),
    region: a.sigungu ?? a.location ?? "-",
    exp: a.experience?.trim() ? a.experience.trim() : "신입",
    // created_at 폴백은 '활동'으로 오독됨 — 발신/수신 이력이 없으면 없다고 표기
    lastActive: a.last_message_at ? relTime(a.last_message_at) : "연락 이력 없음",
    phone: a.phone ?? null,
    agentStage: a.agent_stage ?? null,
    status: a.status,
    availability: a.availability ?? null,
    availabilityUpdatedAtIso: a.availability_updated_at ?? null,
    smsOptOutAt: a.sms_opt_out_at ?? null,
    sido: a.sido ?? null,
    createdAtIso: a.created_at ?? null,
    lastMessageAtIso: a.last_message_at ?? null,
    accessToken: a.access_token ?? null,
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
  const [selectedApplicantId, setSelectedApplicantId] = useState<number | null>(null);
  const [view, setView] = useState<"kanban" | "list" | "map" | "funnel">("list");
  const [rawApplicants, setRawApplicants] = useState<Applicant[]>([]);

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
  const { data: jobsData } = useSWR<{ jobs?: Array<{ id: number; title: string; branch: string | null; pickup_lat?: number | null; pickup_lng?: number | null; pickup_address?: string | null; dropoff_lat?: number | null; dropoff_lng?: number | null; dropoff_address?: string | null }> }>("/api/admin/jobs?status=active");
  const visibleJobs = useMemo(() => (jobsData?.jobs ?? []).filter((j) => !String(j.title).startsWith("__")), [jobsData]);
  const activeJobs = useMemo(() => visibleJobs.map((j) => ({ id: j.id, title: j.title, branch: j.branch ?? null })), [visibleJobs]);
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
    // 필터 프리필로 진입했으면 고급 필터 패널을 열어 무엇이 적용됐는지 보이게 한다.
    if (region || vehicle || status || searchParams.get("recent")) setShowFilters(true);
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
  // 원지원 6개월 이내 코호트 필터 — 재컨택 B안(짧은 템플릿) 대상 격리용
  const [recentAppliedOnly, setRecentAppliedOnly] = useState(false);
  // 주소 확정(지오코딩) 필터 — geo_precision in exact/approx (지도·경로 매칭 신뢰 인원)
  const [geoConfirmedOnly, setGeoConfirmedOnly] = useState(false);
  // 옹매니징 활동 중 제외 필터 — 켜면 현재 활동 중(activeSet) 인원을 리스트에서 제외
  const [excludeActive, setExcludeActive] = useState(false);
  // 최근 14일 재컨택 제외 필터 — 켜면 해당 기간 내 ping_sent 이력이 있는 인원을 리스트에서 제외(중복 재컨택 방지)
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
  // 지원자별 pool_events 반응 요약 — 반응 배지·'재컨택 N일 전' 배지·반응 필터/정렬의 근거 (디바운스 배치 조회)
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
  // 선택된 거리 기준 공고의 양 끝점(상차지·마지막경유지) 좌표 — 존재하는 것만 담는다. 둘 다 없으면 null(거리 정렬 비활성).
  const distanceJobCoords = useMemo(() => {
    if (distanceJobId === null) return null;
    const j = distanceJobs.find((x) => x.id === distanceJobId);
    if (!j) return null;
    const pickup =
      typeof j.pickup_lat === "number" && typeof j.pickup_lng === "number"
        ? { lat: j.pickup_lat, lng: j.pickup_lng }
        : null;
    const dropoff =
      typeof j.dropoff_lat === "number" && typeof j.dropoff_lng === "number"
        ? { lat: j.dropoff_lat, lng: j.dropoff_lng }
        : null;
    return pickup || dropoff ? { pickup, dropoff } : null;
  }, [distanceJobId, distanceJobs]);

  // 필터·검색이 바뀌면 선택 해제 — 화면에서 사라진 인원에게 벌크 발송이 나가는 사고 방지.
  // 거리 기준 공고 변경도 정렬 순서를 바꿔 '상위 N'의 대상이 달라지므로 함께 초기화한다.
  useEffect(() => {
    setSelectedRows(new Set());
    setWaitlistJobId(null);
  }, [channelFilter, vehicleFilter, slotFilter, statusFilter, availabilityFilter, regionFilter, showExcluded, recentAppliedOnly, geoConfirmedOnly, excludeActive, excludeRecentPing, reactionOnly, optOutOnly, sortMode, distanceJobId, query]);

  // 저장된 세그먼트(필터 조합 프리셋) — 브라우저(localStorage)에 저장. 자주 쓰는 필터를 1클릭 재적용.
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
    };
    persistSegments([seg, ...segments.filter((s) => s.name !== name)]);
    setSegNameDraft("");
    toast.success(`세그먼트 '${name}'을 저장했어요`);
  };
  const applySegment = (seg: SavedSegment) => {
    setChannelFilter(new Set(seg.channels));
    setVehicleFilter(seg.vehicle);
    setSlotFilter(new Set(seg.slots));
    setQuery(seg.query ?? "");
    setStatusFilter(new Set(seg.statuses ?? []));
    setAvailabilityFilter(new Set(seg.availability ?? []));
    setRegionFilter(seg.region ?? "all");
    toast.info(`'${seg.name}' 세그먼트를 적용했어요`);
  };
  const deleteSegment = (id: string) => persistSegments(segments.filter((s) => s.id !== id));

  // Modals state
  const confirm = useConfirm();
  const [bulkMsgModalOpen, setBulkMsgModalOpen] = useState(false);
  const [bulkStageModalOpen, setBulkStageModalOpen] = useState(false);
  const [bulkMsgBody, setBulkMsgBody] = useState(DEFAULT_BULK_BODY);
  const [bulkSending, setBulkSending] = useState(false);

  // 옹매니징 '현재 활동 중' 대조 — 벌크 문자 모달이 열릴 때 선택 인원을 1회 조회.
  // configured=false면 미연동(대조 불가, 발송은 허용), active[]는 현재 활동 중인 인원.
  type ActiveCheck = { configured: boolean; checked: number; active: { id: number; name: string; reasons: string[] }[] };
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

  // 세그먼트 → 공고 타겟 전환: 선택된 지원자를 공고 후보로 일괄 추가
  const [jobPickerOpen, setJobPickerOpen] = useState(false);
  const [addingJobId, setAddingJobId] = useState<number | null>(null);

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
    .map((a) => ({ ...toCard(a), stage: a.status, stageColor: "bg-[#A0AEC0]", stageId: "excluded" }));

  const listCards = view === "list" && showExcluded ? [...allCards, ...excludedCards] : allCards;

  // 선택 인원 중 수신거부(sms_opt_out_at) 수 — 벌크 문자 모달 경고용(서버가 발송 시 자동 제외)
  const selectedOptOutCount = listCards.filter((c) => selectedRows.has(c.id) && c.smsOptOutAt).length;

  // 템플릿↔코호트 정합성 — B안(최근 6개월용)을 골랐는데 선택 대상에 원지원 6개월 초과자가 섞였으면 경고(발송은 막지 않음).
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
  const SLOT_TOKENS = ["평일 오전", "평일 오후", "주말 오전", "주말 오후"];
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

  const activeFilterCount =
    channelFilter.size + slotFilter.size + statusFilter.size + availabilityFilter.size +
    (vehicleFilter !== "all" ? 1 : 0) + (regionFilter !== "all" ? 1 : 0) +
    (recentAppliedOnly ? 1 : 0) + (geoConfirmedOnly ? 1 : 0) + (excludeActive ? 1 : 0) +
    (excludeRecentPing ? 1 : 0) + (reactionOnly ? 1 : 0) + (optOutOnly ? 1 : 0);

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
  };

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
    if (slotFilter.size && ![...slotFilter].some((s) => c.slot.includes(s))) return false;
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
  // 카드별 거리(km) — 후보↔{상차지, 마지막경유지} 중 '가까운 쪽'을 순위 근거로 쓴다(어느 끝이든 가까우면 상위).
  //   distByCardId: 정렬 키 = min(상차지 거리, 마지막경유지 거리) (존재하는 끝만).
  //   distDetailByCardId: 배지용 개별 거리(둘 중 있는 것만). 거리모드+공고좌표+카드좌표 모두 있을 때만 산출.
  const distByCardId: Record<string, number> = {};
  const distDetailByCardId: Record<string, { pickup: number | null; dropoff: number | null }> = {};
  if (sortMode === "distance" && distanceJobCoords) {
    for (const c of postFilteredCards) {
      if (typeof c.lat !== "number" || typeof c.lng !== "number") continue;
      const pickup = distanceJobCoords.pickup
        ? distKm(c.lat, c.lng, distanceJobCoords.pickup.lat, distanceJobCoords.pickup.lng)
        : null;
      const dropoff = distanceJobCoords.dropoff
        ? distKm(c.lat, c.lng, distanceJobCoords.dropoff.lat, distanceJobCoords.dropoff.lng)
        : null;
      const both = [pickup, dropoff].filter((d): d is number => d !== null);
      if (both.length === 0) continue;
      distByCardId[c.id] = Math.min(...both);
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

  // 발송 가능 인원 수 — 리스트 상단 이중 카운트("발송가능 N / 표시 M")
  const sendableCount = filteredCards.filter((c) => sendableOf(c).sendable).length;

  // 발송 모달 실제 수신 대상 — 화면 표시(filteredCards) ∩ 선택 ∩ 연락처 보유. handleBulkSend의 발송 대상과 동일 기준.
  // selectedRows.size 그대로 쓰면 필터로 화면에서 빠진 인원까지 세어 인원·비용이 부풀려진다.
  const modalRecipientCount = filteredCards.filter((c) => selectedRows.has(c.id) && c.phone).length;
  const modalExcludedCount = selectedRows.size - modalRecipientCount;

  // 리스트 레벨 옹매니징 활동중 조회 — 기준 집합 id(최대 500)로 디바운스(~400ms) 1회 조회.
  // 발송 모달 로직과 별개(중복 조회 허용). 실패는 조용히 무시(서버가 최종 가드).
  useEffect(() => {
    if (view !== "list") return;
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
  }, [visibleIdsKey, view]);

  // 리스트 레벨 pool_events 반응 요약 조회 — 기준 집합 id(최대 500)로 디바운스(~400ms) 1회 조회.
  // '재컨택 N일 전'·반응 배지와 '최근 14일 재컨택 제외'·'반응 있음' 필터, '반응 최신순' 정렬의 근거.
  // 실패는 조용히 무시(배지/필터는 부가정보). summaryVersion은 벌크 발송 직후 재조회 트리거.
  useEffect(() => {
    if (view !== "list") return;
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
  }, [visibleIdsKey, view, summaryVersion]);

  // 지도 뷰용 — 원본 지원자에 지점 스코프 + 검색어 필터 적용
  const mapApplicants: MapApplicant[] = rawApplicants
    .filter((a) => {
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
    const headers = ["ID", "이름", "나이", "진행단계", "지원채널", "지점", "희망근무", "차량", "지역", "연락처", "최근활동"];
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
    setBulkMsgModalOpen(true);
  };

  const moveCard = (cardId: string, sourceColId: string, destColId: string) => {
    if (sourceColId === destColId) return;

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
          }
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
        return toast.info(`관심자 ${interestedIds.length}명이 모두 확정인력이거나 현재 필터 밖이에요.`);
      }
      setSelectedRows(new Set(eligible.map((c) => c.id)));
      setWaitlistJobId(jobId);
      const excluded = interestedIds.length - eligible.length;
      toast.success(
        `공고 관심자 ${eligible.length}명을 선택했어요.${excluded > 0 ? ` (확정인력·필터 제외 ${excluded}명)` : ""}`
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
    if (recipients.length === 0) return toast.error("발송 가능한 연락처가 없어요.");

    // 대기 안내 프리셋이면 purpose='waitlist'(+ 공고 관심자 선택으로 고른 공고 id)를 실어 발송 이력을 남긴다.
    const isWaitlist = text === WAITLIST_BODY.trim();
    // 비용은 치환자 원문이 아닌 대표 샘플 치환 후 기준 — SMS/LMS 판정 오차 방지.
    const est = estimateSmsCost(fillSampleVars(text));
    if (!(await confirm({
      title: `${recipients.length}명에게 문자를 발송할까요?`,
      description: `실제 SMS가 즉시 발송됩니다. 되돌릴 수 없어요.\n예상 비용: ${est.sms_type} · 약 ${(est.cost_krw * recipients.length).toLocaleString()}원 (1인 ${est.cost_krw}원 × ${recipients.length}명)`,
      confirmText: `${recipients.length}명 발송`,
    }))) return;

    setBulkSending(true);
    try {
      let sent = 0;
      const failErrors: string[] = [];
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
          continue;
        }
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          chunkFailed += chunk.length;
          chunkErrorMsg = chunkErrorMsg ?? (json?.error || "발송 실패");
          continue;
        }
        sent += json.sent ?? 0;
        for (const r of (json.results ?? []) as Array<{ success: boolean; error?: string }>) {
          if (!r.success) failErrors.push(r.error ?? "");
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
      if (noToken) parts.push(`맞춤 링크 없음 ${noToken}명 제외`);
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
          toast.info("방금 발송한 인원이 리스트에 그대로 남아 있어요. 중복 재컨택을 막으려면 '최근 14일 재컨택 제외'를 켜세요.", {
            action: { label: "14일 제외 켜기", onClick: () => setExcludeRecentPing(true) },
          });
        }
      }
      // 청크 실패가 있으면 모달을 열어두고 선택 유지 — 재시도 판단을 매니저에게 남긴다
      // (서버 10분 중복 가드가 이미 나간 인원의 재발송을 막음).
      if (chunkFailed > 0) return;
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
      <div className="flex flex-col h-full overflow-hidden bg-[#F7FAFC]">
        {/* Top Header */}
        <div className="bg-white px-8 py-6 border-b border-[#E2E8F0] shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-extrabold text-[#1A202C] tracking-tight mb-1">인재풀 및 파이프라인 관리</h1>
              <p className="text-[14px] text-[#718096]">조건(지역·차종·가용성)으로 대상을 골라 재컨택 문자를 보내고, 후보의 진행 단계를 관리하는 화면입니다.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={exportCsv} className="flex items-center gap-1.5 px-4 py-2 bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] rounded-lg text-[13px] font-bold text-[#4A5568] transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
                <FileDown size={16} /> CSV로 내보내기
              </button>
            </div>
          </div>
        </div>

        {/* Toolbar & Filters */}
        <div className="px-8 py-4 flex items-center gap-3 border-b border-[#E2E8F0] bg-white shrink-0 flex-wrap z-10 shadow-sm">
          <div className="flex bg-[#F1F4F8] rounded-lg p-1 border border-[#E2E8F0]">
            <button onClick={() => setView("list")} className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-bold transition-all ${view === "list" ? "bg-white text-[#1A202C] shadow-sm" : "text-[#718096] hover:text-[#4A5568]"}`}>
              <ListIcon size={16} /> 리스트 뷰 (대량 관리)
            </button>
            <button onClick={() => setView("kanban")} className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-bold transition-all ${view === "kanban" ? "bg-white text-[#1A202C] shadow-sm" : "text-[#718096] hover:text-[#4A5568]"}`}>
              <LayoutGrid size={16} /> 칸반 보드
            </button>
            <button onClick={() => setView("map")} className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-bold transition-all ${view === "map" ? "bg-white text-[#1A202C] shadow-sm" : "text-[#718096] hover:text-[#4A5568]"}`}>
              <MapIcon size={16} /> 지도 분포
            </button>
            <button onClick={() => setView("funnel")} className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-bold transition-all ${view === "funnel" ? "bg-white text-[#1A202C] shadow-sm" : "text-[#718096] hover:text-[#4A5568]"}`}>
              <Funnel size={16} /> 퍼널
            </button>
          </div>

          <div className="w-px h-6 bg-[#E2E8F0] mx-2"></div>

          {/* 고급 필터는 리스트 뷰 전용 — 칸반·지도에는 적용되지 않아 비활성(오조작으로 '걸었다고 착각' 방지) */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            disabled={view !== "list"}
            title={view !== "list" ? "고급 필터는 리스트 뷰 전용이에요" : undefined}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-bold border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] ${view !== "list" ? 'bg-[#F7FAFC] border-[#E2E8F0] text-[#A0AEC0] cursor-not-allowed' : showFilters || activeFilterCount > 0 ? 'bg-[#FFFBEC] border-[#FFCB3C] text-[#B8860B]' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC]'}`}
          >
            <Filter size={16} /> 고급 필터
            {activeFilterCount > 0 && <span className="bg-[#FFCB3C] text-[#1A202C] text-[11px] font-extrabold px-1.5 py-0.5 rounded-full leading-none">{activeFilterCount}</span>}
          </button>

          <div className="flex-1" />

          {view === "list" && (
            <select
              value={distanceJobId === null ? "" : String(distanceJobId)}
              onChange={(e) => setDistanceJobId(e.target.value ? Number(e.target.value) : null)}
              className={`px-3 py-2.5 bg-white border rounded-lg text-[13px] font-semibold text-[#4A5568] outline-none focus:border-[#FFCB3C] shadow-sm cursor-pointer ${sortMode === "distance" && distanceJobId === null ? "border-[#DD6B20] ring-1 ring-[#DD6B20]" : "border-[#E2E8F0]"}`}
              title="거리 기준 공고 — 상차지 또는 마지막경유지 좌표가 있는 활성 공고만 선택할 수 있어요"
            >
              <option value="">거리 기준 공고 선택…</option>
              {distanceJobs.map((j) => (
                <option key={j.id} value={String(j.id)}>{j.title}</option>
              ))}
              {distanceJobs.length === 0 && <option value="" disabled>상차지·마지막경유지 좌표가 있는 공고가 없어요</option>}
            </select>
          )}

          {view === "list" && (
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
              className={`px-3 py-2.5 bg-white border rounded-lg text-[13px] font-semibold text-[#4A5568] outline-none focus:border-[#FFCB3C] shadow-sm cursor-pointer ${sortMode === "distance" && distanceJobId === null ? "border-[#DD6B20] ring-1 ring-[#DD6B20]" : "border-[#E2E8F0]"}`}
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

          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} type="text" placeholder="이름, 연락처, 지점, 지역 검색" className="pl-9 pr-4 py-2.5 w-[280px] bg-white border border-[#E2E8F0] rounded-lg text-[13px] outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] shadow-sm" />
          </div>
        </div>

        {/* Advanced Filters Panel — 리스트 뷰 전용(칸반·지도 전환 시 숨김, 상태는 유지) */}
        <AnimatePresence>
          {showFilters && view === "list" && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="bg-white border-b border-[#E2E8F0] shrink-0 overflow-hidden">
              <div className="px-8 py-5 bg-[#F7FAFC] flex flex-col gap-4">
                <div className="flex flex-wrap gap-8">
                  {/* 지원 채널 */}
                  <div>
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2">지원 채널</label>
                    <div className="flex flex-wrap gap-1.5">
                      {availableChannels.length === 0 && <span className="text-[12px] text-[#A0AEC0]">채널 없음</span>}
                      {availableChannels.map((ch) => {
                        const on = channelFilter.has(ch);
                        return (
                          <button key={ch} onClick={() => toggleSetValue(setChannelFilter, ch)} className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${on ? 'bg-[#1A202C] border-[#1A202C] text-white' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}>
                            {ch}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 이동수단 */}
                  <div>
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2">이동수단</label>
                    <div className="flex bg-white border border-[#E2E8F0] rounded-lg p-1">
                      {([["all", "전체"], ["vehicle", "차량 보유"], ["walk", "도보"], ["unknown", "미확인"]] as const).map(([val, label]) => (
                        <button key={val} onClick={() => setVehicleFilter(val)} className={`px-3 py-1.5 rounded-md text-[12.5px] font-bold transition-colors ${vehicleFilter === val ? 'bg-[#1A202C] text-white' : 'text-[#718096] hover:text-[#4A5568]'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 희망 슬롯 */}
                  <div>
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2">희망 근무(슬롯)</label>
                    <div className="flex flex-wrap gap-1.5">
                      {SLOT_TOKENS.map((s) => {
                        const on = slotFilter.has(s);
                        return (
                          <button key={s} onClick={() => toggleSetValue(setSlotFilter, s)} className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${on ? 'bg-[#FFCB3C] border-[#FFCB3C] text-[#1A202C]' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}>
                            {s}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 진행 단계 — 적체 트리아지: '스크리닝 전'만 골라 벌크 처리하는 동선 */}
                  <div>
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2">진행 단계</label>
                    <div className="flex flex-wrap gap-1.5">
                      {[...STATUS_TOKENS, ...(showExcluded ? EXCLUDED_STATUS_TOKENS : [])].map((s) => {
                        const on = statusFilter.has(s);
                        return (
                          <button key={s} onClick={() => toggleSetValue(setStatusFilter, s)} className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${on ? 'bg-[#1A202C] border-[#1A202C] text-white' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}>
                            {s}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 가용성 — status(채용 단계)와 별개의 공급 축 */}
                  <div>
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2" title="가용성 — 지금 일할 수 있는 상태(즉시가능·이번주가능·휴면). 채용 단계와 별개로 관리됩니다">가용성</label>
                    <div className="flex flex-wrap gap-1.5">
                      {AVAILABILITY_TOKENS.map((s) => {
                        const on = availabilityFilter.has(s);
                        return (
                          <button key={s} onClick={() => toggleSetValue(setAvailabilityFilter, s)} className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${on ? 'bg-[#38A169] border-[#38A169] text-white' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}>
                            {s}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 지역 — sido 기반, 전체/수도권/서울 3상태. 서울만 좁혀 근거리 재컨택 대상을 격리. */}
                  <div>
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2">지역</label>
                    <div className="flex bg-white border border-[#E2E8F0] rounded-lg p-1">
                      {([["all", "전체"], ["capital", "수도권(서울·경기·인천)"], ["seoul", "서울"]] as const).map(([val, label]) => (
                        <button key={val} onClick={() => setRegionFilter(val)} className={`px-3 py-1.5 rounded-md text-[12.5px] font-bold transition-colors ${regionFilter === val ? 'bg-[#1A202C] text-white' : 'text-[#718096] hover:text-[#4A5568]'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 제외 인원 — 부적합/이탈/기타 (리스트 뷰 한정, 실수 복구·재검토용) */}
                  <div>
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2">제외 인원</label>
                    <button
                      onClick={() => setShowExcluded((v) => !v)}
                      className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${showExcluded ? 'bg-[#E53E3E] border-[#E53E3E] text-white' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}
                      title="부적합·이탈·기타 상태를 리스트 뷰에 표시합니다"
                    >
                      부적합·이탈 표시 {showExcluded ? "ON" : "OFF"}
                    </button>
                  </div>

                  {/* 발송·코호트 — 재컨택 대상 정밀화(원지원 코호트/주소 확정/활동중 제외) */}
                  <div>
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2" title="코호트 — 같은 기간·조건으로 묶은 인원 그룹. 재컨택 문자를 보낼 대상을 좁히는 필터예요">발송·코호트</label>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        onClick={() => setRecentAppliedOnly((v) => !v)}
                        className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${recentAppliedOnly ? 'bg-[#1A202C] border-[#1A202C] text-white' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}
                        title="원지원일이 6개월 이내인 인원만 표시합니다"
                      >
                        원지원 6개월 이내
                      </button>
                      <button
                        onClick={() => setGeoConfirmedOnly((v) => !v)}
                        className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${geoConfirmedOnly ? 'bg-[#1A202C] border-[#1A202C] text-white' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}
                        title="지오코딩으로 주소가 확정(exact·approx)된 인원만 표시합니다"
                      >
                        주소 확정
                      </button>
                      <button
                        onClick={() => setExcludeActive((v) => !v)}
                        className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${excludeActive ? 'bg-[#DD6B20] border-[#DD6B20] text-white' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}
                        title="옹매니징에서 현재 활동 중인 인원을 리스트에서 제외합니다"
                      >
                        활동중 제외
                      </button>
                      <button
                        onClick={() => setExcludeRecentPing((v) => !v)}
                        className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${excludeRecentPing ? 'bg-[#DD6B20] border-[#DD6B20] text-white' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}
                        title="최근 14일 내 재컨택(문자) 발송 이력이 있는 인원을 리스트에서 제외합니다"
                      >
                        최근 14일 재컨택 제외
                      </button>
                      <button
                        onClick={() => setReactionOnly((v) => !v)}
                        className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${reactionOnly ? 'bg-[#38A169] border-[#38A169] text-white' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}
                        title="맞춤링크 열람·관심 클릭·답장 중 1건이라도 있는 인원만 표시합니다"
                      >
                        반응 있음(열람/관심/답장)
                      </button>
                      <button
                        onClick={() => setOptOutOnly((v) => !v)}
                        className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${optOutOnly ? 'bg-[#E53E3E] border-[#E53E3E] text-white' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}
                        title="수신거부('그만' 회신 등) 처리된 인원만 표시합니다 — 컴플라이언스 확인용"
                      >
                        수신거부만
                      </button>
                    </div>
                  </div>
                </div>

                {/* 저장된 세그먼트 (필터 프리셋) */}
                <div className="border-t border-[#E2E8F0] pt-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[12px] font-bold text-[#4A5568]">저장된 세그먼트</span>
                    {segments.length === 0 && <span className="text-[11.5px] text-[#A0AEC0]">자주 쓰는 필터 조합을 저장해 1클릭으로 재적용하세요.</span>}
                    {segments.map((seg) => (
                      <span key={seg.id} className="group inline-flex items-center gap-1 bg-white border border-[#E2E8F0] rounded-lg pl-2.5 pr-1 py-1 text-[12px] font-bold text-[#4A5568] hover:border-[#FFCB3C]">
                        <button onClick={() => applySegment(seg)} className="hover:text-[#1A202C]">{seg.name}</button>
                        <button onClick={() => deleteSegment(seg.id)} className="text-[#CBD5E0] hover:text-[#E53E3E] p-0.5 rounded" title="삭제"><X size={12} /></button>
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      value={segNameDraft}
                      onChange={(e) => setSegNameDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") saveCurrentSegment(); }}
                      placeholder="현재 필터를 이름 붙여 저장 (예: 강서·자차·주말)"
                      className="flex-1 max-w-[340px] px-3 py-1.5 border border-[#E2E8F0] rounded-lg text-[12.5px] focus:outline-none focus:border-[#FFCB3C] bg-white"
                    />
                    <button onClick={saveCurrentSegment} disabled={!segNameDraft.trim()} className="text-[12.5px] font-bold text-[#1A202C] bg-[#FFCB3C] hover:bg-[#E0B500] disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg">현재 필터 저장</button>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-1">
                  <span className="text-[12.5px] font-bold text-[#4A5568]">발송가능 {sendableCount} / 표시 {filteredCards.length}명</span>
                  {activeFilterCount > 0 && (
                    <button onClick={resetFilters} className="text-[12.5px] font-bold text-[#E53E3E] hover:underline">필터 초기화</button>
                  )}
                  <div className="flex-1" />
                  <button onClick={() => setShowFilters(false)} className="text-[13px] font-bold text-[#3182CE] hover:underline px-3 py-1.5 outline-none">닫기</button>
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
              {columns.map((column, idx) => (
                <KanbanColumn key={column.id} column={column} moveCard={moveCard} onCardClick={(id) => setSelectedApplicantId(Number(id))} columnIndex={idx} onExport={handleColumnExport} onBulkMessage={handleColumnBulkMessage} />
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
              onCardClick={(id) => setSelectedApplicantId(id)}
            />
          )}

          {view === "list" && (
            <div className="h-full overflow-y-auto p-8 relative bg-white">
              {/* Floating Bulk Actions Toolbar */}
              <AnimatePresence>
                {selectedRows.size > 0 && (
                  <motion.div initial={{ y: -50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -50, opacity: 0 }} className="sticky top-0 z-20 flex items-center gap-3 bg-gradient-to-r from-[#1A202C] to-[#2D3748] rounded-2xl px-6 py-4 mb-6 shadow-2xl border border-[#4A5568]">
                    <span className="text-[15px] font-extrabold text-white">
                      <span className="text-[#FFCB3C] text-[18px]">{selectedRows.size}명</span> 선택됨
                    </span>
                    <div className="w-px h-6 bg-white/20 mx-2"></div>

                    <button onClick={() => setBulkStageModalOpen(true)} className="bg-white/10 hover:bg-white/20 text-white border-0 rounded-xl px-4 py-2.5 text-[13px] font-bold flex items-center gap-2 transition-all backdrop-blur-sm">
                      <Columns size={16} /> 일괄 상태 변경
                    </button>
                    <button onClick={() => setJobPickerOpen(true)} className="bg-white/10 hover:bg-white/20 text-white border-0 rounded-xl px-4 py-2.5 text-[13px] font-bold flex items-center gap-2 transition-all backdrop-blur-sm">
                      <Briefcase size={16} /> 공고 후보로 추가
                    </button>
                    <button onClick={() => setBulkMsgModalOpen(true)} className="bg-[#FFCB3C] hover:bg-[#E0B500] text-[#1A202C] border-0 rounded-xl px-4 py-2.5 text-[13px] font-bold flex items-center gap-2 transition-all shadow-md">
                      <MessageCircle size={16} /> 알림톡/문자 캠페인 발송
                    </button>

                    <div className="flex-1" />

                    <button className="bg-transparent hover:bg-white/10 text-white/70 hover:text-white rounded-lg p-2 transition-colors" onClick={() => { setSelectedRows(new Set()); setWaitlistJobId(null); }}>
                      <X size={20} />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* 리스트 카운트 + 상위 N명 선택 — 발송 가능 인원 이중 카운트, 배치 발송 진입 단축 */}
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <span className="text-[13px] font-bold text-[#4A5568]">
                  발송가능 <span className="text-[#38A169]">{sendableCount}</span> / 표시 {filteredCards.length}명
                </span>
                {/* '수신거부만' 필터 ON — 컴플라이언스 확인용 카운트 (표시분 전원이 수신거부) */}
                {optOutOnly && (
                  <span className="text-[13px] font-bold text-[#E53E3E]">수신거부 {filteredCards.length}명</span>
                )}
                <div className="flex-1" />
                {/* 공고 관심자 원클릭 선택 — 관심 표시 인원(확정인력 제외)을 선택해 '관심 대기 안내'로 잇는 사후관리 동선 */}
                <select
                  value=""
                  onChange={(e) => { if (e.target.value) void selectJobInterested(Number(e.target.value)); }}
                  disabled={interestPickLoading || activeJobs.length === 0}
                  className="px-3 py-1.5 bg-white border border-[#E2E8F0] rounded-lg text-[13px] font-semibold text-[#4A5568] outline-none focus:border-[#FFCB3C] shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
                    className="w-[64px] px-2 py-1.5 bg-white border border-[#E2E8F0] rounded-lg text-[13px] font-semibold text-[#4A5568] outline-none focus:border-[#FFCB3C] shadow-sm"
                    title="선택할 상위 인원 수"
                  />
                  <button
                    onClick={selectTopN}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] rounded-lg text-[13px] font-bold text-[#4A5568] transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                    title="현재 정렬 순서 상단에서 발송 가능한 N명을 선택합니다"
                  >
                    <Check size={15} /> 상위 {Math.max(1, Math.floor(topN) || 0)}명 선택
                  </button>
                </div>
              </div>

              {topN > 50 && (
                <p className="-mt-2 mb-4 text-[11.5px] text-[#A0AEC0]">발송은 1회 최대 50명 — 50명 초과 시 자동으로 50명씩 나눠 발송됩니다.</p>
              )}

              {sortMode === "distance" && distanceJobId === null && (
                <p className="-mt-2 mb-4 text-[11.5px] font-semibold text-[#DD6B20]">거리순 정렬을 쓰려면 상단에서 &lsquo;거리 기준 공고&rsquo;를 선택하세요. 선택 전에는 기본 순서로 표시됩니다.</p>
              )}

              {/* Data Table */}
              <div className="border border-[#E2E8F0] rounded-[16px] overflow-hidden shadow-sm">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[#F7FAFC] border-b border-[#E2E8F0]">
                      <th className="px-5 py-4 w-[50px]">
                        <button onClick={toggleAll} className={`w-5 h-5 rounded-[6px] border-2 flex items-center justify-center transition-colors ${selectedRows.size === filteredCards.length && filteredCards.length > 0 ? 'bg-[#FFCB3C] border-[#FFCB3C]' : 'border-[#CBD5E0] bg-white'}`}>
                          {selectedRows.size === filteredCards.length && filteredCards.length > 0 && <Check size={14} strokeWidth={4} className="text-[#1A202C]" />}
                        </button>
                      </th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">지원자 정보</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">진행 단계</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">지원 채널 / 지점</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">보유 차량 / 조건</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">거주 지역 / 희망 근무</th>
                      <th className="px-4 py-4 text-[13px] font-bold text-[#718096]">최근 활동</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCards.map(c => {
                      const isSelected = selectedRows.has(c.id);
                      const send = sendableOf(c);
                      const isActive = activeSet.has(Number(c.id));
                      const appliedLabel = appliedMonth(c.appliedAtIso);
                      const summary = summaryById[Number(c.id)] as PoolEventSummary | undefined;
                      const recontactLbl = recontactLabel(summary?.last_ping_at);
                      // 반응 배지 — 과밀 방지: 가장 강한 신호 1개만 (관심 > 답장 > 열람).
                      let reactionBadge: { label: string; cls: string; title: string } | null = null;
                      if (summary?.last_interest) {
                        const it = summary.last_interest;
                        const jobTitle = it.job_id !== null ? activeJobs.find((j) => j.id === it.job_id)?.title : undefined;
                        reactionBadge = {
                          label: `${it.immediate ? "⚡ " : ""}관심${it.job_id !== null ? ` #${it.job_id}` : ""}`,
                          cls: "bg-[#F0FFF4] text-[#38A169]",
                          title: `공고${it.job_id !== null ? ` #${it.job_id}` : ""}${jobTitle ? ` ${jobTitle}` : ""} 관심 표시 ${relTime(it.at)}${it.immediate ? " · 즉시 가능 응답" : ""}`,
                        };
                      } else if (summary?.last_reply_at) {
                        reactionBadge = {
                          label: "답장 옴",
                          cls: "bg-[#BEE3F8] text-[#2C5282]",
                          title: `마지막 답장 ${relTime(summary.last_reply_at)}`,
                        };
                      } else if (summary?.last_link_view_at) {
                        reactionBadge = {
                          label: `열람 ${relTime(summary.last_link_view_at)}`,
                          cls: "bg-[#EDF2F7] text-[#718096]",
                          title: "맞춤링크(맞춤 공고 페이지) 열람",
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
                          onClick={() => setSelectedApplicantId(Number(c.id))}
                          className={`border-b border-[#F1F4F8] last:border-0 transition-colors hover:bg-[#F7FAFC] cursor-pointer group ${isSelected ? 'bg-[#FFFBEC] hover:bg-[#FFFBEC]' : 'bg-white'}`}
                        >
                          <td className="px-5 py-4">
                            <button onClick={(e) => { e.stopPropagation(); toggleRow(c.id); }} className={`w-5 h-5 rounded-[6px] border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-[#FFCB3C] border-[#FFCB3C]' : 'border-[#CBD5E0] bg-white'}`}>
                              {isSelected && <Check size={14} strokeWidth={4} className="text-[#1A202C]" />}
                            </button>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-[12px] bg-[#EDF2F7] text-[#4A5568] flex items-center justify-center font-bold text-[15px] shrink-0">
                                {c.name.charAt(0)}
                              </div>
                              <div>
                                <div className="text-[14px] font-bold text-[#1A202C]">{c.name}{c.age > 0 && <span className="text-[13px] font-medium text-[#718096] ml-1">{c.age}세</span>}</div>
                                <div className="flex items-center gap-1.5 mt-1">
                                  {c.agentStage ? (
                                    <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#EBF8FF] text-[#3182CE]">공고지원 · {STAGE_KO[c.agentStage] ?? c.agentStage}</span>
                                  ) : (
                                    <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#EDF2F7] text-[#718096]">순수 인재풀</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1 items-start">
                              <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-bold px-3 py-1.5 rounded-lg border bg-white ${c.stageId === 'applied' ? 'border-[#E2E8F0] text-[#4A5568]' : c.stageId === 'screening' ? 'border-[#F6E05E] text-[#D69E2E] bg-[#FEFCBF]' : c.stageId === 'interview' ? 'border-[#9AE6B4] text-[#38A169] bg-[#F0FFF4]' : c.stageId === 'excluded' ? 'border-[#CBD5E0] text-[#718096] bg-[#F7FAFC]' : 'border-[#90CDF4] text-[#3182CE] bg-[#EBF8FF]'}`}>
                                <div className={`w-1.5 h-1.5 rounded-full ${c.stageColor}`} />
                                {c.stage}
                              </span>
                              {(c.availability || c.smsOptOutAt || isActive || recontactLbl || reactionBadge || c.vehicleClass === '미확인' || (!send.sendable && !c.smsOptOutAt)) && (
                                <div className="flex flex-wrap items-center gap-1">
                                  {reactionBadge && (
                                    <span title={reactionBadge.title} className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded ${reactionBadge.cls}`}>
                                      {reactionBadge.label}
                                    </span>
                                  )}
                                  {c.availability && (
                                    <span title={c.availabilityUpdatedAtIso ? `갱신 ${relTime(c.availabilityUpdatedAtIso)}` : undefined} className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded ${c.availability === '휴면' ? 'bg-[#EDF2F7] text-[#A0AEC0]' : 'bg-[#F0FFF4] text-[#38A169]'}`}>
                                      {c.availability}
                                    </span>
                                  )}
                                  {recontactLbl && (
                                    <span title={`마지막 재컨택 ${relTime(summary?.last_ping_at ?? null)}`} className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#EBF8FF] text-[#3182CE]">
                                      {recontactLbl}
                                    </span>
                                  )}
                                  {isActive && (
                                    <span title="옹매니징에서 현재 활동 중" className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#FFFBEB] text-[#B7791F] border border-[#F6E05E]">
                                      활동중
                                    </span>
                                  )}
                                  {c.vehicleClass === '미확인' && (
                                    <span title="자차 보유 여부 미확인" className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#FFFAF0] text-[#DD6B20]">
                                      차량 미확인
                                    </span>
                                  )}
                                  {c.smsOptOutAt && (
                                    <span title={`수신거부 ${relTime(c.smsOptOutAt)}`} className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#FFF5F5] text-[#E53E3E]">
                                      수신거부
                                    </span>
                                  )}
                                  {!send.sendable && !c.smsOptOutAt && send.reason && (
                                    <span title="문자 발송 불가" className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#EDF2F7] text-[#718096]">
                                      {send.reason}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1">
                              <span className="inline-flex w-fit items-center text-[12px] font-bold px-2 py-0.5 rounded-md bg-[#EDF2F7] text-[#4A5568]">{c.channel}</span>
                              <span className="text-[12px] font-medium text-[#718096]">{c.branch}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1">
                              <span className="text-[13px] font-bold text-[#4A5568]">{c.tag}</span>
                              <span className="text-[11.5px] text-[#718096]">{c.exp}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[13px] font-medium text-[#4A5568]">{c.region}</span>
                                {distLabel && (
                                  <span title="선택 공고 상차지·마지막경유지까지 직선 거리(가까운 쪽 기준 정렬)" className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#EBF8FF] text-[#3182CE]">
                                    {distLabel}
                                  </span>
                                )}
                              </div>
                              <span className="text-[11.5px] text-[#718096]">{c.slot}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[12.5px] text-[#A0AEC0]">{c.lastActive}</span>
                              {appliedLabel && (
                                <span className="text-[11px] text-[#A0AEC0]">지원 {appliedLabel}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {!loading && filteredCards.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-12 text-center text-[13px] text-[#A0AEC0]">
                          {query
                            ? `'${query}' 검색 결과가 없어요. 이름·전화번호를 다시 확인해 보세요.`
                            : activeFilterCount > 0
                              ? "조건에 맞는 지원자가 없어요. 위 '고급 필터'에서 조건을 풀어 보세요."
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setJobPickerOpen(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-2xl w-full max-w-[440px] max-h-[80vh] flex flex-col border border-[#E2E8F0]">
            <div className="px-6 py-4 border-b border-[#E2E8F0] flex items-start justify-between">
              <div>
                <h2 className="text-[16px] font-bold text-[#1A202C]">공고 후보로 추가</h2>
                <div className="text-[12.5px] text-[#718096] mt-0.5">선택된 {selectedRows.size}명을 추가할 공고를 선택하세요.</div>
              </div>
              <button onClick={() => setJobPickerOpen(false)} className="p-1.5 hover:bg-[#EDF2F7] rounded-lg text-[#A0AEC0]"><X size={18} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
              {activeJobs.length === 0 && <div className="text-[13px] text-[#A0AEC0] text-center py-8">진행 중인 공고가 없어요</div>}
              {activeJobs.map((j) => (
                <button
                  key={j.id}
                  onClick={() => addSelectedToJob(j.id)}
                  disabled={addingJobId !== null}
                  className="w-full text-left flex items-center justify-between gap-3 p-3.5 rounded-xl border border-[#E2E8F0] hover:border-[#FFCB3C] hover:bg-[#FFFBEB] disabled:opacity-50 transition-all"
                >
                  <div className="min-w-0">
                    <div className="text-[14px] font-bold text-[#1A202C] truncate">{j.title}</div>
                    {j.branch && <div className="text-[12px] text-[#718096]">{j.branch}</div>}
                  </div>
                  {addingJobId === j.id ? <Loader2 size={16} className="animate-spin text-[#A0AEC0] shrink-0" /> : <ArrowRight size={16} className="text-[#A0AEC0] shrink-0" />}
                </button>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-[#E2E8F0] text-[11.5px] text-[#A0AEC0]">
              추가 후 공고 상세에서 일괄 스크리닝 문자를 발송할 수 있어요.
            </div>
          </div>
        </div>
      )}

      <ApplicantDetailPanel isOpen={selectedApplicantId != null} onClose={() => setSelectedApplicantId(null)} applicantId={selectedApplicantId} onChanged={loadApplicants} />

      {/* Modals for Bulk Actions */}
      {/* 1. Bulk Stage Change Modal */}
      {bulkStageModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white w-[500px] rounded-2xl shadow-xl flex flex-col overflow-hidden">
            <div className="p-5 border-b border-[#E2E8F0] bg-[#F7FAFC] flex justify-between items-center">
              <div>
                <h2 className="text-[16px] font-bold text-[#1A202C]">일괄 상태(파이프라인) 변경</h2>
                <div className="text-[12.5px] text-[#718096] mt-0.5">선택된 {selectedRows.size}명의 지원자를 어떤 단계로 이동시킬까요?</div>
              </div>
              <button onClick={() => setBulkStageModalOpen(false)} className="text-[#A0AEC0] hover:text-[#4A5568]"><X size={20} /></button>
            </div>
            <div className="p-6 grid grid-cols-2 gap-3">
              {[
                { id: "applied", label: "지원 접수 / 대기", desc: "스크리닝 전" },
                { id: "screening", label: "AI 스크리닝 중", desc: "체크리스트 진행" },
                { id: "interview", label: "스크리닝 완료", desc: "온보딩 · 배민ID 수집" },
                { id: "passed", label: "확정 인력", desc: "슬롯 확정" },
                { id: "rejected", label: "부적합", desc: "인력풀 제외 · 전체 공고에서 빠짐" }
              ].map(stage => (
                <button key={stage.id} onClick={() => handleBulkStageChange(stage.label)} className="p-4 border border-[#E2E8F0] rounded-xl text-left hover:border-[#FFCB3C] hover:bg-[#FFFBEC] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]">
                  <div className="text-[14px] font-bold text-[#1A202C] mb-1">{stage.label}</div>
                  <div className="text-[12px] text-[#718096]">{stage.desc}</div>
                </button>
              ))}
            </div>
          </motion.div>
        </div>
      )}

      {/* 2. Bulk Message/Campaign Modal */}
      {bulkMsgModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-white w-[600px] rounded-2xl shadow-xl flex flex-col overflow-hidden">
            <div className="p-5 border-b border-[#E2E8F0] bg-[#F7FAFC] flex justify-between items-center">
              <div>
                <h2 className="text-[16px] font-bold text-[#1A202C]">선택 인원 대상 문자(SMS) 캠페인 발송</h2>
                <div className="text-[12.5px] text-[#718096] mt-0.5">실제 발송 대상 {modalRecipientCount}명에게 일괄 발송됩니다.</div>
              </div>
              <button onClick={() => setBulkMsgModalOpen(false)} className="text-[#A0AEC0] hover:text-[#4A5568]"><X size={20} /></button>
            </div>
            <div className="p-6 space-y-5">
              {/* 선택 대비 실제 수신 차감 경고 — 필터로 화면에서 빠졌거나 연락처가 없는 인원은 발송되지 않는다 */}
              {modalExcludedCount > 0 && (
                <div className="px-4 py-2.5 rounded-xl bg-[#FFFAF0] border border-[#FBD38D] text-[12.5px] font-bold text-[#C05621]">
                  선택 {selectedRows.size}명 중 {modalExcludedCount}명은 현재 필터에서 벗어났거나 연락처가 없어 제외됩니다.
                </div>
              )}
              {selectedOptOutCount > 0 && (
                <div className="px-4 py-2.5 rounded-xl bg-[#FFF5F5] border border-[#FEB2B2] text-[12.5px] font-bold text-[#C53030]">
                  수신거부 {selectedOptOutCount}명은 서버가 자동 제외합니다.
                </div>
              )}

              {/* 템플릿↔코호트 경고 — B안(최근 6개월용)에 원지원 6개월 초과자가 섞임(발송은 막지 않음, 인지용) */}
              {bCohortMismatchCount > 0 && (
                <div className="px-4 py-2.5 rounded-xl bg-[#FFFBEB] border border-[#F6E05E] text-[12.5px] font-bold text-[#B7791F]">
                  ⚠️ B안은 최근 6개월 코호트용 — 현재 대상 중 {bCohortMismatchCount}명이 6개월 초과(원지원일 미상 포함)예요. A안 사용을 검토하세요.
                </div>
              )}

              {/* 옹매니징 현재 활동 중 대조 */}
              {activeCheckLoading && (
                <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#F7FAFC] border border-[#E2E8F0] text-[12.5px] font-bold text-[#718096]">
                  <Loader2 size={14} className="animate-spin" /> 옹매니징에서 현재 활동 중인 인원을 확인하고 있어요...
                </div>
              )}
              {!activeCheckLoading && activeCheck && !activeCheck.configured && (
                <div className="px-4 py-2.5 rounded-xl bg-[#EDF2F7] border border-[#E2E8F0] text-[12.5px] font-bold text-[#718096]">
                  옹매니징 미연동 — 활동 여부 확인 불가
                </div>
              )}
              {!activeCheckLoading && activeCheck && activeCheck.configured && activeCheck.active.length > 0 && (
                <div className="rounded-xl bg-[#FFFBEB] border border-[#F6E05E] p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-[13px] font-extrabold text-[#B7791F]">
                      옹매니징에서 현재 활동 중인 인원 {activeCheck.active.length}명이 포함되어 있어요
                    </div>
                    <button
                      onClick={excludeActiveFromSelection}
                      className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold text-white bg-[#DD6B20] hover:bg-[#C05621] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                    >
                      <UserX size={14} /> 활동 중 전원 제외
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {activeCheck.active.map((p) => {
                      // 사유가 지난달 정산뿐이면(활성 계약 없음) 판단 여지가 커 배지를 약하게 표시.
                      const onlySettlement = p.reasons.length > 0 && p.reasons.every((r) => r === "recent_settlement");
                      return (
                        <span
                          key={p.id}
                          className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-bold border ${onlySettlement ? 'bg-white border-[#E2E8F0] text-[#718096]' : 'bg-[#FEFCBF] border-[#F6E05E] text-[#975A16]'}`}
                        >
                          {p.name}
                          {p.reasons.includes("active_contract") && (
                            <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#FEEBC8] text-[#C05621]">활성 계약</span>
                          )}
                          {p.reasons.includes("recent_settlement") && (
                            <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#EDF2F7] text-[#718096]">지난달 정산</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                  <p className="text-[11.5px] leading-relaxed text-[#B7791F]">
                    재컨택(구직 안내)이라면 제외하세요. 현재 라인과 시간대가 겹치지 않는 병행 가능 건이라면 유지해도 됩니다 — 발송 목적에 따라 판단하세요.
                  </p>
                </div>
              )}
              <div>
                <label className="text-[13px] font-bold text-[#4A5568] block mb-2">메시지 템플릿</label>
                <select
                  onChange={(e) => { if (e.target.value) setBulkMsgBody(e.target.value); }}
                  className="w-full border border-[#E2E8F0] rounded-xl px-4 py-3 text-[14px] outline-none focus:border-[#FFCB3C] bg-white"
                >
                  <option value="">직접 입력하기</option>
                  <option value={DEFAULT_BULK_BODY}>재컨택 A안 (전체 기본)</option>
                  <option value={RECONTACT_B_BODY}>재컨택 B안 (최근 6개월·짧게)</option>
                  <option value={WAITLIST_BODY}>관심 대기 안내 (사후관리)</option>
                  <option value="안녕하세요, 지원해주셔서 감사합니다! 근무 시작 안내를 위해 본 문자에 답장 부탁드립니다.">근무 시작 안내</option>
                  <option value="지원해주신 내용 중 일부 확인이 필요합니다. 본 문자에 답장 주시면 안내드리겠습니다.">추가 정보 확인 요청</option>
                </select>
              </div>
              <div>
                <label className="text-[13px] font-bold text-[#4A5568] block mb-2">메시지 본문</label>
                <textarea
                  value={bulkMsgBody}
                  onChange={(e) => setBulkMsgBody(e.target.value)}
                  className="w-full h-[150px] border border-[#E2E8F0] rounded-xl p-4 text-[14px] outline-none focus:border-[#FFCB3C] resize-none leading-relaxed text-[#2D3748] bg-[#F7FAFC]"
                />
                <p className="mt-1.5 text-[11.5px] text-[#A0AEC0]">치환자: <b className="text-[#718096]">#{"{이름}"}</b> 수신자 이름 · <b className="text-[#718096]">#{"{맞춤링크}"}</b> 본인 전용 맞춤 공고 페이지 주소</p>
              </div>
            </div>
            <div className="p-5 border-t border-[#E2E8F0] bg-white flex justify-between items-center">
              {/* 비용은 대표 샘플(이름 3자·실제 길이 더미 링크) 치환 후 기준 × 실제 수신자 수 */}
              {(() => {
                const est = estimateSmsCost(fillSampleVars(bulkMsgBody));
                return (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-bold text-[#718096]">예상 비용: {est.sms_type} · 약 {(est.cost_krw * modalRecipientCount).toLocaleString()}원 (1인 {est.cost_krw}원 × {modalRecipientCount}명)</span>
                    {Math.abs(est.bytes - 90) <= 10 && (
                      <span className="text-[11.5px] font-semibold text-[#DD6B20]">문자 길이가 단문 한도(90바이트)에 걸쳐 있어요 — 수신자 이름 길이에 따라 장문(LMS) 요금으로 나갈 수 있어요.</span>
                    )}
                  </div>
                );
              })()}
              <div className="flex gap-2">
                <button onClick={() => setBulkMsgModalOpen(false)} className="px-5 py-2.5 rounded-xl text-[14px] font-bold text-[#718096] hover:bg-[#F7FAFC] border border-[#E2E8F0]">취소</button>
                <button onClick={handleBulkSend} disabled={bulkSending} className="px-6 py-2.5 rounded-xl text-[14px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
                  {bulkSending ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
                  {bulkSending ? "발송 중..." : "캠페인 발송"}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
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
    return { label: "즉시가능", cls: "bg-[#F0FFF4] text-[#276749] border-[#9AE6B4]" };
  if (availability === "이번주가능")
    return { label: "이번주가능", cls: "bg-[#F0FFF4] text-[#38A169] border-[#C6F6D5]" };
  if (availability === "휴면")
    return { label: "휴면", cls: "bg-[#F7FAFC] text-[#A0AEC0] border-[#E2E8F0]" };
  return { label: availability ?? "미확인", cls: "bg-[#F7FAFC] text-[#A0AEC0] border-[#E2E8F0]" };
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
      {/* 상단 컨트롤 — 코호트 요약 + 기간 셀렉트 + 새로고침 */}
      <div className="px-8 pt-6 pb-3 flex items-center gap-3 shrink-0 flex-wrap">
        <span className="text-[13px] font-bold text-[#4A5568]" title="코호트 — 이 기간 안에 재컨택 문자를 받은 인원 묶음">
          최근 {data?.window_days ?? days}일 발송 코호트 <span className="text-[#3182CE]">{members.length}명</span>
          {query && <span className="text-[#A0AEC0] font-semibold"> · 검색 일치 {visible.length}명</span>}
        </span>
        <div className="flex-1" />
        <select
          value={String(days)}
          onChange={(e) => onDaysChange(Number(e.target.value))}
          className="px-3 py-1.5 bg-white border border-[#E2E8F0] rounded-lg text-[13px] font-semibold text-[#4A5568] outline-none focus:border-[#FFCB3C] focus-visible:ring-2 focus-visible:ring-[#FFCB3C]/40 shadow-sm cursor-pointer"
          title="캠페인 코호트 기간 — 이 기간 안에 재컨택 문자를 받은 인원 묶음"
        >
          <option value="7">최근 7일</option>
          <option value="14">최근 14일</option>
          <option value="30">최근 30일</option>
        </select>
        <button
          onClick={onRefresh}
          title="퍼널 새로고침"
          className="flex items-center gap-1 text-[12.5px] font-bold text-[#4A5568] bg-white border border-[#E2E8F0] hover:bg-[#F7FAFC] px-3 py-1.5 rounded-lg shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3182CE]/40"
        >
          <RefreshCw size={13} className={isValidating ? "animate-spin" : ""} /> 새로고침
        </button>
      </div>

      {error ? (
        <div className="flex-1 flex items-center justify-center text-[13px] text-[#E53E3E]">퍼널 데이터를 불러오지 못했어요. 오른쪽 위 &lsquo;새로고침&rsquo;을 눌러 다시 시도해 주세요.</div>
      ) : !data ? (
        <div className="flex-1 flex items-center justify-center text-[13px] text-[#A0AEC0]">
          <Loader2 size={15} className="animate-spin mr-1.5" /> 불러오는 중…
        </div>
      ) : members.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-8">
          <div className="text-[14px] font-bold text-[#4A5568]">최근 {data.window_days}일 캠페인 발송이 없어요</div>
          <div className="text-[12.5px] text-[#A0AEC0]">리스트 뷰에서 대상을 선별해 재컨택 문자를 발송하면 여기에 반응 퍼널이 쌓여요.</div>
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
                className="flex flex-col w-[300px] shrink-0 bg-[#F4F6F9] rounded-[16px] p-4 border border-[#E2E8F0] shadow-sm"
              >
                <div className="flex items-center justify-between mb-4 px-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[15px] font-extrabold text-[#1A202C]">{col.title}</h2>
                    <span className="text-[12px] font-bold text-[#718096] bg-[#E2E8F0] px-2.5 py-0.5 rounded-full">{cards.length}</span>
                  </div>
                  {col.id !== "sent" && total > 0 && (
                    <span
                      title={`발송 ${total}명 중 이 단계 이상 도달 ${reached}명`}
                      className="text-[11px] font-bold text-[#718096] bg-white border border-[#E2E8F0] px-2 py-0.5 rounded-full"
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
                        className={`w-full text-left bg-white border border-[#E2E8F0] rounded-xl p-3.5 shadow-sm hover:border-[#FFCB3C] hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] ${m.opted_out ? "opacity-60 grayscale" : ""}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[13.5px] font-bold text-[#1A202C] truncate">{m.name || "이름 미상"}</span>
                            {m.stage === "replied" && m.unread_count > 0 && (
                              <span
                                title={`미읽음 답장 ${m.unread_count}건`}
                                className="min-w-4 h-4 px-1 rounded-full bg-[#E53E3E] text-white text-[10px] font-bold flex items-center justify-center shrink-0"
                              >
                                {m.unread_count}
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-[#A0AEC0] shrink-0" title="이 단계 마지막 이벤트 시각">{relTime(m.last_event_at)}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1 mt-1.5">
                          {m.sigungu && (
                            <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#EDF2F7] text-[#718096]">{m.sigungu}</span>
                          )}
                          <span className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded border ${badge.cls}`}>{badge.label}</span>
                          {m.opted_out && (
                            <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded border bg-[#FFF5F5] text-[#C53030] border-[#FEB2B2]">수신거부</span>
                          )}
                        </div>
                        {m.stage === "interested" && m.interest_job_title && (
                          <div className="flex items-center gap-1.5 mt-1.5 text-[11.5px] text-[#4A5568]">
                            <span className="font-semibold truncate">{m.interest_job_title}</span>
                            {m.immediate && (
                              <span className="flex items-center gap-0.5 text-[#276749] font-bold shrink-0">
                                <Zap size={11} /> 즉시가능
                              </span>
                            )}
                          </div>
                        )}
                      </button>
                    );
                  })}
                  {cards.length === 0 && (
                    <div className="h-[100px] bg-white/40 border-2 border-dashed border-[#CBD5E0] rounded-xl flex items-center justify-center text-[12.5px] font-bold text-[#A0AEC0]">
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
        <div key={i} className="flex items-center gap-4 py-3 border-b border-[#F1F4F8]">
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
    <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: columnIndex * 0.05 }} ref={drop as any} className={`flex flex-col w-[320px] shrink-0 bg-[#F4F6F9] rounded-[16px] p-4 transition-colors duration-200 border border-[#E2E8F0] shadow-sm ${isOver ? 'ring-2 ring-[#FFCB3C] bg-[#FFFBEB]/50' : ''}`}>
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${column.color}`} />
          <h2 className="text-[15px] font-extrabold text-[#1A202C]">{column.title}</h2>
          <span className="text-[12px] font-bold text-[#718096] bg-[#E2E8F0] px-2.5 py-0.5 rounded-full">{column.count}</span>
        </div>
        <div className="relative">
          <button onClick={() => setMenuOpen((v) => !v)} className="text-[#A0AEC0] hover:text-[#4A5568] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C] rounded-md"><MoreHorizontal size={18} /></button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-7 z-30 w-[200px] bg-white border border-[#E2E8F0] rounded-xl shadow-lg py-1.5">
                <button
                  onClick={() => { setMenuOpen(false); onExport(column); }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] font-bold text-[#4A5568] hover:bg-[#F7FAFC] text-left"
                >
                  <FileDown size={15} className="text-[#718096]" /> 이 단계 CSV 내보내기
                </button>
                <button
                  onClick={() => { setMenuOpen(false); onBulkMessage(column); }}
                  disabled={column.count === 0}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] font-bold text-[#4A5568] hover:bg-[#F7FAFC] text-left disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Mail size={15} className="text-[#718096]" /> 이 단계 일괄 문자
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
          <div className="h-[120px] bg-white/40 border-2 border-dashed border-[#CBD5E0] rounded-xl flex flex-col items-center justify-center text-[#A0AEC0] gap-2">
            <div className="text-[13px] font-bold text-[#718096]">대기 중인 지원자 없음</div>
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
    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.2, delay: cardIndex * 0.05 + 0.1 }} ref={drag as any} onClick={onClick} className={`bg-white border border-[#E2E8F0] rounded-xl p-4 cursor-grab active:cursor-grabbing hover:border-[#FFCB3C] hover:shadow-md transition-all ${isDragging ? 'opacity-50 ring-2 ring-[#FFCB3C]' : 'shadow-sm'}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[14px] font-bold text-[#1A202C]">{card.name} <span className="text-[12px] text-[#718096] font-medium ml-1">{card.age}세</span></div>
        <div className="text-[11px] font-bold px-2 py-0.5 rounded bg-[#EDF2F7] text-[#4A5568]">{card.channel}</div>
      </div>
      <div className="flex flex-col gap-1.5 mb-3">
        <div className="text-[12.5px] text-[#4A5568] flex items-center gap-1.5"><span className="text-[#A0AEC0]">지점:</span> <b>{card.branch}</b></div>
        <div className="text-[12.5px] text-[#4A5568] flex items-center gap-1.5"><span className="text-[#A0AEC0]">수단:</span> {card.tag}</div>
        <div className="text-[12.5px] text-[#4A5568] flex items-center gap-1.5"><span className="text-[#A0AEC0]">희망:</span> {card.slot}</div>
      </div>
      <div className="border-t border-[#F1F4F8] pt-3 flex justify-between items-center">
        <span className="text-[11px] text-[#A0AEC0]">{card.exp}</span>
        <span className="text-[11px] font-medium text-[#718096] bg-[#F7FAFC] px-2 py-1 rounded-md">{card.lastActive}</span>
      </div>
    </motion.div>
  );
}