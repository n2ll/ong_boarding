/**
 * POST /api/admin/ongmanaging/active-check
 *
 * 재컨택 발송 전, 지원자들이 '현재 활동 중'인지 대조 — 두 소스 병합:
 *  - 옹매니징(별도 Supabase): 활성 계약 ∪ 지난달 확정 정산 (실시간 조회, lib/ongmanaging.ts).
 *  - 옹고잉 TMS(배송 운영): 최근/예정 배차 보유 — tms-sync cron이 채운 **캐시 컬럼**에서 읽는다
 *    (실시간 AWS 연결 없음 — Vercel→AWS 매요청 지양).
 * body: { applicantIds: number[] } (최대 500)
 * 응답: { configured, checked, active: [{id, name, reasons}] }
 *   reasons: ('active_contract' | 'recent_settlement' | 'tms_active')[]
 * 두 소스 모두 미연동이면 { configured: false, checked: 0, active: [] } 200 반환
 * (에러 아님 — UI가 미연동 안내를 표시).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import {
  fetchWorkingPhoneSignals,
  isOngmanagingConfigured,
  normalizePhone,
} from "@/lib/ongmanaging";
import { isTmsConfigured } from "@/lib/tms";

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

  const ongConfigured = isOngmanagingConfigured();
  // 두 소스 다 미연동이면 대조 불가 — 발송은 허용(서버 발송 경로가 최종 가드).
  if (!ongConfigured && !isTmsConfigured()) {
    return NextResponse.json({ configured: false, checked: 0, active: [] });
  }

  const numIds = applicantIds.map((v) => Number(v));
  const supabase = createServiceClient();

  // TMS 활동 신호는 tms-sync cron이 채운 캐시(tms_active_signal)에서 읽는다.
  const { data: rows, error } = await supabase
    .from("applicants")
    .select("id, name, phone, tms_active_signal")
    .in("id", numIds);
  if (error) {
    console.error("[active-check] applicants select failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 옹매니징(계약·정산)은 실시간 조회 — 연동된 경우에만. TMS는 위 캐시로 이미 확보.
  let signals = {
    activeContract: new Set<string>(),
    recentSettlement: new Set<string>(),
  };
  if (ongConfigured) {
    try {
      signals = await fetchWorkingPhoneSignals();
    } catch (e) {
      console.error("[active-check] ongmanaging lookup failed", e);
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "ongmanaging lookup failed" },
        { status: 500 }
      );
    }
  }

  const active = (rows ?? [])
    .map((r) => {
      const reasons: string[] = [];
      if (typeof r.phone === "string" && r.phone) {
        const p = normalizePhone(r.phone);
        if (signals.activeContract.has(p)) reasons.push("active_contract");
        if (signals.recentSettlement.has(p)) reasons.push("recent_settlement");
      }
      if (r.tms_active_signal === true) reasons.push("tms_active");
      return { id: r.id as number, name: r.name as string, reasons };
    })
    .filter((r) => r.reasons.length > 0);

  // TMS 미확인(캐시 NULL) 건수 — TMS 연동 상태에서만 의미. NULL은 '비활동'이 아니라 '아직 대조 안 됨'
  // 이므로, 발송 전 이 수를 노출해 '대조했고 활동자 0명'이라는 거짓 안심을 방지한다(NULL≠false).
  const unchecked = isTmsConfigured()
    ? (rows ?? []).filter((r) => r.tms_active_signal == null).length
    : 0;

  return NextResponse.json({
    configured: ongConfigured || isTmsConfigured(),
    checked: (rows ?? []).length,
    active,
    unchecked,
  });
}
