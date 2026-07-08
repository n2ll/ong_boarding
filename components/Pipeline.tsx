import { useState, useEffect, useMemo } from "react";
import useSWR from "swr";
import { useSearchParams } from "next/navigation";
import { Filter, Search, MoreHorizontal, MessageCircle, Calendar, Check, X, UserX, Download, LayoutGrid, List as ListIcon, Columns, ArrowRight, UserPlus, FileDown, Tags, Mail, Loader2, Briefcase, Map as MapIcon } from "lucide-react";
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
function estimateSmsCost(text: string): { sms_type: "SMS" | "LMS"; cost_krw: number } {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) bytes += text.charCodeAt(i) > 0x7f ? 2 : 1;
  const sms_type = bytes <= 90 ? "SMS" : "LMS";
  return { sms_type, cost_krw: sms_type === "SMS" ? 20 : 33 };
}

const SEGMENTS_KEY = "ong_pipeline_segments";

interface SavedSegment {
  id: string;
  name: string;
  channels: string[];
  vehicle: "all" | "vehicle" | "walk";
  slots: string[];
  query: string;
  // v2 확장 — 구버전 저장분은 undefined (하위호환)
  statuses?: string[];
  availability?: string[];
  region?: "all" | "capital";
}

// Types
interface CardData {
  id: string;
  name: string;
  age: number;
  channel: string;
  branch: string;
  slot: string;
  tag: string;
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
}

