import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import {
  VALID_STATUS,
  VALID_CALL_STATUS,
  VALID_AVAILABILITY,
  isValidConfirmedSlot,
} from "@/lib/admin/applicant-validation";

export const dynamic = "force-dynamic";

// GET /api/admin/applicants/[id]
// 통합 지원자 상세 패널용 — applicant 전체 + 연결된 job_candidates(공고/지점/화주사) 집계.
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: applicant, error } = await supabase
    .from("applicants")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!applicant) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // 연결된 공고 지원 내역 (없으면 '순수 인재풀')
  const { data: rawCands } = await supabase
    .from("job_candidates")
    .select(
      `id, job_id, agent_stage, agent_state, paused_reason,
       sent_at, responded_at, confirmed_at, activated_at, closed_at, closed_reason, created_at,
       jobs:job_id ( id, title, branch, client_id, status )`
    )
    .eq("applicant_id", id)
    .order("created_at", { ascending: false });

  const cands = rawCands ?? [];

  // 화주사 이름 매핑 (jobs.client_id → clients.name)
  const clientIds = Array.from(
    new Set(
      cands
        .map((c) => (c.jobs as unknown as { client_id?: number | null } | null)?.client_id)
        .filter((v): v is number => typeof v === "number")
    )
  );
  const clientNameById = new Map<number, string>();
  if (clientIds.length > 0) {
    const { data: clients } = await supabase
      .from("clients")
      .select("id, name")
      .in("id", clientIds);
    for (const cl of clients ?? []) {
      clientNameById.set(cl.id as number, cl.name as string);
    }
  }

  const candidates = cands.map((c) => {
    const job = c.jobs as unknown as
      | { id: number; title: string; branch: string | null; client_id: number | null; status: string }
      | null;
    return {
      id: c.id,
      job_id: c.job_id,
      agent_stage: c.agent_stage,
      agent_state: c.agent_state,
      paused_reason: c.paused_reason,
      sent_at: c.sent_at,
      responded_at: c.responded_at,
      confirmed_at: c.confirmed_at,
      activated_at: c.activated_at,
      closed_at: c.closed_at,
      closed_reason: c.closed_reason,
      created_at: c.created_at,
      job_title: job?.title ?? null,
      job_branch: job?.branch ?? null,
      job_status: job?.status ?? null,
      client_id: job?.client_id ?? null,
      client_name:
        job?.client_id != null ? clientNameById.get(job.client_id) ?? null : null,
    };
  });

  return NextResponse.json({ applicant, candidates });
}

// 매니저가 수정 가능한 모든 컬럼 (시스템 컬럼: id/created_at/churned_at/last_message_at/
// unread_count/lat/lng/sido/sigungu/bname/road_address/marketing_consent_at 등은 제외).
const ALLOWED_FIELDS = new Set([
  "name", "phone", "birth_date", "location",
  "own_vehicle", "license_type", "vehicle_type",
  "branch1", "branch2", "branch",
  "work_hours", "available_date", "self_ownership",
  "introduction", "experience",
  "source", "status", "filter_pass", "note", "memo",
  "start_date", "confirmed_slot", "confirmed_branch", "current_branch",
  "churn_reason", "screening", "sort_order",
  "marketing_consent", "kakao_channel_friend",
  // PPC 상세 페이지에서 매니저가 편집하는 필드
  "baemin_id", "guide_sent", "onboarding_call_status",
  // 가용성 축 (Phase B) — availability_updated_at은 서버가 자동 기록하므로 제외
  "availability", "line_experience",
  // 수신거부 수동 등록/해제 (ISO string | null) — 변경 시 pool_events(opt_out_set/cleared) 기록
  "sms_opt_out_at",
]);

