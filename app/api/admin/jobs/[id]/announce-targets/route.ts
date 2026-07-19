/**
 * GET /api/admin/jobs/[id]/announce-targets — 새 공고 안내(N1) 대상 산정.
 *
 * "새 공고 올라오면 먼저 안내드릴게요" 약속(충원완료·마감 안내 waitlist_notice)과
 * pull 마감 카드 알림 신청(notify_request)의 이행 대상을, 공고 게시 순간 원클릭 발송용으로 내려준다.
 * 발송 자체는 클라이언트가 bulk-send(purpose='new_job')로 수행 — 수신거부·인력풀 제외·10분 중복 가드는 거기서 재차 방어.
 *
 * 우선순위 그룹 (S > A > B > C, 상위 그룹 우선으로 중복 제거):
 *   S suntop    — 선탑(동승) 완료자(suntop_done, 기간 무관) — 현장을 미리 경험한 프리보딩 인력, 압도적 우선
 *   A promised  — waitlist_notice 수신자 (전 공고 대상 — 약속은 공고 무관 "새 공고" 약속)
 *   B requested — notify_request 이력자 (pull 마감 카드 '먼저 알려주세요')
 *   C matched   — 최근 14일 ping_sent 코호트 중 이 공고 앵커(상차지·마지막 경유지) 15km 이내
 *                 + (공고 vehicle_required=true면 own_vehicle='있음')
 *
 * 제외 (전 그룹 공통):
 *   수신거부(sms_opt_out_at) · 인력풀 제외(부적합/이탈) · phone/access_token 없음(맞춤링크 발송 불가)
 *   · 이미 이 공고 후보(job_candidates) · 최근 7일 purpose='new_job' 수신자(주 1회 피로도 상한)
 *
 * 응답: { groups: { promised, requested, matched }, targets: [{id,name,phone,access_token,group}],
 *         night, sms_title }
 *   targets 상한 200(A>B>C 순으로 절단). groups는 절단 후 기준 — 모달 표시 수 = 실제 발송 수.
 *   night = isNightKst() — 야간(KST 21~08)엔 클라이언트가 발송 버튼을 비활성화한다.
 *   sms_title = smsJobTitle(제목) — 문자 문구용 단가 괄호 제거본(클라이언트가 {공고명} 치환).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { haversineKm } from "@/lib/kakao-geocode";
import { isNightKst, smsJobTitle } from "@/lib/agent/engage";
import { isExposed, normalizeRule, type ExposureMode } from "@/lib/exposure";

export const dynamic = "force-dynamic";

const TARGET_CAP = 200;
const MATCH_RADIUS_KM = 15;
const PING_COHORT_DAYS = 14;
const NEW_JOB_FATIGUE_DAYS = 7;

type AnnounceGroup = "suntop" | "promised" | "requested" | "matched";

interface ApplicantRow {
  id: number;
  name: string | null;
  phone: string | null;
  access_token: string | null;
  status: string | null;
  sms_opt_out_at: string | null;
  own_vehicle: string | null;
  lat: number | null;
  lng: number | null;
  // 지정 노출(targeted) 공고의 노출 판정용
  sido: string | null;
  availability: string | null;
  applied_at: string | null;
  created_at: string | null;
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const jobId = Number(params.id);
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id, title, vehicle_required, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, exposure, exposure_rule")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr) {
    console.error("[announce-targets] job", jobErr);
    return NextResponse.json({ error: jobErr.message }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: "공고를 찾을 수 없습니다." }, { status: 404 });
  }

  // S 선탑 완료자 — 프리보딩 자산(pool_events suntop_done, 기간 무관). 거리·차량 조건 없이 최우선.
  const { data: suntopRows, error: sunErr } = await supabase
    .from("pool_events")
    .select("applicant_id")
    .eq("event_type", "suntop_done");
  if (sunErr) {
    console.error("[announce-targets] suntop_done", sunErr);
    return NextResponse.json({ error: sunErr.message }, { status: 500 });
  }

  // A 약속자 — waitlist_notice는 "새 공고가 올라오면 먼저 안내" 약속(충원완료 자동 안내·마감 안내 공통).
  // 약속이 공고 무관이므로 job_id 필터 없이 전 공고 수신자를 본다.
  const { data: promisedRows, error: promErr } = await supabase
    .from("pool_events")
    .select("applicant_id")
    .eq("event_type", "waitlist_notice");
  if (promErr) {
    console.error("[announce-targets] waitlist_notice", promErr);
    return NextResponse.json({ error: promErr.message }, { status: 500 });
  }

  // B 알림 신청자 — pull 마감 카드 '먼저 알려주세요'(notify_request) 이력자(공고 무관).
  const { data: requestedRows, error: reqErr } = await supabase
    .from("pool_events")
    .select("applicant_id")
    .eq("event_type", "notify_request");
  if (reqErr) {
    console.error("[announce-targets] notify_request", reqErr);
    return NextResponse.json({ error: reqErr.message }, { status: 500 });
  }

  // C 코호트 — 최근 14일 내 재컨택(ping_sent) 이력자. 조건 매칭(거리·차량)은 아래에서 적용.
  const sinceCohort = new Date(Date.now() - PING_COHORT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: pingedRows, error: pingErr } = await supabase
    .from("pool_events")
    .select("applicant_id")
    .eq("event_type", "ping_sent")
    .gte("created_at", sinceCohort);
  if (pingErr) {
    console.error("[announce-targets] ping_sent", pingErr);
    return NextResponse.json({ error: pingErr.message }, { status: 500 });
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
    });
  }

  // 이미 이 공고 후보 — 스크리닝 대상과 새 공고 안내가 겹치면 이중 문자가 나가므로 제외.
  const { data: cands, error: candErr } = await supabase
    .from("job_candidates")
    .select("applicant_id")
    .eq("job_id", jobId);
  if (candErr) {
    console.error("[announce-targets] job_candidates", candErr);
    return NextResponse.json({ error: candErr.message }, { status: 500 });
  }
  const candSet = new Set((cands ?? []).map((r) => r.applicant_id as number));

  // 최근 7일 내 새 공고 안내(purpose='new_job') 수신자 — 주 1회 피로도 상한.
  const sinceFatigue = new Date(Date.now() - NEW_JOB_FATIGUE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentNotices, error: fatigueErr } = await supabase
    .from("pool_events")
    .select("applicant_id")
    .eq("event_type", "ping_sent")
    .eq("meta->>purpose", "new_job")
    .gte("created_at", sinceFatigue);
  if (fatigueErr) {
    console.error("[announce-targets] new_job fatigue", fatigueErr);
    return NextResponse.json({ error: fatigueErr.message }, { status: 500 });
  }
  const fatigueSet = new Set((recentNotices ?? []).map((r) => r.applicant_id as number));

  const { data: apps, error: appErr } = await supabase
    .from("applicants")
    .select("id, name, phone, access_token, status, sms_opt_out_at, own_vehicle, lat, lng, sido, availability, applied_at, created_at")
    .in("id", unionIds);
  if (appErr) {
    console.error("[announce-targets] applicants", appErr);
    return NextResponse.json({ error: appErr.message }, { status: 500 });
  }
  const infoById = new Map<number, ApplicantRow>();
  for (const a of (apps ?? []) as ApplicantRow[]) infoById.set(a.id, a);

  // 지정 노출(targeted) 공고 — 유효 노출 대상이 아닌 사람에겐 새 공고 안내를 보내지 않는다.
  // (안내 문자에 공고명이 들어가므로 push 채널로 존재가 새는 것 방지. pull 게이팅과 동일 판정)
  const targetedJob = (job as { exposure?: string | null }).exposure === "targeted";
  const exposureRule = normalizeRule((job as { exposure_rule?: unknown }).exposure_rule);
  const exposureOverrides = new Map<number, ExposureMode>();
  if (targetedJob) {
    const { data: ovRows, error: ovErr } = await supabase
      .from("job_exposure_targets")
      .select("applicant_id, mode")
      .eq("job_id", jobId);
    if (ovErr) {
      console.error("[announce-targets] exposure overrides", ovErr);
      return NextResponse.json({ error: ovErr.message }, { status: 500 });
    }
    for (const r of ovRows ?? []) {
      const row = r as { applicant_id: number; mode: ExposureMode };
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
        availability: a.availability,
        applied_at: a.applied_at,
        created_at: a.created_at,
        suntopDone: suntopDoneSet.has(a.id),
      },
      exposureRule,
      exposureOverrides.get(a.id)
    );
  };

  // 새 공고 안내 제외 상태: 인력풀 제외(부적합·이탈) + 이미 투입 확정된 인력(확정인력) —
  // 확정자는 재컨택 대상이 아니다(라우터 AI 침묵 PR#65와 대칭). waitlist_notice 보유자여도 제외.
  const EXCLUDED_POOL_STATUS = new Set(["부적합", "이탈", "확정인력"]);
  const eligible = (a: ApplicantRow): boolean => {
    if (!a.phone || !a.access_token) return false; // 문구에 맞춤링크가 들어가므로 발송 불가 인원 제외
    if (a.sms_opt_out_at) return false;
    if (EXCLUDED_POOL_STATUS.has(a.status ?? "")) return false;
    if (candSet.has(a.id)) return false;
    if (fatigueSet.has(a.id)) return false;
    if (!exposedForAnnounce(a)) return false; // 지정 노출 공고: 노출 대상만 안내
    return true;
  };

  // C 조건 매칭 — 공고 앵커(상차지·마지막 경유지 중 가까운 쪽) 15km 이내 + 차량 요건.
  // 앵커 좌표가 없는 공고(주소 미입력·지오코딩 실패)는 거리 판정이 불가하므로 C 그룹 없음.
  const anchors: { lat: number; lng: number }[] = [];
  if (typeof job.pickup_lat === "number" && typeof job.pickup_lng === "number") {
    anchors.push({ lat: job.pickup_lat, lng: job.pickup_lng });
  }
  if (typeof job.dropoff_lat === "number" && typeof job.dropoff_lng === "number") {
    anchors.push({ lat: job.dropoff_lat, lng: job.dropoff_lng });
  }
  const matchesJob = (a: ApplicantRow): boolean => {
    if (anchors.length === 0 || typeof a.lat !== "number" || typeof a.lng !== "number") return false;
    const dist = Math.min(...anchors.map((p) => haversineKm(a.lat as number, a.lng as number, p.lat, p.lng)));
    if (dist > MATCH_RADIUS_KM) return false;
    if (job.vehicle_required && a.own_vehicle !== "있음") return false;
    return true;
  };

  // S > A > B > C 순으로 채워 상위 그룹 우선 중복 제거 — 절단(상한 200)도 같은 순서라 선탑 완료자부터 보장.
  const suntopSet = new Set(suntopIds);
  const promisedSet = new Set(promisedIds);
  const requestedSet = new Set(requestedIds);
  const targets: { id: number; name: string | null; phone: string; access_token: string; group: AnnounceGroup }[] = [];
  const push = (id: number, group: AnnounceGroup) => {
    const a = infoById.get(id);
    if (!a || !eligible(a)) return;
    if (group === "matched" && !matchesJob(a)) return;
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

  return NextResponse.json({ groups, targets: capped, night, sms_title: smsTitle });
}
