/**
 * POST /api/pool/[token]/notify — 마감된 공고 카드의 "다음 급구 때 먼저 알려주세요" 클릭.
 *
 * 놓친 지원자를 자산화하는 두 번째 수확 (확정 뉘앙스 금지 — 알림 요청은 '가능 의사 수집'일 뿐):
 *   1. availability 갱신 — '즉시가능'이 아니면 '이번주가능'으로 (강등 금지 규칙 동일)
 *   2. pool_events(notify_request / availability_set) 기록 — 다음 긴급 건의 우선 발송 목록 재료
 *   3. Slack 알림 — 매니저가 다음 웨이브 타깃으로 인지
 * 마감된 공고이므로 job_candidates는 연결하지 않는다(공고 보드 노이즈 방지).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { sendSlackText } from "@/lib/slack";
import {
  isExposed,
  normalizeRule,
  fetchOverridesForApplicant,
  fetchSuntopDone,
  type ExposureApplicant,
} from "@/lib/exposure";

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

  const supabase = createServiceClient();

  const { data: applicant } = await supabase
    .from("applicants")
    .select("id, name, availability, sido, applied_at, created_at")
    .eq("access_token", token)
    .maybeSingle();
  if (!applicant) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // 대상 검증 — GET이 '마감됨' 카드로 노출하는 조건의 거울: active 공고이면서
  // 마감시각이 지났고 3일 유예 안. (진행 중 공고·유예 경과·closed 공고는 거부 —
  // 공개 엔드포인트라 임의 job_id 주입으로 신선도 갱신·허위 Slack을 만들 수 없어야 한다)
  const GRACE_MS = 3 * 24 * 60 * 60 * 1000;
  const { data: job } = await supabase
    .from("jobs")
    .select("id, title, status, closes_at, recruit_mode, exposure, exposure_rule")
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
        availability: (applicant as { availability?: string | null }).availability ?? null,
        applied_at: (applicant as { applied_at?: string | null }).applied_at ?? null,
        created_at: (applicant as { created_at?: string | null }).created_at ?? null,
        suntopDone,
      };
      if (!isExposed(exA, normalizeRule((job as { exposure_rule?: unknown }).exposure_rule), overrides.get(jobId))) {
        return NextResponse.json({ error: "확인할 수 없는 공고예요" }, { status: 400 });
      }
    } catch (e) {
      console.error("[pool notify] exposure gate load failed — 거부(fail-closed)", e);
      return NextResponse.json({ error: "확인할 수 없는 공고예요" }, { status: 400 });
    }
  }

  // 멱등 — 이미 알림 요청한 공고면 재기록·Slack 재발송 없이 성공 반환
  const { data: dup } = await supabase
    .from("pool_events")
    .select("id")
    .eq("applicant_id", applicant.id)
    .eq("job_id", jobId)
    .eq("event_type", "notify_request")
    .limit(1);
  if (dup && dup.length > 0) {
    return NextResponse.json({ success: true, deduped: true });
  }

  // 가용성 갱신 — 알림 요청도 '이번 주 일할 의사' 프록시 (강등 금지)
  const prevAvailability = applicant.availability as string | null;
  const nextAvailability = prevAvailability === "즉시가능" ? "즉시가능" : "이번주가능";
  const { error: avErr } = await supabase
    .from("applicants")
    .update({ availability: nextAvailability, availability_updated_at: new Date().toISOString() })
    .eq("id", applicant.id);
  if (avErr) console.error("[pool notify] availability update failed", avErr);

  const events: { applicant_id: number; job_id?: number; event_type: string; meta?: unknown }[] = [
    { applicant_id: applicant.id as number, job_id: jobId, event_type: "notify_request" },
  ];
  if (prevAvailability !== nextAvailability) {
    events.push({
      applicant_id: applicant.id as number,
      event_type: "availability_set",
      meta: { from: prevAvailability, to: nextAvailability, source: "pull" },
    });
  }
  const { error: evErr } = await supabase.from("pool_events").insert(events);
  if (evErr) console.error("[pool notify] pool_events insert failed", evErr);

  await sendSlackText(
    `🔔 *다음 급구 우선 안내 요청* — ${applicant.name ?? "이름 미상"}님이 마감된 '${job.title}' 공고에서 다음 기회 알림을 요청했어요.\n다음 긴급 건 발송 시 우선 타깃입니다.`
  ).catch(() => false);

  return NextResponse.json({ success: true });
}
