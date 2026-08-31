/**
 * GET /api/admin/jobs/[id]/announce-targets — 새 공고 안내(N1) 대상 산정.
 *
 * 과거 공고의 충원·마감 안내 이력(waitlist_notice)과
 * pull 마감 카드 알림 신청(notify_request)의 이행 대상을, 공고 게시 순간 원클릭 발송용으로 내려준다.
 * 발송 자체는 클라이언트가 bulk-send(purpose='new_job')로 수행 — 수신거부·인력풀 제외·10분 중복 가드는 거기서 재차 방어.
 *
 * 우선순위 그룹 (S > A > B > C, 상위 그룹 우선으로 중복 제거):
 *   S suntop    — 선탑(동승) 완료자(suntop_done, 기간 무관) — 현장을 미리 경험한 프리보딩 인력, 압도적 우선
 *   A promised  — waitlist_notice 수신자 (과거 공고에서 충원·마감 안내를 받은 관심 이력)
 *   B requested — notify_request 이력자 (pull 마감 카드 '먼저 알려주세요')
 *   C matched   — 최근 14일 ping_sent 코호트 중 이 공고 앵커(상차지·마지막 경유지) 15km 이내
 *                 + (공고 vehicle_required=true면 own_vehicle='있음')
 *
 * 제외 (전 그룹 공통):
 *   수신거부(sms_opt_out_at) · 인력풀 제외(부적합/이탈) · phone/access_token 없음(맞춤링크 발송 불가)
 *   · 이미 이 공고 후보(job_candidates) · 최근 7일 purpose='new_job' 수신자(주 1회 피로도 상한)
 *
 * 응답: { groups: { suntop, promised, requested, matched }, targets: [{id,name,phone,access_token,group}],
 *         night, sms_title }
 *   targets 상한 200(S>A>B>C 순으로 절단). groups는 절단 후 기준 — 모달 표시 수 = 실제 발송 수.
 *   night = isNightKst() — 야간(KST 21~08)엔 클라이언트가 발송 버튼을 비활성화한다.
 *   sms_title = smsJobTitle(제목) — 문자 문구용 단가 괄호 제거본(클라이언트가 {공고명} 치환).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { distanceToJobKm, EXPOSURE_JOB_GEO_COLUMNS, type GeoJob } from "@/lib/geo";
import { isNightKst, smsJobTitle } from "@/lib/agent/engage";
import { isExposed, normalizeRule, type ExposureMode } from "@/lib/exposure";
import { smsSendBlockReason } from "@/lib/sms-consent-policy";
import { fetchAllPostgrestRows } from "@/lib/admin/postgrest-pagination";
import {
  fetchPhoneMessageIdentityIndex,
  type PhoneMessageIdentityIndex,
} from "@/lib/admin/phone-message-identity";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isJobEffectivelyClosed } from "@/lib/jobs";
import { normalizePhone } from "@/lib/ongmanaging";

export const dynamic = "force-dynamic";

const TARGET_CAP = 200;
const MATCH_RADIUS_KM = 15;
const PING_COHORT_DAYS = 14;
const NEW_JOB_FATIGUE_DAYS = 7;
const APPLICANT_ID_BATCH_SIZE = 250;

type AnnounceGroup = "suntop" | "promised" | "requested" | "matched";

interface ApplicantRow {
  id: number;
  name: string | null;
  phone: string | null;
  access_token: string | null;
  status: string | null;
  sms_opt_out_at: string | null;
  marketing_consent: boolean | null;
  own_vehicle: string | null;
  // 희망 시간대 판정 재료 — 노출 규칙에 시간대 축이 있으면 이 값으로 판정한다.
  work_hours: string | null;
  available_slots: string[] | null;
  lat: number | null;
  lng: number | null;
  // 지정 노출(targeted) 공고의 노출 판정용
  sido: string | null;
  sigungu: string | null;
  availability: string | null;
  applied_at: string | null;
  created_at: string | null;
}

interface PoolEventApplicantRow {
  id: number;
  applicant_id: number;
  created_at: string | null;
}

async function fetchPoolEventApplicants(
  supabase: SupabaseClient,
  args: { eventType: string; label: string; since?: string; purpose?: string },
): Promise<PoolEventApplicantRow[]> {
  return fetchAllPostgrestRows(async (from, to) => {
    let query = supabase
      .from("pool_events")
      .select("id, applicant_id, created_at")
      .eq("event_type", args.eventType);
    if (args.since) query = query.gte("created_at", args.since);
    if (args.purpose) query = query.eq("meta->>purpose", args.purpose);
    const result = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to);
    return {
      data: result.data as PoolEventApplicantRow[] | null,
      error: result.error,
    };
  }, args.label);
}

async function fetchApplicantsByIds(
  supabase: SupabaseClient,
  applicantIds: number[],
): Promise<ApplicantRow[]> {
  const batches: number[][] = [];
  for (let offset = 0; offset < applicantIds.length; offset += APPLICANT_ID_BATCH_SIZE) {
    batches.push(applicantIds.slice(offset, offset + APPLICANT_ID_BATCH_SIZE));
  }

  const rows: ApplicantRow[] = [];
  for (const batch of batches) {
    const batchRows = await fetchAllPostgrestRows(async (from, to) => {
      const result = await supabase
        .from("applicants")
        .select("id, name, phone, access_token, status, sms_opt_out_at, marketing_consent, own_vehicle, work_hours, available_slots, lat, lng, sido, sigungu, availability, applied_at, created_at")
        .in("id", batch)
        .order("id", { ascending: true })
        .range(from, to);
      return {
        data: result.data as ApplicantRow[] | null,
        error: result.error,
      };
    }, "새 공고 안내 지원자");
    rows.push(...batchRows);
  }
  return rows;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeParams = await params;
  const jobId = Number(routeParams.id);
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select(`id, title, status, closes_at, recruit_mode, vehicle_required, exposure, exposure_rule, ${EXPOSURE_JOB_GEO_COLUMNS}`)
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr) {
    console.error("[announce-targets] job", jobErr);
    return NextResponse.json({ error: jobErr.message }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  }
  // 외부 채널 전용 공고는 맞춤 공고 페이지에 노출되지 않는다. 이 공고명과 맞춤 링크를
  // 문자로 보내면 지원자가 링크에서 안내받은 공고를 찾을 수 없으므로 직접 호출도 닫는다.
  if (job.recruit_mode === "external") {
    return NextResponse.json(
      { error: "외부 채널 모집 전용 공고는 인력풀에 안내할 수 없습니다." },
      { status: 409 },
    );
  }
  if (isJobEffectivelyClosed(job.status, job.closes_at)) {
    return NextResponse.json(
      { error: "마감된 공고는 인력풀에 안내할 수 없습니다." },
      { status: 409 },
    );
  }

  const sinceCohort = new Date(Date.now() - PING_COHORT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let suntopRows: PoolEventApplicantRow[];
  let promisedRows: PoolEventApplicantRow[];
  let requestedRows: PoolEventApplicantRow[];
  let pingedRows: PoolEventApplicantRow[];
  try {
    [suntopRows, promisedRows, requestedRows, pingedRows] = await Promise.all([
      // S 선탑 완료자 — 프리보딩 자산(pool_events suntop_done, 기간 무관). 거리·차량 조건 없이 최우선.
      fetchPoolEventApplicants(supabase, { eventType: "suntop_done", label: "선탑 완료 이력" }),
      // A 충원 안내 이력 — 전 공고 수신자를 포함하되 아래에서 문자 동의를 별도 확인한다.
      fetchPoolEventApplicants(supabase, { eventType: "waitlist_notice", label: "충원 안내 이력" }),
      // B 알림 신청자 — pull 마감 카드 '먼저 알려주세요'(notify_request) 이력자(공고 무관).
      fetchPoolEventApplicants(supabase, { eventType: "notify_request", label: "새 공고 알림 신청 이력" }),
      // C 코호트 — 최근 14일 내 재컨택(ping_sent) 이력자. 거리·차량 조건은 아래에서 적용.
      fetchPoolEventApplicants(supabase, {
        eventType: "ping_sent",
        label: "최근 재컨택 이력",
        since: sinceCohort,
      }),
    ]);
  } catch (sourceError) {
    console.error("[announce-targets] source ledgers", sourceError);
    return NextResponse.json({
      error: sourceError instanceof Error ? sourceError.message : "대상 이력 조회 실패",
    }, { status: 500 });
  }

  const suntopIds = [...new Set((suntopRows ?? []).map((r) => r.applicant_id as number))];
  const promisedIds = [...new Set((promisedRows ?? []).map((r) => r.applicant_id as number))];
  const requestedIds = [...new Set((requestedRows ?? []).map((r) => r.applicant_id as number))];
  const pingedIds = [...new Set((pingedRows ?? []).map((r) => r.applicant_id as number))];

  const night = isNightKst();
  const smsTitle = smsJobTitle(job.title as string);
  const unionIds = [...new Set([...suntopIds, ...promisedIds, ...requestedIds, ...pingedIds])];
  if (unionIds.length === 0) {
    return NextResponse.json({
      groups: { suntop: 0, promised: 0, requested: 0, matched: 0 },
      targets: [],
      night,
      sms_title: smsTitle,
      dropped_by_consent: { total: 0, promised: 0 },
    });
  }

  // 이미 이 공고 후보 — 스크리닝 대상과 새 공고 안내가 겹치면 이중 문자가 나가므로 제외.
  const sinceFatigue = new Date(Date.now() - NEW_JOB_FATIGUE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let cands: Array<{ id: number; applicant_id: number }>;
  let recentNotices: PoolEventApplicantRow[];
  try {
    [cands, recentNotices] = await Promise.all([
      fetchAllPostgrestRows(async (from, to) => {
        const result = await supabase
          .from("job_candidates")
          .select("id, applicant_id")
          .eq("job_id", jobId)
          .order("id", { ascending: true })
          .range(from, to);
        return {
          data: result.data as Array<{ id: number; applicant_id: number }> | null,
          error: result.error,
        };
      }, "현재 공고 후보"),
      // 최근 7일 내 새 공고 안내(purpose='new_job') 수신자 — 주 1회 피로도 상한.
      fetchPoolEventApplicants(supabase, {
        eventType: "ping_sent",
        label: "최근 새 공고 안내 이력",
        since: sinceFatigue,
        purpose: "new_job",
      }),
    ]);
  } catch (excludeError) {
    console.error("[announce-targets] exclusions", excludeError);
    return NextResponse.json({
      error: excludeError instanceof Error ? excludeError.message : "대상 제외 이력 조회 실패",
    }, { status: 500 });
  }
  const candSet = new Set(cands.map((r) => r.applicant_id));

  let apps: ApplicantRow[];
  let phoneIdentityIndex: PhoneMessageIdentityIndex;
  try {
    [apps, phoneIdentityIndex] = await Promise.all([
      fetchApplicantsByIds(supabase, unionIds),
      // 동일 전화번호의 중복 행에 남은 수신거부·재동의와 피로도 이력까지 함께 본다.
      fetchPhoneMessageIdentityIndex(supabase),
    ]);
  } catch (appError) {
    console.error("[announce-targets] applicants", appError);
    return NextResponse.json({
      error: appError instanceof Error ? appError.message : "지원자 조회 실패",
    }, { status: 500 });
  }
  const infoById = new Map<number, ApplicantRow>();
  for (const a of apps) infoById.set(a.id, a);
  const fatiguePhones = new Set<string>();
  for (const notice of recentNotices) {
    const phone = phoneIdentityIndex.phoneByApplicantId.get(notice.applicant_id);
    if (phone) fatiguePhones.add(phone);
  }

  // 지정 노출(targeted) 공고 — 유효 노출 대상이 아닌 사람에겐 새 공고 안내를 보내지 않는다.
  // (안내 문자에 공고명이 들어가므로 push 채널로 존재가 새는 것 방지. pull 게이팅과 동일 판정)
  const targetedJob = (job as { exposure?: string | null }).exposure === "targeted";
  const exposureRule = normalizeRule((job as { exposure_rule?: unknown }).exposure_rule);
  const exposureOverrides = new Map<number, ExposureMode>();
  if (targetedJob) {
    let ovRows: Array<{ applicant_id: number; mode: ExposureMode }>;
    try {
      ovRows = await fetchAllPostgrestRows(async (from, to) => {
        const result = await supabase
          .from("job_exposure_targets")
          .select("applicant_id, mode")
          .eq("job_id", jobId)
          .order("applicant_id", { ascending: true })
          .range(from, to);
        return {
          data: result.data as Array<{ applicant_id: number; mode: ExposureMode }> | null,
          error: result.error,
        };
      }, "공고 지정 노출 명단");
    } catch (overrideError) {
      console.error("[announce-targets] exposure overrides", overrideError);
      return NextResponse.json({
        error: overrideError instanceof Error ? overrideError.message : "공고 지정 노출 명단 조회 실패",
      }, { status: 500 });
    }
    for (const row of ovRows) {
      exposureOverrides.set(row.applicant_id, row.mode);
    }
  }
  const suntopDoneSet = new Set(suntopIds); // S그룹 소스와 동일(pool_events suntop_done)
  const exposedForAnnounce = (a: ApplicantRow): boolean => {
    if (!targetedJob) return true;
    return isExposed(
      {
        id: a.id,
        sido: a.sido,
        sigungu: a.sigungu,
        availability: a.availability,
        own_vehicle: a.own_vehicle,
        work_hours: a.work_hours,
        available_slots: a.available_slots,
        lat: a.lat,
        lng: a.lng,
        applied_at: a.applied_at,
        created_at: a.created_at,
        suntopDone: suntopDoneSet.has(a.id),
      },
      exposureRule,
      exposureOverrides.get(a.id),
      { job: job as unknown as GeoJob }
    );
  };

  // 새 공고 안내 제외 상태: 인력풀 제외(부적합·이탈) + 이미 투입 확정된 인력(확정인력) —
  // 확정자는 재컨택 대상이 아니다(라우터 AI 침묵 PR#65와 대칭). waitlist_notice 보유자여도 제외.
  const EXCLUDED_POOL_STATUS = new Set(["부적합", "이탈", "확정인력"]);
  // 지정 노출 명단 때문에 빠진 인원 집계 — 과거 충원 안내 이력이 있는 후보도
  // 공고를 지정 노출로 좁히면 대상에서 빠질 수 있다.
  // 그러면 모달은 그냥 작은 숫자를 보여주고, 0명일 때는 "이력이 없다"고 잘못 안내한다.
  // 매니저가 '좁힌 명단 때문에 빠졌다'는 걸 알 수 있게 이유를 숫자로 돌려준다.
  const droppedByExposure = { total: 0, promised: 0 };
  // **7일 피로도로 빠진 수** — 공고를 며칠에 걸쳐 여러 개 올리면 두 번째 공고부터 이 이유로 대상이 0명이 된다.
  // 예전엔 이 수를 돌려주지 않아, 화면이 "이력이 없습니다"라는 **사실과 다른 이유**를 말했다.
  const droppedByFatigue = { total: 0, promised: 0 };
  // 신규 일자리 안내는 명시적으로 동의한 지원자에게만 보낸다. 동의 누락으로 0명이 된 경우를
  // "대상 이력 없음"으로 오인하지 않도록 다른 제외 사유와 같은 형태로 집계한다.
  const droppedByConsent = { total: 0, promised: 0 };
  const eligible = (a: ApplicantRow, group: AnnounceGroup): boolean => {
    if (!a.phone || !a.access_token) return false; // 문구에 맞춤링크가 들어가므로 발송 불가 인원 제외
    const normalizedPhone = normalizePhone(a.phone);
    const phoneIdentity = phoneIdentityIndex.byPhone.get(normalizedPhone);
    // 같은 전화번호의 어느 지원자 행에서든 유효한 수신거부가 확인되면 전화번호 전체를 차단한다.
    // 전체 인덱스에 해당 행이 없다는 비정상 상태도 홍보 발송 대상에서는 fail-closed 한다.
    if (!phoneIdentity || phoneIdentity.hasActiveSmsOptOut) return false;
    if (phoneIdentity.applicantStatuses.some((status) => EXCLUDED_POOL_STATUS.has(status))) return false;
    if (phoneIdentity.applicantIds.some((applicantId) => candSet.has(applicantId))) return false;
    const consentBlock = smsSendBlockReason({
      category: "promotional",
      marketingConsent: a.marketing_consent,
      smsOptOutAt: a.sms_opt_out_at,
    });
    if (consentBlock === "opt_out") return false;
    if (consentBlock) {
      droppedByConsent.total++;
      if (group === "suntop" || group === "promised") droppedByConsent.promised++;
      return false;
    }
    if (fatiguePhones.has(normalizedPhone)) {
      droppedByFatigue.total++;
      if (group === "suntop" || group === "promised") droppedByFatigue.promised++;
      return false;
    }
    if (!exposedForAnnounce(a)) {
      // 지정 노출 공고: 노출 대상만 안내
      droppedByExposure.total++;
      if (group === "suntop" || group === "promised") droppedByExposure.promised++;
      return false;
    }
    return true;
  };

  // C 조건 매칭 — 공고가 정한 거리 기준(집결지만 / 집결지·마지막 경유지 중 가까운 쪽) 15km 이내 + 차량 요건.
  // 앵커 좌표가 없는 공고(주소 미입력·지오코딩 실패)는 거리 판정이 불가하므로 C 그룹 없음.
  const matchesJob = (a: ApplicantRow): boolean => {
    // 거리 판정은 lib/geo 단일 공식 — 기준점(집결지만/경유지 포함)은 공고가 정한다(distance_basis).
    const dist = distanceToJobKm({ lat: a.lat, lng: a.lng }, job as unknown as GeoJob);
    if (dist === null || dist > MATCH_RADIUS_KM) return false;
    if (job.vehicle_required && a.own_vehicle !== "있음") return false;
    return true;
  };

  // S > A > B > C 순으로 채워 상위 그룹 우선 중복 제거 — 절단(상한 200)도 같은 순서라 선탑 완료자부터 보장.
  const suntopSet = new Set(suntopIds);
  const promisedSet = new Set(promisedIds);
  const requestedSet = new Set(requestedIds);
  const targets: { id: number; name: string | null; phone: string; access_token: string; group: AnnounceGroup }[] = [];
  const targetPhones = new Set<string>();
  const push = (id: number, group: AnnounceGroup) => {
    const a = infoById.get(id);
    if (!a) return;
    // 거리·차량 미달은 노출과 무관한 탈락이라 **먼저** 걸러 노출 집계를 오염시키지 않는다.
    if (group === "matched" && !matchesJob(a)) return;
    if (!eligible(a, group)) return;
    // 같은 사람이 중복 지원자 행으로 존재해도 S>A>B>C 중 가장 높은 우선순위 1건만 남긴다.
    // bulk-send는 50명씩 나뉘므로 요청 내부 phone dedupe만으로는 청크 경계 중복을 막지 못한다.
    const normalizedPhone = normalizePhone(a.phone as string);
    if (targetPhones.has(normalizedPhone)) return;
    targetPhones.add(normalizedPhone);
    targets.push({ id: a.id, name: a.name, phone: a.phone as string, access_token: a.access_token as string, group });
  };
  for (const id of suntopIds) push(id, "suntop");
  for (const id of promisedIds) if (!suntopSet.has(id)) push(id, "promised");
  for (const id of requestedIds) if (!suntopSet.has(id) && !promisedSet.has(id)) push(id, "requested");
  for (const id of pingedIds) if (!suntopSet.has(id) && !promisedSet.has(id) && !requestedSet.has(id)) push(id, "matched");

  const capped = targets.slice(0, TARGET_CAP);
  const groups = {
    suntop: capped.filter((t) => t.group === "suntop").length,
    promised: capped.filter((t) => t.group === "promised").length,
    requested: capped.filter((t) => t.group === "requested").length,
    matched: capped.filter((t) => t.group === "matched").length,
  };

  return NextResponse.json({
    groups,
    targets: capped,
    night,
    sms_title: smsTitle,
    // 지정 노출 여부와 '명단 때문에 빠진 수' — 0명일 때 이유를 이력 부족으로 잘못 안내하지 않기 위해.
    exposure: targetedJob ? "targeted" : "all",
    dropped_by_exposure: droppedByExposure,
    // 최근 7일 안에 다른 공고 안내를 이미 받아 빠진 수 — 0명의 진짜 이유를 화면이 말할 수 있게.
    dropped_by_fatigue: droppedByFatigue,
    fatigue_days: NEW_JOB_FATIGUE_DAYS,
    // 명시 동의(marketing_consent=true)가 없어 빠진 수. null/false 모두 포함한다.
    dropped_by_consent: droppedByConsent,
  });
}
