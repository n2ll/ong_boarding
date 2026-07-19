/**
 * J · 타겟 공고 노출 — 규칙 빌더 보조.
 *
 * GET  : 규칙 빌더 셀렉트 옵션 — 실데이터 distinct 시도(sido)·가용성(availability) 값.
 *        (sido는 "서울특별시" 전체명 형식 — 하드코딩 대신 실값을 내려 규칙-데이터 드리프트 방지)
 * POST : { rule } → 정규화된 규칙에 매칭되는 지원자 수 미리보기 { count, total, sample }.
 *        저장 전 "규칙 해당 N명" 실시간 확인용. 어드민 미들웨어 인증.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { fetchApplicantsForExposure, matchesRule, normalizeRule } from "@/lib/exposure";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServiceClient();
  const sidos = new Set<string>();
  const availabilities = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("applicants")
      .select("sido, availability")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error("[exposure options] load failed", error);
      return NextResponse.json({ error: "옵션 조회 실패" }, { status: 500 });
    }
    const batch = data ?? [];
    for (const r of batch) {
      const row = r as { sido: string | null; availability: string | null };
      if (row.sido) sidos.add(row.sido);
      if (row.availability) availabilities.add(row.availability);
    }
    if (batch.length < 1000) break;
  }
  return NextResponse.json({
    sidos: [...sidos].sort(),
    availabilities: [...availabilities].sort(),
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const rule = normalizeRule(body?.rule);
  const supabase = createServiceClient();
  try {
    const applicants = await fetchApplicantsForExposure(supabase);
    const now = Date.now();
    const matched = rule ? applicants.filter((a) => matchesRule(a, rule, now)) : [];
    return NextResponse.json({
      rule, // 정규화된 규칙(무효 키 제거 결과)을 되돌려줘 UI가 실제 저장될 값을 보여줄 수 있게
      count: matched.length,
      total: applicants.length,
      sample: matched.slice(0, 5).map((a) => a.name ?? `#${a.id}`),
    });
  } catch (e) {
    console.error("[exposure preview] failed", e);
    return NextResponse.json({ error: "미리보기 실패" }, { status: 500 });
  }
}
