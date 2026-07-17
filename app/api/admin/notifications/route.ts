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

  const [inboxRes, handoffRes, aiDisabled] = await Promise.all([
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("classification", "pending")
      .eq("direction", "inbound"),
    // 수동 개입 = 매니저 인계(paused) 후보 수. (기존 unread_count 기준은 현재 0으로 사실상 사문화)
    supabase
      .from("job_candidates")
      .select("id", { count: "exact", head: true })
      .eq("agent_stage", "paused"),
    isAgentDisabled(supabase),
  ]);

  const inboxCount = inboxRes.count ?? 0;
  const interventions = handoffRes.count ?? 0;

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
      title: `분류 대기 문자함 ${inboxCount}건`,
      desc: "어떤 지원자와도 매칭되지 않은 인입 메시지가 쌓였어요.",
      path: "/inbox",
    });
  }
  if (interventions > 0) {
    items.push({
      id: "live",
      tone: "amber",
      title: `매니저 인계 대기 ${interventions}건`,
      desc: "AI가 매니저에게 넘긴 대화가 처리를 기다리고 있어요.",
      path: "/live",
    });
  }

  return NextResponse.json({
    items,
    count: items.length,
    counts: { inbox: inboxCount, interventions, aiDisabled },
  });
}
