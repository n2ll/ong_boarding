/**
 * PATCH /api/admin/sos/[id] — 긴급 건 수정 (해결/취소 종결 포함)
 *
 * 허용 필드만 화이트리스트로 반영. status를 resolved/cancelled로 바꿀 때
 * 기존 resolved_at이 비어 있으면 now로 자동 기록(TTF 끝점).
 * 인증은 middleware.ts의 /api/admin/* Basic Auth에 위임.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { SOS_RESOLUTIONS } from "@/lib/sos";

export const dynamic = "force-dynamic";

const ALLOWED_PATCH_FIELDS = new Set([
  "status",
  "resolution",
  "cost_krw",
  "duration_minutes",
  "resolution_note",
  "note",
  "line_label",
  "region",
  "vehicle",
  "job_id",
]);

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

  if ("status" in update && update.status !== "resolved" && update.status !== "cancelled") {
    return NextResponse.json({ error: "status는 'resolved' 또는 'cancelled'만 가능합니다." }, { status: 400 });
  }
  if ("resolution" in update && update.resolution != null && !((update.resolution as string) in SOS_RESOLUTIONS)) {
    return NextResponse.json({ error: `resolution 값이 잘못되었습니다: ${update.resolution}` }, { status: 400 });
  }
  for (const key of ["cost_krw", "duration_minutes"] as const) {
    if (key in update && update[key] != null && (!Number.isInteger(update[key]) || (update[key] as number) < 0)) {
      return NextResponse.json({ error: `${key}는 0 이상의 정수여야 합니다.` }, { status: 400 });
    }
  }
  if ("line_label" in update) {
    const label = typeof update.line_label === "string" ? update.line_label.trim() : "";
    if (!label) return NextResponse.json({ error: "line_label은 비울 수 없습니다." }, { status: 400 });
    update.line_label = label;
  }

  const supabase = createServiceClient();
  const { data: existing, error: selErr } = await supabase
    .from("sos_requests")
    .select("id, resolved_at")
    .eq("id", id)
    .maybeSingle();
  if (selErr) {
    console.error("[sos PATCH select error]", selErr);
    return NextResponse.json({ error: selErr.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "해당 긴급 건을 찾을 수 없습니다." }, { status: 404 });
  }

  // 종결(resolved/cancelled) 전환 시 해결 시각 자동 기록 — 이미 있으면 유지
  if ((update.status === "resolved" || update.status === "cancelled") && !existing.resolved_at) {
    update.resolved_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("sos_requests")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[sos PATCH error]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data });
}
