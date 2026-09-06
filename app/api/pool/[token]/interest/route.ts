/**
 * POST /api/pool/[token]/interest — pull 페이지 '관심 있음' 클릭.
 *
 * 하는 일 (확정 뉘앙스 금지 — 관심 표시는 '가능 의사 수집'일 뿐, 배정·확정은 매니저):
 *   1. job_candidates upsert — 매니저 파이프라인/공고 보드에 후보로 노출 (발송은 dispatch에서)
 *   2. 명시적인 오늘·내일 가능 응답일 때만 availability를 '즉시가능'으로 갱신
 *   3. pool_events(interest_click, 필요한 경우 availability_set) 기록 — 신선도·신뢰 점수 근거
 *   4. 자동 응대(auto-engage) — 전역 3단 모드 준수(off=발송 없음 / draft=수동 유도 / auto=첫 문자
 *      발송 + screening 진입). 야간(KST 21~08시) 클릭은 engage_queued_at에 예약만 하고
 *      아침 9시 cron(/api/admin/cron/engage-queued)이 발송한다. 로직은 lib/agent/engage.ts.
 *   5. Slack 알림 — 자동 응대 결과 병기, 매니저가 후속 처리를 결정
 */

import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase";
import { EXPOSURE_JOB_GEO_COLUMNS, type GeoJob } from "@/lib/geo";
import { sendSlackText } from "@/lib/slack";
import {
  isPoolActionId,
  poolActionReplayDecision,
  poolDurableActionDecision,
  poolInterestEngageIntentDecision,
  poolInterestEngageIntentFor,
  shouldCompletePoolInterestEngageIntent,
} from "@/lib/pool-durable-action";
import { isJobEffectivelyClosed } from "@/lib/jobs";
import { getAgentMode } from "@/lib/agent/kill-switch";
import {
  isExposed,
  normalizeRule,
  fetchOverridesForApplicant,
  fetchSuntopDone,
  type ExposureApplicant,
} from "@/lib/exposure";
import {
  engageOutcomeLabel,
  isNightKst,
  recoverInterestEngage,
  runInterestEngage,
  type EngageOutcome,
} from "@/lib/agent/engage";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InterestIntentResume =
  | { kind: "completed"; outcome: string }
  | { kind: "retryable"; error: string }
  | { kind: "conflict"; error: string };

function interestOutcomeKey(outcome: EngageOutcome): string {
  return outcome.action === "skipped"
    ? `skipped:${outcome.reason}`
    : outcome.action;
}

function interestSlackBase(params: {
  applicantName: string | null;
  jobTitle: string;
  immediate: boolean;
}): string {
  return params.immediate
    ? `⚡ *오늘·내일부터 가능* — ${params.applicantName ?? "이름 미상"}님이 '${params.jobTitle}' 공고에서 오늘이나 내일부터 일할 수 있다고 답했어요.\n근무 확정은 아니며, 파이프라인에서 확인 후 연락해주세요.`
    : `💡 *맞춤 공고 관심 표시* — ${params.applicantName ?? "이름 미상"}님이 '${params.jobTitle}' 공고에 관심을 표시했어요.\n파이프라인/공고 보드에서 확인 후 컨택해주세요.`;
}

