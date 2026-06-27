/**
 * GET /api/admin/cron/airtable-sync
 *
 * 옹고잉 홈페이지(Tally 폼) → Airtable("옹고잉 지원자") → Supabase applicants 단방향 동기화.
 *
 * 정책:
 *  - INSERT-only. 이미 import된 레코드(airtable_record_id)나 이미 존재하는 전화번호는 건너뛴다
 *    → 매니저가 파이프라인에서 진행 중인 row를 절대 덮어쓰지 않는다.
 *  - import 상태는 '스크리닝 전'(대기 중) 고정 → AI 자동발송 없음("확정 뉘앙스 금지" 안전).
 *  - 한 번에 max건만 처리(지오코딩 비용/타임아웃 보호). 나머지는 다음 cron이 이어서 처리.
 *
 * 쿼리 파라미터:
 *  - ?dry=1  : 쓰기 없이 신규 후보 건수만 미리보기
 *  - ?max=N  : 이번 호출에서 INSERT할 최대 신규 건수(기본 30)
 *
 * 인증: Vercel Cron(user-agent) 또는 Authorization: Bearer <CRON_SECRET>.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { geocodeAddressWithFallback } from "@/lib/kakao-geocode";
import { listAirtableApplicants, mapAirtableApplicant, type MappedApplicant } from "@/lib/airtable";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_MAX = 30;

export async function GET(req: NextRequest) {
  // 인증 — Vercel cron 또는 Bearer CRON_SECRET
  const isVercelCron = req.headers.get("user-agent")?.includes("vercel-cron");
  const secret = process.env.CRON_SECRET;
  const expected = secret ? `Bearer ${secret}` : null;
  if (!isVercelCron && (!expected || req.headers.get("authorization") !== expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const max = Math.max(1, Number(url.searchParams.get("max")) || DEFAULT_MAX);

  const supabase = createServiceClient();

  // 기존 applicants 인덱스 — 멱등성(record id) + 전화번호 중복 방지
  const { data: existing, error: exErr } = await supabase
    .from("applicants")
    .select("phone, airtable_record_id");
  if (exErr) {
    console.error("[airtable-sync] existing load error", exErr);
    return NextResponse.json({ error: exErr.message }, { status: 500 });
  }
  const existingRecIds = new Set(
    (existing ?? []).map((r) => r.airtable_record_id).filter(Boolean) as string[]
  );
  const existingPhones = new Set(
    (existing ?? []).map((r) => String(r.phone ?? "").replace(/[^0-9]/g, "")).filter(Boolean)
  );

  // Airtable 전체 로드(최신순)
  let records;
  try {
    records = await listAirtableApplicants();
  } catch (e) {
    console.error("[airtable-sync] airtable fetch error", e);
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }

  // 신규 후보 선별 — 이미 import / 기존 전화 / 매핑 불가 / 이번 실행 내 전화 중복 제외
  const seenPhones = new Set<string>();
  const candidates: MappedApplicant[] = [];
  let alreadyImported = 0;
  let skippedExistingPhone = 0;
  let skippedDupInBatch = 0;
  let unmappable = 0;

  for (const rec of records) {
    if (existingRecIds.has(rec.id)) {
      alreadyImported++;
      continue;
    }
    const mapped = mapAirtableApplicant(rec);
    if (!mapped) {
      unmappable++;
      continue;
    }
    if (existingPhones.has(mapped.phone_norm)) {
      skippedExistingPhone++;
      continue;
    }
    if (seenPhones.has(mapped.phone_norm)) {
      skippedDupInBatch++;
      continue;
    }
    seenPhones.add(mapped.phone_norm);
    candidates.push(mapped);
  }

  const byStatus = candidates.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});

  if (dry) {
    return NextResponse.json({
      dry: true,
      scanned: records.length,
      alreadyImported,
      skippedExistingPhone,
      skippedDupInBatch,
      unmappable,
      newCandidates: candidates.length,
      byStatus,
      sample: candidates.slice(0, 3).map((c) => ({
        name: c.name, phone: c.phone, birth_date: c.birth_date,
        location: c.location, status: c.status, work_hours: c.work_hours,
      })),
    });
  }

  // 실제 INSERT — max건까지만(지오코딩 포함). 나머지는 다음 cron이 처리.
  const batch = candidates.slice(0, max);
  let inserted = 0;
  const errors: Array<{ record_id: string; error: string }> = [];

  for (const c of batch) {
    let geo = null;
    let precision: "exact" | "approx" | null = null;
    try {
      if (c.location && c.location !== "미지정") {
        const r = await geocodeAddressWithFallback(c.location);
        geo = r.geo;
        precision = r.precision;
      }
    } catch (e) {
      console.error("[airtable-sync] geocode fail", c.airtable_record_id, e);
    }

    const { error: insErr } = await supabase.from("applicants").insert({
      name: c.name,
      birth_date: c.birth_date,
      phone: c.phone,
      location: c.location,
      own_vehicle: c.own_vehicle,
      license_type: c.license_type,
      vehicle_type: c.vehicle_type,
      branch1: c.branch1,
      branch: c.branch,
      work_hours: c.work_hours,
      experience: c.experience,
      available_date: c.available_date,
      self_ownership: c.self_ownership,
      source: c.source,
      status: c.status,
      filter_pass: c.filter_pass,
      note: c.note,
      airtable_record_id: c.airtable_record_id,
      airtable_raw: c.airtable_raw,
      lat: geo?.lat ?? null,
      lng: geo?.lng ?? null,
      sido: geo?.sido ?? null,
      sigungu: geo?.sigungu ?? null,
      bname: geo?.bname ?? null,
      road_address: geo?.road_address ?? null,
      geo_precision: precision,
    });

    if (insErr) {
      // 동시 실행 등으로 인한 record_id 유니크 충돌은 정상(멱등) — 에러로 취급하지 않음
      if ((insErr as { code?: string }).code === "23505") {
        alreadyImported++;
      } else {
        console.error("[airtable-sync] insert error", c.airtable_record_id, insErr);
        errors.push({ record_id: c.airtable_record_id, error: insErr.message });
      }
      continue;
    }
    inserted++;
  }

  return NextResponse.json({
    scanned: records.length,
    alreadyImported,
    skippedExistingPhone,
    skippedDupInBatch,
    unmappable,
    newCandidates: candidates.length,
    inserted,
    remaining: candidates.length - inserted,
    byStatus,
    errors,
  });
}
