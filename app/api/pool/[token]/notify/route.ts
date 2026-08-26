/**
 * POST /api/pool/[token]/notify — 마감된 공고 카드의 "새 일자리 안내 문자를 받을게요" 클릭.
 *
 * 놓친 지원자를 자산화하는 두 번째 수확 (확정 뉘앙스 금지 — 알림 요청은 '가능 의사 수집'일 뿐):
 *   1. pool_events(notify_request)와 신규 일자리 문자 수신 동의 기록 — 다음 긴급 건의 우선 발송 목록 재료
 *   2. Slack 알림 — 매니저가 다음 웨이브 타깃으로 인지
 * 다음 기회 알림은 이번 주 근무 가능 응답이 아니므로 applicants.availability는 바꾸지 않는다.
 * 본인이 공개 링크에서 다시 명시적으로 신청하면 기존 수신거부도 함께 해제한다.
 * 마감된 공고이므로 job_candidates는 연결하지 않는다(공고 보드 노이즈 방지).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { EXPOSURE_JOB_GEO_COLUMNS, type GeoJob } from "@/lib/geo";
import { sendSlackText } from "@/lib/slack";
import { poolAvailabilityDecision } from "@/lib/pool-availability";
import {
  isPoolActionId,
  poolActionReplayDecision,
  poolDurableActionDecision,
} from "@/lib/pool-durable-action";
import {
  isExposed,
  normalizeRule,
  fetchOverridesForApplicant,
  fetchSuntopDone,
  type ExposureApplicant,
} from "@/lib/exposure";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const routeParams = await params;
  const token = routeParams.token;
  if (!UUID_RE.test(token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const jobId = Number(body?.job_id);
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "job_id 필수" }, { status: 400 });
  }
  const actionId = body?.action_id;
  if (!isPoolActionId(actionId)) {
    return NextResponse.json({ error: "요청 정보를 다시 확인해 주세요." }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: applicant } = await supabase
    .from("applicants")
    .select("id, name, availability, sido, sigungu, own_vehicle, work_hours, available_slots, lat, lng, applied_at, created_at")
    .eq("access_token", token)
    .maybeSingle();
  if (!applicant) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: replayRow, error: replayError } = await supabase
    .from("pool_events")
    .select("applicant_id, job_id, event_type, meta")
    .eq("action_key", actionId)
    .maybeSingle();
  const replay = poolActionReplayDecision(replayRow, replayError, {
    applicantId: applicant.id as number,
    jobId,
    eventType: "notify_request",
  });
  if (replay === "retryable") {
    console.error("[pool notify] replay lookup failed", replayError);
    return NextResponse.json(
      { error: "알림 요청을 확인하지 못했어요. 잠시 후 다시 시도해 주세요." },
      { status: 503 },
    );
  }
  if (replay === "conflict") {
    return NextResponse.json({ error: "이미 다른 요청에 사용된 요청 정보예요." }, { status: 409 });
  }
  if (replay === "deduped") {
    // 최초 이벤트와 동의 저장은 한 트랜잭션이다. 과거 요청을 다시 실행하면
    // 그 뒤의 수신거부를 덮어쓸 수 있으므로 저장된 성공만 그대로 복구한다.
    return NextResponse.json({ success: true, deduped: true });
  }

  // 대상 검증 — GET이 '마감됨' 카드로 노출하는 조건의 거울: active 공고이면서
  // 마감시각이 지났고 3일 유예 안. (진행 중 공고·유예 경과·closed 공고는 거부 —
  // 공개 엔드포인트라 임의 job_id 주입으로 신선도 갱신·허위 Slack을 만들 수 없어야 한다)
  const GRACE_MS = 3 * 24 * 60 * 60 * 1000;
  const { data: job } = await supabase
    .from("jobs")
    // 반경 축 판정 재료 — 게이트가 pool GET과 같은 컬럼을 봐야 한다(빠지면 카드는 보이는데 클릭만 400).
    .select(`id, title, status, closes_at, recruit_mode, exposure, exposure_rule, ${EXPOSURE_JOB_GEO_COLUMNS}`)
    .eq("id", jobId)
    .maybeSingle();
  const closesMs = job?.closes_at ? new Date(job.closes_at as string).getTime() : null;
  const nowMs = Date.now();
  const eligible =
    job &&
    !String(job.title).startsWith("__") &&
    // pull 채널 공고(internal·both)만 — GET·interest와 대칭(external 공고 존재 프로브 방지)
    ((job as { recruit_mode?: string | null }).recruit_mode === "internal" ||
      (job as { recruit_mode?: string | null }).recruit_mode === "both") &&
    job.status === "active" &&
    closesMs !== null &&
    closesMs <= nowMs &&
    closesMs > nowMs - GRACE_MS;
  if (!eligible) {
    return NextResponse.json({ error: "확인할 수 없는 공고예요" }, { status: 400 });
  }

  // 지정 노출(targeted) 게이팅 — 노출 대상이 아니면 존재를 숨긴다(동일한 불투명 400).
  // 판정 재료 조회 실패도 같은 400(fail-closed) — exclude 무시(fail-open) 방지.
  if ((job as { exposure?: string }).exposure === "targeted") {
    try {
      const [overrides, suntopDone] = await Promise.all([
        fetchOverridesForApplicant(supabase, applicant.id as number, [jobId]),
        fetchSuntopDone(supabase, applicant.id as number),
      ]);
      const exA: ExposureApplicant = {
        id: applicant.id as number,
        sido: (applicant as { sido?: string | null }).sido ?? null,
        sigungu: (applicant as { sigungu?: string | null }).sigungu ?? null,
        availability: (applicant as { availability?: string | null }).availability ?? null,
        own_vehicle: (applicant as { own_vehicle?: string | null }).own_vehicle ?? null,
        work_hours: (applicant as { work_hours?: string | null }).work_hours ?? null,
        available_slots: (applicant as { available_slots?: string[] | null }).available_slots ?? null,
        lat: (applicant as { lat?: number | null }).lat ?? null,
        lng: (applicant as { lng?: number | null }).lng ?? null,
        applied_at: (applicant as { applied_at?: string | null }).applied_at ?? null,
        created_at: (applicant as { created_at?: string | null }).created_at ?? null,
        suntopDone,
      };
      if (!isExposed(exA, normalizeRule((job as { exposure_rule?: unknown }).exposure_rule), overrides.get(jobId), { job: job as unknown as GeoJob })) {
        return NextResponse.json({ error: "확인할 수 없는 공고예요" }, { status: 400 });
      }
    } catch (e) {
      console.error("[pool notify] exposure gate load failed — 거부(fail-closed)", e);
      return NextResponse.json({ error: "확인할 수 없는 공고예요" }, { status: 400 });
    }
  }

  // 알림 요청은 오늘·내일 근무 가능 응답이 아니다. 공통 계약이 null을 반환해야 하며,
  // 이 엔드포인트에서는 전역 가용성을 변경하지 않는다.
  const availabilityDecision = poolAvailabilityDecision(
    applicant.availability as string | null,
    "notify",
  );
  if (availabilityDecision) {
    console.error("[pool notify] invalid availability decision ignored", availabilityDecision);
  }

  const { data: durableData, error: durableError } = await supabase.rpc(
    "record_pool_notify_request",
    {
      p_job_id: jobId,
      p_applicant_id: applicant.id as number,
      p_action_key: actionId,
    },
  );
  const durable = poolDurableActionDecision(durableData, durableError);
  if (durable.kind === "retryable") {
    console.error("[pool notify] atomic write failed", durableError ?? durableData);
    return NextResponse.json(
      { error: "알림 요청을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." },
      { status: 503 },
    );
  }
  if (durable.kind === "unavailable") {
    return NextResponse.json({ error: "확인할 수 없는 공고예요" }, { status: 400 });
  }
  if (durable.kind === "unchanged_closed") {
    return NextResponse.json({ error: "이 요청의 이전 처리 결과가 유지되고 있어요." }, { status: 409 });
  }
  if (durable.kind === "deduped") {
    return NextResponse.json({ success: true, deduped: true });
  }

  // durable write가 새로 완료된 요청만 외부 알림을 보낸다.
  await sendSlackText(
    `🔔 *다음 급구 우선 안내 요청* — ${applicant.name ?? "이름 미상"}님이 마감된 '${job.title}' 공고에서 다음 기회 알림을 요청했어요.\n다음 긴급 건 발송 시 우선 타깃입니다.`
  ).catch(() => false);

  return NextResponse.json({ success: true });
}
