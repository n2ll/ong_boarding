/**
 * GET /api/admin/cron/engage-queued
 *
 * 야간(KST 21~08시) pull '관심 있어요' 클릭으로 큐잉된 후보(job_candidates.engage_queued_at)에게
 * 아침 9시(KST — vercel.json '0 0 * * *' UTC)에 자동 첫 문자를 발송한다.
 *
 * 발송 직전 전역 3단 모드·가드(수신거부/진행 중/중복/충원/마감)를 재검사한다 — 밤사이 변화 반영.
 *  - off  : 아무것도 안 하고 큐 유지 — 모드 복귀 후 다음 아침에 발송.
 *  - draft: 코파일럿 — 인바운드가 없어 초안 불가 → 큐 클리어 + Slack으로 수동 컨택 유도.
 *  - auto : runInterestEngage 실행. 발송·스킵 시 engage_queued_at 클리어,
 *           발송 실패 건은 큐 유지 → 다음날 재시도.
 *
 * 인증: Authorization: Bearer CRON_SECRET (requireCronAuth — 미설정 시 fail-closed).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { requireCronAuth } from "@/lib/cron-auth";
import { sendSlackText } from "@/lib/slack";
import { getAgentMode } from "@/lib/agent/kill-switch";
import { runInterestEngage } from "@/lib/agent/engage";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  const supabase = createServiceClient();

  const mode = await getAgentMode(supabase);
  if (mode === "off") {
    // off = 아무 발송 없음 — 큐를 건드리지 않고 유지한다(모드 복귀 시 다음 아침에 발송).
    return NextResponse.json({ mode, processed: 0, note: "mode off — 큐 유지" });
  }

  const { data: rows, error } = await supabase
    .from("job_candidates")
    .select("id, job_id, applicant_id")
    .not("engage_queued_at", "is", null)
    // 예약 시각이 도달한 건만 처리 — 미래 시각으로 세팅하면 '특정일 아침 시작' 예약이 된다
    // (예: 주말 유입을 월요일 09:00에). 야간 큐(당일 클릭)는 과거 시각이라 그대로 처리.
    .lte("engage_queued_at", new Date().toISOString())
    .limit(200);
  if (error) {
    console.error("[engage-queued cron] query error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const counts = { engaged: 0, waitlist: 0, copilot: 0, skipped: 0, failed: 0 };
  const results: Array<{
    candidate_id: number;
    action: string;
    reason?: string;
    error?: string;
  }> = [];

  for (const row of rows ?? []) {
    const outcome = await runInterestEngage({
      supabase,
      jobId: row.job_id as number,
      applicantId: row.applicant_id as number,
      mode,
      source: "engage_queued_cron",
    });
    switch (outcome.action) {
      case "engaged":
        counts.engaged++;
        break;
      case "waitlist_sent":
        counts.waitlist++;
        break;
      case "copilot_manual":
        counts.copilot++;
        break;
      case "send_failed":
        counts.failed++;
        break;
      default:
        counts.skipped++;
    }
    results.push({
      candidate_id: row.id as number,
      action: outcome.action,
      reason: outcome.action === "skipped" ? outcome.reason : undefined,
      error: outcome.action === "send_failed" ? outcome.error : undefined,
    });
    // 발송 간 간격 — SOLAPI 연속 호출 완화 (bulk-send와 동일)
    await new Promise((r) => setTimeout(r, 150));
  }

  // Slack 요약 — 실제 발송·수동 유도·실패가 있었을 때만 (매일 0건 스팸 방지, non-fatal)
  if (counts.engaged + counts.waitlist + counts.copilot + counts.failed > 0) {
    const lines = ["🌅 *아침 자동 응대(관심 클릭 야간 큐) 처리 결과*"];
    if (counts.engaged > 0) lines.push(`- ⚡ AI 스크리닝 시작: ${counts.engaged}명`);
    if (counts.waitlist > 0) lines.push(`- 충원 완료 대기 안내 발송: ${counts.waitlist}명`);
    if (counts.copilot > 0)
      lines.push(
        `- 🤖 코파일럿: 초안 불가(인바운드 없음) ${counts.copilot}명 — 관심 큐에서 [빠른 컨택]으로 수동 진행해주세요.`
      );
    if (counts.failed > 0) lines.push(`- ⚠️ 발송 실패(내일 재시도): ${counts.failed}명`);
    if (counts.skipped > 0) lines.push(`- 가드 스킵(진행 중/중복/수신거부 등): ${counts.skipped}명`);
    await sendSlackText(lines.join("\n")).catch(() => false);
  }

  return NextResponse.json({ mode, processed: results.length, counts, results });
}
