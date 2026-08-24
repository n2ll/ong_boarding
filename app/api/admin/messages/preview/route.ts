/**
 * GET /api/admin/messages/preview?ids=1,2,3[&with_manual=1]
 * POST /api/admin/messages/preview { ids: [1, 2, 3] }
 *
 * 주어진 지원자들의 "마지막 메시지" 본문/방향/발신주체 + "마지막 inbound 시각"을 가볍게 반환한다.
 *
 * 판정 로직은 lib/message-preview.ts에 있다 — 실시간 응대 **목록 응답**도 같은 값을 함께
 * 실어 보내기 때문에(왕복 1회로 목록을 완성하기 위해) 두 곳이 한 모듈을 공유해야 한다.
 * 이 라우트는 그 모듈의 얇은 HTTP 껍데기다.
 *
 * 실사용처: components/ReplyQueueCard.tsx(대시보드 '내가 답할 차례' 카드) — 자기 큐의 id로
 * with_manual 없이 호출한다. 실시간 응대 화면은 목록 응답에 실려 오는 값을 쓰므로 여기를
 * 부르지 않는다. **지우지 말 것** — 대시보드가 죽는다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { gatherMessagePreviews } from "@/lib/message-preview";
import { parsePreviewRequestIds } from "@/lib/admin/message-preview-request";

export const dynamic = "force-dynamic";

async function previewResponse(ids: number[], withManual: boolean) {
  if (ids.length === 0 && !withManual) {
    return NextResponse.json({ previews: {} });
  }

  const supabase = createServiceClient();
  try {
    const previews = await gatherMessagePreviews(supabase, ids, {
      withManual,
      throwOnCoreError: true,
      requireComplete: withManual,
    });
    return NextResponse.json({ previews });
  } catch (error) {
    console.error("[messages/preview] core query failed", error);
    return NextResponse.json(
      { error: "대화 상태를 확인하지 못했어요." },
      { status: 503 },
    );
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const idsParam = url.searchParams.get("ids") ?? "";
  const withManual = url.searchParams.get("with_manual") === "1";
  const ids = idsParam
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  return previewResponse(ids, withManual);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "요청 형식을 확인해 주세요." }, { status: 400 });
  }

  const idsValue = body && typeof body === "object" && "ids" in body
    ? (body as { ids?: unknown }).ids
    : undefined;
  const parsed = parsePreviewRequestIds(idsValue);
  if (!parsed.ok) {
    const error = parsed.status === 413
      ? "한 번에 확인할 지원자가 너무 많아요."
      : "지원자 목록을 확인해 주세요.";
    return NextResponse.json({ error }, { status: parsed.status });
  }

  // POST는 대시보드의 명시 ID 조회 전용이다. with_manual 탐색을 각 클라이언트 묶음마다
  // 반복하면 최근 outbound 전량을 중복 스캔하므로, 호환 GET에서만 그 옵션을 유지한다.
  return previewResponse(parsed.ids, false);
}