// 검증 상수·헬퍼는 벌크 라우트(bulk-status)와 공유 — lib/admin/applicant-validation.ts

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const body = await req.json();
  const updates: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_FIELDS.has(key)) continue;

    if (key === "status" && value && !VALID_STATUS.has(value as string)) {
      return NextResponse.json(
        { error: `invalid status: ${value}` },
        { status: 400 }
      );
    }
    if (key === "confirmed_slot" && value && !isValidConfirmedSlot(value)) {
      return NextResponse.json(
        { error: `invalid confirmed_slot: ${value}` },
        { status: 400 }
      );
    }
    if (key === "onboarding_call_status" && value && !VALID_CALL_STATUS.has(value as string)) {
      return NextResponse.json(
        { error: `invalid onboarding_call_status: ${value}` },
        { status: 400 }
      );
    }
    if (key === "availability" && value && !VALID_AVAILABILITY.has(value as string)) {
      return NextResponse.json(
        { error: `invalid availability: ${value}` },
        { status: 400 }
      );
    }
    if (
      key === "sms_opt_out_at" &&
      value != null &&
      value !== "" &&
      (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    ) {
      return NextResponse.json(
        { error: "invalid sms_opt_out_at: ISO string 또는 null" },
        { status: 400 }
      );
    }
    updates[key] = value === "" ? null : value;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "no updatable fields" },
      { status: 400 }
    );
  }

  // 부적합/이탈로 전환 시 current_branch 비우고 churned_at 자동 기록.
  // (부적합 = 자격 미달로 탈락, 이탈 = 근무 중이었다가 그만둠. 둘 다 활성 풀에서 빠진다)
  if (updates.status === "부적합" || updates.status === "이탈") {
    updates.current_branch = null;
    updates.churned_at = new Date().toISOString();
  }

  const supabase = createServiceClient();

  // 이전 상태가 필요한 자동 기록(확정지점 채움·확정 시각·가용성 이벤트)은 1회 조회로 해결.
  const needPrev =
    updates.status === "확정인력" || updates.status === "대기자" ||
    "availability" in updates || "sms_opt_out_at" in updates;
  let prev: {
    status: string | null;
    hired_at: string | null;
    confirmed_branch: string | null;
    branch1: string | null;
    availability: string | null;
    current_job_id: number | null;
    line_experience: string[] | null;
    sms_opt_out_at: string | null;
  } | null = null;
  if (needPrev) {
    const { data: cur } = await supabase
      .from("applicants")
      .select("status, hired_at, confirmed_branch, branch1, availability, current_job_id, line_experience, sms_opt_out_at")
      .eq("id", id)
      .single();
    prev = cur ?? null;
  }

  // status를 확정인력/대기자로 바꿀 때 confirmed_branch가 비어 있으면 branch1로 자동 채움.
  // 매니저가 지원자 목록에서 status만 인라인 변경했을 때 PPC 매트릭스/상세에 안 보이는 문제 방지.
  if (
    (updates.status === "확정인력" || updates.status === "대기자") &&
    !("confirmed_branch" in updates) &&
    prev && !prev.confirmed_branch && prev.branch1
  ) {
    updates.confirmed_branch = prev.branch1;
  }

  // 매니저 확정 시각 — status가 처음 '확정인력'이 될 때 1회 기록 (churned_at 자동 기록과 대칭).
  // TTF(요청→확정 리드타임) 측정 기반. 이미 값이 있으면 유지(재확정으로 덮지 않음).
  if (updates.status === "확정인력" && prev && prev.status !== "확정인력" && !prev.hired_at) {
    updates.hired_at = new Date().toISOString();
  }

  // 라인 경험 자동 태깅 — 확정으로 전환될 때 진행 공고 제목을 append (§6.2: 벤치는 라인 단위, 수기 태깅 금지)
  if (updates.status === "확정인력" && prev && prev.status !== "확정인력" && prev.current_job_id) {
    const { data: job } = await supabase
      .from("jobs")
      .select("title")
      .eq("id", prev.current_job_id)
      .maybeSingle();
    const title = ((job?.title as string | null) ?? "").trim();
    if (title && !title.startsWith("__")) {
      const existing = prev.line_experience ?? [];
      if (!existing.includes(title)) {
        updates.line_experience = [...existing, title];
      }
    }
  }

  // 가용성은 값이 같아도 "재확인" 자체가 신선도 신호 — 갱신 시각은 서버가 항상 기록.
  if ("availability" in updates) {
    updates.availability_updated_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("applicants")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[applicant PATCH error]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 가용성 변경 이력 — pool_events 기록 (신선도·신뢰 점수 근거, 실패해도 응답은 성공 유지)
  if ("availability" in updates && prev && prev.availability !== updates.availability) {
    const { error: evErr } = await supabase.from("pool_events").insert({
      applicant_id: id,
      event_type: "availability_set",
      meta: { from: prev.availability, to: updates.availability, source: "manual" },
    });
    if (evErr) console.error("[applicant PATCH] pool_events insert failed", evErr);
  }

  // 수신거부 수동 등록/해제 이력 — pool_events 기록 (실패해도 응답은 성공 유지)
  if ("sms_opt_out_at" in updates && prev) {
    const wasOptOut = prev.sms_opt_out_at != null;
    const isOptOut = updates.sms_opt_out_at != null;
    if (wasOptOut !== isOptOut) {
      const { error: evErr } = await supabase.from("pool_events").insert({
        applicant_id: id,
        event_type: isOptOut ? "opt_out_set" : "opt_out_cleared",
        meta: { by: "manager" },
      });
      if (evErr) console.error("[applicant PATCH] pool_events opt_out insert failed", evErr);
    }
  }

  return NextResponse.json({ success: true, data });
}
