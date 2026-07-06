/**
 * POST /api/admin/ongmanaging/active-check
 *
 * 재컨택 발송 전, 지원자들이 옹매니징(별도 Supabase)에서 '현재 활동 중'인지 대조.
 * 판정 = 활성 계약 ∪ 지난달 확정 정산 (두 신호, lib/ongmanaging.ts 참조).
 * body: { applicantIds: number[] } (최대 500)
 * 응답: { configured, checked, active: [{id, name, reasons}] }
 *   reasons: ('active_contract' | 'recent_settlement')[]
 * 옹매니징 미구성이면 { configured: false, checked: 0, active: [] } 200 반환
 * (에러 아님 — UI가 미구성 안내를 표시).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import {
  fetchWorkingPhoneSignals,
  isOngmanagingConfigured,
  normalizePhone,
} from "@/lib/ongmanaging";

export const dynamic = "force-dynamic";

const MAX_IDS = 500;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const applicantIds: unknown = body?.applicantIds;

  if (
    !Array.isArray(applicantIds) ||
    applicantIds.length === 0 ||
    !applicantIds.every((v) => Number.isFinite(Number(v)))
  ) {
    return NextResponse.json(
      { error: "applicantIds must be a non-empty number array" },
      { status: 400 }
    );
  }
  if (applicantIds.length > MAX_IDS) {
    return NextResponse.json({ error: `too many applicantIds (max ${MAX_IDS})` }, { status: 400 });
  }

  if (!isOngmanagingConfigured()) {
    return NextResponse.json({ configured: false, checked: 0, active: [] });
  }

  const numIds = applicantIds.map((v) => Number(v));
  const supabase = createServiceClient();

  const { data: rows, error } = await supabase
    .from("applicants")
    .select("id, name, phone")
    .in("id", numIds);
  if (error) {
    console.error("[active-check] applicants select failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const withPhone = (rows ?? []).filter((r) => typeof r.phone === "string" && r.phone);

  let signals: Awaited<ReturnType<typeof fetchWorkingPhoneSignals>>;
  try {
    signals = await fetchWorkingPhoneSignals();
  } catch (e) {
    console.error("[active-check] ongmanaging lookup failed", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "ongmanaging lookup failed" },
      { status: 500 }
    );
  }

  const active = withPhone
    .map((r) => {
      const p = normalizePhone(r.phone as string);
      const reasons: string[] = [];
      if (signals.activeContract.has(p)) reasons.push("active_contract");
      if (signals.recentSettlement.has(p)) reasons.push("recent_settlement");
      return { id: r.id as number, name: r.name as string, reasons };
    })
    .filter((r) => r.reasons.length > 0);

  return NextResponse.json({ configured: true, checked: withPhone.length, active });
}
