/**
 * GET   /api/admin/jobs/[id]   — 공고 상세 (counts 포함)
 * PATCH /api/admin/jobs/[id]   — 공고 수정 (본문/정원/상태)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

const ALLOWED_PATCH_FIELDS = new Set([
  "title",
  "body",
  "branch",
  "slot",
  "start_date",
  "vehicle_required",
  "pickup_address",
  "pickup_lat",
  "pickup_lng",
  "capacity",
  "status",
  "site_manager_id",
]);

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: job, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  }

  // 후보 stage 카운트
  const { data: cands } = await supabase
    .from("job_candidates")
    .select("agent_stage")
    .eq("job_id", id);
  const counts: Record<string, number> = {};
  for (const c of cands ?? []) {
    const k = (c.agent_stage as string | null) ?? "sent";
    counts[k] = (counts[k] ?? 0) + 1;
  }

  return NextResponse.json({ job, counts });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALLOWED_PATCH_FIELDS.has(k)) update[k] = v;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "변경할 필드가 없습니다." }, { status: 400 });
  }
  if (
    typeof update.status === "string" &&
    !["active", "closed", "paused"].includes(update.status)
  ) {
    return NextResponse.json({ error: "status 값이 잘못되었습니다." }, { status: 400 });
  }
  if (
    typeof update.slot === "string" &&
    !["평일오전", "평일오후", "주말오전", "주말오후"].includes(update.slot)
  ) {
    return NextResponse.json({ error: "slot 값이 잘못되었습니다." }, { status: 400 });
  }

  // 마감 처리 — closed로 바뀌면 closed_at 자동 기록
  if (update.status === "closed") {
    update.closed_at = new Date().toISOString();
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("jobs")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error || !data) {
    console.error("[jobs PATCH]", error);
    return NextResponse.json({ error: "수정 실패" }, { status: 500 });
  }

  return NextResponse.json({ job: data });
}
