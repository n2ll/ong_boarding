import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPostgrestRows } from "../admin/postgrest-pagination.ts";
import { fetchOverridesForApplicant, isExposed, normalizeRule, type ExposureApplicant, type ExposureMode } from "../exposure.ts";
import { EXPOSURE_JOB_GEO_COLUMNS, type GeoJob } from "../geo.ts";
import { isSystemJobTitle, slotKeysLabel } from "../jobs.ts";
import type { ConsultationJob } from "./consultation-types.ts";

const JOB_COLUMNS = `id, title, branch, status, recruit_mode, exposure, exposure_rule, closes_at, slot, slot_keys, start_date, work_period, pay_info, pay_type, pay_amount, pickup_address, vehicle_required, ${EXPOSURE_JOB_GEO_COLUMNS}`;
const ID_BATCH_SIZE = 200;
const EXPIRED_GRACE_MS = 3 * 24 * 60 * 60 * 1_000;

interface CandidateRow {
  id: number;
  job_id: number;
  agent_stage: ConsultationJob["stage"];
  closed_at: string | null;
  closed_reason: string | null;
}

interface JobRow extends GeoJob {
  id: number;
  title: string;
  branch: string | null;
  status: string;
  recruit_mode: string;
  exposure: string;
  exposure_rule: unknown;
  closes_at: string | null;
  slot: string | null;
  slot_keys: string[] | null;
  start_date: string | null;
  work_period: string | null;
  pay_info: string | null;
  pay_type: string | null;
  pay_amount: number | null;
  pickup_address: string | null;
  vehicle_required: boolean | null;
}

/** 상담 자료만 읽는다. 후보 연결·단계·가용성·현재 대화 포인터를 변경하지 않는다. */
export async function loadConsultationJobs(supabase: SupabaseClient, applicantId: number): Promise<ConsultationJob[]> {
  const [applicantResult, candidates, visibleJobs] = await Promise.all([
    supabase.from("applicants")
      .select("id, sido, sigungu, availability, own_vehicle, work_hours, available_slots, lat, lng, applied_at, created_at")
      .eq("id", applicantId).maybeSingle(),
    fetchAllPostgrestRows<CandidateRow>(async (from, to) => {
      const result = await supabase.from("job_candidates")
        .select("id, job_id, agent_stage, closed_at, closed_reason")
        .eq("applicant_id", applicantId).order("id", { ascending: false }).range(from, to);
      return { data: result.data as CandidateRow[] | null, error: result.error };
    }, "상담 후보"),
    fetchAllPostgrestRows<JobRow>(async (from, to) => {
      const result = await supabase.from("jobs").select(JOB_COLUMNS)
        .eq("status", "active").in("recruit_mode", ["internal", "both"])
        .order("id", { ascending: true }).range(from, to);
      return { data: result.data as JobRow[] | null, error: result.error };
    }, "상담 공고"),
  ]);
  if (applicantResult.error || !applicantResult.data) {
    throw new Error(`상담 지원자 조회 실패: ${applicantResult.error?.message ?? "applicant not found"}`);
  }

  const candidateByJob = new Map<number, CandidateRow>();
  for (const candidate of candidates) {
    if (!candidateByJob.has(candidate.job_id)) candidateByJob.set(candidate.job_id, candidate);
  }
  const jobsById = new Map(visibleJobs.map((job) => [job.id, job]));
  // external은 이 지원자의 기존 연결만 조회한다. 전체 외부 모집 공고가 상담에 섞이면 안 된다.
  const linkedIds = [...candidateByJob.values()]
    .filter((candidate) => candidate.agent_stage !== "abort" && !candidate.closed_at && !candidate.closed_reason && !jobsById.has(candidate.job_id))
    .map((candidate) => candidate.job_id);
  for (let offset = 0; offset < linkedIds.length; offset += ID_BATCH_SIZE) {
    const { data, error } = await supabase.from("jobs").select(JOB_COLUMNS)
      .eq("status", "active").eq("recruit_mode", "external")
      .in("id", linkedIds.slice(offset, offset + ID_BATCH_SIZE)).order("id", { ascending: true });
    if (error || !data) throw new Error(`연결 상담 공고 조회 실패: ${error?.message ?? "invalid response"}`);
    for (const job of data as JobRow[]) jobsById.set(job.id, job);
  }

  const nowMs = Date.now();
  const jobs = [...jobsById.values()].filter((job) => {
    if (!job.title?.trim() || isSystemJobTitle(job.title)) return false;
    const closesAt = job.closes_at == null ? null : Date.parse(job.closes_at);
    return closesAt === null || (Number.isFinite(closesAt) && closesAt > nowMs - EXPIRED_GRACE_MS);
  });
  const targetedIds = jobs.filter((job) => job.exposure === "targeted").map((job) => job.id);
  const overrides = new Map<number, ExposureMode>();
  let suntopDone = false;
  if (targetedIds.length) {
    // 한 지원자·공고당 override는 하나다. IN을 작게 나눠 PostgREST 1000행 상한도 피한다.
    for (let offset = 0; offset < targetedIds.length; offset += ID_BATCH_SIZE) {
      const batch = await fetchOverridesForApplicant(supabase, applicantId, targetedIds.slice(offset, offset + ID_BATCH_SIZE));
      for (const [jobId, mode] of batch) overrides.set(jobId, mode);
    }
    // fetchSuntopDone은 DB 오류를 false로 삼으므로, 자동 상담에서는 오류까지 직접 확인한다.
    const { data, error } = await supabase.from("pool_events").select("id")
      .eq("applicant_id", applicantId).eq("event_type", "suntop_done").limit(1).maybeSingle();
    if (error) throw new Error(`상담 노출 선탑 이력 조회 실패: ${error.message}`);
    suntopDone = Boolean(data);
  }
  const applicant = { ...applicantResult.data, suntopDone } as ExposureApplicant;
  return jobs.filter((job) => job.exposure === "all" || (
    job.exposure === "targeted" && isExposed(applicant, normalizeRule(job.exposure_rule), overrides.get(job.id), { job, nowMs })
  )).sort((a, b) => a.id - b.id).map((job) => {
    const candidate = candidateByJob.get(job.id);
    return {
      job_id: job.id,
      candidate_id: candidate?.id ?? null,
      stage: candidate?.agent_stage ?? null,
      title: job.title,
      branch: job.branch,
      expired: job.closes_at !== null && Date.parse(job.closes_at) <= nowMs,
      slot: job.slot || slotKeysLabel(job.slot_keys) || null,
      start_date: job.start_date,
      work_period: job.work_period,
      pay_info: job.pay_info,
      pay_type: job.pay_type,
      pay_amount: job.pay_amount,
      pickup_address: job.pickup_address,
      vehicle_required: job.vehicle_required,
    };
  });
}
