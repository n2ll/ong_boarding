/**
 * GET /api/admin/sourcing/inflow
 *
 * 채널(applicants.source)별 실제 유입 집계. Sourcing 탭의 광고 지표(데모)와 달리
 * 실제 지원자 데이터에서 파생되는 실집계다.
 *  - bySource: 채널별 전체 누적 + 최근 7일 유입
 *  - confirmedBySource: 채널별 확정 인력 수 (전환 품질 비교용)
 *  - total / recent7 합계
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("applicants")
    .select("source, status, created_at");

  if (error) {
    console.error("[sourcing inflow]", error);
    return NextResponse.json({ error: "집계 실패" }, { status: 500 });
  }

  const rows = data ?? [];
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const map = new Map<string, { source: string; total: number; recent7: number; confirmed: number }>();
  for (const r of rows) {
    const source = (r.source as string | null) ?? "direct";
    const entry = map.get(source) ?? { source, total: 0, recent7: 0, confirmed: 0 };
    entry.total += 1;
    if (r.created_at && new Date(r.created_at as string).getTime() >= weekAgo) entry.recent7 += 1;
    if (r.status === "확정인력") entry.confirmed += 1;
    map.set(source, entry);
  }

  const bySource = Array.from(map.values()).sort((a, b) => b.total - a.total);

  return NextResponse.json({
    bySource,
    total: rows.length,
    recent7: bySource.reduce((a, s) => a + s.recent7, 0),
    confirmed: bySource.reduce((a, s) => a + s.confirmed, 0),
  });
}
