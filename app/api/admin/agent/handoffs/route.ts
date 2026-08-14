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
import { classifyHandoff, getCategory } from "@/lib/agent/handoff-category";

export const dynamic = "force-dynamic";

interface PauseMeta {
  category?: string | null;
  summary?: string | null;
  suggested_action?: string | null;
}

interface JcRow {
  id: number;
  applicant_id: number;
  job_id: number;
  paused_reason: string | null;
  agent_state: { meta?: { paused_at?: string; pause?: PauseMeta } } | null;
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
  // 상한을 명시한다. 예전엔 limit이 없어 PostgREST 기본값(1000)에 **오류 없이** 걸렸고,
  // 그러면 사람이 직접 답해야 하는 대화가 화면에 아무 표시 없이 빠진다.
  // 실측(2026-08-14) 2건이라 지금은 여유가 크지만, 공고를 여럿 동시에 올리면 늘어난다.
  const MAX_HANDOFFS = 1000;
  const { data, error } = await supabase
    .from("job_candidates")
    .select(
      "id, applicant_id, job_id, paused_reason, agent_state, updated_at, jobs:job_id ( id, title, branch ), applicants:applicant_id ( id, name, phone, branch )"
    )
    .eq("agent_stage", "paused")
    .order("updated_at", { ascending: true })
    .limit(MAX_HANDOFFS);

  if (error) {
    console.error("[handoffs]", error);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  // 상한에 닿았으면 잘렸다는 사실을 남긴다 — 조용한 누락을 만들지 않는다.
  // 정렬을 오래된 순으로 두어, 잘리는 쪽이 '방금 들어온 건'이 되게 했다(오래 방치된 건이
  // 먼저 보이는 게 이 큐의 목적이다).
  const truncated = (data?.length ?? 0) >= MAX_HANDOFFS;
  if (truncated) {
    console.error(`[handoffs] 상한 ${MAX_HANDOFFS}건에 도달 — 일부가 큐에서 빠졌다. 상한을 올리거나 페이징이 필요하다.`);
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
      // 1순위: 에이전트가 pause 시 직접 emit한 meta.pause. 없으면 paused_reason 키워드 분류(폴백).
      const pauseMeta = c.agent_state?.meta?.pause ?? null;
      const category = pauseMeta?.category ? getCategory(pauseMeta.category) : classifyHandoff(c.paused_reason);
      const suggestedAction =
        (pauseMeta?.suggested_action && pauseMeta.suggested_action.trim()) || category.action;
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
        suggested_action: suggestedAction,
        // 시스템 더미 공고는 반영할 실제 공고가 없으므로 '공고에 반영' 액션 비활성 대상
        is_system_job: isSystemJob,
        paused_at: pausedAt,
        age_days: ageDays,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => new Date(a.paused_at).getTime() - new Date(b.paused_at).getTime());

  // truncated를 응답에 실어 보낸다 — 서버 로그만으로는 아무도 모른다.
  // 지금 화면은 이 값을 읽지 않지만, 잘렸는지 확인할 방법을 남겨두는 게 조용한 누락보다 낫다.
  return NextResponse.json({ handoffs, total: handoffs.length, by_category: byCategory, truncated });
}
