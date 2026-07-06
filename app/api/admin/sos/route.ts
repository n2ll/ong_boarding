/**
 * GET  /api/admin/sos — 긴급 건 현황: 진행 중 전건 + 최근 처리 10건 + 이번 달(KST) 요약
 * POST /api/admin/sos — 긴급 건 신규 기록 (기록 전용 — 발송 로직 없음)
 *
 * 인증은 middleware.ts의 /api/admin/* Basic Auth에 위임.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { kstMonth } from "@/lib/sos";

export const dynamic = "force-dynamic";

/** 'YYYY-MM'(KST)의 시작~다음 달 시작을 UTC ISO 구간으로 변환 — created_at(TIMESTAMPTZ) 필터용 */
function monthRangeUtc(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;
  return {
    start: new Date(`${month}-01T00:00:00+09:00`).toISOString(),
    end: new Date(`${next}-01T00:00:00+09:00`).toISOString(),
  };
}

export async function GET() {
  const supabase = createServiceClient();
  const { start, end } = monthRangeUtc(kstMonth());

  const [openRes, recentRes, monthRes] = await Promise.all([
    supabase
      .from("sos_requests")
      .select("*")
      .eq("status", "open")
      .order("created_at", { ascending: false }),
    supabase
      .from("sos_requests")
      .select("*")
      .in("status", ["resolved", "cancelled"])
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("sos_requests")
      .select("status, cost_krw")
      .gte("created_at", start)
      .lt("created_at", end),
  ]);

  const error = openRes.error ?? recentRes.error ?? monthRes.error;
  if (error) {
    console.error("[sos GET error]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const monthRows = monthRes.data ?? [];
  const month_summary = {
    count: monthRows.length,
    resolved: monthRows.filter((r) => r.status === "resolved").length,
    cost_sum: monthRows.reduce((sum, r) => sum + (typeof r.cost_krw === "number" ? r.cost_krw : 0), 0),
  };

  return NextResponse.json({
    open: openRes.data ?? [],
    recent: recentRes.data ?? [],
    month_summary,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  const lineLabel = typeof body?.line_label === "string" ? body.line_label.trim() : "";
  if (!lineLabel) {
    return NextResponse.json({ error: "line_label(라인/권역 라벨)은 필수입니다." }, { status: 400 });
  }
  const neededCount = body?.needed_count == null ? 1 : Number(body.needed_count);
  if (!Number.isInteger(neededCount) || neededCount < 1) {
    return NextResponse.json({ error: "needed_count는 1 이상의 정수여야 합니다." }, { status: 400 });
  }
  const jobId = body?.job_id == null ? null : Number(body.job_id);
  if (jobId !== null && !Number.isFinite(jobId)) {
    return NextResponse.json({ error: "job_id 값이 잘못되었습니다." }, { status: 400 });
  }
  const optText = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("sos_requests")
    .insert({
      line_label: lineLabel,
      region: optText(body?.region),
      vehicle: optText(body?.vehicle),
      needed_count: neededCount,
      note: optText(body?.note),
      job_id: jobId,
    })
    .select("*")
    .single();

  if (error) {
    console.error("[sos POST error]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data }, { status: 201 });
}
