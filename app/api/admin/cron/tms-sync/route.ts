/**
 * GET /api/admin/cron/tms-sync
 *
 * 옹고잉 TMS(배송 운영, AWS RDS) → applicants '활동 중 배송원' 신호 단방향 동기화.
 *
 * 정책:
 *  - 전화번호 있는 applicants 전체를 TMS와 대조(lib/tms.ts, 최근/예정 배차 보유 = 활동 중).
 *  - applicants.tms_active_signal을 3-상태로 갱신: 활동=true / 확인했으나 없음=false /
 *    전화 없음·미대조=NULL 유지. checked_at으로 신선도 기록.
 *  - **저장은 파생값(boolean/마커/시각)뿐** — TMS 원본 배차·개인정보·금액은 반입하지 않는다.
 *  - TMS 미구성(TMS_DB_* 없음, 예: Vercel env 미투입) 시 안전 스킵({skipped:true}).
 *
 * 쿼리 파라미터:
 *  - ?dry=1 : 쓰기 없이 활동/비활동 건수만 미리보기.
 *
 * 인증: Authorization: Bearer <CRON_SECRET> (requireCronAuth — 미설정 시 fail-closed).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { requireCronAuth } from "@/lib/cron-auth";
import { fetchActiveDeliveryPhones, isTmsConfigured } from "@/lib/tms";
import { normalizePhone } from "@/lib/ongmanaging";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHUNK = 500;

export async function GET(req: NextRequest) {
  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  // TMS 미연동이면 조용히 스킵 — 캐시는 NULL(미확인)로 남아 콜드 발송이 오작동하지 않는다.
  if (!isTmsConfigured()) {
    return NextResponse.json({ skipped: true, reason: "TMS not configured (TMS_DB_* 미설정)" });
  }

  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const supabase = createServiceClient();

  // 전화번호 보유 applicants 전체 — phone 없는 행은 대조 불가라 NULL 유지(선택 자체 제외).
  // PostgREST 기본 행 상한(보통 1000)에 잘리지 않게 페이지네이션으로 전량 조회한다
  // (일부만 조회되면 미조회분이 NULL로 남아 활동 기사가 콜드 발송에서 안 빠질 수 있음).
  const rows: { id: number; phone: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("applicants")
      .select("id, phone")
      .not("phone", "is", null)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error("[tms-sync] applicants load error", error);
      return NextResponse.json({ error: "applicants load failed" }, { status: 500 });
    }
    const batch = (data ?? []) as { id: number; phone: string | null }[];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }

  const withPhone = rows
    .map((r) => ({ id: r.id, np: normalizePhone(String(r.phone ?? "")) }))
    .filter((r) => Boolean(r.np));

  let activeSet: Set<string>;
  try {
    activeSet = await fetchActiveDeliveryPhones(withPhone.map((r) => r.np));
  } catch (e) {
    // 내부 상세(호스트·계정 등)는 로그에만, 클라이언트엔 일반 메시지.
    console.error("[tms-sync] TMS lookup failed", e);
    return NextResponse.json({ error: "TMS lookup failed" }, { status: 500 });
  }

  const activeIds = withPhone.filter((r) => activeSet.has(r.np)).map((r) => r.id);
  const inactiveIds = withPhone.filter((r) => !activeSet.has(r.np)).map((r) => r.id);

  if (dry) {
    return NextResponse.json({
      configured: true,
      dry: true,
      checked: withPhone.length,
      active: activeIds.length,
      inactive: inactiveIds.length,
    });
  }

  // 플라우저빌리티 플로어 — 평시 수십 명이 활동 중이라 TMS가 '활동 0명'을 성공 반환하는 건
  // 비현실적(읽기 리플리카 지연·야간 ETL 재적재 등 일시 이상 가능성). 이때 기존 true를 false로
  // 뭉개면 실활동 기사가 콜드 발송 대상이 되므로, 빈 결과면 캐시를 갱신하지 않고 기존값을 보존한다.
  // (활동자가 있는데 소수로 급감하는 케이스까지 막으려면 직전 대비 비율 플로어를 추가할 수 있음.)
  if (activeSet.size === 0) {
    console.warn(
      `[tms-sync] active set empty (checked ${withPhone.length}) — TMS 이상 가능성으로 쓰기 스킵(기존 신호 보존)`
    );
    return NextResponse.json({
      configured: true,
      skipped_empty: true,
      checked: withPhone.length,
      active: 0,
      note: "TMS 활동 0명 반환 — 이상 가능성으로 캐시 미갱신(기존값 보존)",
    });
  }

  const now = new Date().toISOString();
  let updated = 0;

  // 활동 = true(근거 마커) / 비활동 = false(근거 NULL). checked_at은 양쪽 다 기록(신선도).
  const passes: { ids: number[]; patch: Record<string, unknown> }[] = [
    { ids: activeIds, patch: { tms_active_signal: true, tms_active_reason: "recent_schedule", tms_active_checked_at: now } },
    { ids: inactiveIds, patch: { tms_active_signal: false, tms_active_reason: null, tms_active_checked_at: now } },
  ];
  for (const { ids, patch } of passes) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { error: upErr } = await supabase.from("applicants").update(patch).in("id", chunk);
      if (upErr) {
        console.error("[tms-sync] update error", upErr);
        return NextResponse.json({ error: upErr.message }, { status: 500 });
      }
      updated += chunk.length;
    }
  }

  return NextResponse.json({
    configured: true,
    checked: withPhone.length,
    active: activeIds.length,
    inactive: inactiveIds.length,
    updated,
    checked_at: now,
  });
}
