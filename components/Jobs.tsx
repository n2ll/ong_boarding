import { useState, useEffect, useCallback, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Filter, Briefcase, MapPin, CheckCircle2, Copy, CopyPlus, Edit2, Play, Pause, PauseCircle, Sparkles, Loader2, Wand2, X, Save, Users, ChevronRight, UserPlus } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { ApplicantDetailPanel } from "./ApplicantDetailPanel";
import { useConfirm } from "./ConfirmDialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuItem } from "./ui/dropdown-menu";
import { sourceLabel } from "@/lib/applicant-source";
import { isJobEffectivelyClosed, isSystemJobTitle, stripSystemPrefix } from "@/lib/jobs";

interface JobRow {
  id: string;
  title: string;
  branch: string;
  branchId: number | null;
  clientId: number | null;
  role: string;
  status: "active" | "closed";
  recruitMode: RecruitMode;
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
}

interface ApiJob {
  id: number;
  title: string;
  branch: string | null;
  branch_id: number | null;
  client_id: number | null;
  status: string;
  recruit_mode: string | null;
  vehicle_required: boolean;
  capacity: number | null;
  created_at: string;
  closed_at: string | null;
  work_period: string | null;
  closes_at: string | null;
  counts: Record<string, number>;
  // 매니저 명시 확정(applicants.status='확정인력') 수 — 충원율 게이지의 분자.
  confirmed_count?: number;
}

interface ClientOpt { id: number; name: string }
interface BranchOpt { id: number; name: string; client_id: number | null }

interface JobCand {
  id: number;
  applicant_id: number;
  agent_stage: string | null;
  closed_reason: string | null;
  sent_at: string | null;
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
    last_message_at: string | null;
    unread_count: number | null;
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

// 단계 그룹 표시 순서
const STAGE_ORDER = ["exploration", "screening", "onboarding", "active", "paused", "abort"];

function slotMatch(confirmed: string | null | undefined, key: string): boolean {
  if (!confirmed) return false;
  const day = key.startsWith("평일") ? "평일" : "주말";
  const time = key.endsWith("오전") ? "오전" : "오후";
  return confirmed.split(",").some((p) => p.includes(day) && p.includes(time));
}

const STAGE_KO: Record<string, string> = {
  exploration: "탐색", screening: "스크리닝", onboarding: "온보딩",
  active: "활성", paused: "수동", abort: "중단",
};
const STAGE_COLOR: Record<string, string> = {
  exploration: "bg-[#EDF2F7] text-[#4A5568]",
  screening: "bg-[#FEFCBF] text-[#D69E2E]",
  onboarding: "bg-[#FAF5FF] text-[#805AD5]",
  active: "bg-[#F0FFF4] text-[#38A169]",
  paused: "bg-[#EDF2F7] text-[#718096]",
  abort: "bg-[#FFF5F5] text-[#E53E3E]",
};

// abort(공고 단위 종료) 카드의 결과 구분 — closed_reason으로 '보류'·'공고부적합'·그 외 '중단'을 색·라벨로 나눈다.
// 모두 인력풀은 유지된다(재활용 원칙). '보류'는 되살릴 여지, '부적합'은 이 공고 부적격, 그 외는 AI abort 등.
type ClosedKind = { label: string; badge: string };
function closedKind(closedReason: string | null | undefined): ClosedKind {
  const r = closedReason ?? "";
  if (r.includes("보류")) return { label: "보류", badge: "bg-[#EDF2F7] text-[#718096]" };
  if (r.includes("부적합")) return { label: "공고부적합", badge: "bg-[#FFF5F5] text-[#E53E3E]" };
  return { label: "중단", badge: "bg-[#FFFAF0] text-[#DD6B20]" };
}

type RecruitMode = "external" | "internal" | "both";
const RECRUIT_MODE_META: Record<RecruitMode, { label: string; desc: string; badge: string }> = {
  external: { label: "공개 모집", desc: "지원 폼·광고로 새 지원자 모집", badge: "bg-[#EBF8FF] text-[#2B6CB0] border-[#BEE3F8]" },
  internal: { label: "인재풀 진행", desc: "보유 인재풀에서 골라 컨택", badge: "bg-[#FAF5FF] text-[#805AD5] border-[#E9D8FD]" },
  both: { label: "병행", desc: "공개 모집 + 인재풀 동시", badge: "bg-[#F0FFF4] text-[#2F855A] border-[#C6F6D5]" },
};
function asRecruitMode(v: unknown): RecruitMode {
  return v === "internal" || v === "both" ? v : "external";
}

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
    candidates: total,
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
  };
}

