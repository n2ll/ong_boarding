/**
 * GET /api/admin/messages/preview?ids=1,2,3
 *
 * 주어진 지원자들의 "마지막 메시지" 본문/방향 + "마지막 inbound 시각"을 가볍게 반환한다.
 * 실시간 응대 목록에서 대화 미리보기·미답 판정(마지막 메시지=inbound)에 쓰는 용도로,
 * 활성 대화 subset에만 호출한다.
 * (전체 지원자에 대한 메시지 스캔을 피하기 위해 ids를 필수로 받는다.)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const idsParam = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = idsParam
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  if (ids.length === 0) {
    return NextResponse.json({ previews: {} });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("messages")
    .select("applicant_id, body, direction, created_at")
    .in("applicant_id", ids)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[messages preview]", error);
    return NextResponse.json({ previews: {} });
  }

  // applicant_id별 최신 1건 + 최신 inbound 시각 (정렬이 desc이므로 처음 만난 것이 최신)
  const previews: Record<number, { body: string; direction: string; created_at: string; last_inbound_at: string | null }> = {};
  for (const m of data ?? []) {
    const aid = m.applicant_id as number | null;
    if (aid == null) continue;
    if (!previews[aid]) {
      previews[aid] = {
        body: (m.body as string) ?? "",
        direction: (m.direction as string) ?? "",
        created_at: (m.created_at as string) ?? "",
        last_inbound_at: null,
      };
    }
    if (previews[aid].last_inbound_at == null && m.direction === "inbound") {
      previews[aid].last_inbound_at = (m.created_at as string) ?? null;
    }
  }

  return NextResponse.json({ previews });
}
