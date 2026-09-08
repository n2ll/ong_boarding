import type { SupabaseClient } from "@supabase/supabase-js";
export type PilotCandidate = { id: number; job_id: number; applicant_id: number; agent_stage: string | null; applicants: { id: number; name: string | null; phone: string | null; status: string | null; sms_opt_out_at: string | null } | null };
export function isPilotCandidateEligible(row: PilotCandidate): boolean { const applicant = row.applicants;
  return Boolean(applicant?.phone && !applicant.sms_opt_out_at
    && !["부적합", "이탈", "인력풀 제외", "확정인력"].includes(applicant.status ?? "")
    && (row.agent_stage === null || ["exploration", "screening", "onboarding", "active"].includes(row.agent_stage))); }


export async function loadPilotCandidates(db: SupabaseClient, jobIds: number[]): Promise<PilotCandidate[]> {
  const { data: jobs, error: jobsError } = await db.from("jobs").select("id,title,status,closes_at").in("id", jobIds);
  if (jobsError) throw new Error("공고를 조회하지 못했습니다.");
  if (jobs?.length !== jobIds.length || jobs.some((job) => !job.title?.trim() || job.title.startsWith("__") || job.status !== "active" || (job.closes_at != null && !(Date.parse(job.closes_at) > Date.now())))) throw new Error("모집 중인 실제 공고를 선택해주세요.");
  const { data, error } = await db.from("job_candidates").select("id,job_id,applicant_id,agent_stage,applicants:applicant_id(id,name,phone,status,sms_opt_out_at)").in("job_id", jobIds).limit(1000);
  if (error || (data?.length ?? 0) >= 1000) throw new Error("후보 목록을 모두 확인하지 못했습니다. 공고를 나누어 선택해주세요.");
  return (data ?? []).map((row) => ({ ...row, applicants: Array.isArray(row.applicants) ? row.applicants[0] ?? null : row.applicants }) as PilotCandidate).filter(isPilotCandidateEligible);
}
