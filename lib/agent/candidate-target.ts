import type { SupabaseClient } from "@supabase/supabase-js";
import { isSystemJobTitle } from "../jobs";

/**
 * 매니저 액션(발송·AI 중단·AI 재개)의 **대상 후보 판정 단일화**.
 *
 * 왜: 세 지점(messages/send · agent/pause · agent/resume)이 각각 "job_id가 오면 그 공고, 없으면 최신 후보"
 * 폴백을 따로 들고 있었다. 한 사람이 여러 공고를 동시에 진행하면(다공고 운영) 이 폴백이
 * **엉뚱한 공고의 AI를 끄고**, 그 뒤 '재개'는 다른 공고를 보게 되어 400으로 실패했다.
 *
 * 규칙:
 *  - jobId를 명시하면 **그 공고만** 본다. 그 공고에 해당 후보가 없으면 다른 공고로 넘어가지 않는다(none).
 *  - jobId가 없으면 후보가 정확히 1건일 때만 그것을 쓴다(현재 동작과 동일 — 단일 공고 케이스 100% 보존).
 *    2건 이상이면 ambiguous로 돌려주고 호출부가 공고를 고르게 한다(조용히 아무거나 고르지 않는다).
 *
 * 확정 뉘앙스와 무관한 순수 대상 판정이다 — 상태를 바꾸는 건 호출부의 책임.
 */

export interface TargetCandidate {
  id: number;
  job_id: number;
  agent_stage: string | null;
  agent_state: unknown;
}

export type CandidateTarget =
  | { ok: true; candidate: TargetCandidate }
  | { ok: false; reason: "none" }
  | { ok: false; reason: "ambiguous"; options: { job_id: number; title: string | null }[] };

/** want='active' = AI가 응대 중인 후보(중단·이탈 제외) · want='paused' = 재개 대상(중단된 후보). */
export type TargetWant = "active" | "paused";

const ACTIVE_STAGES = ["exploration", "screening", "onboarding", "active"];

export async function resolveCandidateTarget(
  supabase: SupabaseClient,
  applicantId: number,
  jobId: number | null,
  opts: { want: TargetWant }
): Promise<CandidateTarget> {
  let q = supabase
    .from("job_candidates")
    .select("id, job_id, agent_stage, agent_state, created_at, jobs:job_id ( title )")
    .eq("applicant_id", applicantId);

  q = opts.want === "paused" ? q.eq("agent_stage", "paused") : q.in("agent_stage", ACTIVE_STAGES);

  if (jobId != null && Number.isFinite(jobId)) q = q.eq("job_id", jobId);

  const { data, error } = await q.order("created_at", { ascending: false }).limit(20);
  if (error) {
    console.error("[candidate-target] load failed", error);
    return { ok: false, reason: "none" };
  }

  type Row = TargetCandidate & { jobs?: { title: string | null } | { title: string | null }[] | null };
  // 시스템 더미 공고(__baemin_system__ 등)는 매니저가 고르는 대상이 아니다 — 후보 목록에서 뺀다.
  const rows = ((data ?? []) as Row[]).filter((r) => {
    const rel = r.jobs;
    const j = Array.isArray(rel) ? rel[0] : rel;
    return !isSystemJobTitle(j?.title ?? "");
  });

  if (rows.length === 0) return { ok: false, reason: "none" };

  // 공고를 명시했으면 그 공고 안에서 최신 1건(같은 공고에 후보 행이 중복될 수 있는 과거 데이터 방어).
  if (jobId != null) {
    const r = rows[0];
    return { ok: true, candidate: { id: r.id, job_id: r.job_id, agent_stage: r.agent_stage, agent_state: r.agent_state } };
  }

  const byJob = new Map<number, Row>();
  for (const r of rows) if (!byJob.has(r.job_id)) byJob.set(r.job_id, r);
  if (byJob.size === 1) {
    const r = rows[0];
    return { ok: true, candidate: { id: r.id, job_id: r.job_id, agent_stage: r.agent_stage, agent_state: r.agent_state } };
  }

  return {
    ok: false,
    reason: "ambiguous",
    options: [...byJob.values()].map((r) => {
      const rel = r.jobs;
      const j = Array.isArray(rel) ? rel[0] : rel;
      return { job_id: r.job_id, title: j?.title ?? null };
    }),
  };
}
