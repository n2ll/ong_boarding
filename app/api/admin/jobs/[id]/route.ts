/**
 * GET   /api/admin/jobs/[id]   — 공고 상세 (counts 포함)
 * PATCH /api/admin/jobs/[id]   — 공고 수정 (본문/정원/상태)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { geocodeAddressWithFallback } from "@/lib/kakao-geocode";
import { normalizeRule } from "@/lib/exposure";

const ALLOWED_PATCH_FIELDS = new Set([
  "title",
  "body",
  "branch",
  "branch_id",
  "slot",
  "start_date",
  "vehicle_required",
  "pickup_address",
  "pickup_lat",
  "pickup_lng",
  "dropoff_address",
  "dropoff_lat",
  "dropoff_lng",
  "pay_info",
  "policy_notes",
  "pay_type",
  "pay_amount",
  "ai_facts",
  "capacity",
  "status",
  "recruit_mode",
  "site_manager_id",
  "work_period",
  "closes_at",
  // J 타겟 노출 — 노출 범위(all/targeted) + 자동 노출 규칙(jsonb)
  "exposure",
  "exposure_rule",
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
  if (
    typeof update.recruit_mode === "string" &&
    !["external", "internal", "both"].includes(update.recruit_mode)
  ) {
    return NextResponse.json({ error: "recruit_mode 값이 잘못되었습니다." }, { status: 400 });
  }
  if (
    typeof update.pay_type === "string" &&
    update.pay_type !== "" &&
    !["건당", "일당", "주급", "월급", "혼합", "협의"].includes(update.pay_type)
  ) {
    return NextResponse.json({ error: "pay_type 값이 잘못되었습니다." }, { status: 400 });
  }
  if (
    "exposure" in update &&
    (typeof update.exposure !== "string" || !["all", "targeted"].includes(update.exposure))
  ) {
    return NextResponse.json({ error: "exposure 값이 잘못되었습니다." }, { status: 400 });
  }
  // exposure_rule — 알 수 없는 키·타입은 정규화로 제거해 저장(쓰레기 규칙이 노출 판정을 오염하지 않게).
  if ("exposure_rule" in update) {
    update.exposure_rule = normalizeRule(update.exposure_rule);
  }
  if (update.pay_type === "") update.pay_type = null;
  if (
    typeof update.work_period === "string" &&
    update.work_period !== "" &&
    !["하루", "단기", "정기"].includes(update.work_period)
  ) {
    return NextResponse.json({ error: "work_period 값이 잘못되었습니다." }, { status: 400 });
  }
  if (update.work_period === "") update.work_period = null;

  // 마감 처리 — closed로 바뀌면 closed_at 자동 기록, 재개 시 해제
  if (update.status === "closed") {
    update.closed_at = new Date().toISOString();
  } else if (update.status === "active" || update.status === "paused") {
    update.closed_at = null;
  }

  const supabase = createServiceClient();

  // 지점(branch_id) 변경 시 지점 이름·소속 화주사를 함께 맞춰 계층 정합성 유지
  if (typeof update.branch_id === "number") {
    const { data: b } = await supabase
      .from("branches")
      .select("name, client_id")
      .eq("id", update.branch_id)
      .maybeSingle();
    if (b) {
      update.branch = (b.name as string) ?? update.branch ?? null;
      update.client_id = (b.client_id as number | null) ?? null;
    }
  } else if (update.branch_id === null) {
    update.client_id = null;
  }

  // 상차지 주소가 바뀌었고 좌표를 함께 안 넘겼으면 지오코딩 (거리 정렬 근거). 주소를 비우면 좌표도 클리어.
  if (typeof update.pickup_address === "string" && update.pickup_address.trim() && update.pickup_lat === undefined) {
    const { geo } = await geocodeAddressWithFallback(update.pickup_address);
    if (geo) {
      update.pickup_lat = geo.lat;
      update.pickup_lng = geo.lng;
    }
  } else if (update.pickup_address === null || update.pickup_address === "") {
    update.pickup_lat = null;
    update.pickup_lng = null;
  }

  // 마지막 경유지(배송 종료 지점) 주소도 상차지와 동일 패턴 — 변경 시 지오코딩, 비우면 좌표 클리어. 거리 정렬은 둘 중 가까운 쪽 기준.
  if (typeof update.dropoff_address === "string" && update.dropoff_address.trim() && update.dropoff_lat === undefined) {
    const { geo } = await geocodeAddressWithFallback(update.dropoff_address);
    if (geo) {
      update.dropoff_lat = geo.lat;
      update.dropoff_lng = geo.lng;
    }
  } else if (update.dropoff_address === null || update.dropoff_address === "") {
    update.dropoff_lat = null;
    update.dropoff_lng = null;
  }

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