async function resumeInterestEngageIntent(params: {
  supabase: SupabaseClient;
  actionKey: string;
  applicantId: number;
  applicantName: string | null;
  jobId: number;
  jobTitle?: string;
  immediate: boolean;
  allowHistoricalMissing: boolean;
}): Promise<InterestIntentResume> {
  const { data: intentRow, error: intentError } = await params.supabase
    .from("pool_interest_engage_intents")
    .select("applicant_id, job_id, intent, queue_created, status, outcome")
    .eq("action_key", params.actionKey)
    .maybeSingle();
  const intent = poolInterestEngageIntentDecision(intentRow, intentError, {
    applicantId: params.applicantId,
    jobId: params.jobId,
  });

  if (intent.kind === "retryable") {
    console.error("[pool interest] durable engage intent lookup failed", intentError ?? intentRow);
    return { kind: "retryable", error: "자동응대 처리 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
  if (intent.kind === "conflict") {
    return { kind: "conflict", error: "이미 다른 요청에 사용된 자동응대 정보예요." };
  }
  if (intent.kind === "completed") {
    return { kind: "completed", outcome: intent.outcome };
  }
  if (intent.kind === "missing") {
    if (!params.allowHistoricalMissing) {
      return { kind: "retryable", error: "자동응대 요청을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." };
    }
    // 새 의도 원장 도입 전 action은 기존 outbox가 있을 때만 finalize/불명 상태를 복구한다.
    // 최초 모드·시간대 근거가 없으므로 새 SMS를 추측 발송하지 않는다.
    const historicalRecovery = await recoverInterestEngage({
      supabase: params.supabase,
      jobId: params.jobId,
      applicantId: params.applicantId,
      actionKey: params.actionKey,
    });
    if (historicalRecovery?.action === "sent_unfinalized") {
      return { kind: "retryable", error: "문자 기록 복구를 마치지 못했어요. 잠시 후 다시 시도해 주세요." };
    }
    return { kind: "completed", outcome: historicalRecovery?.action ?? "none" };
  }

  let outcome: EngageOutcome | null = null;
  let outcomeKey = "";
  let engageNote = "";

  if (intent.intent === "auto_queue") {
    outcomeKey = intent.queueCreated ? "queued" : "queue_skipped";
    engageNote = intent.queueCreated
      ? "🌙 야간 클릭 — 아침 자동응대 예약이 저장됐어요. 발송 직전 전역 모드와 후보 상태를 다시 확인합니다."
      : "이미 진행 중인 후보 — 야간 자동응대 예약을 추가하지 않았어요.";
  } else if (intent.intent === "off") {
    outcome = { action: "off" };
  } else if (intent.intent === "draft") {
    outcome = await runInterestEngage({
      supabase: params.supabase,
      jobId: params.jobId,
      applicantId: params.applicantId,
      mode: "draft",
      source: "interest_click",
      actionKey: params.actionKey,
    });
  } else {
    const recovery = await recoverInterestEngage({
      supabase: params.supabase,
      jobId: params.jobId,
      applicantId: params.applicantId,
      actionKey: params.actionKey,
    });
    if (recovery) {
      outcome = recovery;
    } else {
      const currentMode = await getAgentMode(params.supabase);
      if (currentMode === "auto" && isNightKst()) {
        // 주간 요청 복구가 야간까지 늦어졌다면 SMS를 보내지 않고 원장+후보 큐를 원자 전환한다.
        const { data: deferred, error: deferError } = await params.supabase.rpc(
          "defer_pool_interest_engage_intent",
          {
            p_action_key: params.actionKey,
            p_applicant_id: params.applicantId,
            p_job_id: params.jobId,
          },
        );
        if (deferError || (deferred !== "queued" && deferred !== "not_queued")) {
          console.error("[pool interest] engage intent night deferral failed", deferError ?? deferred);
          return { kind: "retryable", error: "야간 자동응대 예약을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." };
        }
        outcomeKey = deferred === "queued" ? "queued" : "queue_skipped";
        engageNote = deferred === "queued"
          ? "🌙 처리 재개 시각이 야간이라 SMS 대신 아침 자동응대 예약을 저장했어요."
          : "후보 상태가 이미 변경되어 야간 자동응대 예약을 추가하지 않았어요.";
      } else {
        outcome = await runInterestEngage({
          supabase: params.supabase,
          jobId: params.jobId,
          applicantId: params.applicantId,
          mode: currentMode,
          source: "interest_click",
          actionKey: params.actionKey,
        });
      }
    }
  }

  if (outcome) {
    outcomeKey = interestOutcomeKey(outcome);
    engageNote = engageOutcomeLabel(outcome);
    if (!shouldCompletePoolInterestEngageIntent(outcome)) {
      if (outcome.action === "sent_unfinalized") {
        const title = params.jobTitle ?? "해당";
        const baseSlack = interestSlackBase({
          applicantName: params.applicantName,
          jobTitle: title,
          immediate: params.immediate,
        });
        await sendSlackText(`${baseSlack}\n${engageNote}`).catch(() => false);
      }
      return { kind: "retryable", error: "자동응대 처리가 진행 중이에요. 잠시 후 다시 시도해 주세요." };
    }
  }

  let jobTitle = params.jobTitle;
  if (!jobTitle) {
    const { data: titleRow } = await params.supabase
      .from("jobs")
      .select("title")
      .eq("id", params.jobId)
      .maybeSingle();
    jobTitle = typeof titleRow?.title === "string" ? titleRow.title : "해당";
  }
  const baseSlack = interestSlackBase({
    applicantName: params.applicantName,
    jobTitle,
    immediate: params.immediate,
  });
  await sendSlackText(engageNote ? `${baseSlack}\n${engageNote}` : baseSlack).catch(() => false);

  const { data: completion, error: completionError } = await params.supabase.rpc(
    "complete_pool_interest_engage_intent",
    {
      p_action_key: params.actionKey,
      p_applicant_id: params.applicantId,
      p_job_id: params.jobId,
      p_outcome: outcomeKey,
    },
  );
  if (completionError || (completion !== "recorded" && completion !== "deduped")) {
    console.error("[pool interest] engage intent completion failed", completionError ?? completion);
    return { kind: "retryable", error: "자동응대 처리 결과를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." };
  }
  return { kind: "completed", outcome: outcomeKey };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const routeParams = await params;
  const token = routeParams.token;
  if (!UUID_RE.test(token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const jobId = Number(body?.job_id);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "job_id 필수" }, { status: 400 });
  }
  const actionId = body?.action_id;
  if (!isPoolActionId(actionId)) {
    return NextResponse.json({ error: "요청 정보를 다시 확인해 주세요." }, { status: 400 });
  }
  // '오늘이나 내일부터 가능' 후속 버튼 — 관심 표시보다 강한 가용성 신호.
  // 여전히 '가능 의사 수집'일 뿐 확정 아님 (확정 뉘앙스 금지).
  const immediate = body?.immediate === true;
  const switchFocus = req.nextUrl.pathname.endsWith("/focus");
  const interestOnly = body?.interest_only === true;
  if ((switchFocus && (immediate || interestOnly)) || (body?.interest_only != null && typeof body.interest_only !== "boolean")) {
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

  const successResponse = async (outcome: string, deduped: boolean) => {
    if (!switchFocus) return NextResponse.json({ success: true, deduped, engage_recovery: outcome });
    const { data: current, error } = await supabase.from("applicants")
      .select("conversation_focus_job_id, conversation_focus_action_key").eq("id", applicant.id).maybeSingle();
    if (error || !current) return NextResponse.json({ error: "현재 대화 공고를 확인하지 못했어요. 다시 확인해 주세요." }, { status: 503 });
    // 오래된 요청을 재시도해도 이전 공고를 현재 공고처럼 표시하지 않는다.
    return NextResponse.json({ success: true, deduped, focus_job_id: current.conversation_focus_job_id === jobId ? jobId : null, engage: current.conversation_focus_action_key === actionId ? outcome : "superseded" });
  };

  // 완료된 동일 요청은 공고의 현재 모집 상태보다 먼저 확인한다. 응답 유실 뒤 공고가
  // 마감되어도 같은 action_id 재시도는 성공으로 복구되어야 한다.
  const { data: replayRow, error: replayError } = await supabase
    .from("pool_events")
    .select("applicant_id, job_id, event_type, meta")
    .eq("action_key", actionId)
    .maybeSingle();
  const replay = poolActionReplayDecision(replayRow, replayError, {
    applicantId: applicant.id as number,
    jobId,
    eventType: "interest_click",
    immediate,
  });
  if (replay === "retryable") {
    console.error("[pool interest] replay lookup failed", replayError);
    return NextResponse.json(
      { error: "관심 요청을 확인하지 못했어요. 잠시 후 다시 시도해 주세요." },
      { status: 503 },
    );
  }
  const replayMeta = replayRow?.meta as { conversation_focus?: boolean; interest_only?: boolean } | null;
  if (replay === "conflict" || (replay === "deduped" && (
    (replayMeta?.conversation_focus === true) !== switchFocus || (replayMeta?.interest_only === true) !== interestOnly
  ))) {
    return NextResponse.json({ error: "이미 다른 요청에 사용된 요청 정보예요." }, { status: 409 });
  }
  if (replay === "deduped") {
    const resumed = await resumeInterestEngageIntent({
      supabase,
      actionKey: actionId,
      applicantId: applicant.id as number,
      applicantName: applicant.name as string | null,
      jobId,
      immediate,
      allowHistoricalMissing: true,
    });
    if (resumed.kind === "retryable") {
      return NextResponse.json({ error: resumed.error }, { status: 503 });
    }
    if (resumed.kind === "conflict") {
      return NextResponse.json({ error: resumed.error }, { status: 409 });
    }
    return successResponse(resumed.outcome, true);
  }

  const { data: job } = await supabase
    .from("jobs")
    // 반경 축 판정 재료 — 게이트가 pool GET과 같은 컬럼을 봐야 한다(빠지면 카드는 보이는데 클릭만 400).
    .select(`id, title, status, closes_at, recruit_mode, exposure, exposure_rule, ${EXPOSURE_JOB_GEO_COLUMNS}`)
    .eq("id", jobId)
    .maybeSingle();
  // pull 노출 대상(internal·both)이 아니면 접근 거부 — GET에서 안 보이는 공고에 관심 표시가 새는 걸 막는다.
  const pullExposed = job?.recruit_mode === "internal" || job?.recruit_mode === "both";
  const closed =
    !job ||
    !pullExposed ||
    String(job.title).startsWith("__") ||
    isJobEffectivelyClosed(job.status as string | null, job.closes_at as string | null);
  if (closed) {
    return NextResponse.json({ error: "모집이 마감된 공고예요" }, { status: 400 });
  }

  // 지정 노출(targeted) 게이팅 — 이 지원자가 노출 대상이 아니면 GET과 동일하게 불투명 400(공고 존재 숨김).
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
        return NextResponse.json({ error: "모집이 마감된 공고예요" }, { status: 400 });
      }
    } catch (e) {
      console.error("[pool interest] exposure gate load failed — 거부(fail-closed)", e);
      return NextResponse.json({ error: "모집이 마감된 공고예요" }, { status: 400 });
    }
  }

  const mode = await getAgentMode(supabase);
  const engageIntent = poolInterestEngageIntentFor(mode, isNightKst());

  // 후보 연결·휴면 후보 재부상·명시 가용성·이벤트·후속 자동응대 의도를 한 트랜잭션으로 저장한다.
  // auto_queue는 이 RPC 안에서 engage_queued_at까지 설정하므로 커밋 직후 런타임이 종료돼도 예약이 남는다.
  const { data: durableData, error: durableError } = await supabase.rpc(
    switchFocus ? "select_pool_conversation_focus" : interestOnly ? "record_pool_interest_only" : "record_pool_interest_with_engage_intent",
    {
      p_job_id: jobId,
      p_applicant_id: applicant.id as number,
      p_action_key: actionId,
      ...(!switchFocus ? { p_immediate: immediate } : {}),
      ...(!interestOnly ? { p_engage_intent: engageIntent } : {}),
    },
  );
  if (durableData === "busy") {
    return NextResponse.json({ error: "이전 문자 처리를 확인 중이에요. 잠시 후 다시 확인해 주세요." }, { status: 409 });
  }
  if (durableError?.code === "23505") {
    return NextResponse.json({ error: "이미 다른 요청에 사용된 요청 정보예요." }, { status: 409 });
  }
  if (switchFocus && durableData === "unavailable") {
    return NextResponse.json({ error: "지금은 이 공고로 대화를 바꿀 수 없어요. 담당자에게 문의해 주세요." }, { status: 409 });
  }
  const durable = poolDurableActionDecision(durableData, durableError);
  if (durable.kind === "retryable") {
    console.error("[pool interest] atomic write failed", durableError ?? durableData);
    return NextResponse.json(
      { error: "관심을 저장하지 못했어요. 잠시 후 다시 시도해 주세요." },
      { status: 503 },
    );
  }
  if (durable.kind === "unavailable") {
    return NextResponse.json({ error: "모집이 마감된 공고예요" }, { status: 400 });
  }
  if (durable.kind === "unchanged_closed") {
    return NextResponse.json(
      { error: "이 공고의 이전 처리 결과가 유지되어 검토 목록에 다시 추가하지 않았어요." },
      { status: 409 },
    );
  }
  const resumed = await resumeInterestEngageIntent({
    supabase,
    actionKey: actionId,
    applicantId: applicant.id as number,
    applicantName: applicant.name as string | null,
    jobId,
    jobTitle: job.title as string,
    immediate,
    allowHistoricalMissing: durable.kind === "deduped",
  });
  if (resumed.kind === "retryable") {
    return NextResponse.json({ error: resumed.error }, { status: 503 });
  }
  if (resumed.kind === "conflict") {
    return NextResponse.json({ error: resumed.error }, { status: 409 });
  }
  return successResponse(resumed.outcome, durable.kind === "deduped");
}
