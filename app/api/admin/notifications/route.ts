/**
 * GET /api/admin/notifications
 *
 * 헤더 알림 벨용 실시간 알림 집계. 저장형이 아니라 현재 상태에서 파생되는 라이브 알림이다.
 *  - 미분류 인박스 누적
 *  - 사람 확인 필요(AI가 매니저에게 넘긴 대화)
 *  - AI 전역 응답 중단(kill switch) 상태
 *  - 5분 이상 끝나지 않은 일괄 문자 발송 확인
 */
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { notificationAiDisabled, notificationQueryState } from "@/lib/admin/notification-query-state";
import {
  bulkMessageAttentionPresentation,
  loadBulkMessageAttention,
} from "@/lib/admin/bulk-message-attention";

export const dynamic = "force-dynamic";

type Notice = {
  id: string;
  kind?: "bulk-message" | "bulk-message-error";
  tone: "red" | "amber" | "slate";
  title: string;
  desc: string;
  path: string;
};

export async function GET() {
  const supabase = createServiceClient();
  const envForced = process.env.AGENT_DISABLED === "1";

  const [inboxRes, inboxOldestRes, handoffRes, killSwitchRes, bulkAttention] = await Promise.all([
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("classification", "pending")
      .eq("direction", "inbound"),
    // 가장 오래 기다린 미분류 문자 — '오늘의 할 일'이 건수만이 아니라 시간을 말하게 한다.
    supabase
      .from("messages")
      .select("created_at")
      .eq("classification", "pending")
      .eq("direction", "inbound")
      .order("created_at", { ascending: true })
      .limit(1),
    // 사람 확인 필요 = 매니저 인계(paused) 후보. head-count가 아니라 행을 받아
    // (1) '처리 완료'(handoffs/resolve) 표식이 있는 건을 제외하고 — 안 거르면 처리한 건이
    //     벨·사이드바 배지에 계속 남아 인계 큐 목록과 숫자가 어긋난다 —
    // (2) 가장 오래 방치된 건의 경과일을 함께 계산한다.
    // (applicants.unread_count는 '스레드 미열람' 신호라 열람만으로 0이 된다 — 답장 여부 지표로 쓰지 않는다)
    supabase
      .from("job_candidates")
      .select("id, updated_at, agent_state")
      .eq("agent_stage", "paused")
      .order("updated_at", { ascending: true })
      .limit(1000),
    // 운영 파이프라인의 fail-open 모드는 건드리지 않는다. 알림 집계만 별도로 오류를
    // 확인해, 전역 중단 상태를 읽지 못한 상황을 정상(auto)으로 표시하지 않는다.
    envForced
      ? Promise.resolve({ data: null, error: null })
      : supabase
          .from("prompt_examples")
          .select("body")
          .eq("category", "system_message")
          .eq("title", "agent_kill_switch")
          .maybeSingle(),
    loadBulkMessageAttention(supabase),
  ]);

  const queryState = notificationQueryState({
    inbox: inboxRes,
    inboxOldest: inboxOldestRes,
    handoffs: handoffRes,
    killSwitch: killSwitchRes,
  });
  if (!queryState.ok) {
    console.error("[notifications GET error]", {
      failed: queryState.failed,
      cause: queryState.cause,
    });
    return NextResponse.json({ error: "알림 집계를 불러오지 못했습니다." }, { status: 500 });
  }
  const inboxCount = queryState.inboxCount;
  const aiDisabled = notificationAiDisabled(envForced, queryState.killSwitchBody);
  const dayDiff = (iso: string | null | undefined) =>
    iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) : null;
  const inboxOldestDays = dayDiff((queryState.inboxOldestRows[0] as { created_at?: string } | undefined)?.created_at);

  type PausedRow = { updated_at: string; agent_state: { meta?: { paused_at?: string; handoff_resolved?: unknown } } | null };
  const pausedRows = (queryState.handoffRows as PausedRow[]).filter((r) => !r.agent_state?.meta?.handoff_resolved);
  const interventions = pausedRows.length;
  const interventionsOldestDays = pausedRows.length
    ? Math.max(...pausedRows.map((r) => dayDiff(r.agent_state?.meta?.paused_at ?? r.updated_at) ?? 0))
    : null;

  const bulkJobIds = [...new Set(
    bulkAttention.batches
      .map((batch) => batch.jobId)
      .filter((jobId): jobId is number => jobId !== null),
  )];
  const bulkMessageJobTitles: Record<string, string> = {};
  if (bulkJobIds.length > 0) {
    const { data: titleRows, error: titleError } = await supabase
      .from("jobs")
      .select("id, title")
      .in("id", bulkJobIds);
    if (titleError) {
      console.error("[notifications GET] bulk message job title lookup failed", titleError);
    } else {
      for (const row of titleRows ?? []) {
        if (typeof row.id === "number" && typeof row.title === "string") {
          bulkMessageJobTitles[String(row.id)] = row.title;
        }
      }
    }
  }

  const items: Notice[] = [];
  const bulkNotice = bulkMessageAttentionPresentation(bulkAttention);
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
      title: `분류가 필요한 문자 ${inboxCount}건`,
      desc: "지원자나 기존 계약자 문의 등으로 정리해야 하는 인입 메시지가 있어요.",
      path: "/live?tab=inbox",
    });
  }
  if (interventions > 0) {
    items.push({
      id: "live",
      tone: (interventionsOldestDays ?? 0) >= 7 ? "red" : "amber",
      title: `사람 확인 필요 ${interventions}건${(interventionsOldestDays ?? 0) >= 1 ? ` · 최장 ${interventionsOldestDays}일` : ""}`,
      desc: "AI가 답을 멈추고 넘긴 대화예요. 매니저가 직접 확인해 답해야 합니다.",
      path: "/live?tab=intervention",
    });
  }
  if (bulkNotice) {
    items.push({
      id: "bulk-message-attention",
      kind: bulkNotice.state === "error" ? "bulk-message-error" : "bulk-message",
      tone: bulkNotice.tone,
      title: bulkNotice.title,
      desc: bulkNotice.description,
      path: bulkNotice.path,
    });
  }

  return NextResponse.json({
    items,
    count: items.length,
    bulk_message_attention: bulkAttention,
    bulk_message_job_titles: bulkMessageJobTitles,
    counts: {
      inbox: inboxCount,
      interventions,
      aiDisabled,
      inbox_oldest_days: inboxOldestDays,
      interventions_oldest_days: interventionsOldestDays,
    },
  });
}
