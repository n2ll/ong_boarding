/**
 * GET /api/admin/agent/handoffs
 *
 * 매니저 인계(agent_stage='paused') 작업 큐.
 * 후보(job_candidate) 단위로, 어떤 지원자의 어떤 공고가 왜·얼마나 오래 인계돼 있는지 반환한다.
 *  - 시스템 더미 공고(__ 접두) 제외
 *  - paused_reason을 카테고리로 분류해 배지/필터에 사용
 *  - 오래 방치된 순(paused_at 오름차순)으로 정렬 → SLA 상단 노출
 *
 * 응답: { handoffs: [...], total, by_category: { [id]: count } }
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { classifyHandoff } from "@/lib/agent/handoff-category";

export const dynamic = "force-dynamic";

interface JcRow {
  id: number;
  applicant_id: number;
  job_id: number;
  paused_reason: string | null;
  agent_state: { meta?: { paused_at?: string } } | null;
  updated_at: string;
  jobs: { id: number; title: string; branch: string | null } | null;
  applicants: { id: number; name: string | null; phone: string | null; branch: string | null } | null;
}

// 시스템 더미 공고(__접두)는 "공고 미지정" 일반 지원 후보다. 큐에서 제외하지 말고 친근한 라벨로 보여준다.
function jobLabel(title: string): string {
  if (title === "__danggeun_system__") return "당근 지원 (공고 미지정)";
  if (title === "__baemin_system__") return "배민 지원 (공고 미지정)";
  if (title.startsWith("__")) return "공고 미지정";
  return title;
}

export async function GET(_req: NextRequest) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("job_candidates")
    .select(
      "id, applicant_id, job_id, paused_reason, agent_state, updated_at, jobs:job_id ( id, title, branch ), applicants:applicant_id ( id, name, phone, branch )"
    )
    .eq("agent_stage", "paused");

  if (error) {
    console.error("[handoffs]", error);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  const now = Date.now();
  const byCategory: Record<string, number> = {};

  const handoffs = ((data ?? []) as unknown as JcRow[])
    .map((c) => {
      const job = c.jobs ?? null;
      if (!job || typeof job.title !== "string") return null;
      const isSystemJob = job.title.startsWith("__");
      const pausedAt = c.agent_state?.meta?.paused_at ?? c.updated_at;
      const ageDays = Math.max(0, Math.floor((now - new Date(pausedAt).getTime()) / 86400000));
      const category = classifyHandoff(c.paused_reason);
      byCategory[category.id] = (byCategory[category.id] ?? 0) + 1;
      return {
        candidate_id: c.id,
        applicant_id: c.applicant_id,
        job_id: c.job_id,
        applicant_name: c.applicants?.name ?? `지원자 #${c.applicant_id}`,
        phone: c.applicants?.phone ?? null,
        job_title: jobLabel(job.title),
        // 시스템 공고는 지점 정보가 없으니 지원자 지점으로 대체
        branch: isSystemJob ? c.applicants?.branch ?? null : job.branch ?? null,
        reason: c.paused_reason ?? null,
        category: category.id,
        category_label: category.label,
        tone: category.tone,
        suggested_action: category.action,
        paused_at: pausedAt,
        age_days: ageDays,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => new Date(a.paused_at).getTime() - new Date(b.paused_at).getTime());

  return NextResponse.json({ handoffs, total: handoffs.length, by_category: byCategory });
}
