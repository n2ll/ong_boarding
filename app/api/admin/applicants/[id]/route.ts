import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

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
]);

const VALID_STATUS = new Set([
  "스크리닝 전",
  "스크리닝 중",
  "스크리닝 완료",
  "기타",
  "확정인력",
  "대기자",
  "부적합",
  "이탈",
]);

const VALID_SLOT = new Set(["평일오전", "평일오후", "주말오전", "주말오후"]);

// 온보딩 통화 상태 — UI(ApplicantDetailPanel) select 옵션과 동일 집합.
// TEXT 자유입력 시절 쌓인 쓰레기값('o', 'o 10:00', '전화완료' 등) 재유입 방지.
// null/빈값(미지정)은 허용.
const VALID_CALL_STATUS = new Set([
  "미실시",
  "통화 완료",
  "부재중",
  "예정",
  "카톡대체",
]);

// 콤마로 구분된 confirmed_slot 값 검증 — 각 토큰이 VALID_SLOT에 포함돼야 함.
function isValidConfirmedSlot(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const tokens = v.split(",").map((t) => t.trim()).filter(Boolean);
  return tokens.every((t) => VALID_SLOT.has(t));
}

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

  // status를 확정인력/대기자로 바꿀 때 confirmed_branch가 비어 있으면 branch1로 자동 채움.
  // 매니저가 지원자 목록에서 status만 인라인 변경했을 때 PPC 매트릭스/상세에 안 보이는 문제 방지.
  if (updates.status === "확정인력" || updates.status === "대기자") {
    if (!("confirmed_branch" in updates)) {
      const { data: cur } = await supabase
        .from("applicants")
        .select("confirmed_branch, branch1")
        .eq("id", id)
        .single();
      if (cur && !cur.confirmed_branch && cur.branch1) {
        updates.confirmed_branch = cur.branch1;
      }
    }
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

  return NextResponse.json({ success: true, data });
}