const STAGE_KO: Record<string, string> = {
  exploration: "탐색", screening: "스크리닝", onboarding: "온보딩",
  active: "활성", paused: "수동", abort: "중단",
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

const DEFAULT_BULK_BODY =
  "[옹고잉] #{이름}님, 안녕하세요!\n현재 거주하고 계신 인근에 야간 배달 파트너를 긴급 모집 중입니다.\n\n이번 주말(금,토,일) 근무 시 기본 단가의 1.5배를 지급합니다. 관심 있으시다면 본 문자에 답장 주세요!";

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

// 수도권 판별 — sido 원문("서울특별시"/"경기도"/"인천광역시" 등) 접두 매칭
const CAPITAL_SIDO_PREFIXES = ["서울", "경기", "인천"];
function isCapitalArea(sido: string | null): boolean {
  return !!sido && CAPITAL_SIDO_PREFIXES.some((p) => sido.startsWith(p));
}

// 목록 API가 추가로 내려주는 컬럼 — 공용 Applicant 타입엔 아직 없어 로컬 확장으로 소비.
type ApplicantRow = Applicant & { sms_opt_out_at?: string | null };

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
  const [view, setView] = useState<"kanban" | "list" | "map">("list");
  const [rawApplicants, setRawApplicants] = useState<Applicant[]>([]);

  // 지원자 목록은 SWR 캐시로 관리 — 탭 재방문 시 즉시 표시 + 대시보드와 중복 호출 dedup.
  // 칸반 컬럼은 드래그로 낙관적 변경되는 로컬 상태라, SWR 데이터가 갱신될 때만 동기화한다.
  const { data: applicantsData, isLoading, mutate: mutateApplicants } = useSWR<{ data?: Applicant[] }>("/api/admin/applicants");
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
  const { data: jobsData } = useSWR<{ jobs?: Array<{ id: number; title: string; branch: string | null; pickup_lat?: number | null; pickup_lng?: number | null; pickup_address?: string | null }> }>("/api/admin/jobs?status=active");
  const visibleJobs = useMemo(() => (jobsData?.jobs ?? []).filter((j) => !String(j.title).startsWith("__")), [jobsData]);
  const activeJobs = useMemo(() => visibleJobs.map((j) => ({ id: j.id, title: j.title, branch: j.branch ?? null })), [visibleJobs]);
  const mapJobs = useMemo<MapJob[]>(() => visibleJobs.map((j) => ({ id: j.id, title: j.title, pickup_lat: j.pickup_lat ?? null, pickup_lng: j.pickup_lng ?? null, pickup_address: j.pickup_address ?? null })), [visibleJobs]);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [query, setQuery] = useState("");

  // 헤더 글로벌 검색에서 ?q= 로 진입하면 검색어 프리필.
  // 대시보드 '지도에서 보기'에서 ?view=map 으로 진입하면 지도 분포 뷰로 시작.
  useEffect(() => {
    const q = searchParams.get("q");
    if (q) setQuery(q);
    const v = searchParams.get("view");
    if (v === "map" || v === "kanban" || v === "list") setView(v);
  }, [searchParams]);
  const [channelFilter, setChannelFilter] = useState<Set<string>>(new Set());
  const [vehicleFilter, setVehicleFilter] = useState<"all" | "vehicle" | "walk">("all");
  const [slotFilter, setSlotFilter] = useState<Set<string>>(new Set());
  // 진행 단계(status)·가용성 필터 — 적체 트리아지의 핵심 동선 (예: '스크리닝 전'만 격리 → 벌크 처리)
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [availabilityFilter, setAvailabilityFilter] = useState<Set<string>>(new Set());
  // 지역(sido) 필터 — 수도권(서울/경기/인천) 공급 풀 격리용 칩 1개
  const [regionFilter, setRegionFilter] = useState<"all" | "capital">("all");
  // 부적합/이탈/기타는 칸반 보드에서 제외되지만, 리스트에서는 토글로 복구·재검토 가능해야 한다.
  const [showExcluded, setShowExcluded] = useState(false);
  // 리스트 정렬 — '방치 오래된 순'이 적체 트리아지용 (last_message_at 없음 → 최상단)
  const [sortMode, setSortMode] = useState<"recent" | "oldest" | "active" | "neglected">("recent");

  // 필터·검색이 바뀌면 선택 해제 — 화면에서 사라진 인원에게 벌크 발송이 나가는 사고 방지.
  useEffect(() => {
    setSelectedRows(new Set());
  }, [channelFilter, vehicleFilter, slotFilter, statusFilter, availabilityFilter, regionFilter, showExcluded, query]);

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
    (vehicleFilter !== "all" ? 1 : 0) + (regionFilter !== "all" ? 1 : 0);

  const resetFilters = () => {
    setChannelFilter(new Set());
    setVehicleFilter("all");
    setSlotFilter(new Set());
    setStatusFilter(new Set());
    setAvailabilityFilter(new Set());
    setRegionFilter("all");
  };

  const q = query.trim().toLowerCase();
  const filteredCards = listCards.filter((c) => {
    if (!matchesBranchScope(c.branch, scopeBranch)) return false;
    if (q && ![c.name, c.phone ?? "", c.branch, c.region, c.channel, c.tag].some((v) => v.toLowerCase().includes(q))) return false;
    if (channelFilter.size && !channelFilter.has(c.channel)) return false;
    if (vehicleFilter === "walk" && c.tag !== "도보") return false;
    if (vehicleFilter === "vehicle" && c.tag === "도보") return false;
    if (slotFilter.size && ![...slotFilter].some((s) => c.slot.includes(s))) return false;
    if (statusFilter.size && !statusFilter.has(c.status)) return false;
    if (availabilityFilter.size && !availabilityFilter.has(c.availability ?? "미확인")) return false;
    if (regionFilter === "capital" && !isCapitalArea(c.sido)) return false;
    return true;
  }).sort((a, b) => {
    const created = (c: typeof a) => (c.createdAtIso ? new Date(c.createdAtIso).getTime() : 0);
    const lastMsg = (c: typeof a) => (c.lastMessageAtIso ? new Date(c.lastMessageAtIso).getTime() : 0);
    switch (sortMode) {
      case "oldest": return created(a) - created(b);
      case "active": return lastMsg(b) - lastMsg(a);                 // 최근 활동순 (무활동은 뒤)
      case "neglected": return lastMsg(a) - lastMsg(b);              // 방치 오래된 순 (무활동=0 → 최상단)
      default: return created(b) - created(a);                       // 최근 등록순 (API 기본 순서와 동일)
    }
  });

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
  };

  const handleBulkSend = async () => {
    if (bulkSending) return;
    const text = bulkMsgBody.trim();
    if (!text) return toast.error("메시지 내용을 입력해주세요.");

    const selected = allCards.filter((c) => selectedRows.has(c.id) && c.phone);
    const recipients = selected.map((c) => ({
      phone: c.phone as string,
      applicant_id: Number(c.id),
    }));
    if (recipients.length === 0) return toast.error("발송 가능한 연락처가 없어요.");

    const est = estimateSmsCost(text);
    if (!(await confirm({
      title: `${recipients.length}명에게 문자를 발송할까요?`,
      description: `실제 SMS가 즉시 발송됩니다. 되돌릴 수 없어요.\n예상 비용: ${est.sms_type} · 약 ${(est.cost_krw * recipients.length).toLocaleString()}원 (1인 ${est.cost_krw}원 × ${recipients.length}명)`,
      confirmText: `${recipients.length}명 발송`,
    }))) return;

    setBulkSending(true);
    try {
      let sent = 0;
      const failErrors: string[] = [];
      // bulk-send 엔드포인트는 1회 최대 50명 → 50명씩 끊어서 발송
      for (let i = 0; i < recipients.length; i += 50) {
        const chunk = recipients.slice(i, i + 50);
        const res = await fetch("/api/admin/messages/bulk-send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipients: chunk, body: text }),
        });
        const json = await res.json();
        if (!res.ok) {
          toast.error(json.error || "발송에 실패했어요");
          return;
        }
        sent += json.sent ?? 0;
        for (const r of (json.results ?? []) as Array<{ success: boolean; error?: string }>) {
          if (!r.success) failErrors.push(r.error ?? "");
        }
      }
      // 서버 results[].error 집계 — 수신거부/인력풀 제외/링크토큰 없음은 '실패'가 아니라 의도된 제외로 구분 표기
      const optOut = failErrors.filter((e) => e.includes("수신거부")).length;
      const poolExcluded = failErrors.filter((e) => e.includes("인력풀 제외")).length;
      const noToken = failErrors.filter((e) => e.includes("토큰 없음")).length;
      const failed = failErrors.length - optOut - poolExcluded - noToken;
      const skipped = selectedRows.size - recipients.length;
      const parts = [`${sent}명 발송`];
      if (optOut) parts.push(`수신거부 ${optOut}명 제외`);
      if (poolExcluded) parts.push(`인력풀 제외 ${poolExcluded}명`);
      if (noToken) parts.push(`링크토큰 없음 ${noToken}명 제외`);
      if (skipped) parts.push(`연락처 없음 ${skipped}명 제외`);
      if (failed) parts.push(`실패 ${failed}명`);
      (sent > 0 ? toast.success : toast.error)(parts.join(" · "));
      setBulkMsgModalOpen(false);
      setSelectedRows(new Set());
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
              <p className="text-[14px] text-[#718096]">수천 명의 대규모 지원자 DB를 여러 채용 단계와 조건에 따라 직관적으로 필터링하고 일괄 관리합니다.</p>
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
          </div>

          <div className="w-px h-6 bg-[#E2E8F0] mx-2"></div>

          <button onClick={() => setShowFilters(!showFilters)} className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-bold border transition-colors ${showFilters || activeFilterCount > 0 ? 'bg-[#FFFBEC] border-[#FFCB3C] text-[#B8860B]' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC]'}`}>
            <Filter size={16} /> 고급 필터
            {activeFilterCount > 0 && <span className="bg-[#FFCB3C] text-[#1A202C] text-[11px] font-extrabold px-1.5 py-0.5 rounded-full leading-none">{activeFilterCount}</span>}
          </button>

          <div className="flex-1" />

          {view === "list" && (
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
              className="px-3 py-2.5 bg-white border border-[#E2E8F0] rounded-lg text-[13px] font-semibold text-[#4A5568] outline-none focus:border-[#FFCB3C] shadow-sm cursor-pointer"
              title="리스트 정렬"
            >
              <option value="recent">최근 등록순</option>
              <option value="oldest">오래된 등록순</option>
              <option value="active">최근 활동순</option>
              <option value="neglected">방치 오래된 순</option>
            </select>
          )}

          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} type="text" placeholder="이름, 연락처, 지점, 지역 검색" className="pl-9 pr-4 py-2.5 w-[280px] bg-white border border-[#E2E8F0] rounded-lg text-[13px] outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] shadow-sm" />
          </div>
        </div>

        {/* Advanced Filters Panel */}
        <AnimatePresence>
          {showFilters && (
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
                      {([["all", "전체"], ["vehicle", "차량 보유"], ["walk", "도보"]] as const).map(([val, label]) => (
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
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2">가용성</label>
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

                  {/* 지역 — sido 기반, 수도권 공급 풀 격리용 */}
                  <div>
                    <label className="block text-[12px] font-bold text-[#4A5568] mb-2">지역</label>
                    <button
                      onClick={() => setRegionFilter((v) => (v === "capital" ? "all" : "capital"))}
                      className={`px-3 py-1.5 rounded-lg text-[12.5px] font-bold border transition-colors ${regionFilter === "capital" ? 'bg-[#1A202C] border-[#1A202C] text-white' : 'bg-white border-[#E2E8F0] text-[#4A5568] hover:bg-[#EDF2F7]'}`}
                    >
                      수도권(서울/경기/인천)
                    </button>
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
                  <span className="text-[12.5px] font-bold text-[#4A5568]">{filteredCards.length}명 표시 중</span>
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
          {loading && <PipelineSkeleton />}
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

                    <button className="bg-transparent hover:bg-white/10 text-white/70 hover:text-white rounded-lg p-2 transition-colors" onClick={() => setSelectedRows(new Set())}>
                      <X size={20} />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

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
                              {(c.availability || c.smsOptOutAt) && (
                                <div className="flex items-center gap-1">
                                  {c.availability && (
                                    <span title={c.availabilityUpdatedAtIso ? `갱신 ${relTime(c.availabilityUpdatedAtIso)}` : undefined} className={`text-[10.5px] font-bold px-1.5 py-0.5 rounded ${c.availability === '휴면' ? 'bg-[#EDF2F7] text-[#A0AEC0]' : 'bg-[#F0FFF4] text-[#38A169]'}`}>
                                      {c.availability}
                                    </span>
                                  )}
                                  {c.smsOptOutAt && (
                                    <span title={`수신거부 ${relTime(c.smsOptOutAt)}`} className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#FFF5F5] text-[#E53E3E]">
                                      수신거부
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
                              <span className="text-[13px] font-medium text-[#4A5568]">{c.region}</span>
                              <span className="text-[11.5px] text-[#718096]">{c.slot}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4 text-[12.5px] text-[#A0AEC0]">
                            {c.lastActive}
                          </td>
                        </tr>
                      );
                    })}
                    {!loading && filteredCards.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-12 text-center text-[13px] text-[#A0AEC0]">
                          {query ? `'${query}' 검색 결과가 없어요.` : "표시할 지원자가 없어요."}
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
                <div className="text-[12.5px] text-[#718096] mt-0.5">총 {selectedRows.size}명에게 일괄 발송됩니다. (연락처 없는 인원은 자동 제외)</div>
              </div>
              <button onClick={() => setBulkMsgModalOpen(false)} className="text-[#A0AEC0] hover:text-[#4A5568]"><X size={20} /></button>
            </div>
            <div className="p-6 space-y-5">
              {selectedOptOutCount > 0 && (
                <div className="px-4 py-2.5 rounded-xl bg-[#FFF5F5] border border-[#FEB2B2] text-[12.5px] font-bold text-[#C53030]">
                  수신거부 {selectedOptOutCount}명은 서버가 자동 제외합니다.
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
                  <option value={DEFAULT_BULK_BODY}>[긴급] 야간 파트너 충원 (단가 1.5배)</option>
                  <option value={"[옹고잉] #{이름}님, 안녕하세요!\n지금 모집 중인 일자리를 모아 보실 수 있는 본인 전용 페이지를 보내드려요.\n\n#{맞춤링크}\n\n마음에 드는 일자리가 있으면 [관심 있어요]를 눌러주세요. 확인 후 연락드리겠습니다!"}>맞춤 공고 링크 안내 (재컨택)</option>
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
              <span className="text-[13px] font-bold text-[#718096]">예상 비용: {(() => { const c = estimateSmsCost(bulkMsgBody); return `${c.sms_type} · 약 ${(c.cost_krw * selectedRows.size).toLocaleString()}원 (1인 ${c.cost_krw}원 × ${selectedRows.size}명)`; })()}</span>
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