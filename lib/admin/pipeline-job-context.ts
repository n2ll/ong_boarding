import { defaultJobAnnouncementBody } from "./job-announcement-copy.ts";

interface PipelineActiveJobReference {
  id: number;
}

const PIPELINE_JOB_SLOT_KEYS = ["평일오전", "평일오후", "주말오전", "주말오후"] as const;
type PipelineJobSlotKey = (typeof PIPELINE_JOB_SLOT_KEYS)[number];

interface PipelineJobApiRow {
  id: number;
  title: string;
  branch?: string | null;
  exposure?: string | null;
  vehicle_required?: boolean | null;
  slot_keys?: unknown;
  pickup_address?: string | null;
  pickup_lat?: number | null;
  pickup_lng?: number | null;
  dropoff_address?: string | null;
  dropoff_lat?: number | null;
  dropoff_lng?: number | null;
  distance_basis?: string | null;
  recruit_mode?: string | null;
}

export interface PipelineFocusedJob {
  id: number;
  title: string;
  branch: string | null;
  exposure: "all" | "targeted";
  vehicleRequired: boolean | null;
  slotKeys: PipelineJobSlotKey[];
  pickupAddress: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffAddress: string | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
  distanceBasis: "pickup" | "nearest" | null;
  recruitMode: "external" | "internal" | "both" | null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableCoordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 활성 공고 응답을 내부 충원 화면의 안전한 스냅샷으로 바꾼다.
 * 차량·시간·주소는 DB에 실제 저장된 값만 보존하며, 제목·지점·주소에서 지역을 추측하지 않는다.
 */
export function pipelineFocusedJobProjection(job: PipelineJobApiRow): PipelineFocusedJob {
  const rawSlots = Array.isArray(job.slot_keys) ? job.slot_keys : [];
  const slotSet = new Set(
    rawSlots.filter(
      (value): value is PipelineJobSlotKey =>
        typeof value === "string" && (PIPELINE_JOB_SLOT_KEYS as readonly string[]).includes(value),
    ),
  );

  return {
    id: job.id,
    title: job.title,
    branch: nullableText(job.branch),
    exposure: job.exposure === "targeted" ? "targeted" : "all",
    vehicleRequired: typeof job.vehicle_required === "boolean" ? job.vehicle_required : null,
    slotKeys: PIPELINE_JOB_SLOT_KEYS.filter((key) => slotSet.has(key)),
    pickupAddress: nullableText(job.pickup_address),
    pickupLat: nullableCoordinate(job.pickup_lat),
    pickupLng: nullableCoordinate(job.pickup_lng),
    dropoffAddress: nullableText(job.dropoff_address),
    dropoffLat: nullableCoordinate(job.dropoff_lat),
    dropoffLng: nullableCoordinate(job.dropoff_lng),
    distanceBasis:
      job.distance_basis === "pickup" || job.distance_basis === "nearest" ? job.distance_basis : null,
    recruitMode:
      job.recruit_mode === "external" || job.recruit_mode === "internal" || job.recruit_mode === "both"
        ? job.recruit_mode
        : null,
  };
}

/** 공고 위치가 실제 좌표로 저장된 경우에만 내부 충원 목록을 근거리순으로 시작한다. */
export function pipelineFocusedJobInitialSortMode(
  job: Pick<
    PipelineFocusedJob,
    "pickupLat" | "pickupLng" | "dropoffLat" | "dropoffLng" | "distanceBasis"
  >,
): "distance" | null {
  const hasPickup = job.pickupLat !== null && job.pickupLng !== null;
  const hasDropoff =
    job.distanceBasis !== "pickup" && job.dropoffLat !== null && job.dropoffLng !== null;
  return hasPickup || hasDropoff ? "distance" : null;
}

export type PipelineFillMissionStepState = "done" | "current" | "upcoming";

/** 선택·노출 저장은 사실 상태로만 전진시키며, 문자 단계는 언제나 별도 검토로 남긴다. */
export function pipelineFillMissionSteps(input: {
  selectedCount: number;
  exposureReady: boolean;
}): Array<{ label: string; state: PipelineFillMissionStepState }> {
  const hasSelection = input.selectedCount > 0;
  return [
    { label: "조건 확인", state: "done" },
    { label: "대상 선택", state: hasSelection ? "done" : "current" },
    {
      label: "공고 노출",
      state: input.exposureReady ? "done" : hasSelection ? "current" : "upcoming",
    },
    { label: "문자 검토", state: input.exposureReady ? "current" : "upcoming" },
  ];
}

/** 노출 성공 뒤 열리는 문자 작성창의 초안. 생성만 하며 발송은 호출자가 별도 확인받는다. */
export function pipelineFocusedJobMessageBody(title: string): string {
  return defaultJobAnnouncementBody(title);
}

/** 새 공고 안내는 개인 맞춤 링크가 빠진 채 발송되지 않도록 작성 단계에서 막는다. */
export function pipelineFocusedJobMessageReviewIssue(input: {
  body: string;
  newJobNoticeJobId: number | null;
}): string | null {
  if (input.newJobNoticeJobId === null || input.body.includes("#{맞춤링크}")) return null;
  return "새 공고 안내에는 #{맞춤링크} 치환자가 필요해요.";
}

/** 서버의 new_job 발송 규칙과 같이 이미 확정된 인력은 새 공고 안내에서 제외한다. */
export function pipelineFocusedJobRecipientStatusAllowed(input: {
  status: string;
  newJobNoticeJobId: number | null;
}): boolean {
  return input.newJobNoticeJobId === null || input.status !== "확정인력";
}

/** 벌크 작성창의 진입 맥락을 서버 발송 목적과 공고 귀속으로 보존한다. */
export function pipelineBulkMessageContext(input: {
  isWaitlist: boolean;
  waitlistJobId: number | null;
  newJobNoticeJobId: number | null;
}): { purpose: "campaign" | "waitlist" | "new_job"; jobId: number | null } {
  if (input.isWaitlist) {
    return {
      purpose: "waitlist",
      jobId: Number.isSafeInteger(input.waitlistJobId) && (input.waitlistJobId ?? 0) > 0
        ? input.waitlistJobId
        : null,
    };
  }
  if (Number.isSafeInteger(input.newJobNoticeJobId) && (input.newJobNoticeJobId ?? 0) > 0) {
    return { purpose: "new_job", jobId: input.newJobNoticeJobId };
  }
  return { purpose: "campaign", jobId: null };
}

function searchParamsFrom(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

/**
 * 공고 등록 뒤 인재풀로 넘긴 `job` 맥락은 화면 상태와 분리해 엄격하게 읽는다.
 * 잘못된 값이 다른 공고를 가리키는 것보다 맥락을 표시하지 않는 편이 안전하다.
 */
export function pipelineFocusedJobIdFromSearch(search = ""): number | null {
  const raw = searchParamsFrom(search).get("job")?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return null;

  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 활성 공고 응답에 실제로 남아 있는 경우에만 인계 맥락을 노출한다. */
export function pipelineFocusedActiveJob<T extends PipelineActiveJobReference>(
  search: string,
  activeJobs: readonly T[],
): T | null {
  const focusedJobId = pipelineFocusedJobIdFromSearch(search);
  if (focusedJobId === null) return null;
  return activeJobs.find((job) => job.id === focusedJobId) ?? null;
}

/** 활성 공고 조회가 끝난 뒤에도 인계 공고가 없으면 마감·삭제 복구 안내를 보여준다. */
export function pipelineFocusedJobHandoffState(
  search: string,
  activeJobs: readonly PipelineActiveJobReference[],
  activeJobsLoaded: boolean,
  activeJobsFailed = false,
): "none" | "invalid" | "loading" | "error" | "active" | "unavailable" {
  if (!searchParamsFrom(search).has("job")) return "none";
  const focusedJobId = pipelineFocusedJobIdFromSearch(search);
  if (focusedJobId === null) return "invalid";
  if (activeJobsFailed) return "error";
  if (!activeJobsLoaded) return "loading";
  return activeJobs.some((job) => job.id === focusedJobId) ? "active" : "unavailable";
}

/**
 * 노출 지정 창을 여는 순간의 기본 선택만 계산한다.
 * 저장·후보 등록·연락은 하지 않으며, 활성 목록에서 사라진 공고는 선택하지 않는다.
 */
export function pipelineExposureJobIdsOnOpen(
  search: string,
  activeJobs: readonly PipelineActiveJobReference[],
): Set<number> {
  const focusedJob = pipelineFocusedActiveJob(search, activeJobs);
  return new Set(focusedJob ? [focusedJob.id] : []);
}
