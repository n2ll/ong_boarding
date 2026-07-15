/**
 * GET /api/admin/suntop-stats — 선탑(동승) → 투입 전환 퍼널 지표.
 *
 * "선탑이 투자할 만한가"를 답하는 간단 지표. pool_events(suntop_scheduled/suntop_done) 원장 +
 * applicants(status='확정인력', hired_at)로 계산한다. 선탑은 프리보딩 자산이라 기간 제한 없이 집계.
 *
 *  - scheduled : 선탑 예정을 1회 이상 기록한 지원자 수(distinct)
 *  - done      : 선탑 완료를 1회 이상 기록한 지원자 수(distinct)
 *  - hired     : 선탑 완료자 중 현재 status='확정인력'인 수 (선탑→투입)
 *  - done_rate : 예정 대비 완료율 (done/scheduled)
 *  - hire_rate : 완료 대비 투입율 (hired/done)  ← 선탑이 투입으로 이어지는 핵심 지표
 *  - avg_lead_days : 선탑 완료 → 확정(hired_at) 평균 리드타임(일). 표본 없으면 null.
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServiceClient();

  const { data: events, error } = await supabase
    .from("pool_events")
    .select("applicant_id, event_type, created_at")
    .in("event_type", ["suntop_scheduled", "suntop_done"])
    .limit(5000);
  if (error) {
    console.error("[suntop-stats]", error);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  const scheduledIds = new Set<number>();
  const doneIds = new Set<number>();
  const firstDoneAt = new Map<number, string>(); // 지원자별 최초 선탑 완료 시각(리드타임 기준)
  for (const e of events ?? []) {
    const aid = e.applicant_id as number | null;
    if (typeof aid !== "number") continue;
    if (e.event_type === "suntop_scheduled") scheduledIds.add(aid);
    else {
      doneIds.add(aid);
      const at = e.created_at as string;
      const prev = firstDoneAt.get(aid);
      if (!prev || new Date(at).getTime() < new Date(prev).getTime()) firstDoneAt.set(aid, at);
    }
  }

  let hired = 0;
  const leadDays: number[] = [];
  const doneArr = [...doneIds];
  if (doneArr.length > 0) {
    const { data: apps } = await supabase
      .from("applicants")
      .select("id, status, hired_at")
      .in("id", doneArr);
    for (const a of apps ?? []) {
      if (a.status !== "확정인력") continue;
      hired++;
      const doneAt = firstDoneAt.get(a.id as number);
      const hiredAt = a.hired_at as string | null;
      if (doneAt && hiredAt) {
        const d = (new Date(hiredAt).getTime() - new Date(doneAt).getTime()) / 86_400_000;
        if (d >= 0) leadDays.push(d);
      }
    }
  }

  const scheduled = scheduledIds.size;
  const done = doneIds.size;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return NextResponse.json({
    scheduled,
    done,
    hired,
    done_rate: scheduled > 0 ? round1((done / scheduled) * 100) : null,
    hire_rate: done > 0 ? round1((hired / done) * 100) : null,
    avg_lead_days: leadDays.length > 0 ? round1(leadDays.reduce((s, x) => s + x, 0) / leadDays.length) : null,
  });
}
