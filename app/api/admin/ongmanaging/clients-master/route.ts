/**
 * GET /api/admin/ongmanaging/clients-master
 *
 * 옹매니징 화주사 마스터 — 화주사(clients) + 배송라인(delivery_lines) + 집계(client_performance_view).
 * 어드민 '화주사·라인 현황' 브라우징용(읽기 전용). 개인정보·금액 미반입 — 회사·라인 운영 데이터만.
 * 미구성이면 { configured: false, clients: [] } 200 반환(에러 아님 — UI가 미연동 안내).
 */

import { NextResponse } from "next/server";
import { fetchClientsMaster, isOngmanagingConfigured } from "@/lib/ongmanaging";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isOngmanagingConfigured()) {
    return NextResponse.json({ configured: false, clients: [] });
  }
  try {
    const clients = await fetchClientsMaster();
    return NextResponse.json({ configured: true, clients });
  } catch (e) {
    console.error("[clients-master] lookup failed", e);
    return NextResponse.json({ error: "clients master lookup failed" }, { status: 500 });
  }
}
