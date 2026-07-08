/**
 * /api/admin/interest-queue
 *
 * pull 채널 '관심 있음' 클릭으로 생겨난, 아직 매니저가 응대하지 않은 후보 큐.
 * 인증은 middleware의 /api/admin/* Basic Auth에 위임.
 *
 * GET  → 대기 큐 조회.
 *   대상: 시스템 공고(__ 접두) 제외, 관심클릭 유래 후보(agent_stage IS NULL),
 *         아직 처리 안 함(contacted_at IS NULL), 이미 처리된 지원자 제외
 *         (status NOT IN 확정인력·부적합·이탈).
 *   각 (applicant_id, job_id)의 최신 interest_click pool_event에서 interested_at·immediate 산출
 *   (meta.immediate='true' 또는 availability='즉시가능'이면 immediate).
 *   정렬: immediate desc, interested_at desc.
 *
 * POST → 액션. body { candidate_id, action: 'contacted' | 'dismiss' }.
 *   'contacted': contacted_at = now() (큐에서 빠짐, 스테이지 변화 없음 — 수동 컨택).
 *   'dismiss'  : contacted_at = now() AND agent_stage='abort' (보류/제외).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const PROCESSED_STATUSES = ["확정인력", "부적합", "이탈"];

export async function GET() {
  const supabase = createServiceClient();

  // 관심클릭 유래 & 미처리 후보 — jobs/applicants 조인해 시스템 공고·이미 처리된 지원자 제외.
  const { data: rows, error } = await supabase
    .from("job_candidates")
    .select(
      "id, job_id, applicant_id, " +
        "jobs!inner(id, title), " +
        "applicants!inner(id, name, phone, availability, sms_opt_out_at, status)"
    )
    .is("agent_stage", null)
    .is("contacted_at", null);

  if (error) {
    console.error("[interest-queue GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  type JoinRow = {
    id: number;
    job_id: number;
    applicant_id: number;
    jobs: { id: number; title: string | null } | null;
    applicants: {
      id: number;
      name: string | null;
      phone: string | null;
      availability: string | null;
      sms_opt_out_at: string | null;
      status: string | null;
    } | null;
  };

  // 시스템 공고(__ 접두)·이미 처리된 지원자를 클라이언트에서 배제.
  const candidates = ((rows ?? []) as unknown as JoinRow[]).filter((r) => {
    const title = r.jobs?.title ?? "";
    const status = r.applicants?.status ?? "";
    return !title.startsWith("__") && !PROCESSED_STATUSES.includes(status);
  });

  // 최신 interest_click pool_event 매핑 — 대상 (applicant_id, job_id)들을 한 번에 조회.
  const applicantIds = [...new Set(candidates.map((c) => c.applicant_id))];
  const jobIds = [...new Set(candidates.map((c) => c.job_id))];
  const clickByKey = new Map<string, { created_at: string; immediate: boolean }>();

  if (applicantIds.length > 0 && jobIds.length > 0) {
    const { data: events, error: evErr } = await supabase
      .from("pool_events")
      .select("applicant_id, job_id, created_at, meta")
      .eq("event_type", "interest_click")
      .in("applicant_id", applicantIds)
      .in("job_id", jobIds)
      .order("created_at", { ascending: false });
    if (evErr) {
      console.error("[interest-queue GET] pool_events", evErr);
      return NextResponse.json({ error: evErr.message }, { status: 500 });
    }
    // created_at desc 정렬이므로 각 키의 첫 등장이 최신.
    for (const ev of events ?? []) {
      const key = `${ev.applicant_id}:${ev.job_id}`;
      if (clickByKey.has(key)) continue;
      const meta = ev.meta as { immediate?: unknown } | null;
      clickByKey.set(key, {
        created_at: ev.created_at as string,
        immediate: meta?.immediate === true || meta?.immediate === "true",
      });
    }
  }

  const items = candidates.map((c) => {
    const click = clickByKey.get(`${c.applicant_id}:${c.job_id}`);
    const availability = c.applicants?.availability ?? null;
    const immediate = (click?.immediate ?? false) || availability === "즉시가능";
    return {
      candidate_id: c.id,
      applicant_id: c.applicant_id,
      name: c.applicants?.name ?? null,
      phone: c.applicants?.phone ?? null,
      availability,
      sms_opt_out_at: c.applicants?.sms_opt_out_at ?? null,
      job_id: c.job_id,
      job_title: c.jobs?.title ?? "",
      interested_at: click?.created_at ?? null,
      immediate,
    };
  });

  // 정렬: immediate desc, interested_at desc (null은 뒤).
  items.sort((a, b) => {
    if (a.immediate !== b.immediate) return a.immediate ? -1 : 1;
    const at = a.interested_at ? Date.parse(a.interested_at) : 0;
    const bt = b.interested_at ? Date.parse(b.interested_at) : 0;
    return bt - at;
  });

  return NextResponse.json({
    items,
    count: items.length,
    immediate_count: items.filter((i) => i.immediate).length,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const candidateId = Number(body?.candidate_id);
  const action: unknown = body?.action;

  if (!Number.isFinite(candidateId)) {
    return NextResponse.json({ error: "candidate_id must be a number" }, { status: 400 });
  }
  if (action !== "contacted" && action !== "dismiss") {
    return NextResponse.json({ error: `invalid action: ${String(action)}` }, { status: 400 });
  }

  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const updates: Record<string, unknown> = { contacted_at: now };
  if (action === "dismiss") {
    updates.agent_stage = "abort";
  }

  const { data: updated, error } = await supabase
    .from("job_candidates")
    .update(updates)
    .eq("id", candidateId)
    .select("id");

  if (error) {
    console.error("[interest-queue POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "candidate not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
