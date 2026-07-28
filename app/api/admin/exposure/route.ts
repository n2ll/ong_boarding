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
  // 시군구는 이름만으론 구분이 안 된다(중구·서구가 여러 시도에 있다) → 시도별로 묶고 건수를 함께 내려
  // 에디터가 '서울특별시 > 강남구 13' 형태로 보여줄 수 있게 한다.
  const sigunguByArea = new Map<string, Map<string, number>>();
  let sidoUnknown = 0;
  let sigunguUnknown = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("applicants")
      .select("sido, sigungu, availability")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error("[exposure options] load failed", error);
      return NextResponse.json({ error: "옵션 조회 실패" }, { status: 500 });
    }
    const batch = data ?? [];
    for (const r of batch) {
      const row = r as { sido: string | null; sigungu: string | null; availability: string | null };
      const sido = (row.sido ?? "").trim();
      const sigungu = (row.sigungu ?? "").trim();
      if (sido) sidos.add(sido);
      else sidoUnknown++;
      if (sigungu) {
        // 시도가 없는 값(지오코딩 폴백 산물)도 숨기지 않는다 — 숨기면 그 인원은 어떤 규칙으로도 잡을 수 없다.
        const areaKey = sido || "시도 미확인";
        const m = sigunguByArea.get(areaKey) ?? new Map<string, number>();
        m.set(sigungu, (m.get(sigungu) ?? 0) + 1);
        sigunguByArea.set(areaKey, m);
      } else {
        sigunguUnknown++;
      }
      if (row.availability) availabilities.add(row.availability);
    }
    if (batch.length < 1000) break;
  }
  return NextResponse.json({
    sidos: [...sidos].sort(),
    availabilities: [...availabilities].sort(),
    // [{ sido, items: [{ name, count }] }] — 시도 오름차순, 그 안에서 인원 많은 순
    sigunguGroups: [...sigunguByArea.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sido, m]) => ({
        sido,
        // 이름순 — '고양시'와 '고양시 덕양구'처럼 계층이 섞인 값이 붙어 보여야
        // 시 단위만 골라 그 시의 대부분이 조용히 빠지는 일을 막는다.
        items: [...m.entries()]
          .sort((x, y) => x[0].localeCompare(y[0], "ko"))
          .map(([name, count]) => ({ name, count, key: `${sido}>${name}` })),
      })),
    unknown: { sido: sidoUnknown, sigungu: sigunguUnknown },
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
