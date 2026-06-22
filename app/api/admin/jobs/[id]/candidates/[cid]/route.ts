/**
 * GET   /api/admin/jobs/[id]/candidates/[cid]   — 후보자 단건 조회 (슬라이드 패널 진입 시)
 * PATCH /api/admin/jobs/[id]/candidates/[cid]   — 매니저 액션 (일시정지/재개/부적합/단계 변경)
 *
 * PATCH 허용 필드:
 *   - agent_stage: "exploration" | "screening" | "onboarding" | "active" | "paused" | "abort" | null
 *   - paused_reason: string | null
 *   - closed_reason: string | null
 *
 * paused → 다른 stage 복귀 시 paused_reason 자동 클리어.
 * abort 전이 시 closed_at 자동 기록 + applicants.status='부적합'.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

const ALLOWED_STAGES = ["exploration", "screening", "onboarding", "active", "paused", "abort"];

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; cid: string } }
) {
  const cid = Number(params.cid);
  if (!Number.isFinite(cid)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("job_candidates")
    .select(`
      id, job_id, applicant_id, agent_stage, agent_state, paused_reason,
      sent_at, responded_at, confirmed_at, activated_at, closed_at, closed_reason,
      created_at, updated_at,
      applicants:applicant_id (*),
      jobs:job_id (*)
    `)
    .eq("id", cid)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "후보를 찾을 수 없습니다." }, { status: 404 });
  }

  return NextResponse.json({ candidate: data });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; cid: string } }
) {
  const cid = Number(params.cid);
  if (!Number.isFinite(cid)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // 현재 candidate 조회 (검증·후처리용)
  const { data: cur } = await supabase
    .from("job_candidates")
    .select("id, applicant_id, agent_stage")
    .eq("id", cid)
    .single();
  if (!cur) {
    return NextResponse.json({ error: "후보를 찾을 수 없습니다." }, { status: 404 });
  }

  const update: Record<string, unknown> = {};
  const now = new Date().toISOString();

  if ("agent_stage" in body) {
    const stage = body.agent_stage;
    if (stage !== null && (typeof stage !== "string" || !ALLOWED_STAGES.includes(stage))) {
      return NextResponse.json({ error: "agent_stage 값이 잘못되었습니다." }, { status: 400 });
    }
    update.agent_stage = stage;

    // paused 해제 시 paused_reason 클리어
    if (cur.agent_stage === "paused" && stage !== "paused") {
      update.paused_reason = null;
    }
    // abort 처리
    if (stage === "abort") {
      update.closed_at = now;
      if (typeof body.closed_reason === "string") {
        update.closed_reason = body.closed_reason;
      } else if (!body.closed_reason) {
        update.closed_reason = "manager: abort";
      }
      // applicants.status='부적합' + current_job_id=null
      await supabase
        .from("applicants")
        .update({ status: "부적합", current_job_id: null })
        .eq("id", cur.applicant_id);
    }
  }

  if ("paused_reason" in body) {
    update.paused_reason = body.paused_reason ?? null;
  }
  if ("closed_reason" in body && !("agent_stage" in body)) {
    update.closed_reason = body.closed_reason ?? null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "변경할 필드가 없습니다." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("job_candidates")
    .update(update)
    .eq("id", cid)
    .select()
    .single();

  if (error || !data) {
    console.error("[candidate PATCH]", error);
    return NextResponse.json({ error: "수정 실패" }, { status: 500 });
  }

  return NextResponse.json({ candidate: data });
}
