/**
 * GET /api/admin/applicants/[id]/active-jobs
 *
 * 한 지원자가 지금 붙어 있는 공고 목록 — 실시간 응대의 공고 탭·상세 포커스 데이터.
 * 판정은 `lib/candidate-links.ts`(살아있는 결속 단일 정의)에 있다 — 인력풀 목록 배지 "공고 N건"과
 * **같은 집합**이어야 하기 때문이다(목록에 3건이면 열었을 때 탭도 3개).
 *
 * ⚠️ 예전에는 여기서 `agent_stage IS NULL`을 제외했다. 그래서 관심만 눌러둔 공고는 탭에 뜨지 않고,
 *    매니저는 그 사람이 다른 자리에도 관심을 눌렀다는 사실 자체를 이 화면에서 볼 수 없었다.
 *    공고를 여러 개 동시에 열면 NULL(관심)이 다수 상태가 되므로 그 제외가 곧 '안 보이는 결속'이 된다.
 *    (마감·시스템 공고 제외는 그대로 — 닫힌 공고로 대화 맥락이 잡히면 안 된다.)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { gatherLiveJobLinks } from "@/lib/candidate-links";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const applicantId = Number(params.id);
  if (!Number.isFinite(applicantId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { links, error } = await gatherLiveJobLinks(supabase, [applicantId]);
  if (error) {
    console.error("[active-jobs]", error);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  return NextResponse.json({ jobs: links.get(applicantId) ?? [] });
}
