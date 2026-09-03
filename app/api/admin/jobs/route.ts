/**
 * GET  /api/admin/jobs              — 공고 목록 (필터: status)
 * POST /api/admin/jobs              — 공고 신규 생성
 *
 * 사이드바 + 보드용 카운트도 같이 내려준다 (단일 쿼리 부담을 줄이기 위해 별도 view 없이 집계).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { DANGGEUN_SYSTEM_JOB_TITLE } from "@/lib/agent/danggeun-job";
import { isSystemJobTitle, isJobEffectivelyClosed, describeDbConstraintError, normalizeSlotKeys } from "@/lib/jobs";
import { geocodeAddressWithFallback } from "@/lib/kakao-geocode";
import { normalizeRule } from "@/lib/exposure";
import { jobSupportsRadius } from "@/lib/geo";
import { isReviewReadyCandidate, jobCandidateAggregateStage } from "@/lib/admin/job-operations";
import {
  resolveJobCreateRouting,
  validateJobCreateRequiredFields,
  type JobCreateBranchRoutingRow,
  type JobCreateClientRoutingRow,
} from "@/lib/admin/job-create-server-validation";
import {
  jobCreatePayloadDigest,
  jobCreateReplayDecision,
  validateJobCreateRequestId,
} from "@/lib/admin/job-create-idempotency";
import { jobCreatePersistedChannelBodies } from "@/lib/admin/job-create-draft";
import { fetchAllPostgrestRows } from "@/lib/admin/postgrest-pagination";

export const dynamic = "force-dynamic";

const RECRUIT_MODES = new Set(["external", "internal", "both"]);

type JobAggregateCandidateRow = {
  job_id: number;
  agent_stage: string | null;
  sent_at: string | null;
  responded_at: string | null;
  applicants:
    | { status?: string | null; current_job_id?: number | null }
    | { status?: string | null; current_job_id?: number | null }[]
    | null;
};

type JobInterestRow = {
  applicant_id: number | null;
  job_id: number | null;
};

const JOB_AGGREGATE_ID_CHUNK_SIZE = 250;

async function fetchJobAggregateRows<T>(
  jobIds: number[],
  label: string,
  fetchPage: (jobIdChunk: number[], from: number, to: number) => Promise<{
    data: T[] | null;
    error: { message?: string } | null;
  }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < jobIds.length; index += JOB_AGGREGATE_ID_CHUNK_SIZE) {
    const chunk = jobIds.slice(index, index + JOB_AGGREGATE_ID_CHUNK_SIZE);
    const chunkRows = await fetchAllPostgrestRows(
      (from, to) => fetchPage(chunk, from, to),
      label,
    );
    rows.push(...chunkRows);
  }
  return rows;
}

export async function GET(req: NextRequest) {
  const supabase = createServiceClient();
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status"); // active/closed/paused/all
  const clientFilter = url.searchParams.get("client_id");
  const branchFilter = url.searchParams.get("branch_id");

  let jobs;
  try {
    jobs = await fetchAllPostgrestRows(async (from, to) => {
      let query = supabase
        .from("jobs")
        .select("id, title, body, branch, branch_id, client_id, slot, slot_keys, start_date, vehicle_required, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, pay_info, policy_notes, pay_type, pay_amount, ai_facts, capacity, status, recruit_mode, site_manager_id, created_at, updated_at, closed_at, work_period, closes_at, exposure, exposure_rule, distance_basis, client:clients ( client_type, uses_slots )")
        .neq("title", DANGGEUN_SYSTEM_JOB_TITLE) // 시스템 더미 공고는 칸반에서 숨김
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });

      if (statusFilter && statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }
      if (clientFilter && /^\d+$/.test(clientFilter)) {
        query = query.eq("client_id", Number(clientFilter));
      }
      if (branchFilter && /^\d+$/.test(branchFilter)) {
        query = query.eq("branch_id", Number(branchFilter));
      }

      const result = await query.range(from, to);
      return { data: result.data, error: result.error };
    }, "공고 목록");
  } catch (error) {
    console.error("[jobs GET]", error);
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  // 공고별 후보 카운트(stage 별) — PostgREST 상한을 넘겨도 페이지 단위로 전량 조회한다.
  // 충원율은 매니저 명시 확정(applicants.status='확정인력')만 센다 — agent_stage='active'는 자동 전이라
  // '확정'이 아니다(확정은 매니저 판단, transitions.ts 참조). confirmed_count로 별도 집계해 게이지와
  // 보드의 '확정 슬롯 분포'가 같은 소스를 쓰게 한다.
  const jobIds = (jobs ?? []).map((j) => j.id);
  // 마감(실질) 공고 집합 — 확정 충원율 계상에서 제외한다. 확정은 person-level(applicants.status)이라
  // 한 지원자가 여러 공고에 링크되면 마감된 공고로도 새어 이중 계상된다(외부 충원 마감 공고에 유령 1).
  // 진행 중 공고 링크에만 확정을 계상해 게이지가 실제 투입 공고를 정확히 반영하게 한다.
  const closedJobIds = new Set(
    (jobs ?? []).filter((j) => isJobEffectivelyClosed(j.status as string | null, j.closes_at as string | null)).map((j) => j.id as number)
  );
  const stageCounts: Record<number, Record<string, number>> = {};
  const confirmedCounts: Record<number, number> = {};
  const reviewReadyCounts: Record<number, number> = {};
  const interestCounts: Record<number, number> = {};
  if (jobIds.length > 0) {
    let candidateRows: JobAggregateCandidateRow[];
    let interestRows: JobInterestRow[];
    try {
      [candidateRows, interestRows] = await Promise.all([
        fetchJobAggregateRows(jobIds, "공고 후보 집계", async (jobIdChunk, from, to) => {
          const result = await supabase
            .from("job_candidates")
            .select("id, job_id, agent_stage, sent_at, responded_at, applicants:applicant_id ( status, current_job_id )")
            .in("job_id", jobIdChunk)
            .order("id", { ascending: true })
            .range(from, to);
          return {
            data: result.data as unknown as JobAggregateCandidateRow[] | null,
            error: result.error,
          };
        }),
        fetchJobAggregateRows(jobIds, "공고 관심 집계", async (jobIdChunk, from, to) => {
          const result = await supabase
            .from("pool_events")
            .select("id, applicant_id, job_id")
            .eq("event_type", "interest_click")
            .in("job_id", jobIdChunk)
            .order("id", { ascending: true })
            .range(from, to);
          return {
            data: result.data as unknown as JobInterestRow[] | null,
            error: result.error,
          };
        }),
      ]);
    } catch (aggregateError) {
      console.error("[jobs GET] aggregate load failed", aggregateError);
      return NextResponse.json({ error: "공고 후보·관심 집계 조회 실패" }, { status: 500 });
    }

    for (const c of candidateRows) {
      const jid = c.job_id as number;
      const stage = jobCandidateAggregateStage(c.agent_stage, c.sent_at, c.responded_at);
      stageCounts[jid] ??= {};
      stageCounts[jid][stage] = (stageCounts[jid][stage] ?? 0) + 1;
      // supabase 조인은 1:1이어도 배열/객체로 올 수 있어 둘 다 방어.
      const rel = c.applicants;
      const a = Array.isArray(rel) ? rel[0] : rel;
      // 스크리닝을 마쳤지만 아직 매니저가 확정하지 않은 후보 — 공고 목록의 '후보 검토' 큐.
      // agent_stage='active'도 자동 전이일 수 있으므로 확정으로 간주하지 않는다.
      if (isReviewReadyCandidate(stage, a?.status ?? null)) {
        reviewReadyCounts[jid] = (reviewReadyCounts[jid] ?? 0) + 1;
      }
      // 확정 계상 가드: 마감 공고 링크·이탈(abort) 링크는 제외 + **확정이 이 공고에 결속됐을 때만**.
      // 확정은 사람 단위(applicants.status)라, 공고가 여럿이면 다른 라인 확정자가 이 공고에 링크만 있어도
      // (예: 맞춤 공고 링크에서 관심 클릭) 충원율이 올라가 '충원 완료 — 마감하기'가 오탐된다.
      // current_job_id는 확정 시 서버가 링크·비시스템·비마감 검증을 거쳐 박는 포인터다(applicants/[id] PATCH).
      if (
        a?.status === "확정인력" &&
        a?.current_job_id === jid &&
        stage !== "abort" &&
        !closedJobIds.has(jid)
      ) {
        confirmedCounts[jid] = (confirmedCounts[jid] ?? 0) + 1;
      }
    }
    const seen = new Set<string>();
    for (const ev of interestRows) {
      const jid = ev.job_id as number | null;
      const aid = ev.applicant_id as number | null;
      if (typeof jid !== "number" || typeof aid !== "number") continue;
      const key = `${jid}:${aid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      interestCounts[jid] = (interestCounts[jid] ?? 0) + 1;
    }
  }

  const enriched = (jobs ?? []).map((j) => ({
    ...j,
    counts: stageCounts[j.id] ?? {},
    confirmed_count: confirmedCounts[j.id] ?? 0,
    review_ready_count: reviewReadyCounts[j.id] ?? 0,
    interest_count: interestCounts[j.id] ?? 0,
  }));

  return NextResponse.json({ jobs: enriched });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const {
    title,
    body: jobBody,
    branch,
    branch_id,
    client_id,
    slot,
    slot_keys,
    start_date,
    vehicle_required,
    pickup_address,
    pickup_lat,
    pickup_lng,
    dropoff_address,
    dropoff_lat,
    dropoff_lng,
    pay_info,
    policy_notes,
    pay_type,
    pay_amount,
    ai_facts,
    capacity,
    recruit_mode,
    exposure,
    exposure_rule,
    site_manager_id,
    created_by,
    work_period,
    closes_at,
    sos_request_id,
    channel_bodies,
  } = body as {
    title?: string;
    body?: string;
    branch?: string | null;
    branch_id?: number | null;
    client_id?: number | null;
    slot?: string | null;
    slot_keys?: string[] | null;
    start_date?: string | null;
    vehicle_required?: boolean;
    pickup_address?: string | null;
    pickup_lat?: number | null;
    pickup_lng?: number | null;
    dropoff_address?: string | null;
    dropoff_lat?: number | null;
    dropoff_lng?: number | null;
    pay_info?: string | null;
    policy_notes?: string | null;
    pay_type?: string | null;
    pay_amount?: number | null;
    ai_facts?: string | null;
    capacity?: number;
    recruit_mode?: string;
    exposure?: string;
    exposure_rule?: unknown;
    site_manager_id?: number | null;
    created_by?: string | null;
    work_period?: string | null;
    closes_at?: string | null;
    sos_request_id?: number | null;
    channel_bodies?: unknown;
  };

  const validatedCreateRequestId = validateJobCreateRequestId(body.client_request_id);
  if (!validatedCreateRequestId.ok) {
    return NextResponse.json(
      { error: "공고 생성 요청 ID가 없거나 올바르지 않습니다. 새 공고 창을 다시 열어주세요." },
      { status: 400 },
    );
  }
  const createRequestId = validatedCreateRequestId.requestId;
  const createRequestFingerprint = await jobCreatePayloadDigest(body);

  const supabase = createServiceClient();

  // 먼저 처리된 요청은 현재 비즈니스 검증 규칙과 무관하게 기존 결과를 재생한다. 배포 사이에
  // 검증이 강화돼도 같은 UUID·같은 payload가 400으로 바뀌지 않아야 완전한 replay가 된다.
  const { data: existingCreate, error: existingCreateError } = await supabase
    .from("jobs")
    .select("*")
    .eq("client_request_id", createRequestId)
    .maybeSingle();
  if (existingCreateError) {
    console.error("[jobs POST idempotency lookup]", existingCreateError);
    return NextResponse.json({ error: "공고 중복 등록 여부를 확인하지 못했습니다." }, { status: 500 });
  }
  if (existingCreate) {
    if (jobCreateReplayDecision(existingCreate.creation_request_fingerprint, createRequestFingerprint) === "replay") {
      return NextResponse.json({ job: existingCreate, deduplicated: true });
    }
    return NextResponse.json(
      {
        error: "이미 처리된 공고 등록 요청과 내용이 다릅니다. 공고 목록을 확인한 뒤 새 창에서 다시 등록해주세요.",
        job: existingCreate,
      },
      { status: 409 },
    );
  }

  if (!title?.trim() || !jobBody?.trim()) {
    return NextResponse.json(
      { error: "title과 body는 필수입니다." },
      { status: 400 }
    );
  }
  const requiredFieldIssue = validateJobCreateRequiredFields({
    capacity,
    pickupAddress: pickup_address,
    dropoffAddress: dropoff_address,
    payInfo: pay_info,
  });
  if (requiredFieldIssue) {
    return NextResponse.json({ error: requiredFieldIssue.error }, { status: 400 });
  }
  // `__` 프리픽스는 시스템 더미 공고 예약어 — 사용자 공고가 이걸로 시작하면 목록·pull에서 숨겨져 사라진 것처럼 보인다.
  if (isSystemJobTitle(title.trim())) {
    return NextResponse.json(
      { error: "공고 제목은 '__'로 시작할 수 없습니다(시스템 예약 프리픽스)." },
      { status: 400 }
    );
  }
  // slot(근무시간) — 길이만 검증(4-슬롯 enum 강제 제거). internal 정기 라인은 자유 텍스트 입력,
  // 비마트/배민은 UI select가 4-슬롯을 제약. 서버 enum은 internal 등록을 막던 막다른 길이었음.
  if (typeof slot === "string" && slot.length > 80) {
    return NextResponse.json({ error: "근무시간이 너무 깁니다(최대 80자)." }, { status: 400 });
  }
  // slot_keys(시간대 매칭용 칩 값) — 4슬롯 어휘만. 사람이 읽는 slot과 별개 필드다.
  const normalizedSlotKeys = normalizeSlotKeys(slot_keys);
  if (normalizedSlotKeys === null) {
    return NextResponse.json({ error: "시간대 값이 잘못되었습니다 — 평일/주말 × 오전/오후 중에서 고르세요." }, { status: 400 });
  }
  if (recruit_mode && !RECRUIT_MODES.has(recruit_mode)) {
    return NextResponse.json({ error: "recruit_mode 값이 잘못되었습니다." }, { status: 400 });
  }
  if (exposure && !["all", "targeted"].includes(exposure)) {
    return NextResponse.json({ error: "exposure 값이 잘못되었습니다." }, { status: 400 });
  }
  if (pay_type && !["건당", "일당", "주급", "월급", "혼합", "협의"].includes(pay_type)) {
    return NextResponse.json({ error: "pay_type 값이 잘못되었습니다." }, { status: 400 });
  }
  if (work_period && !["하루", "단기", "정기"].includes(work_period)) {
    return NextResponse.json({ error: "work_period 값이 잘못되었습니다." }, { status: 400 });
  }

  // 화주사 자체는 일반 라인 호환을 위해 선택값으로 두되, 전달된 라우팅은 활성 마스터에만 연결한다.
  // 지점은 활성 상태·소속 화주사까지 확인하고, 요청 화주사와 다르면 조용히 덮어쓰지 않고 막는다.
  let branchRow: JobCreateBranchRoutingRow | null = null;
  if (typeof branch_id === "number" && Number.isSafeInteger(branch_id) && branch_id > 0) {
    const { data: branchData, error: branchError } = await supabase
      .from("branches")
      .select("id, name, client_id, active")
      .eq("id", branch_id)
      .maybeSingle();
    if (branchError) {
      console.error("[jobs POST routing branch]", branchError);
      return NextResponse.json({ error: "지점 정보를 확인하지 못했습니다." }, { status: 500 });
    }
    branchRow = branchData as JobCreateBranchRoutingRow | null;
  }

  const routingClientId =
    typeof branchRow?.client_id === "number"
      ? branchRow.client_id
      : typeof client_id === "number" && Number.isSafeInteger(client_id) && client_id > 0
        ? client_id
        : null;
  let clientRow: JobCreateClientRoutingRow | null = null;
  if (routingClientId !== null) {
    const { data: clientData, error: clientError } = await supabase
      .from("clients")
      .select("id, active")
      .eq("id", routingClientId)
      .maybeSingle();
    if (clientError) {
      console.error("[jobs POST routing client]", clientError);
      return NextResponse.json({ error: "화주사 정보를 확인하지 못했습니다." }, { status: 500 });
    }
    clientRow = clientData as JobCreateClientRoutingRow | null;
  }

  const routing = resolveJobCreateRouting({
    requestedClientId: client_id,
    requestedBranchId: branch_id,
    requestedBranchName: branch,
    branch: branchRow,
    client: clientRow,
  });
  if (!routing.ok) {
    return NextResponse.json({ error: routing.error }, { status: 400 });
  }

  const normalizedPickupAddress = pickup_address!.trim();
  const normalizedDropoffAddress = dropoff_address!.trim();
  const normalizedPayInfo = pay_info!.trim();

  // 상차지 주소가 있고 좌표가 안 넘어왔으면 지오코딩 — 파이프라인 거리 정렬의 근거.
  let resolvedPickupLat = typeof pickup_lat === "number" ? pickup_lat : null;
  let resolvedPickupLng = typeof pickup_lng === "number" ? pickup_lng : null;
  if (resolvedPickupLat === null && resolvedPickupLng === null) {
    const { geo } = await geocodeAddressWithFallback(normalizedPickupAddress);
    if (geo) {
      resolvedPickupLat = geo.lat;
      resolvedPickupLng = geo.lng;
    }
  }

  // 마지막 경유지(배송 종료 지점) 주소가 있고 좌표가 안 넘어왔으면 지오코딩 — 거리 정렬은 상차지·마지막경유지 중 가까운 쪽 기준.
  let resolvedDropoffLat = typeof dropoff_lat === "number" ? dropoff_lat : null;
  let resolvedDropoffLng = typeof dropoff_lng === "number" ? dropoff_lng : null;
  if (resolvedDropoffLat === null && resolvedDropoffLng === null) {
    const { geo } = await geocodeAddressWithFallback(normalizedDropoffAddress);
    if (geo) {
      resolvedDropoffLat = geo.lat;
      resolvedDropoffLng = geo.lng;
    }
  }

  // 반경 규칙 쓰기 가드 — 기준점(집결지 좌표)이 없으면 그 규칙은 아무도 통과 못 한다(수정 PATCH와 같은 규칙).
  const normalizedNewRule = normalizeRule(exposure_rule);
  if (
    normalizedNewRule?.radiusKm &&
    !jobSupportsRadius({
      pickup_lat: resolvedPickupLat,
      pickup_lng: resolvedPickupLng,
      dropoff_lat: resolvedDropoffLat,
      dropoff_lng: resolvedDropoffLng,
      distance_basis: null,
    })
  ) {
    return NextResponse.json(
      {
        error:
          "거리 반경 규칙은 집결지 좌표가 있어야 쓸 수 있어요 — 집결지 주소를 넣어 좌표가 잡힌 뒤에 설정해 주세요(지금 저장하면 아무에게도 안 보입니다).",
      },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("jobs")
    .insert({
      title: title.trim(),
      body: jobBody.trim(),
      branch: routing.branchName,
      branch_id: routing.branchId,
      client_id: routing.clientId,
      slot: slot ?? null,
      slot_keys: normalizedSlotKeys ?? null,
      start_date: start_date ?? null,
      vehicle_required: vehicle_required ?? true,
      pickup_address: normalizedPickupAddress,
      pickup_lat: resolvedPickupLat,
      pickup_lng: resolvedPickupLng,
      dropoff_address: normalizedDropoffAddress,
      dropoff_lat: resolvedDropoffLat,
      dropoff_lng: resolvedDropoffLng,
      pay_info: normalizedPayInfo,
      policy_notes: policy_notes ?? null,
      pay_type: pay_type ?? null,
      pay_amount: typeof pay_amount === "number" ? pay_amount : null,
      ai_facts: ai_facts ?? null,
      capacity,
      // 기본 internal — 파일럿 배포 채널이 pull(맞춤링크) 전용이라, 미전송 시 external이면 지원자에게 안 보이는 함정.
      // (유일 호출자 등록 모달은 recruit_mode를 항상 전송하므로 이 기본값은 방어용.) asRecruitMode의 레거시 파싱 fallback은 별개로 external 유지.
      recruit_mode: recruit_mode ?? "internal",
      exposure: exposure ?? "all",
      exposure_rule: normalizedNewRule,
      site_manager_id: site_manager_id ?? null,
      created_by: created_by ?? null,
      work_period: work_period || null,
      closes_at: closes_at ?? null,
      // 긴급 건(SOS)에서 파생된 공고면 그 id를 보관 — 파생 관계 영속(자동 해결 연동은 범위 밖).
      sos_request_id: typeof sos_request_id === "number" ? sos_request_id : null,
      // 신규 저장은 지원하는 공고 원문·문자 안내만 유지한다. 과거 채널 키는 읽기 호환만 한다.
      channel_bodies: channel_bodies && typeof channel_bodies === "object"
        ? jobCreatePersistedChannelBodies(channel_bodies)
        : null,
      client_request_id: createRequestId,
      creation_request_fingerprint: createRequestFingerprint,
    })
    .select()
    .single();

  if (error || !data) {
    // 두 요청이 동시에 들어오면 둘 다 사전 조회를 통과할 수 있다. unique 승자가 저장한 행을
    // 다시 읽어 같은 payload면 성공 replay, 다른 payload면 409로 처리한다.
    if (error?.code === "23505") {
      const { data: concurrentCreate, error: concurrentCreateError } = await supabase
        .from("jobs")
        .select("*")
        .eq("client_request_id", createRequestId)
        .maybeSingle();
      if (concurrentCreateError) {
        console.error("[jobs POST idempotency concurrent lookup]", concurrentCreateError);
        return NextResponse.json({ error: "공고 중복 등록 여부를 확인하지 못했습니다." }, { status: 500 });
      }
      if (concurrentCreate) {
        if (jobCreateReplayDecision(concurrentCreate.creation_request_fingerprint, createRequestFingerprint) === "replay") {
          return NextResponse.json({ job: concurrentCreate, deduplicated: true });
        }
        return NextResponse.json(
          { error: "이미 처리된 공고 등록 요청과 내용이 다릅니다. 공고 목록을 확인한 뒤 새 창에서 다시 등록해주세요." },
          { status: 409 },
        );
      }
    }
    console.error("[jobs POST]", error);
    // 제약 위반은 사용자 입력 문제다 — 어느 칸이 문제인지 이름으로 돌려준다(500 침묵 금지).
    const readable = describeDbConstraintError(error);
    if (readable) return NextResponse.json({ error: readable }, { status: 400 });
    return NextResponse.json({ error: "공고 생성 실패" }, { status: 500 });
  }

  return NextResponse.json({ job: data });
}