// 모집 기간(work_period) 배지 — 하루/단기=노랑, 정기=초록
const PERIOD_BADGE: Record<string, string> = {
  하루: "bg-[#FFFBEC] text-[#B7791F] border-[#FAF089]",
  단기: "bg-[#FFFBEC] text-[#B7791F] border-[#FAF089]",
  정기: "bg-[#F0FFF4] text-[#2F855A] border-[#C6F6D5]",
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
  const [newJobMode, setNewJobMode] = useState<RecruitMode>("external");
  const [newJobCapacity, setNewJobCapacity] = useState(1);
  const [newJobPayType, setNewJobPayType] = useState("");
  const [newJobPayAmount, setNewJobPayAmount] = useState<number | "">("");
  const [newJobPeriod, setNewJobPeriod] = useState("");
  const [newJobClosesAt, setNewJobClosesAt] = useState("");
  // 근무 상세 — pull(/p/[token]) 카드가 표시하는 필드. slot은 컨벤션상 4개 enum(평일오전 등), start_date는 date, pickup_address는 text.
  const [newJobSlot, setNewJobSlot] = useState("");
  const [newJobStartDate, setNewJobStartDate] = useState("");
  const [newJobPickupAddress, setNewJobPickupAddress] = useState("");
  const [newJobVehicleRequired, setNewJobVehicleRequired] = useState(true);
  // AI 응대 근거(급여·정책) — 등록 단계에서 접이식으로 함께 입력해 편집 모달 2단계 강제를 없앤다.
  const [newJobPayInfo, setNewJobPayInfo] = useState("");
  const [newJobPolicyNotes, setNewJobPolicyNotes] = useState("");
  const [newJobAiFacts, setNewJobAiFacts] = useState("");
  const [newJobExtraOpen, setNewJobExtraOpen] = useState(false);
  // 긴급 건(SOS)에서 넘어온 공고 — 등록 시 sos_request_id로 저장 + 등록 후 '대상 선별' CTA용 권역/차종 보관.
  const [newJobSosId, setNewJobSosId] = useState<string | null>(null);
  const [newJobSosRegion, setNewJobSosRegion] = useState<string | null>(null);
  const [newJobSosVehicle, setNewJobSosVehicle] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ id: string; title: string; body: string; branchId: number | ""; capacity: number; vehicleRequired: boolean; payInfo: string; policyNotes: string; payType: string; payAmount: number | ""; aiFacts: string; recruitMode: RecruitMode; workPeriod: string; closesAt: string; slot: string; startDate: string; pickupAddress: string } | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  // 전역 AI 응답 on/off (kill-switch). 공고별 AI 자동 스크리닝 적용 여부 표시에 사용.
  const [aiGlobalOn, setAiGlobalOn] = useState(true);

  // 공고별 지원자 보드
  const [candPanel, setCandPanel] = useState<{ jobId: number; title: string } | null>(null);
  const [candidates, setCandidates] = useState<JobCand[]>([]);
  const [candLoading, setCandLoading] = useState(false);
  const [selectedApplicantId, setSelectedApplicantId] = useState<number | null>(null);
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
      description: `'${name}'님을 이 공고 후보로 되살립니다(탐색 단계). 인력풀 상태는 그대로예요.`,
      confirmText: "재개하기",
    });
    if (!ok) return;
    await patchCandidate(c.id, { agent_stage: "exploration" }, "이 공고 후보로 되살렸어요");
  };

  // 미발송 후보에게 공고 본문 일괄 SMS 발송 (스크리닝 시작)
  const dispatchUnsent = async () => {
    if (!candPanel) return;
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
          r.no_token ? `맞춤링크 토큰 없음 ${r.no_token}명` : "",
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
    setCandPanel({ jobId: Number(job.id), title: job.title });
    setCandidates([]);
    loadCandidates(Number(job.id));
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

  // 공고별 요약 집계 (단계/채널/확정 슬롯)
  const stageCounts = candidates.reduce<Record<string, number>>((acc, c) => {
    const s = c.agent_stage ?? "exploration";
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
  const stageGroups = STAGE_ORDER
    .map((stage) => ({ stage, items: candidates.filter((c) => (c.agent_stage ?? "exploration") === stage) }))
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
  const { data: jobsApi, mutate: mutateJobs } = useSWR<{ jobs?: ApiJob[] }>("/api/admin/jobs?status=all");
  const jobs = useMemo(
    () => (jobsApi?.jobs ?? []).filter((j) => !isSystemJobTitle(j.title)).map(toJobRow),
    [jobsApi]
  );
  const loadJobs = useCallback(() => { void mutateJobs(); }, [mutateJobs]);

  // 필터용 메타데이터(화주사/지점) — 실패해도 조용히 무시.
  const { data: clientsApi } = useSWR<{ data?: ClientOpt[] }>("/api/admin/clients");
  const { data: branchesApi } = useSWR<{ data?: BranchOpt[] }>("/api/admin/branches");
  const clients = useMemo(() => (clientsApi?.data ?? []).map((c) => ({ id: c.id, name: c.name })), [clientsApi]);
  const branches = useMemo(() => (branchesApi?.data ?? []).map((b) => ({ id: b.id, name: b.name, client_id: b.client_id })), [branchesApi]);

  const handleGenerateJD = async () => {
    if (!aiPrompt.trim()) return toast.error("채용 조건을 입력해주세요.");
    setIsGenerating(true);
    setChannelDrafts(null);
    setAiSource(null);
    try {
      const res = await fetch("/api/admin/jobs/generate-posting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt.trim() }),
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
      if (payText || schedText) {
        if (payText) setNewJobPayInfo((prev) => prev || payText);
        if (schedText) setNewJobAiFacts((prev) => prev || `근무: ${schedText}`);
        setNewJobExtraOpen(true);
      }
      setActiveChannel("danggeun");
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
    setChannelDrafts(null);
    setAiSource(null);
    setPostingTitle("");
    setNewJobClientId("");
    setNewJobBranchId("");
    setNewJobMode("external");
    setNewJobCapacity(1);
    setNewJobPayType("");
    setNewJobPayAmount("");
    setNewJobPeriod("");
    setNewJobClosesAt("");
    setNewJobSlot("");
    setNewJobStartDate("");
    setNewJobPickupAddress("");
    setNewJobVehicleRequired(true);
    setNewJobPayInfo("");
    setNewJobPolicyNotes("");
    setNewJobAiFacts("");
    setNewJobExtraOpen(false);
    setNewJobSosId(null);
    setNewJobSosRegion(null);
    setNewJobSosVehicle(null);
  };

  // 공고 복제 — 기존 공고를 프리필한 등록 모달을 연다(후보·마감시각·id는 비움).
  // 정기 라인 재모집 시 반복 입력을 없앤다. 등록은 기존 POST를 그대로 재사용.
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const duplicateJob = async (job: JobRow) => {
    setDuplicatingId(job.id);
    try {
      const res = await fetch(`/api/admin/jobs/${job.id}`);
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "공고를 불러오지 못했어요");
        return;
      }
      const j = json.job;
      resetNewJobForm();
      const body = (j.body ?? "").trim();
      // 등록 모달은 channelDrafts로 구동 — 세 채널 모두 원본 본문으로 채운다(등록 시 알바몬 본문이 캐논).
      setChannelDrafts({ danggeun: body, albamon: body, sms: body });
      setActiveChannel("albamon");
      setPostingTitle((j.title ?? "").slice(0, 80));
      setNewJobClientId(typeof j.client_id === "number" ? j.client_id : "");
      setNewJobBranchId(typeof j.branch_id === "number" ? j.branch_id : "");
      setNewJobMode(asRecruitMode(j.recruit_mode));
      setNewJobCapacity(typeof j.capacity === "number" && j.capacity > 0 ? j.capacity : 1);
      setNewJobPayType(j.pay_type ?? "");
      setNewJobPayAmount(typeof j.pay_amount === "number" ? j.pay_amount : "");
      setNewJobPeriod(j.work_period ?? "");
      setNewJobSlot(j.slot ?? "");
      setNewJobStartDate(j.start_date ?? "");
      setNewJobPickupAddress(j.pickup_address ?? "");
      setNewJobVehicleRequired(j.vehicle_required !== false);
      setNewJobPayInfo(j.pay_info ?? "");
      setNewJobPolicyNotes(j.policy_notes ?? "");
      setNewJobAiFacts(j.ai_facts ?? "");
      if (j.pay_info || j.policy_notes || j.ai_facts || j.slot || j.start_date || j.pickup_address) setNewJobExtraOpen(true);
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
    const body = (channelDrafts.albamon || channelDrafts.danggeun || channelDrafts.sms).trim();
    // '__' 예약 프리픽스로 시작하면 목록·pull에서 숨겨져 사라진 것처럼 보이므로 제거(서버도 400으로 방어).
    const title = stripSystemPrefix((postingTitle || channelDrafts.albamon.split("\n")[0] || "새 공고").trim()).slice(0, 80) || "새 공고";
    if (!body) return;
    // 마감시각을 과거로 넣으면 등록 즉시 pull에서 '마감됨'으로 빠져 혼란 — 저장 전 경고.
    if (newJobClosesAt && new Date(newJobClosesAt).getTime() <= Date.now()) {
      toast.error("마감시각이 과거입니다. 현재 이후 시각으로 설정해주세요.");
      return;
    }
    // resetNewJobForm()이 SOS 상태를 지우기 전에, 등록 후 CTA용으로 스냅샷을 잡아둔다.
    const sosSnapshot = { id: newJobSosId, region: newJobSosRegion, vehicle: newJobSosVehicle };
    setRegistering(true);
    try {
      const res = await fetch("/api/admin/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          // 긴급 건에서 파생된 공고면 sos_request_id로 연결 저장(자동 해결 연동은 범위 밖).
          ...(newJobSosId && /^\d+$/.test(newJobSosId) ? { sos_request_id: Number(newJobSosId) } : {}),
          // 지점 미선택이어도 화주사만 고르면 client_id를 실어 필터 유실을 막는다(지점 선택 시 서버가 소속 화주사로 역채움).
          branch_id: newJobBranchId === "" ? null : newJobBranchId,
          ...(newJobBranchId === "" && newJobClientId !== "" ? { client_id: newJobClientId } : {}),
          recruit_mode: newJobMode,
          capacity: newJobCapacity,
          vehicle_required: newJobVehicleRequired,
          pay_type: newJobPayType || null,
          pay_amount: newJobPayAmount === "" ? null : Number(newJobPayAmount),
          pay_info: newJobPayInfo.trim() || null,
          policy_notes: newJobPolicyNotes.trim() || null,
          ai_facts: newJobAiFacts.trim() || null,
          slot: newJobSlot || null,
          start_date: newJobStartDate || null,
          pickup_address: newJobPickupAddress.trim() || null,
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
      // 긴급 건에서 파생된 공고면 '이 조건으로 대상 선별' CTA를 붙여 탭 이동 단절을 없앤다(SOS→공고→선별 브릿지).
      if (sosSnapshot.id) {
        const params = sosToPipelineParams(sosSnapshot.region, sosSnapshot.vehicle);
        params.set("status", "스크리닝 전");
        toast.success("새 공고가 등록되었어요.", {
          description: "이 조건에 맞는 인력풀에서 재컨택 대상을 선별하세요.",
          action: {
            label: "이 조건으로 대상 선별 →",
            onClick: () => router.push(`/pipeline?${params.toString()}`),
          },
          duration: 8000,
        });
      } else {
        toast.success("새 공고가 등록되었어요.");
      }
      setAiModalOpen(false);
      resetNewJobForm();
      await loadJobs();
    } catch {
      toast.error("공고 등록에 실패했어요");
    } finally {
      setRegistering(false);
    }
  };

  const q = query.trim();
  const filteredJobs = jobs.filter(job => {
    if (activeTab !== 'all' && job.status !== activeTab) return false;
    if (clientFilter !== "" && job.clientId !== clientFilter) return false;
    if (branchFilter !== "" && job.branchId !== branchFilter) return false;
    if (q && !(job.title.includes(q) || job.branch.includes(q))) return false;
    return true;
  });

  const branchOptions = clientFilter === "" ? branches : branches.filter(b => b.client_id === clientFilter);

  const openEdit = useCallback(async (id: string) => {
    setEditForm({ id, title: "", body: "", branchId: "", capacity: 1, vehicleRequired: true, payInfo: "", policyNotes: "", payType: "", payAmount: "", aiFacts: "", recruitMode: "external", workPeriod: "", closesAt: "", slot: "", startDate: "", pickupAddress: "" });
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
        branchId: j.branch_id ?? "",
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
        startDate: j.start_date ?? "",
        pickupAddress: j.pickup_address ?? "",
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
    setEditSaving(true);
    try {
      const res = await fetch(`/api/admin/jobs/${editForm.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body: editForm.body,
          branch_id: editForm.branchId === "" ? null : editForm.branchId,
          capacity: editForm.capacity,
          vehicle_required: editForm.vehicleRequired,
          pay_info: editForm.payInfo.trim() || null,
          policy_notes: editForm.policyNotes.trim() || null,
          pay_type: editForm.payType || null,
          pay_amount: editForm.payAmount === "" ? null : Number(editForm.payAmount),
          ai_facts: editForm.aiFacts.trim() || null,
          recruit_mode: editForm.recruitMode,
          work_period: editForm.workPeriod || null,
          closes_at: editForm.closesAt ? new Date(editForm.closesAt).toISOString() : null,
          slot: editForm.slot || null,
          start_date: editForm.startDate || null,
          pickup_address: editForm.pickupAddress.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "수정에 실패했어요");
        return;
      }
      toast.success("공고를 수정했어요.");
      setEditForm(null);
      await loadJobs();
    } catch {
      toast.error("수정에 실패했어요");
    } finally {
      setEditSaving(false);
    }
  };

  const handleToggleClose = async (job: JobRow) => {
    const next = job.status === "active" ? "closed" : "active";
    let ok: boolean;
    if (next === "closed") {
      // 마감하면 dispatch·pull 관심표시가 막히고 AI 자동 응대가 꺼진다.
      // 진행 중 후보가 있으면 그 응대가 멈추는 걸 명시해 무심코 대화를 끊는 걸 막는다.
      const warn = job.inProgress > 0
        ? `\n\n⚠️ 진행 중인 후보 ${job.inProgress}명의 AI 응대가 멈춰요. 나누던 대화가 끊길 수 있어요.`
        : "";
      ok = await confirm({
        title: "공고를 마감할까요?",
        description: `'${job.title}' 공고를 마감합니다. 마감 후에도 언제든 재개할 수 있어요.${warn}`,
        confirmText: "마감하기",
        destructive: job.inProgress > 0,
      });
    } else {
      ok = await confirm({ title: "공고를 다시 진행할까요?", description: `'${job.title}' 공고를 재개합니다.`, confirmText: "재개하기" });
    }
    if (!ok) return;
    setStatusBusyId(job.id);
    try {
      const res = await fetch(`/api/admin/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "변경에 실패했어요");
        return;
      }
      toast.success(next === "closed" ? "공고를 마감했어요." : "공고를 다시 진행합니다.");
      await loadJobs();
    } catch {
      toast.error("변경에 실패했어요");
    } finally {
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
      <div className="grid grid-cols-4 gap-5 mb-8">
        {[
          { label: "전체 공고", value: jobs.length, unit: "건" },
          { label: "진행 중인 공고", value: jobs.filter(j => !j.effectivelyClosed).length, unit: "건", highlight: true },
          { label: "AI 자동 응대 공고", value: aiGlobalOn ? jobs.filter(j => !j.effectivelyClosed).length : 0, unit: "건", color: "text-[#3182CE]" },
          { label: "신규 지원자(미시작)", value: jobs.reduce((a, j) => a + j.newCandidates, 0), unit: "명", color: "text-[#38A169]" }
        ].map((stat, i) => (
          <div key={i} className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm flex flex-col justify-between">
            <div className="text-[13px] font-bold text-[#718096] mb-2">{stat.label}</div>
            <div className="flex items-baseline gap-1">
              <span className={`text-[28px] font-extrabold tracking-tight leading-none ${stat.highlight ? 'text-[#D69E2E]' : stat.color || 'text-[#1A202C]'}`}>
                {stat.value}
              </span>
              <span className="text-sm font-semibold text-[#A0AEC0]">{stat.unit}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-sm overflow-hidden flex flex-col min-h-[600px]">
        {/* Toolbar */}
        <div className="p-5 border-b border-[#E2E8F0] flex items-center justify-between gap-4">
          <div className="flex gap-1.5">
            <button
              onClick={() => setActiveTab('all')}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeTab === 'all' ? 'bg-[#1A202C] text-white' : 'bg-white border border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC]'}`}
            >
              전체
            </button>
            <button
              onClick={() => setActiveTab('active')}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeTab === 'active' ? 'bg-[#1A202C] text-white' : 'bg-white border border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC]'}`}
            >
              진행 중 <span className="opacity-60 ml-1 font-medium">{jobs.filter(j => j.status === 'active').length}</span>
            </button>
            <button
              onClick={() => setActiveTab('closed')}
              className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${activeTab === 'closed' ? 'bg-[#1A202C] text-white' : 'bg-white border border-[#E2E8F0] text-[#4A5568] hover:bg-[#F7FAFC]'}`}
            >
              마감됨 <span className="opacity-60 ml-1 font-medium">{jobs.filter(j => j.status === 'closed').length}</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-2 py-1">
              <Filter size={15} className="text-[#A0AEC0] ml-1" />
              <select
                value={clientFilter}
                onChange={(e) => {
                  const v = e.target.value === "" ? "" : Number(e.target.value);
                  setClientFilter(v);
                  setBranchFilter("");
                }}
                className="bg-transparent text-sm font-semibold text-[#4A5568] py-1.5 pr-1 focus:outline-none cursor-pointer"
                title="화주사로 필터"
              >
                <option value="">전체 화주사</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <span className="text-[#CBD5E0]">›</span>
              <select
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value === "" ? "" : Number(e.target.value))}
                className="bg-transparent text-sm font-semibold text-[#4A5568] py-1.5 pr-1 focus:outline-none cursor-pointer"
                title="지점으로 필터"
              >
                <option value="">전체 지점</option>
                {branchOptions.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="공고명, 지점 검색"
                className="pl-9 pr-4 py-2 border border-[#E2E8F0] rounded-xl text-sm w-[220px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
              />
            </div>
            <button
              onClick={() => setAiModalOpen(true)}
              className="flex items-center gap-1.5 bg-[#FFCB3C] hover:bg-[#E0B500] text-[#1A202C] px-4 py-2 rounded-xl text-sm font-bold transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
            >
              <Wand2 size={16} /> 새 공고
            </button>
          </div>
        </div>

        {/* Table Header */}
        <div className="grid grid-cols-[2fr_1fr_1fr_1.5fr_1fr_0.5fr] items-center px-6 py-3.5 border-b border-[#E2E8F0] bg-[#F7FAFC] text-[13px] font-bold text-[#718096]">
          <div>공고 정보</div>
          <div>지점 / 직무</div>
          <div>모집 기간</div>
          <div>지원자 관리 (AI 현황)</div>
          <div>상태</div>
          <div className="text-right">관리</div>
        </div>

        {/* Table Body */}
        <div className="flex flex-col flex-1">
          {filteredJobs.length > 0 ? (
            filteredJobs.map(job => (
              <div key={job.id} className="grid grid-cols-[2fr_1fr_1fr_1.5fr_1fr_0.5fr] items-center px-6 py-5 border-b border-[#F1F4F8] hover:bg-[#F7FAFC] transition-colors">
                <div className="flex flex-col gap-1.5 min-w-0 pr-4">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <div onClick={() => openCandidates(job)} className="text-[15px] font-bold text-[#1A202C] truncate cursor-pointer hover:underline">{job.title}</div>
                    {job.workPeriod && PERIOD_BADGE[job.workPeriod] && (
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10.5px] font-bold border ${PERIOD_BADGE[job.workPeriod]}`}>{job.workPeriod}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] text-[#A0AEC0] font-mono">{job.id}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10.5px] font-bold border ${RECRUIT_MODE_META[job.recruitMode].badge}`}>{RECRUIT_MODE_META[job.recruitMode].label}</span>
                  </div>
                  {job.capacity > 0 && (() => {
                    const pct = Math.min(100, Math.round((job.confirmed / job.capacity) * 100));
                    const done = job.confirmed >= job.capacity;
                    return (
                      <div className="mt-1 pr-2" title={`매니저 확정 ${job.confirmed}명 / 정원 ${job.capacity}명 (확정인력으로 지정된 후보 기준)`}>
                        <div className="flex items-center justify-between text-[11px] font-bold mb-0.5">
                          <span className="text-[#718096]">충원율</span>
                          <span className={done ? "text-[#38A169]" : "text-[#4A5568]"}>{job.confirmed}/{job.capacity}{done && " ✓"}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-[#EDF2F7] overflow-hidden">
                          <div className={`h-full rounded-full ${done ? "bg-[#38A169]" : "bg-[#FFCB3C]"}`} style={{ width: `${Math.max(pct, job.confirmed > 0 ? 6 : 0)}%` }} />
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5 text-[13.5px] font-semibold text-[#4A5568]">
                    <MapPin size={14} className="text-[#A0AEC0]" /> {job.branch}
                  </div>
                  <div className="flex items-center gap-1.5 text-[13px] text-[#718096]">
                    <Briefcase size={14} className="text-[#A0AEC0]" /> {job.role}
                  </div>
                </div>

                <div className="flex flex-col gap-1 text-[13px] text-[#4A5568]">
                  <div>{job.created} ~</div>
                  {!job.closesAt ? (
                    <div className="font-bold text-[#2D3748]">상시</div>
                  ) : new Date(job.closesAt).getTime() <= Date.now() ? (
                    <span className="w-fit px-1.5 py-0.5 rounded text-[11px] font-bold bg-[#F1F4F8] text-[#718096] border border-[#E2E8F0]">마감됨</span>
                  ) : (
                    <div className={`font-bold ${new Date(job.closesAt).getTime() - Date.now() <= 24 * 60 * 60 * 1000 ? "text-[#DD6B20]" : "text-[#2D3748]"}`}>{fmtCloses(job.closesAt)}</div>
                  )}
                </div>

                <div className="flex items-center gap-4">
                  <button onClick={() => openCandidates(job)} className="flex flex-col items-start group/cand">
                    <div className="text-[13px] text-[#718096] flex items-center gap-1 group-hover/cand:text-[#3182CE]">총 지원자 <ChevronRight size={13} className="opacity-0 group-hover/cand:opacity-100 transition-opacity" /></div>
                    <div className="text-[15px] font-extrabold text-[#1A202C] group-hover/cand:text-[#3182CE]">{job.candidates}명 {job.newCandidates > 0 && <span className="text-[12px] font-bold text-[#D69E2E] ml-1">+{job.newCandidates}</span>}</div>
                  </button>
                  <div className="w-px h-8 bg-[#E2E8F0]"></div>
                  <div className="flex flex-col gap-1">
                    <div className="text-[12px] font-bold text-[#718096]">AI 자동 스크리닝</div>
                    {!aiGlobalOn ? (
                      <Link href="/brain" title="에이전트 두뇌에서 전역 AI 상태를 관리하세요" className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-bold bg-[#FFF5F5] text-[#E53E3E] border border-[#FED7D7] w-fit">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#E53E3E]"></span> 전역 중지됨
                      </Link>
                    ) : !job.effectivelyClosed ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-bold bg-[#EBF8FF] text-[#3182CE] border border-[#BEE3F8] w-fit">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#3182CE]"></span> 자동 응대 중
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-bold bg-[#F1F4F8] text-[#718096] border border-[#E2E8F0] w-fit">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#A0AEC0]"></span> 중지
                      </span>
                    )}
                  </div>
                </div>

                <div>
                  {!job.effectivelyClosed ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold bg-[#F0FFF4] text-[#38A169] border border-[#C6F6D5]">
                      <Play size={12} className="fill-current" /> 진행 중
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold bg-[#F1F4F8] text-[#718096] border border-[#E2E8F0]">
                      <Pause size={12} className="fill-current" /> 마감됨
                    </span>
                  )}
                </div>

                <div className="flex justify-end gap-1">
                  {job.recruitMode !== "internal" && (
                    // shadcn(Radix) DropdownMenu — 바깥 클릭·ESC 닫기·충돌 회피 포지셔닝·포털 렌더(행 잘림 방지)를 위임.
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="flex items-center gap-1 px-2 py-2 text-[12px] font-bold text-[#718096] hover:bg-[#E2E8F0] rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]" title="채널별 게시 링크 복사 — 유입이 해당 채널로 집계됩니다">
                          <Copy size={14} /> 게시 링크
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[170px] rounded-xl border-[#E2E8F0]">
                        <DropdownMenuLabel className="text-[11px] font-bold text-[#A0AEC0]">게시 채널 선택</DropdownMenuLabel>
                        {PUBLISH_CHANNELS.map((ch) => (
                          <DropdownMenuItem key={ch.source} onSelect={() => copyJobLink(job, ch.source)} className="text-[12.5px] font-semibold text-[#4A5568]">
                            {ch.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <button
                    onClick={() => duplicateJob(job)}
                    disabled={duplicatingId === job.id}
                    className="p-2 text-[#718096] hover:bg-[#E2E8F0] rounded-lg transition-colors disabled:opacity-50"
                    title="공고 복제 — 이 공고 내용으로 새 공고 등록(후보·마감시각은 비움)"
                  >
                    {duplicatingId === job.id ? <Loader2 size={16} className="animate-spin" /> : <CopyPlus size={16} />}
                  </button>
                  <button onClick={() => openEdit(job.id)} className="p-2 text-[#718096] hover:bg-[#E2E8F0] rounded-lg transition-colors" title="공고 수정">
                    <Edit2 size={16} />
                  </button>
                  <button
                    onClick={() => handleToggleClose(job)}
                    disabled={statusBusyId === job.id}
                    className="p-2 text-[#718096] hover:bg-[#E2E8F0] rounded-lg transition-colors disabled:opacity-50"
                    title={job.status === "active" ? "공고 마감" : "공고 재개"}
                  >
                    {statusBusyId === job.id ? <Loader2 size={16} className="animate-spin" /> : job.status === "active" ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-12">
              <div className="w-16 h-16 bg-[#F1F4F8] rounded-full flex items-center justify-center mb-4">
                <Briefcase size={24} className="text-[#A0AEC0]" />
              </div>
              <h3 className="text-[16px] font-bold text-[#1A202C] mb-2">공고가 없습니다</h3>
              <p className="text-[14px] text-[#718096] mb-6">현재 선택된 상태의 공고가 존재하지 않습니다.</p>
              <button
                onClick={() => setAiModalOpen(true)}
                className="flex items-center gap-2 bg-[#FFCB3C] hover:bg-[#E0B500] text-[#1A202C] px-5 py-2.5 rounded-xl font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
              >
                새 공고 등록하기
              </button>
            </div>
          )}
        </div>
      </div>

      {/* AI JD Generator Modal */}
      {aiModalOpen && (
        <div className="fixed inset-0 bg-[#00000080] z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white w-full max-w-[800px] rounded-[20px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-7 py-5 border-b border-[#E2E8F0]">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-[#FFFBEC] flex items-center justify-center text-[#D69E2E]">
                  <Wand2 size={18} />
                </div>
                <div>
                  <h2 className="text-[18px] font-extrabold text-[#1A202C] tracking-tight">AI 맞춤형 공고 작성</h2>
                  <p className="text-[13px] text-[#718096] mt-0.5">간단한 조건만 입력하면 시니어에 최적화된 공고 초안을 생성합니다.</p>
                </div>
              </div>
              <button onClick={() => { setAiModalOpen(false); resetNewJobForm(); }} className="text-[#A0AEC0] hover:text-[#4A5568] transition-colors">
                <X size={24} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-7 flex flex-col gap-6 bg-[#F7FAFC]">
              {/* Prompt Input */}
              <div className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-sm">
                <label className="block text-[13px] font-bold text-[#4A5568] mb-2">어떤 포지션을 찾고 계신가요?</label>
                <textarea
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="예: 스타벅스 성수점 매장 청소 및 테이블 관리, 주 3일 오전반, 시급 1.1만원, 60대 우대"
                  className="w-full bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3.5 text-[14px] text-[#1A202C] placeholder:text-[#A0AEC0] focus:outline-none focus:border-[#FFCB3C] min-h-[100px] resize-none"
                />
                <div className="flex justify-end mt-3">
                  <button
                    onClick={handleGenerateJD}
                    disabled={isGenerating || !aiPrompt}
                    className="flex items-center gap-1.5 px-5 py-2.5 bg-[#1A202C] text-white hover:bg-[#2D3748] disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-[13.5px] font-bold transition-colors"
                  >
                    {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} className="text-[#FFCB3C]" />}
                    {isGenerating ? 'JD 생성 중...' : 'AI 초안 생성'}
                  </button>
                </div>
              </div>

              {/* Generated Result — 채널별 초안 (당근/알바몬/SMS) */}
              {(isGenerating || channelDrafts) && (
                <div className="bg-white border border-[#FFCB3C] rounded-2xl p-5 shadow-sm relative overflow-hidden">
                  {isGenerating && (
                    <div className="absolute inset-0 bg-white/60 backdrop-blur-sm z-10 flex flex-col items-center justify-center">
                      <Wand2 size={28} className="text-[#D69E2E] animate-bounce mb-3" />
                      <div className="text-[14px] font-bold text-[#1A202C]">AI 옹봇이 채널별 공고를 작성하고 있습니다...</div>
                      <div className="text-[12px] text-[#718096] mt-1">당근 · 알바몬 · 문자 형식으로 각각 최적화하는 중</div>
                    </div>
                  )}
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-[13px] font-bold text-[#D69E2E] flex items-center gap-1.5">
                      <Sparkles size={14} /> 채널별 공고 초안
                      {aiSource === "mock" && <span className="text-[10.5px] font-bold bg-[#EDF2F7] text-[#718096] px-1.5 py-0.5 rounded">오프라인 템플릿</span>}
                    </label>
                    <span className="text-[11px] text-[#A0AEC0]">탭별로 수정·복사할 수 있어요</span>
                  </div>

                  {channelDrafts && (
                    <>
                      {/* 채널 탭 */}
                      <div className="flex gap-1.5 mb-3">
                        {([
                          { id: "danggeun", label: "당근알바" },
                          { id: "albamon", label: "알바몬" },
                          { id: "sms", label: "문자(SMS)" },
                        ] as const).map((ch) => (
                          <button key={ch.id} onClick={() => setActiveChannel(ch.id)} className={`px-3.5 py-1.5 rounded-lg text-[12.5px] font-bold transition-colors ${activeChannel === ch.id ? "bg-[#1A202C] text-white" : "bg-[#F1F4F8] text-[#718096] hover:bg-[#E2E8F0]"}`}>{ch.label}</button>
                        ))}
                        <div className="flex-1" />
                        <button onClick={() => copyChannel(channelDrafts[activeChannel], activeChannel === "danggeun" ? "당근알바" : activeChannel === "albamon" ? "알바몬" : "문자")} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-bold bg-[#FFFBEC] border border-[#FFCB3C] text-[#B8860B] hover:bg-[#FFF3C4]">
                          <Copy size={14} /> 복사
                        </button>
                      </div>
                      <textarea
                        value={channelDrafts[activeChannel]}
                        onChange={(e) => setChannelDrafts({ ...channelDrafts, [activeChannel]: e.target.value })}
                        className="w-full bg-[#FFFBEC] border-0 rounded-xl px-4 py-3.5 text-[13.5px] text-[#2D3748] leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#FFCB3C] min-h-[260px] font-medium resize-none whitespace-pre-wrap"
                      />
                      <div className="mt-2 text-[11.5px] text-[#A0AEC0]">등록 시 <b className="text-[#718096]">알바몬 형식</b> 본문이 공고 원문으로 저장되어 AI 스크리닝이 참조합니다.</div>
                    </>
                  )}
                </div>
              )}

              {/* 근무 상세 + AI 응대 근거 — 접이식. pull 카드 표시 필드(근무시간·시작일·집결지)와
                  단가·정책 참고정보를 등록 단계에서 함께 채워 편집 모달 2단계 강제를 없앤다. */}
              {channelDrafts && (
                <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-sm overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setNewJobExtraOpen((v) => !v)}
                    className="w-full flex items-center justify-between px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                  >
                    <div>
                      <div className="text-[13px] font-bold text-[#1A202C]">근무 상세 · AI 응대 근거 (선택)</div>
                      <div className="text-[11.5px] text-[#A0AEC0] mt-0.5">근무시간·시작일·집결지와 단가·정책을 채우면 pull 공고에 표시되고 AI가 문의에 직접 답합니다.</div>
                    </div>
                    <ChevronRight size={18} className={`text-[#A0AEC0] transition-transform ${newJobExtraOpen ? "rotate-90" : ""}`} />
                  </button>
                  {newJobExtraOpen && (
                    <div className="px-5 pb-5 flex flex-col gap-4 border-t border-[#F1F4F8] pt-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-[12.5px] font-bold text-[#4A5568] mb-1.5">근무시간</label>
                          <select
                            value={newJobSlot}
                            onChange={(e) => setNewJobSlot(e.target.value)}
                            className="w-full px-3.5 py-2.5 border border-[#E2E8F0] rounded-xl text-[13.5px] bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
                          >
                            <option value="">미지정</option>
                            {SLOT_KEYS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[12.5px] font-bold text-[#4A5568] mb-1.5">시작일</label>
                          <input
                            type="date"
                            value={newJobStartDate}
                            onChange={(e) => setNewJobStartDate(e.target.value)}
                            className="w-full px-3.5 py-2.5 border border-[#E2E8F0] rounded-xl text-[13.5px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[12.5px] font-bold text-[#4A5568] mb-1.5">집결지</label>
                        <input
                          type="text"
                          value={newJobPickupAddress}
                          onChange={(e) => setNewJobPickupAddress(e.target.value)}
                          placeholder="예: 성수동 물류센터 3번 게이트"
                          className="w-full px-3.5 py-2.5 border border-[#E2E8F0] rounded-xl text-[13.5px] focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
                        />
                      </div>
                      <div className="p-4 bg-[#FFFBEC] border border-[#FAF089] rounded-xl flex flex-col gap-4">
                        <div className="text-[12px] font-bold text-[#B7791F]">AI 응대 근거 — 채우면 단가·정책 문의를 AI가 직접 안내해 인계가 줄어듭니다</div>
                        <div>
                          <label className="block text-[12.5px] font-bold text-[#4A5568] mb-1.5">급여·정산 정보</label>
                          <textarea value={newJobPayInfo} onChange={(e) => setNewJobPayInfo(e.target.value)} rows={2} placeholder="예: 건당 3,000원 · 매주 정산 · 프로모션 5천원(1~2개월 후 종료 가능)" className="w-full px-3.5 py-2.5 border border-[#E2E8F0] rounded-xl text-[13.5px] leading-relaxed bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none" />
                        </div>
                        <div>
                          <label className="block text-[12.5px] font-bold text-[#4A5568] mb-1.5">고용·정책 안내</label>
                          <textarea value={newJobPolicyNotes} onChange={(e) => setNewJobPolicyNotes(e.target.value)} rows={2} placeholder="예: 프리랜서(3.3%) 계약, 4대보험 미적용 · 본인 명의 정산" className="w-full px-3.5 py-2.5 border border-[#E2E8F0] rounded-xl text-[13.5px] leading-relaxed bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none" />
                        </div>
                        <div>
                          <label className="block text-[12.5px] font-bold text-[#4A5568] mb-1.5">기타 참고정보 (근무·차량 정책 등)</label>
                          <textarea value={newJobAiFacts} onChange={(e) => setNewJobAiFacts(e.target.value)} rows={3} placeholder="예: 주말·공휴일 근무 있음(월 2회 로테이션) · 오전+오후 동시 진행 가능 · 렌트/리스 차량 가능(1톤 이하) · 풀타임 불가" className="w-full px-3.5 py-2.5 border border-[#E2E8F0] rounded-xl text-[13.5px] leading-relaxed bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none" />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 px-7 py-5 border-t border-[#E2E8F0] bg-white">
              <div className="flex items-center gap-2 flex-wrap">
                <MapPin size={15} className="text-[#A0AEC0]" />
                {/* 화주사→지점 2단 선택 — 지점 미선택 시 client_id=null로 화주사 필터에서 유실되던 문제 방어(화주사만 골라도 저장). */}
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
                  className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-3 py-2 text-[13px] font-semibold text-[#4A5568] focus:outline-none focus:border-[#FFCB3C] cursor-pointer"
                  title="공고 화주사 — 지점을 안 골라도 필터 귀속을 위해 선택 권장"
                >
                  <option value="">화주사 선택</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
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
                  className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-3 py-2 text-[13px] font-semibold text-[#4A5568] focus:outline-none focus:border-[#FFCB3C] cursor-pointer"
                  title="공고를 등록할 지점"
                >
                  <option value="">지점 선택(선택)</option>
                  {(newJobClientId === "" ? branches : branches.filter((b) => b.client_id === newJobClientId)).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <select
                  value={newJobMode}
                  onChange={(e) => setNewJobMode(e.target.value as RecruitMode)}
                  className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-3 py-2 text-[13px] font-semibold text-[#4A5568] focus:outline-none focus:border-[#FFCB3C] cursor-pointer"
                  title="모집 방식"
                >
                  {(Object.keys(RECRUIT_MODE_META) as RecruitMode[]).map((m) => (
                    <option key={m} value={m}>{RECRUIT_MODE_META[m].label}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  value={newJobCapacity}
                  onChange={(e) => setNewJobCapacity(Math.max(1, Number(e.target.value) || 1))}
                  className="w-[72px] bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-3 py-2 text-[13px] font-semibold text-[#4A5568] focus:outline-none focus:border-[#FFCB3C]"
                  title="모집 인원(정원) — 충원율의 분모"
                />
                <select
                  value={newJobPayType}
                  onChange={(e) => setNewJobPayType(e.target.value)}
                  className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-3 py-2 text-[13px] font-semibold text-[#4A5568] focus:outline-none focus:border-[#FFCB3C] cursor-pointer"
                  title="대표 단가 형태 — 채우면 AI가 단가 문의에 직접 답합니다"
                >
                  <option value="">단가 형태(선택)</option>
                  {["건당", "일당", "주급", "월급", "혼합", "협의"].map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                {newJobPayType && newJobPayType !== "협의" && (
                  <input
                    type="number"
                    min={0}
                    value={newJobPayAmount}
                    onChange={(e) => setNewJobPayAmount(e.target.value === "" ? "" : Math.max(0, Number(e.target.value) || 0))}
                    placeholder="금액(원)"
                    className="w-[110px] bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-3 py-2 text-[13px] font-semibold text-[#4A5568] focus:outline-none focus:border-[#FFCB3C]"
                    title="대표 금액(원)"
                  />
                )}
                <select
                  value={newJobPeriod}
                  onChange={(e) => setNewJobPeriod(e.target.value)}
                  className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-3 py-2 text-[13px] font-semibold text-[#4A5568] focus:outline-none focus:border-[#FFCB3C] cursor-pointer"
                  title="모집 기간"
                >
                  <option value="">기간 미지정</option>
                  <option value="하루">하루(당일 단기)</option>
                  <option value="단기">단기(며칠~몇 주)</option>
                  <option value="정기">정기(상시 라인)</option>
                </select>
                <input
                  type="datetime-local"
                  value={newJobClosesAt}
                  min={nowLocalInput()}
                  onChange={(e) => setNewJobClosesAt(e.target.value)}
                  className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-3 py-2 text-[13px] font-semibold text-[#4A5568] focus:outline-none focus:border-[#FFCB3C]"
                  title="모집 마감시각 — 지나면 지원자 페이지에서 자동 마감"
                />
                <label className="flex items-center gap-1.5 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl px-3 py-2 text-[13px] font-semibold text-[#4A5568] cursor-pointer" title="차량(이륜/사륜) 필요 여부 — pull 공고 카드에 표시">
                  <input
                    type="checkbox"
                    checked={newJobVehicleRequired}
                    onChange={(e) => setNewJobVehicleRequired(e.target.checked)}
                    className="accent-[#FFCB3C]"
                  />
                  차량 필요
                </label>
                {/* 긴급 건에서 넘어온 공고 표시 — sos_id는 향후 공고↔긴급건 연결용으로만 보관 */}
                {newJobSosId && <input type="hidden" name="sos_id" value={newJobSosId} readOnly />}
              </div>
              <div className="flex items-center gap-3">
              <button
                onClick={() => { setAiModalOpen(false); resetNewJobForm(); }}
                className="px-5 py-2.5 rounded-xl text-[14px] font-bold text-[#4A5568] hover:bg-[#F1F4F8] transition-colors"
              >
                닫기
              </button>
              <button
                onClick={handleRegisterJob}
                disabled={!channelDrafts || registering}
                className="px-6 py-2.5 rounded-xl text-[14px] font-bold text-[#1A202C] bg-[#FFCB3C] hover:bg-[#E0B500] disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm flex items-center gap-2"
              >
                {registering ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                {registering ? "등록 중..." : "이 내용으로 공고 등록"}
              </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 공고 수정 모달 */}
      {editForm && (
        <div className="fixed inset-0 bg-[#00000080] z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => !editSaving && setEditForm(null)}>
          <div className="bg-white w-full max-w-[640px] rounded-[20px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-7 py-5 border-b border-[#E2E8F0]">
              <h2 className="text-[18px] font-extrabold text-[#1A202C]">공고 수정</h2>
              <button onClick={() => setEditForm(null)} className="text-[#A0AEC0] hover:text-[#4A5568]"><X size={22} /></button>
            </div>
            {editLoading ? (
              <div className="flex items-center justify-center py-16 text-[#A0AEC0]"><Loader2 size={20} className="animate-spin mr-2" /> 불러오는 중…</div>
            ) : (
              <div className="flex-1 overflow-y-auto p-7 flex flex-col gap-5">
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">공고 제목 <span className="text-[#E53E3E]">*</span></label>
                  <input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">지점</label>
                    <select value={editForm.branchId} onChange={(e) => setEditForm({ ...editForm, branchId: e.target.value === "" ? "" : Number(e.target.value) })} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]">
                      <option value="">미지정</option>
                      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">모집 인원</label>
                    <input type="number" min={1} value={editForm.capacity} onChange={(e) => setEditForm({ ...editForm, capacity: Math.max(1, Number(e.target.value) || 1) })} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                  </div>
                </div>
                <div className="flex items-center justify-between p-4 bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl">
                  <div className="text-[14px] font-bold text-[#1A202C]">차량(이륜/사륜) 필요</div>
                  <button onClick={() => setEditForm({ ...editForm, vehicleRequired: !editForm.vehicleRequired })} className={`w-12 h-7 rounded-full relative transition-colors ${editForm.vehicleRequired ? "bg-[#38A169]" : "bg-[#CBD5E0]"}`}>
                    <span className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform ${editForm.vehicleRequired ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">모집 방식</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(Object.keys(RECRUIT_MODE_META) as RecruitMode[]).map((m) => {
                      const sel = editForm.recruitMode === m;
                      return (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setEditForm({ ...editForm, recruitMode: m })}
                          className={`text-left p-3 rounded-xl border transition-colors ${sel ? "border-[#1A202C] bg-white ring-1 ring-[#1A202C]" : "border-[#E2E8F0] bg-white hover:border-[#CBD5E0]"}`}
                        >
                          <div className={`text-[13px] font-bold ${sel ? "text-[#1A202C]" : "text-[#4A5568]"}`}>{RECRUIT_MODE_META[m].label}</div>
                          <div className="text-[11px] text-[#A0AEC0] mt-0.5 leading-snug">{RECRUIT_MODE_META[m].desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">모집 기간</label>
                    <select value={editForm.workPeriod} onChange={(e) => setEditForm({ ...editForm, workPeriod: e.target.value })} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]">
                      <option value="">미지정</option>
                      <option value="하루">하루(당일 단기)</option>
                      <option value="단기">단기(며칠~몇 주)</option>
                      <option value="정기">정기(상시 라인)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">모집 마감시각</label>
                    <input type="datetime-local" value={editForm.closesAt} min={nowLocalInput()} onChange={(e) => setEditForm({ ...editForm, closesAt: e.target.value })} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                    <p className="text-[11px] text-[#A0AEC0] mt-1">지나면 지원자 페이지에서 자동 마감</p>
                  </div>
                </div>
                {/* 근무 상세 — pull(/p/[token]) 카드 표시 필드 (근무시간·시작일·집결지) */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">근무시간</label>
                    <select value={editForm.slot} onChange={(e) => setEditForm({ ...editForm, slot: e.target.value })} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]">
                      <option value="">미지정</option>
                      {SLOT_KEYS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">시작일</label>
                    <input type="date" value={editForm.startDate} onChange={(e) => setEditForm({ ...editForm, startDate: e.target.value })} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                  </div>
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">집결지</label>
                  <input type="text" value={editForm.pickupAddress} onChange={(e) => setEditForm({ ...editForm, pickupAddress: e.target.value })} placeholder="예: 성수동 물류센터 3번 게이트" className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]" />
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#4A5568] mb-2">공고 내용</label>
                  <textarea value={editForm.body} onChange={(e) => setEditForm({ ...editForm, body: e.target.value })} rows={10} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-[13.5px] leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none" />
                </div>
                {/* AI 응대 근거 — 채워두면 단가·정책 질문을 AI가 직접 답해 매니저 인계가 줄어든다 */}
                <div className="p-4 bg-[#FFFBEC] border border-[#FAF089] rounded-xl flex flex-col gap-4">
                  <div className="text-[12px] font-bold text-[#B7791F]">AI 응대 근거 (선택) — 채우면 단가·정책 문의를 AI가 직접 안내해 인계가 줄어듭니다</div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[13px] font-bold text-[#4A5568] mb-2">대표 단가 형태</label>
                      <select value={editForm.payType} onChange={(e) => setEditForm({ ...editForm, payType: e.target.value })} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm bg-white focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]">
                        <option value="">미지정</option>
                        {["건당", "일당", "주급", "월급", "혼합", "협의"].map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[13px] font-bold text-[#4A5568] mb-2">대표 금액(원)</label>
                      <input type="number" min={0} value={editForm.payAmount} onChange={(e) => setEditForm({ ...editForm, payAmount: e.target.value === "" ? "" : Math.max(0, Number(e.target.value) || 0) })} placeholder="예: 3500" className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] bg-white" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">급여·정산 정보</label>
                    <textarea value={editForm.payInfo} onChange={(e) => setEditForm({ ...editForm, payInfo: e.target.value })} rows={2} placeholder="예: 건당 3,000원 · 매주 정산 · 프로모션 5천원(1~2개월 후 종료 가능)" className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-[13.5px] leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none bg-white" />
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">고용·정책 안내</label>
                    <textarea value={editForm.policyNotes} onChange={(e) => setEditForm({ ...editForm, policyNotes: e.target.value })} rows={2} placeholder="예: 프리랜서(3.3%) 계약, 4대보험 미적용 · 본인 명의 정산" className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-[13.5px] leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none bg-white" />
                  </div>
                  <div>
                    <label className="block text-[13px] font-bold text-[#4A5568] mb-2">기타 참고정보 (근무·차량 정책 등)</label>
                    <textarea value={editForm.aiFacts} onChange={(e) => setEditForm({ ...editForm, aiFacts: e.target.value })} rows={3} placeholder={"예: 주말·공휴일 근무 있음(월 2회 로테이션) · 오전+오후 동시 진행 가능 · 렌트/리스 차량 가능(1톤 이하) · 풀타임 불가"} className="w-full px-4 py-3 border border-[#E2E8F0] rounded-xl text-[13.5px] leading-relaxed focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C] resize-none bg-white" />
                  </div>
                </div>
              </div>
            )}
            <div className="flex items-center justify-end gap-3 px-7 py-5 border-t border-[#E2E8F0] bg-white">
              <button onClick={() => setEditForm(null)} disabled={editSaving} className="px-5 py-2.5 rounded-xl text-[14px] font-bold text-[#4A5568] hover:bg-[#F1F4F8] disabled:opacity-50">취소</button>
              <button onClick={handleEditSave} disabled={editSaving || editLoading} className="px-6 py-2.5 rounded-xl text-[14px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] disabled:opacity-60 flex items-center gap-2">
                {editSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} 저장
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 공고별 지원자 보드 (슬라이드) */}
      <AnimatePresence>
        {candPanel && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setCandPanel(null)} className="fixed inset-0 bg-black/30 z-40 backdrop-blur-[2px]" />
            <motion.div
              initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 26, stiffness: 220 }}
              className="fixed top-0 right-0 w-[480px] max-w-[92vw] h-full bg-white shadow-[-10px_0_30px_rgba(0,0,0,0.1)] z-40 flex flex-col border-l border-[#E2E8F0]"
            >
              <div className="px-6 py-4 border-b border-[#E2E8F0] bg-[#F7FAFC] shrink-0">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[12px] font-bold text-[#718096] mb-1"><Users size={13} /> 공고별 지원자</div>
                    <h2 className="text-[17px] font-extrabold text-[#1A202C] truncate">{candPanel.title}</h2>
                    <div className="text-[12px] text-[#A0AEC0] mt-0.5">{candidates.length}명 지원 · 미발송 {unsentCount}명</div>
                  </div>
                  <button onClick={() => setCandPanel(null)} className="p-2 hover:bg-[#E2E8F0] rounded-lg text-[#A0AEC0] hover:text-[#1A202C]"><X size={20} /></button>
                </div>
                <button
                  onClick={openPicker}
                  className="mt-3 w-full flex items-center justify-center gap-2 bg-white hover:bg-[#F7FAFC] text-[#1A202C] border border-[#E2E8F0] px-4 py-2.5 rounded-xl text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                >
                  <UserPlus size={15} /> 인재풀에서 후보 추가
                </button>
                {unsentCount > 0 && (
                  <button
                    onClick={dispatchUnsent}
                    disabled={dispatching}
                    className="mt-3 w-full flex items-center justify-center gap-2 bg-[#1A202C] hover:bg-[#2D3748] disabled:opacity-60 text-white px-4 py-2.5 rounded-xl text-[13px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFCB3C]"
                  >
                    {dispatching ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                    미발송 {unsentCount}명에게 스크리닝 문자 발송
                  </button>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {candLoading && <div className="text-[13px] text-[#A0AEC0] text-center py-8">불러오는 중…</div>}
                {!candLoading && candidates.length === 0 && <div className="text-[13px] text-[#A0AEC0] text-center py-8">아직 지원자가 없어요</div>}

                {!candLoading && candidates.length > 0 && (
                  <div className="bg-[#F7FAFC] border border-[#E2E8F0] rounded-xl p-3.5 space-y-3">
                    {/* 단계 분포 */}
                    <div>
                      <div className="text-[11px] font-bold text-[#A0AEC0] mb-1.5">진행 단계</div>
                      <div className="flex flex-wrap gap-1.5">
                        {STAGE_ORDER.filter((s) => stageCounts[s]).map((s) => (
                          <span key={s} className={`text-[11px] font-bold px-2 py-0.5 rounded-md ${STAGE_COLOR[s] ?? "bg-[#EDF2F7] text-[#4A5568]"}`}>{STAGE_KO[s] ?? s} {stageCounts[s]}</span>
                        ))}
                      </div>
                    </div>
                    {/* 채널 유입 */}
                    <div>
                      <div className="text-[11px] font-bold text-[#A0AEC0] mb-1.5">유입 채널</div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(channelCounts).sort((a, b) => b[1] - a[1]).map(([src, n]) => (
                          <span key={src} className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-white border border-[#E2E8F0] text-[#4A5568]">{sourceLabel(src)} {n}</span>
                        ))}
                      </div>
                    </div>
                    {/* 확정 슬롯 분포 */}
                    {hasConfirmedSlot && (
                      <div>
                        <div className="text-[11px] font-bold text-[#A0AEC0] mb-1.5" title="매니저가 '확정인력'으로 지정한 후보의 시간대 분포 — 충원율 게이지와 같은 기준">확정 슬롯 분포</div>
                        <div className="grid grid-cols-4 gap-1.5">
                          {slotFill.map((s) => (
                            <div key={s.key} className={`text-center rounded-md py-1.5 ${s.count > 0 ? "bg-[#F0FFF4] border border-[#C6F6D5]" : "bg-white border border-[#E2E8F0]"}`}>
                              <div className="text-[10px] font-bold text-[#718096]">{s.label}</div>
                              <div className={`text-[14px] font-extrabold ${s.count > 0 ? "text-[#38A169]" : "text-[#CBD5E0]"}`}>{s.count}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {stageGroups.map((group) => (
                  <div key={group.stage} className="space-y-2">
                    <div className="flex items-center gap-2 px-0.5">
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md ${STAGE_COLOR[group.stage] ?? "bg-[#EDF2F7] text-[#4A5568]"}`}>{STAGE_KO[group.stage] ?? group.stage}</span>
                      <span className="text-[11px] text-[#A0AEC0] font-bold">{group.items.length}명</span>
                      <div className="flex-1 h-px bg-[#EDF2F7]" />
                    </div>
                    {group.items.map((c) => {
                      const a = c.applicants;
                      const stage = c.agent_stage ?? "";
                      const unread = a?.unread_count ?? 0;
                      const busy = candBusyId === c.id;
                      const isPaused = stage === "paused";
                      const isClosed = stage === "abort";
                      return (
                        <div key={c.id} className="bg-white border border-[#E2E8F0] rounded-xl p-3.5 hover:border-[#CBD5E0] transition-all">
                          <button onClick={() => setSelectedApplicantId(c.applicant_id)} className="w-full text-left">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className="w-9 h-9 rounded-lg bg-[#EDF2F7] text-[#4A5568] flex items-center justify-center font-bold text-[14px] shrink-0">{a?.name?.charAt(0) ?? "?"}</div>
                                <div className="min-w-0">
                                  <div className="text-[14px] font-bold text-[#1A202C] flex items-center gap-1.5">{a?.name ?? `#${c.applicant_id}`} {unread > 0 && <span className="w-4 h-4 rounded-full bg-[#E53E3E] text-white text-[10px] flex items-center justify-center">{unread}</span>}</div>
                                  <div className="text-[11.5px] text-[#718096] truncate">{a?.source ? sourceLabel(a.source) + " · " : ""}{a?.branch1 ?? "-"} · {a?.work_hours ?? "-"}{!c.sent_at && <span className="ml-1 text-[#D69E2E] font-bold">· 미발송</span>}</div>
                                </div>
                              </div>
                              {/* 종료 카드는 결과(보류/공고부적합/중단)를 closed_reason으로 구분해 배지로 보여준다. */}
                              {stage && (
                                isClosed ? (
                                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md shrink-0 ${closedKind(c.closed_reason).badge}`}>{closedKind(c.closed_reason).label}</span>
                                ) : (
                                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md shrink-0 ${STAGE_COLOR[stage] ?? "bg-[#EDF2F7] text-[#4A5568]"}`}>{STAGE_KO[stage] ?? stage}</span>
                                )
                              )}
                            </div>
                          </button>
                          {isClosed ? (
                            <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-[#F1F4F8]">
                              {/* 되돌리기 — 잘못 종료한 카드를 이 공고 후보로 복원(확인 모달). 인력풀은 건드리지 않는다. */}
                              <button onClick={() => resumeCandidate(c)} disabled={busy} className="flex items-center gap-1 text-[11.5px] font-bold text-[#3182CE] hover:bg-[#EBF8FF] px-2 py-1 rounded-md disabled:opacity-50 transition-colors">
                                {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} 재개
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-[#F1F4F8]">
                              {isPaused ? (
                                <button onClick={() => patchCandidate(c.id, { agent_stage: "screening" }, "AI 응대를 재개했어요")} disabled={busy} className="flex items-center gap-1 text-[11.5px] font-bold text-[#3182CE] hover:bg-[#EBF8FF] px-2 py-1 rounded-md disabled:opacity-50 transition-colors">
                                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} 응대 재개
                                </button>
                              ) : (
                                <button onClick={() => patchCandidate(c.id, { agent_stage: "paused", paused_reason: "manager: 수동 전환" }, "AI 응대를 정지했어요 (수동 전환)")} disabled={busy} className="flex items-center gap-1 text-[11.5px] font-bold text-[#718096] hover:bg-[#EDF2F7] px-2 py-1 rounded-md disabled:opacity-50 transition-colors">
                                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Pause size={12} />} 응대 정지
                                </button>
                              )}
                              {/* 공고 단위 결과 — 둘 다 이 공고 후보만 닫고, 지원자는 인력풀에 유지된다(다른 공고엔 여전히 후보).
                                  인력풀 전체 제외는 지원자 상세의 '인력풀 제외'에서만. */}
                              <button onClick={() => patchCandidate(c.id, { agent_stage: "abort", closed_reason: "manager: 보류" }, "이 공고 보류했어요 (인력풀에는 유지)")} disabled={busy} className="flex items-center gap-1 text-[11.5px] font-bold text-[#718096] hover:bg-[#EDF2F7] px-2 py-1 rounded-md disabled:opacity-50 transition-colors ml-auto">
                                <PauseCircle size={12} /> 보류
                              </button>
                              <button onClick={() => patchCandidate(c.id, { agent_stage: "abort", closed_reason: "manager: 공고부적합" }, "이 공고 부적합 처리했어요 (인력풀에는 유지)")} disabled={busy} className="flex items-center gap-1 text-[11.5px] font-bold text-[#E53E3E] hover:bg-[#FFF5F5] px-2 py-1 rounded-md disabled:opacity-50 transition-colors">
                                <X size={12} /> 부적합
                              </button>
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
        <div className="fixed inset-0 bg-[#00000080] z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => !adding && setPickerOpen(false)}>
          <div className="bg-white w-full max-w-[560px] rounded-[20px] shadow-2xl overflow-hidden flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2E8F0]">
              <div>
                <h2 className="text-[17px] font-extrabold text-[#1A202C] flex items-center gap-2"><UserPlus size={18} className="text-[#805AD5]" /> 인재풀에서 후보 추가</h2>
                <p className="text-[12px] text-[#718096] mt-0.5">선택한 분들을 <b>미발송 후보</b>로 추가합니다. 컨택(문자 발송)은 이후 매니저가 진행해요.</p>
              </div>
              <button onClick={() => setPickerOpen(false)} className="text-[#A0AEC0] hover:text-[#4A5568]"><X size={22} /></button>
            </div>
            <div className="px-6 py-3 border-b border-[#F1F4F8]">
              <div className="relative">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
                <input
                  type="text"
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  placeholder="이름, 연락처, 지점 검색"
                  className="w-full pl-9 pr-3 py-2.5 border border-[#E2E8F0] rounded-xl text-sm focus:outline-none focus:border-[#FFCB3C] focus:ring-1 focus:ring-[#FFCB3C]"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
              {poolLoading && <div className="text-[13px] text-[#A0AEC0] text-center py-10">불러오는 중…</div>}
              {!poolLoading && pickablePool.length === 0 && <div className="text-[13px] text-[#A0AEC0] text-center py-10">추가할 수 있는 인재풀 후보가 없어요</div>}
              {!poolLoading && pickablePool.map((p) => {
                const sel = picked.has(p.id);
                const conflict = p.current_job_id != null && p.current_job_id !== candPanel?.jobId;
                return (
                  <button
                    key={p.id}
                    onClick={() => setPicked((prev) => { const n = new Set(prev); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}
                    className={`w-full flex items-center gap-3 text-left px-3 py-2.5 rounded-xl border transition-colors ${sel ? "border-[#805AD5] bg-[#FAF5FF]" : "border-[#E2E8F0] bg-white hover:border-[#CBD5E0]"}`}
                  >
                    <span className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${sel ? "bg-[#805AD5] border-[#805AD5]" : "border-[#CBD5E0]"}`}>
                      {sel && <CheckCircle2 size={14} className="text-white" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-bold text-[#1A202C] flex items-center gap-1.5">
                        {p.name ?? `#${p.id}`}
                        {conflict && <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded bg-[#FFFAF0] text-[#DD6B20] border border-[#FEEBC8]">다른 공고 진행 중</span>}
                      </div>
                      <div className="text-[11.5px] text-[#718096] truncate">{(p.source ? sourceLabel(p.source) + " · " : "")}{p.branch1 ?? "-"} · {p.work_hours ?? "-"}{p.status ? " · " + p.status : ""}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-[#E2E8F0] bg-white">
              <div className="text-[13px] font-bold text-[#4A5568]">{picked.size}명 선택</div>
              <div className="flex items-center gap-2">
                <button onClick={() => setPickerOpen(false)} disabled={adding} className="px-5 py-2.5 rounded-xl text-[14px] font-bold text-[#4A5568] hover:bg-[#F1F4F8] disabled:opacity-50">취소</button>
                <button onClick={addFromPool} disabled={adding || picked.size === 0} className="px-6 py-2.5 rounded-xl text-[14px] font-bold text-white bg-[#1A202C] hover:bg-[#2D3748] disabled:opacity-50 flex items-center gap-2">
                  {adding ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />} 후보로 추가
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ApplicantDetailPanel
        isOpen={selectedApplicantId != null}
        onClose={() => setSelectedApplicantId(null)}
        applicantId={selectedApplicantId}
        jobId={candPanel?.jobId ?? null}
        onChanged={() => { if (candPanel) loadCandidates(candPanel.jobId); loadJobs(); }}
      />
    </div>
  );
}