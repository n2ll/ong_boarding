/**
 * POST /api/pool/[token]/interest — pull 페이지 '관심 있음' 클릭.
 *
 * 하는 일 (확정 뉘앙스 금지 — 관심 표시는 '가능 의사 수집'일 뿐, 배정·확정은 매니저):
 *   1. job_candidates upsert — 매니저 파이프라인/공고 보드에 후보로 노출 (발송은 dispatch에서)
 *   2. availability 갱신 — '즉시가능'이 아니면 '이번주가능'으로 (강한 신호를 약한 신호로 강등하지 않음)
 *   3. pool_events(interest_click / availability_set) 기록 — 신선도·신뢰 점수 근거
 *   4. 자동 응대(auto-engage) — 전역 3단 모드 준수(off=발송 없음 / draft=수동 유도 / auto=첫 문자
 *      발송 + screening 진입). 야간(KST 21~08시) 클릭은 engage_queued_at에 예약만 하고
 *      아침 9시 cron(/api/admin/cron/engage-queued)이 발송한다. 로직은 lib/agent/engage.ts.
 *   5. Slack 알림 — 자동 응대 결과 병기, 매니저가 후속 처리를 결정
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { sendSlackText } from "@/lib/slack";
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
  hasEngageMessage,
  isNightKst,
  runInterestEngage,
} from "@/lib/agent/engage";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const token = params.token;
  if (!UUID_RE.test(token)) {
    return NextResponse.json({ error: "invalid token" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const jobId = Number(body?.job_id);
  if (!Number.isFinite(jobId)) {
    return NextResponse.json({ error: "job_id 필수" }, { status: 400 });
  }
  // '바로(내일부터) 시작 가능' 후속 버튼 — 관심 표시보다 강한 가용성 신호.
  // 여전히 '가능 의사 수집'일 뿐 확정 아님 (확정 뉘앙스 금지).
  const immediate = body?.immediate === true;

  const supabase = createServiceClient();

  const { data: applicant } = await supabase
    .from("applicants")
    .select("id, name, availability, sido, applied_at, created_at")
    .eq("access_token", token)
    .maybeSingle();
  if (!applicant) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: job } = await supabase
    .from("jobs")
    .select("id, title, status, closes_at, recruit_mode, exposure, exposure_rule")
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
        availability: (applicant as { availability?: string | null }).availability ?? null,
        applied_at: (applicant as { applied_at?: string | null }).applied_at ?? null,
        created_at: (applicant as { created_at?: string | null }).created_at ?? null,
        suntopDone,
      };
      if (!isExposed(exA, normalizeRule((job as { exposure_rule?: unknown }).exposure_rule), overrides.get(jobId))) {
        return NextResponse.json({ error: "모집이 마감된 공고예요" }, { status: 400 });
      }
    } catch (e) {
      console.error("[pool interest] exposure gate load failed — 거부(fail-closed)", e);
      return NextResponse.json({ error: "모집이 마감된 공고예요" }, { status: 400 });
    }
  }

  // 1) 후보 연결 (이미 있으면 무시 — 중복 클릭 안전)
  const { error: jcErr } = await supabase
    .from("job_candidates")
    .upsert([{ job_id: jobId, applicant_id: applicant.id }], {
      onConflict: "job_id,applicant_id",
      ignoreDuplicates: true,
    });
  if (jcErr) {
    console.error("[pool interest] jc upsert failed", jcErr);
    return NextResponse.json({ error: "처리 실패" }, { status: 500 });
  }

  // 1b) 재관심 재부상 — 관심 처리 큐는 agent_stage IS NULL + contacted_at IS NULL로 잡는다.
  // 매니저가 이미 [컨택 완료](contacted_at 기록)나 [보류](abort)한 뒤 지원자가 다시 관심을 누르면
  // ignoreDuplicates 때문에 기존 행이 그대로 남아 큐에서 안 보인다. 휴면 상태(stage NULL 또는 abort)인
  // 후보만 contacted_at를 비우고 abort를 해제해 재부상시킨다. 진행 중(screening/exploration/active)
  // 후보는 이미 파이프라인에서 처리 중이므로 건드리지 않는다.
  const { error: resurfaceErr } = await supabase
    .from("job_candidates")
    .update({
      contacted_at: null,
      agent_stage: null,
    })
    .eq("job_id", jobId)
    .eq("applicant_id", applicant.id)
    .or("agent_stage.is.null,agent_stage.eq.abort");
  if (resurfaceErr) console.error("[pool interest] resurface failed", resurfaceErr);

  // 2) 가용성 갱신 — 관심 클릭은 '이번 주 일할 의사', '바로 가능' 버튼은 '즉시 투입 가능' 프록시
  const prevAvailability = applicant.availability as string | null;
  const nextAvailability = immediate
    ? "즉시가능"
    : prevAvailability === "즉시가능"
      ? "즉시가능"
      : "이번주가능";
  const { error: avErr } = await supabase
    .from("applicants")
    .update({ availability: nextAvailability, availability_updated_at: new Date().toISOString() })
    .eq("id", applicant.id);
  if (avErr) console.error("[pool interest] availability update failed", avErr);

  // 3) 이벤트 기록 (non-fatal)
  const events: { applicant_id: number; job_id?: number; event_type: string; meta?: unknown }[] = [
    {
      applicant_id: applicant.id as number,
      job_id: jobId,
      event_type: "interest_click",
      meta: immediate ? { immediate: true } : undefined,
    },
  ];
  if (prevAvailability !== nextAvailability) {
    events.push({
      applicant_id: applicant.id as number,
      event_type: "availability_set",
      meta: { from: prevAvailability, to: nextAvailability, source: "pull", immediate },
    });
  }
  const { error: evErr } = await supabase.from("pool_events").insert(events);
  if (evErr) console.error("[pool interest] pool_events insert failed", evErr);

  // 4) 자동 응대(auto-engage) — 실패해도 관심 표시(1~3)는 성공 처리, 부가 동작이다 (non-fatal).
  //    가드·발송·기록은 runInterestEngage(lib/agent/engage.ts)가 담당.
  let engageNote = "";
  try {
    const mode = await getAgentMode(supabase);
    if (mode === "auto" && isNightKst()) {
      // 야간(KST 21~08시) 클릭 — 즉시 발송 대신 예약. 아침 9시 cron이 가드 재검사 후 발송.
      if (await hasEngageMessage(supabase, jobId, applicant.id as number)) {
        engageNote = "이미 이 공고 안내 문자를 받은 후보 — 중복 발송 방지로 생략.";
      } else {
        const { data: queued, error: qErr } = await supabase
          .from("job_candidates")
          .update({ engage_queued_at: new Date().toISOString() })
          .eq("job_id", jobId)
          .eq("applicant_id", applicant.id)
          .is("agent_stage", null) // 진행 중 후보에겐 예약하지 않는다
          .select("id");
        if (qErr) {
          console.error(
            "[pool interest] engage queue failed (docs/migrations/2026-07-jc-engage-queued.sql 적용 확인)",
            qErr
          );
        } else if ((queued?.length ?? 0) > 0) {
          engageNote = "🌙 야간 클릭 — 내일 아침 9시(KST) AI 첫 문자 발송 예약됨.";
        } else {
          engageNote = "이미 진행 중인 후보 — 자동 발송 생략.";
        }
      }
    } else if (mode !== "off") {
      // 주간 auto 즉시 발송 / draft는 시간대와 무관하게 수동 유도(초안 불가 — 인바운드 없음)
      const outcome = await runInterestEngage({
        supabase,
        jobId,
        applicantId: applicant.id as number,
        mode,
        source: "interest_click",
      });
      engageNote = engageOutcomeLabel(outcome);
    }
  } catch (e) {
    console.error("[pool interest] auto-engage failed (non-fatal)", e);
  }

  // 5) 매니저 알림 (non-fatal) — 자동 응대 결과 병기
  const baseSlack = immediate
    ? `⚡ *바로 시작 가능* — ${applicant.name ?? "이름 미상"}님이 '${job.title}' 공고에 "바로 시작 가능"이라고 답했어요.\n우선 컨택 후보입니다 — 파이프라인에서 확인해주세요.`
    : `💡 *맞춤 공고 관심 표시* — ${applicant.name ?? "이름 미상"}님이 '${job.title}' 공고에 관심을 표시했어요.\n파이프라인/공고 보드에서 확인 후 컨택해주세요.`;
  await sendSlackText(engageNote ? `${baseSlack}\n${engageNote}` : baseSlack).catch(() => false);

  return NextResponse.json({ success: true });
}
