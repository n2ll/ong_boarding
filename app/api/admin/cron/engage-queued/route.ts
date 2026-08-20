/**
 * GET /api/admin/cron/engage-queued
 *
 * 야간(KST 21~08시) pull '관심 있어요' 클릭으로 큐잉된 후보(job_candidates.engage_queued_at)에게
 * 아침 9시(KST — vercel.json '0 0 * * *' UTC)에 자동 첫 문자를 발송한다.
 *
 * 발송 직전 전역 3단 모드·가드(수신거부/진행 중/중복/충원/마감)를 재검사한다 — 밤사이 변화 반영.
 *  - off  : 새 발송 없이 큐 유지. 이미 sent인 outbox의 DB finalize만 복구한다.
 *  - draft: 코파일럿 — 인바운드가 없어 초안 불가 → 큐 클리어 + Slack으로 수동 컨택 유도.
 *  - auto : runInterestEngage 실행. 공급자가 실패를 확정한 건만 다음 회차 새 action으로 재시도한다.
 *           발송 결과가 불명확한 건은 claim을 유지하고 자동 재시도하지 않는다.
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

  const { data: rows, error } = await supabase
    .from("job_candidates")
    .select("id, job_id, applicant_id")
    .not("engage_queued_at", "is", null)
    // 예약 시각이 도달한 건만 처리 — 미래 시각으로 세팅하면 '특정일 아침 시작' 예약이 된다
    // (예: 주말 유입을 월요일 09:00에). 야간 큐(당일 클릭)는 과거 시각이라 그대로 처리.
    .lte("engage_queued_at", new Date().toISOString())
    // 먼저 누른 것부터 처리한다 — 정렬이 없으면 여러 개를 누른 사람의 '어느 공고'가 발송될지 DB 반환 순서에 달린다.
    .order("engage_queued_at", { ascending: true })
    .limit(200);
  if (error) {
    console.error("[engage-queued cron] query error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const counts = {
    engaged: 0,
    waitlist: 0,
    recovered: 0,
    copilot: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
  };
  const results: Array<{
    candidate_id: number;
    action: string;
    reason?: string;
    error?: string;
  }> = [];

  // 한 사람이 밤에 여러 공고를 누른 경우 — 이번 회차에는 가장 먼저 누른 1건만 처리하고 나머지는 큐에 남긴다.
  // 이어서 처리하면 '한 사람 = 진행 중 1공고' 가드에 걸려 스킵되는데, 그 과정에서 예약 표시가 지워져
  // 다시 시도할 방법이 없어졌다. 남겨두면 매니저가 관심 큐에서 수동 처리하거나 다음 회차에 다시 잡힌다.
  const handledApplicants = new Set<number>();
  let deferredSameApplicant = 0;

  for (const row of rows ?? []) {
    const applicantId = row.applicant_id as number;
    if (handledApplicants.has(applicantId)) {
      deferredSameApplicant++;
      results.push({ candidate_id: row.id as number, action: "deferred", reason: "same_applicant_this_run" });
      continue;
    }
    handledApplicants.add(applicantId);
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
      case "recovered":
        counts.recovered++;
        break;
      case "copilot_manual":
        counts.copilot++;
        break;
      case "off":
        // kill-switch는 새 발송만 막는다. runInterestEngage가 이 분기 전에 수행한
        // sent finalize/unknown 가시화 외에는 큐와 집계를 그대로 유지한다.
        break;
      case "send_failed":
        counts.failed++;
        break;
      case "send_unknown":
      case "sent_unfinalized":
        counts.unknown++;
        break;
      default:
        counts.skipped++;
    }
    results.push({
      candidate_id: row.id as number,
      action: outcome.action,
      reason: outcome.action === "skipped" ? outcome.reason : undefined,
      error:
        outcome.action === "send_failed"
        || outcome.action === "send_unknown"
        || outcome.action === "sent_unfinalized"
          ? outcome.error
          : undefined,
    });
    // 발송 간 간격 — SOLAPI 연속 호출 완화 (bulk-send와 동일)
    await new Promise((r) => setTimeout(r, 150));
  }

  // Slack 요약 — 처리할 게 있었으면 결과를 알린다. 스킵·보류만 있어도 보내야 한다:
  // 전건 스킵이면 지원자는 관심을 눌렀는데 아무 문자도 못 받고 매니저는 그 사실조차 모르는 상태가 됐다.
  if (
    counts.engaged
    + counts.waitlist
    + counts.recovered
    + counts.copilot
    + counts.failed
    + counts.unknown
    + counts.skipped
    + deferredSameApplicant
    > 0
  ) {
    const lines = ["🌅 *아침 자동 응대(관심 클릭 야간 큐) 처리 결과*"];
    if (counts.engaged > 0) lines.push(`- ⚡ AI 스크리닝 시작: ${counts.engaged}명`);
    if (counts.waitlist > 0) lines.push(`- 충원 완료 대기 안내 발송: ${counts.waitlist}명`);
    if (counts.recovered > 0)
      lines.push(`- ♻️ SMS 재발송 없이 기존 발송의 후보 기록 복구: ${counts.recovered}명`);
    if (counts.copilot > 0)
      lines.push(
        `- 🤖 코파일럿: 초안 불가(인바운드 없음) ${counts.copilot}명 — 관심 큐에서 [빠른 컨택]으로 수동 진행해주세요.`
      );
    if (counts.failed > 0)
      lines.push(`- ⚠️ 공급자가 확인한 발송 실패(내일 새 요청으로 재시도): ${counts.failed}명`);
    if (counts.unknown > 0)
      lines.push(
        `- ⚠️ 발송 결과/후보 기록 확인 필요: ${counts.unknown}명 — 중복 방지를 위해 자동 재시도하지 않아요. 발송 내역을 수동 확인해주세요.`
      );
    if (counts.skipped > 0) lines.push(`- 가드로 건너뜀: ${counts.skipped}건 (진행 중·중복·수신거부 등 — 대개 정상이에요)`);
    if (deferredSameApplicant > 0)
      lines.push(
        `- ⏭ 같은 분의 추가 관심 ${deferredSameApplicant}건은 큐에 남겨뒀어요(한 번에 1건만 자동 진행) — 관심 큐에서 직접 처리해 주세요.`
      );
    await sendSlackText(lines.join("\n")).catch(() => false);
  }

  return NextResponse.json({ mode, processed: results.length, counts, results });
}
