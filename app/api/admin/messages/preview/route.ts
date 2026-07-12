/**
 * GET /api/admin/messages/preview?ids=1,2,3[&with_manual=1]
 *
 * 주어진 지원자들의 "마지막 메시지" 본문/방향/발신주체 + "마지막 inbound 시각"을 가볍게 반환한다.
 * 실시간 응대 목록에서 대화 미리보기·미답/답 대기 판정에 쓰는 용도로,
 * 활성 대화 subset에만 호출한다.
 * (전체 지원자에 대한 메시지 스캔을 피하기 위해 ids를 기본으로 받는다.)
 *
 * with_manual=1이면 '최근 14일 내 매니저 수동 발신이 있는 지원자'를 서버가 직접 찾아
 * ids와 합집합으로 미리보기를 내려준다 — applicants.last_message_at은 inbound 수신 시각이라
 * 발신만 있는 대화(답 대기)가 클라이언트의 조회 대상 산정에서 빠지는 문제를 여기서 메꾼다.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// AI·시스템 자동 발송 라벨 — 이 외 outbound는 '매니저 수동 발신'으로 본다
// (send/route.ts의 pause 판정, handoffs/promote의 수동 답변 판정과 동일한 deny-list 관례).
// system-bulk(캠페인 벌크 핑)를 자동으로 분류해, 벌크 발송 대상 전원이 '답 대기'로 뜨지 않게 한다.
const AUTO_SENT_BY = new Set([
  "agent",
  "agent-practice",
  "system-auto",
  "system-bulk",
  "system-reminder",
  "system-onboarding-reminder",
  "system-first-day",
  "system-venue-guide",
  "system-baemin-invite",
  "danggeun-start",
  "baemin-start",
  "danggeun-practice-start",
  "danggeun-recommend",
  "dispatch",
  "multijob-test",
]);

const RECENT_MANUAL_MS = 14 * 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const idsParam = url.searchParams.get("ids") ?? "";
  const withManual = url.searchParams.get("with_manual") === "1";
  const ids = idsParam
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  if (ids.length === 0 && !withManual) {
    return NextResponse.json({ previews: {} });
  }

  const supabase = createServiceClient();

  // '답 대기' 후보 합집합 — 최근 14일 내 outbound 중 수동 발신(sent_by가 자동 라벨이 아님)의
  // 지원자 id를 ids에 합친다. applicant_id+sent_by 2컬럼만 읽는 경량 쿼리.
  const allIds = new Set<number>(ids);
  if (withManual) {
    const since = new Date(Date.now() - RECENT_MANUAL_MS).toISOString();
    const { data: outs, error: outErr } = await supabase
      .from("messages")
      .select("applicant_id, sent_by")
      .eq("direction", "outbound")
      .gte("created_at", since)
      .not("applicant_id", "is", null);
    if (outErr) {
      console.error("[messages preview] recent manual query failed", outErr);
    } else {
      for (const m of outs ?? []) {
        if (!AUTO_SENT_BY.has((m.sent_by as string) ?? "")) allIds.add(m.applicant_id as number);
      }
    }
  }

  if (allIds.size === 0) {
    return NextResponse.json({ previews: {} });
  }

  const idList = Array.from(allIds);
  const { data, error } = await supabase
    .from("messages")
    .select("applicant_id, body, direction, created_at, sent_by")
    .in("applicant_id", idList)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[messages preview]", error);
    return NextResponse.json({ previews: {} });
  }

  // applicant_id별 최신 1건 + 최신 inbound 시각 (정렬이 desc이므로 처음 만난 것이 최신)
  const previews: Record<
    number,
    { body: string; direction: string; created_at: string; sent_by: string | null; manual_outbound: boolean; last_inbound_at: string | null; pending_draft: boolean }
  > = {};
  for (const m of data ?? []) {
    const aid = m.applicant_id as number | null;
    if (aid == null) continue;
    if (!previews[aid]) {
      const sentBy = (m.sent_by as string | null) ?? null;
      previews[aid] = {
        body: (m.body as string) ?? "",
        direction: (m.direction as string) ?? "",
        created_at: (m.created_at as string) ?? "",
        sent_by: sentBy,
        // 마지막 메시지가 '매니저 수동 발신'인가 — 클라이언트 '답 대기' 판정용
        manual_outbound: m.direction === "outbound" && !AUTO_SENT_BY.has(sentBy ?? ""),
        last_inbound_at: null,
        pending_draft: false,
      };
    }
    if (previews[aid].last_inbound_at == null && m.direction === "inbound") {
      previews[aid].last_inbound_at = (m.created_at as string) ?? null;
    }
  }

  // 미처리 AI 초안(pending/need_info) 보유 여부 — 목록의 '초안 대기' 배지용(코파일럿 모드 포함).
  // 부가정보이므로 실패해도 미리보기 자체는 내려준다.
  const { data: drafts, error: draftErr } = await supabase
    .from("message_drafts")
    .select("applicant_id")
    .in("applicant_id", idList)
    .in("status", ["pending", "need_info"]);
  if (draftErr) {
    console.error("[messages preview] drafts query failed", draftErr);
  } else {
    for (const d of drafts ?? []) {
      const aid = d.applicant_id as number | null;
      if (aid != null && previews[aid]) previews[aid].pending_draft = true;
    }
  }

  return NextResponse.json({ previews });
}
