/**
 * J · 타겟 공고 노출 — 규칙 빌더 보조.
 *
 * GET  : 규칙 빌더 셀렉트 옵션 — 실데이터 distinct 시도(sido)·가용성(availability) 값.
 *        (sido는 "서울특별시" 전체명 형식 — 하드코딩 대신 실값을 내려 규칙-데이터 드리프트 방지)
 * POST : { rule } → 정규화된 규칙에 매칭되는 지원자 수 미리보기 { count, total, sample }.
 *        저장 전 "규칙 해당 N명" 실시간 확인용. 어드민 미들웨어 인증.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { fetchApplicantsForExposure, matchesRule, normalizeRule } from "@/lib/exposure";
import { SLOTS, SLOT_LABEL, applicantAvailableSlots, type SlotKey } from "@/lib/admin/types";
import { EXPOSURE_JOB_GEO_COLUMNS, jobSupportsRadius, type GeoJob } from "@/lib/geo";
import { geocodeAddressWithFallback } from "@/lib/kakao-geocode";
import { normalizePhone } from "@/lib/ongmanaging";
import { fetchAllPostgrestRows } from "@/lib/admin/postgrest-pagination";
import { selectJobAudiencePreview } from "@/lib/admin/job-audience-preview";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServiceClient();
  const sidos = new Set<string>();
  const availabilities = new Set<string>();
  // 시군구는 이름만으론 구분이 안 된다(중구·서구가 여러 시도에 있다) → 시도별로 묶고 건수를 함께 내려
  // 에디터가 '서울특별시 > 강남구 13' 형태로 보여줄 수 있게 한다.
  const sigunguByArea = new Map<string, Map<string, number>>();
  let sidoUnknown = 0;
  let sigunguUnknown = 0;
  // 시간대 — 슬롯별 인원 + 미확인(그중 요일만 아는 partial). 조용한 탈락을 없애려면 미확인 수를 보여줘야 한다.
  const slotCounts = new Map<SlotKey, number>();
  let slotUnknown = 0;
  let slotPartial = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("applicants")
      .select("sido, sigungu, availability, work_hours, available_slots")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error("[exposure options] load failed", error);
      return NextResponse.json({ error: "옵션 조회 실패" }, { status: 500 });
    }
    const batch = data ?? [];
    for (const r of batch) {
      const row = r as {
        sido: string | null;
        sigungu: string | null;
        availability: string | null;
        work_hours: string | null;
        available_slots: string[] | null;
      };
      // 시간대 — 규칙 판정과 **같은 함수**로 센다. 화면의 '해당 N명'과 실제 판정이 어긋나면 안 된다.
      const j = applicantAvailableSlots({ work_hours: row.work_hours, available_slots: row.available_slots });
      if (j.slots.length === 0) {
        slotUnknown++;
        if (j.partial) slotPartial++;
      } else {
        for (const s of j.slots) slotCounts.set(s, (slotCounts.get(s) ?? 0) + 1);
      }
      const sido = (row.sido ?? "").trim();
      const sigungu = (row.sigungu ?? "").trim();
      if (sido) sidos.add(sido);
      else sidoUnknown++;
      if (sigungu) {
        // 시도가 없는 값(지오코딩 폴백 산물)도 숨기지 않는다 — 숨기면 그 인원은 어떤 규칙으로도 잡을 수 없다.
        const areaKey = sido || "시도 미확인";
        const m = sigunguByArea.get(areaKey) ?? new Map<string, number>();
        m.set(sigungu, (m.get(sigungu) ?? 0) + 1);
        sigunguByArea.set(areaKey, m);
      } else {
        sigunguUnknown++;
      }
      if (row.availability) availabilities.add(row.availability);
    }
    if (batch.length < 1000) break;
  }
  return NextResponse.json({
    sidos: [...sidos].sort(),
    availabilities: [...availabilities].sort(),
    // [{ sido, items: [{ name, count }] }] — 시도 오름차순, 그 안에서 인원 많은 순
    sigunguGroups: [...sigunguByArea.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sido, m]) => ({
        sido,
        // 이름순 — '고양시'와 '고양시 덕양구'처럼 계층이 섞인 값이 붙어 보여야
        // 시 단위만 골라 그 시의 대부분이 조용히 빠지는 일을 막는다.
        items: [...m.entries()]
          .sort((x, y) => x[0].localeCompare(y[0], "ko"))
          .map(([name, count]) => ({ name, count, key: `${sido}>${name}` })),
      })),
    // 4슬롯 고정 순서 + 실제 인원 — 값이 0인 슬롯도 내려 매니저가 '왜 없지'를 알 수 있게 한다.
    slots: SLOTS.map((s) => ({ key: s, label: SLOT_LABEL[s], count: slotCounts.get(s) ?? 0 })),
    unknown: { sido: sidoUnknown, sigungu: sigunguUnknown, slot: slotUnknown, slot_partial: slotPartial },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const rule = normalizeRule(body?.rule);
  const exposure = body?.exposure === "all" ? "all" : "targeted";
  const supabase = createServiceClient();
  try {
    const now = Date.now();
    const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [applicants, blacklistResult, guardResult, recentMessages, recentEvents] = await Promise.all([
      fetchApplicantsForExposure(supabase),
      supabase.from("recruitment_blacklist").select("phone"),
      supabase
        .from("bulk_message_phone_guards")
        .select("applicant_phone")
        .in("scope", ["bulk_10m", "job_notice_24h", "new_job_7d"])
        .gt("expires_at", new Date(now).toISOString()),
      fetchAllPostgrestRows(async (from, to) => {
        const result = await supabase
          .from("messages")
          .select("id, applicant_id")
          .eq("direction", "outbound")
          .eq("sent_by", "system-bulk")
          .gt("created_at", tenMinutesAgo)
          .order("id", { ascending: true })
          .range(from, to);
        return {
          data: result.data as Array<{ id: number; applicant_id: number | null }> | null,
          error: result.error,
        };
      }, "공고 등록 미리보기 최근 문자"),
      fetchAllPostgrestRows(async (from, to) => {
        const result = await supabase
          .from("pool_events")
          .select("id, applicant_id, meta, created_at")
          .eq("event_type", "ping_sent")
          .gt("created_at", sevenDaysAgo)
          .order("id", { ascending: true })
          .range(from, to);
        return {
          data: result.data as Array<{
            id: number;
            applicant_id: number;
            meta: unknown;
            created_at: string;
          }> | null,
          error: result.error,
        };
      }, "공고 등록 미리보기 최근 공고 안내"),
    ]);
    if (blacklistResult.error) throw new Error(`[exposure preview] blacklist load failed: ${blacklistResult.error.message}`);
    if (guardResult.error) throw new Error(`[exposure preview] phone guard load failed: ${guardResult.error.message}`);

    const phoneByApplicantId = new Map(
      applicants.map((applicant) => [applicant.id, normalizePhone(applicant.phone ?? "")]),
    );
    const guardedPhones = new Set(
      (guardResult.data ?? [])
        .map((row) => normalizePhone(String(row.applicant_phone ?? "")))
        .filter(Boolean),
    );
    for (const message of recentMessages) {
      const phone = typeof message.applicant_id === "number"
        ? phoneByApplicantId.get(message.applicant_id)
        : null;
      if (phone) guardedPhones.add(phone);
    }
    const oneDayAgoMs = now - 24 * 60 * 60 * 1000;
    for (const event of recentEvents) {
      const purpose = (event.meta as { purpose?: unknown } | null)?.purpose;
      const createdAtMs = new Date(event.created_at).getTime();
      const blocksNewJob = purpose === "new_job"
        || (
          Number.isFinite(createdAtMs)
          && createdAtMs > oneDayAgoMs
          && (purpose === "job_closed" || purpose === "campaign")
        );
      if (!blocksNewJob) continue;
      const phone = phoneByApplicantId.get(event.applicant_id);
      if (phone) guardedPhones.add(phone);
    }
    const blacklistedPhones = new Set(
      (blacklistResult.data ?? [])
        .map((row) => normalizePhone(String(row.phone ?? "")))
        .filter(Boolean),
    );

    // 반경 축은 **공고 기준점**이 필요하다 — 미리보기가 공고를 받으면 그 공고로 재고,
    // 못 받으면 그 축을 셀 수 없다는 사실을 그대로 알린다(0명으로 위장하지 않는다).
    const jobId = Number(body?.job_id);
    let job: GeoJob | null = null;
    let vehicleRequired = body?.draft_job?.vehicle_required === true;
    let geocodePrecision: { pickup: string | null; dropoff: string | null } | null = null;
    if (Number.isFinite(jobId) && jobId > 0) {
      const { data: jobRow, error: jobError } = await supabase
        .from("jobs")
        .select(EXPOSURE_JOB_GEO_COLUMNS)
        .eq("id", jobId)
        .maybeSingle();
      if (jobError) throw new Error(`[exposure preview] job load failed: ${jobError.message}`);
      job = (jobRow as unknown as GeoJob) ?? null;
    } else if (body?.draft_job && typeof body.draft_job === "object") {
      const pickupAddress = typeof body.draft_job.pickup_address === "string"
        ? body.draft_job.pickup_address.trim()
        : "";
      const dropoffAddress = typeof body.draft_job.dropoff_address === "string"
        ? body.draft_job.dropoff_address.trim()
        : "";
      const [pickup, dropoff] = await Promise.all([
        geocodeAddressWithFallback(pickupAddress),
        geocodeAddressWithFallback(dropoffAddress),
      ]);
      job = {
        pickup_lat: pickup.geo?.lat ?? null,
        pickup_lng: pickup.geo?.lng ?? null,
        dropoff_lat: dropoff.geo?.lat ?? null,
        dropoff_lng: dropoff.geo?.lng ?? null,
        distance_basis: body.draft_job.distance_basis === "pickup" ? "pickup" : "nearest",
      };
      geocodePrecision = { pickup: pickup.precision, dropoff: dropoff.precision };
    }
    // 수정 모달이 '방금 고른'(아직 저장 안 한) 거리 기준을 넘기면 그걸로 계산 —
    // 저장된 기준으로 재면 같은 화면에서 미리보기와 저장 결과 인원이 어긋난다(실측 296↔190).
    const basisOverride = body?.distance_basis;
    if (job && (basisOverride === "pickup" || basisOverride === "nearest")) {
      job = { ...job, distance_basis: basisOverride };
    }
    const radiusNeedsJob = typeof rule?.radiusKm === "number" && rule.radiusKm > 0;
    const radiusUnavailable = radiusNeedsJob && !jobSupportsRadius(job);
    const matched = exposure === "all"
      ? applicants
      : rule
        ? applicants.filter((a) => matchesRule(a, rule, { nowMs: now, job }))
        : [];
    const audience = selectJobAudiencePreview({
      applicants,
      exposure,
      rule,
      job,
      vehicleRequired,
      nowMs: now,
      blacklistedPhones,
      guardedPhones,
    });
    return NextResponse.json({
      rule, // 정규화된 규칙(무효 키 제거 결과)을 되돌려줘 UI가 실제 저장될 값을 보여줄 수 있게
      count: matched.length,
      total: applicants.length,
      sample: matched.slice(0, 5).map((a) => a.name ?? `#${a.id}`),
      visible_count: audience.visibleCount,
      sms_eligible_count: audience.smsEligibleCount,
      recommendations: audience.recommendations,
      snapshot_at: new Date(now).toISOString(),
      geocode_precision: geocodePrecision,
      // 반경 규칙인데 공고 좌표가 없거나 공고를 못 받았다 → 화면이 '0명'이 아니라 '계산 불가'로 보여야 한다.
      radius_unavailable: radiusUnavailable,
      // 좌표 없는 인원 수 — 반경 규칙에서 항상 빠지는 집단(주소가 플레이스홀더라 지오코딩 불가).
      geo_unknown: applicants.filter((a) => typeof a.lat !== "number" || typeof a.lng !== "number").length,
    });
  } catch (e) {
    console.error("[exposure preview] failed", e);
    return NextResponse.json({ error: "미리보기 실패" }, { status: 500 });
  }
}
