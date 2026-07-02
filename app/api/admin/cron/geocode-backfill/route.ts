/**
 * GET /api/admin/cron/geocode-backfill
 *
 * 좌표(lat)가 없는 applicants를 location 기준으로 재지오코딩한다.
 * 전체 주소 실패 시 시/군/구 단위로 폴백(geocodeAddressWithFallback) → 커버리지 향상.
 * 근사 좌표는 geo_precision='approx'로 표기해 정확 좌표와 구분한다.
 *
 * 쿼리 파라미터:
 *  - ?max=N : 이번 호출에서 처리할 최대 건수(기본 50, 지오코딩 비용/타임아웃 보호)
 *  - ?dry=1 : 대상 건수만 미리보기
 *
 * 인증: Vercel Cron(user-agent) 또는 Authorization: Bearer <CRON_SECRET>.
 * 스케줄 cron은 아니며, 필요 시 수동/일회성으로 호출하는 유지보수 엔드포인트.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { requireCronAuth } from "@/lib/cron-auth";
import { geocodeAddressWithFallback } from "@/lib/kakao-geocode";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_MAX = 50;

export async function GET(req: NextRequest) {
  // 인증 — Bearer CRON_SECRET만 허용(위조 가능한 user-agent 검사 제거, 미설정 시 fail-closed)
  const authFail = requireCronAuth(req);
  if (authFail) return authFail;

  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const max = Math.max(1, Number(url.searchParams.get("max")) || DEFAULT_MAX);

  const supabase = createServiceClient();

  const { data: rows, error } = await supabase
    .from("applicants")
    .select("id, location")
    .is("lat", null)
    .not("location", "is", null)
    .neq("location", "미지정")
    .order("id", { ascending: false })
    .limit(dry ? 1000 : max);

  if (error) {
    console.error("[geocode-backfill] query error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (dry) {
    return NextResponse.json({ dry: true, pending: rows?.length ?? 0 });
  }

  let exact = 0;
  let approx = 0;
  let failed = 0;
  const errors: Array<{ id: number; error: string }> = [];

  for (const row of rows ?? []) {
    const { geo, precision } = await geocodeAddressWithFallback(String(row.location));
    if (!geo) {
      failed++;
      continue;
    }
    const { error: upErr } = await supabase
      .from("applicants")
      .update({
        lat: geo.lat,
        lng: geo.lng,
        sido: geo.sido ?? null,
        sigungu: geo.sigungu ?? null,
        bname: geo.bname ?? null,
        road_address: geo.road_address ?? null,
        geo_precision: precision,
      })
      .eq("id", row.id);
    if (upErr) {
      errors.push({ id: row.id as number, error: upErr.message });
      continue;
    }
    if (precision === "approx") approx++;
    else exact++;
  }

  return NextResponse.json({
    processed: (rows ?? []).length,
    exact,
    approx,
    failed,
    errors,
  });
}
