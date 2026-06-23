/**
 * GET /api/admin/notifications
 *
 * 헤더 알림 벨용 실시간 알림 집계. 저장형이 아니라 현재 상태에서 파생되는 라이브 알림이다.
 *  - 미분류 인박스 누적
 *  - 수동 개입 필요(미답장 unread)
 *  - AI 전역 응답 중단(kill switch) 상태
 */
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { isAgentDisabled } from "@/lib/agent/kill-switch";

export const dynamic = "force-dynamic";

type Notice = {
  id: string;
  tone: "red" | "amber" | "slate";
  title: string;
  desc: string;
  path: string;
};

export async function GET() {
  const supabase = createServiceClient();

  const [inboxRes, applicantsRes, aiDisabled] = await Promise.all([
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("classification", "pending")
      .eq("direction", "inbound"),
    supabase.from("applicants").select("unread_count"),
    isAgentDisabled(supabase),
  ]);

  const inboxCount = inboxRes.count ?? 0;
  const interventions = (applicantsRes.data ?? []).filter(
    (a) => ((a.unread_count as number | null) ?? 0) > 0
  ).length;

  const items: Notice[] = [];
  if (aiDisabled) {
    items.push({
      id: "ai-off",
      tone: "red",
      title: "AI 자동응대가 중단된 상태예요",
      desc: "전역 응답 스위치가 꺼져 있어 신규 인입에 자동 응대하지 않습니다.",
      path: "/automation",
    });
  }
  if (inboxCount > 0) {
    items.push({
      id: "inbox",
      tone: "amber",
      title: `미분류 인박스 ${inboxCount}건`,
      desc: "어떤 지원자와도 매칭되지 않은 인입 메시지가 쌓였어요.",
      path: "/inbox",
    });
  }
  if (interventions > 0) {
    items.push({
      id: "live",
      tone: "amber",
      title: `수동 개입 필요 ${interventions}건`,
      desc: "미답장 상태인 지원자 대화가 있어요. 직접 응대가 필요합니다.",
      path: "/live",
    });
  }

  return NextResponse.json({
    items,
    count: items.length,
    counts: { inbox: inboxCount, interventions, aiDisabled },
  });
}
