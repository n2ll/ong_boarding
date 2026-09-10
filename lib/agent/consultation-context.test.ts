import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { loadConsultationJobs } from "./consultation-context.ts";

type Row = Record<string, unknown>;

function database(jobs: Row[], candidates: Row[] = [], overrides: Row[] = []) {
  return {
    applicants: [{ id: 7, sido: "서울", sigungu: "용산구", availability: "바로가능", own_vehicle: "있음", work_hours: null, available_slots: ["평일오전"], lat: 37.5, lng: 127, applied_at: null, created_at: "2026-01-01" }],
    jobs,
    job_candidates: candidates,
    job_exposure_targets: overrides,
    pool_events: [] as Row[],
  };
}

function client(rows: ReturnType<typeof database>, failingTable?: string | ((url: URL) => boolean)) {
  const requests: URL[] = [];
  const supabase = createClient("https://consultation.invalid", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        assert.equal(init?.method, "GET", "상담 목록 조회는 상태를 쓰지 않는다");
        const url = new URL(String(input));
        requests.push(url);
        const table = url.pathname.split("/").at(-1)!;
        if (typeof failingTable === "function" ? failingTable(url) : table === failingTable) return Response.json({ message: "query failed" }, { status: 400 });
        let found = [...(rows[table as keyof typeof rows] ?? [])] as Row[];
        for (const [column, expression] of url.searchParams) {
          if (expression.startsWith("eq.")) found = found.filter((row) => String(row[column]) === expression.slice(3));
          if (expression.startsWith("in.(")) {
            const values = expression.slice(4, -1).split(",");
            found = found.filter((row) => values.includes(String(row[column])));
          }
        }
        const orders = (url.searchParams.get("order") ?? "").split(",").filter(Boolean).map((value) => value.split("."));
        found.sort((a, b) => {
          for (const [column, direction] of orders) {
            if (a[column] !== b[column]) return (a[column]! < b[column]! ? -1 : 1) * (direction === "desc" ? -1 : 1);
          }
          return 0;
        });
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 1_000), 1_000);
        return Response.json(found.slice(offset, offset + limit));
      },
    },
  });
  return { supabase, requests };
}

function job(id: number, patch: Row = {}): Row {
  return { id, title: `공고 ${id}`, branch: "용산", status: "active", recruit_mode: "internal", exposure: "all", exposure_rule: null, closes_at: null, slot: "오전 9시", slot_keys: null, start_date: null, work_period: null, pay_info: null, pay_type: "hourly", pay_amount: 12000, pickup_address: "서울 용산구", vehicle_required: false, pickup_lat: 37.5, pickup_lng: 127, dropoff_lat: null, dropoff_lng: null, distance_basis: "pickup", ...patch };
}

function candidate(id: number, jobId: number, patch: Row = {}): Row {
  return { id, applicant_id: 7, job_id: jobId, agent_stage: "screening", closed_at: null, closed_reason: null, ...patch };
}

test("본인 노출 공고와 연결된 외부 공고를 조회하고 관심만 표시한 후보도 상담에 포함한다", async () => {
  const { supabase } = client(database([
    job(1), job(2, { recruit_mode: "both" }), job(3, { recruit_mode: "external" }),
    job(4, { recruit_mode: "external" }), job(5, { recruit_mode: "external" }),
    job(6, { title: "__system__" }), job(7, { status: "closed" }),
    job(8, { recruit_mode: "external" }),
  ], [candidate(10, 1, { agent_stage: null }), candidate(11, 3), candidate(12, 5, { agent_stage: "abort" }), candidate(13, 8, { applicant_id: 8 })]));
  const result = await loadConsultationJobs(supabase, 7);
  assert.deepEqual(result.map((row) => row.job_id), [1, 2, 3]);
  assert.equal(result[0].candidate_id, 10);
  assert.equal(result[0].stage, null);
  assert.equal(result[1].candidate_id, null);
  assert.equal(result[2].stage, "screening");
});

test("연결 후보라도 exclude를 지키고 규칙·수동 include·반경을 같은 노출 판정으로 평가한다", async () => {
  const { supabase } = client(database([
    job(1, { exposure: "targeted", exposure_rule: { sido: ["서울"], slot: ["평일오전"], vehicle: ["있음"], radiusKm: 2 } }),
    job(2, { exposure: "targeted", exposure_rule: { sido: ["서울"] } }),
    job(3, { exposure: "targeted", exposure_rule: { sido: ["부산"] } }),
    job(4, { exposure: "targeted", exposure_rule: { radiusKm: 2 }, pickup_lat: 35 }),
    job(5, { exposure: "targeted", exposure_rule: null }),
    job(6, { recruit_mode: "external", exposure: "targeted", exposure_rule: { sido: ["서울"] } }),
  ], [candidate(10, 2), candidate(11, 6)], [
    { id: 1, applicant_id: 7, job_id: 2, mode: "exclude" },
    { id: 2, applicant_id: 7, job_id: 3, mode: "include" },
    { id: 3, applicant_id: 7, job_id: 6, mode: "exclude" },
  ]));
  assert.deepEqual((await loadConsultationJobs(supabase, 7)).map((row) => row.job_id), [1, 3]);
});

test("마감된 카드는 3일 이내만 expired로 표시하고 오래된 마감은 숨긴다", async () => {
  const now = Date.now();
  const { supabase } = client(database([
    job(1, { closes_at: new Date(now - 86_400_000).toISOString() }),
    job(2, { closes_at: new Date(now - 4 * 86_400_000).toISOString() }),
    job(3, { closes_at: new Date(now + 86_400_000).toISOString() }),
  ]));
  const jobs = await loadConsultationJobs(supabase, 7);
  assert.deepEqual(jobs.map(({ job_id, expired }) => ({ job_id, expired })), [{ job_id: 1, expired: true }, { job_id: 3, expired: false }]);
});

test("공고·후보 1000행 이후와 대량 수동 제외를 빠뜨리지 않는다", async () => {
  const jobs = Array.from({ length: 1_001 }, (_, i) => job(i + 1, { exposure: "targeted", exposure_rule: { sido: ["서울"] } }));
  jobs.push(job(2002, { recruit_mode: "external" }));
  const candidates = Array.from({ length: 1_001 }, (_, i) => candidate(i + 1, i === 1_000 ? 2002 : i + 1));
  const overrides = Array.from({ length: 1_001 }, (_, i) => ({ id: i + 1, applicant_id: 7, job_id: i + 1, mode: "exclude" }));
  const { supabase } = client(database(jobs, candidates, overrides));
  assert.deepEqual((await loadConsultationJobs(supabase, 7)).map((row) => row.job_id), [2002]);
});

for (const table of ["applicants", "jobs", "job_candidates", "job_exposure_targets", "pool_events"]) {
  test(`${table} 조회 실패 시 부분 목록으로 상담을 허용하지 않는다`, async () => {
    const { supabase } = client(database([job(1, { exposure: "targeted", exposure_rule: { suntopDone: true } })]), table);
    await assert.rejects(loadConsultationJobs(supabase, 7), /failed|실패/);
  });
}

test("지원자가 없으면 상담 목록을 만들지 않는다", async () => {
  const { supabase } = client(database([job(1)]));
  await assert.rejects(loadConsultationJobs(supabase, 999), /지원자|applicant/);
});

test("수거 상담 근거로 노출된 해당 공고의 본문만 전달한다", async () => {
  const body = "배송하면서 전날 가방을 맞수거합니다.";
  const { supabase, requests } = client(database([
    job(1, { body }), job(2, { body: "당일 오후 재방문해 가방을 수거합니다.", exposure: "none" }),
  ]));
  const result = await loadConsultationJobs(supabase, 7);
  assert.deepEqual(result.map((row) => [row.job_id, row.body]), [[1, body]]);
  assert.ok(requests.filter((url) => url.pathname.endsWith("/jobs")).every((url) => url.searchParams.get("select")?.split(/,\s*/).includes("body")));
});

const emptyPreparation = { source: "manager", dates: [], training_availability: "", note: "" };
const emptyManagerContext = {
  training_status: "reviewing", backup_intent: "unknown", training_availability: { has_date: false, has_time: false },
  training_completed: false, backup_completed: false, manager_follow_up_open: false, last_contact_recorded: false,
};
function preparationEvent(id: number, jobId: number, meta: unknown, patch: Row = {}): Row {
  return { id, applicant_id: 7, job_id: jobId, event_type: "staffing_preparation", meta, created_at: "2026-09-09T00:00:00Z", ...patch };
}

test("매니저 기록은 상태·불리언만 전달하고 메모·담당자·연락처·실제 날짜는 제외한다", async () => {
  const rows = database([job(1)], [candidate(1, 1)]);
  rows.pool_events = [preparationEvent(1, 1, {
    ...emptyPreparation, dates: [{ date: "2027-04-20", availability: "available", role: "primary_candidate", confirmation: "confirmed" }],
    training_availability: "월요일 오전 가능", note: "팀만 보는 메모 010-1234-5678",
    training: { status: "scheduled", backup_intent: "declined", scheduled_at: "2027-04-20T07:30:00+09:00", first_loading_location: "비공개 상세 주소", linked_pro: "비공개 프로" },
    records: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "training", date: "2026-01-08", note: "참여 평가 메모" }],
    follow_up: { owner: "비공개 담당자", next_action: "다시 전화 010-2222-3333", due_date: "2027-04-20", status: "open",
      last_contact: { date: "2026-01-08", method: "phone", result: "비공개 통화 내용" } },
    actor: { account_id: "secret-account", name: "비공개 작성자" },
  })];
  const { supabase } = client(rows);
  const result = await loadConsultationJobs(supabase, 7);
  assert.deepEqual(result[0].manager_preparation, {
    training_status: "scheduled", backup_intent: "declined", training_availability: { has_date: true, has_time: true },
    training_completed: true, backup_completed: false, manager_follow_up_open: true, last_contact_recorded: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /비공개|메모|010-|2027-04-20|2026-01-08|secret-account/);
});

test("최신 저장 시각을 우선하고 동시각에는 큰 ID를 선택해 명시 삭제를 유지한다", async () => {
  const rows = database([job(1), job(2)], [candidate(1, 1), candidate(2, 2)]);
  const old = { ...emptyPreparation, training_availability: "월요일 오전 가능",
    follow_up: { owner: "담당자", next_action: "다음 연락", due_date: "", status: "open", last_contact: null } };
  rows.pool_events = [
    preparationEvent(99, 1, old), preparationEvent(1, 1, { ...emptyPreparation, follow_up: null }, { created_at: "2026-09-10T00:00:00Z" }),
    preparationEvent(20, 2, old), preparationEvent(30, 2, { ...emptyPreparation, follow_up: null }),
  ];
  const { supabase } = client(rows);
  assert.deepEqual((await loadConsultationJobs(supabase, 7)).map((row) => row.manager_preparation), [emptyManagerContext, emptyManagerContext]);
});

test("손상된 최신 매니저 기록은 과거 기록으로 돌아가지 않고 상담을 중단한다", async () => {
  const rows = database([job(1)], [candidate(1, 1)]);
  rows.pool_events = [preparationEvent(1, 1, emptyPreparation), preparationEvent(2, 1, { ...emptyPreparation, follow_up: { status: "broken" } })];
  const { supabase } = client(rows);
  await assert.rejects(loadConsultationJobs(supabase, 7), /매니저.*기록|운영 준비.*기록/);
});

test("배열로 저장된 상태는 허용된 문자열처럼 AI 문맥에 전달하지 않는다", async () => {
  for (const patch of [{ status: ["scheduled"] }, { backup_intent: ["interested"] }]) {
    const rows = database([job(1)], [candidate(1, 1)]);
    rows.pool_events = [preparationEvent(1, 1, { ...emptyPreparation, training: {
      status: "reviewing", backup_intent: "unknown", scheduled_at: "", first_loading_location: "", linked_pro: "", ...patch,
    } })];
    const { supabase } = client(rows);
    await assert.rejects(loadConsultationJobs(supabase, 7), /매니저.*기록|운영 준비.*기록/);
  }
});

test("본인의 노출·미마감·열린 연결에만 매니저 기록을 붙이고 다른 범위의 손상 기록은 읽지 않는다", async () => {
  const rows = database([
    job(1), job(2), job(3), job(4, { exposure: "none" }), job(5, { closes_at: new Date(Date.now() - 1000).toISOString() }),
    job(6), job(7), job(8), job(9),
  ], [candidate(1, 1), candidate(3, 3, { applicant_id: 8 }), candidate(4, 4), candidate(5, 5),
    candidate(6, 6, { agent_stage: "paused" }), candidate(7, 7, { agent_stage: "abort" }),
    candidate(8, 8), candidate(80, 8, { closed_at: "2026-09-09T00:00:00Z" }), candidate(9, 9, { closed_reason: "manager_closed" })]);
  rows.pool_events = [preparationEvent(1, 1, emptyPreparation), preparationEvent(100, 1, null, { applicant_id: 8 }),
    preparationEvent(101, 1, null, { event_type: "job_consultation_observation" }),
    ...Array.from({ length: 8 }, (_, i) => preparationEvent(i + 2, i + 2, null))];
  const { supabase, requests } = client(rows);
  const result = await loadConsultationJobs(supabase, 7);
  assert.deepEqual(result.filter((row) => row.manager_preparation).map((row) => row.job_id), [1]);
  assert.deepEqual(result.find((row) => row.job_id === 1)?.manager_preparation, emptyManagerContext);
  const events = requests.filter((url) => url.searchParams.get("event_type") === "eq.staffing_preparation");
  assert.ok(events.length > 0);
  assert.ok(events.every((url) => url.searchParams.get("applicant_id") === "eq.7" && url.searchParams.get("job_id") === "in.(1)"));
});

test("선탑 완료 상태·백업 가능일로 실제 참여나 선탑 가능시간을 만들지 않는다", async () => {
  const rows = database([job(1), job(2)], [candidate(1, 1), candidate(2, 2)]);
  rows.pool_events = [preparationEvent(1, 1, { ...emptyPreparation,
    dates: [{ date: "2027-04-20", availability: "available", role: "reserve_candidate" }],
    training: { status: "completed", backup_intent: "interested", scheduled_at: "2027-04-20T07:30:00+09:00", first_loading_location: "", linked_pro: "" },
  }), preparationEvent(2, 2, { ...emptyPreparation, training_availability: "오후 가능",
    records: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", kind: "backup", date: "2026-01-08", note: "" }],
  })];
  const { supabase } = client(rows);
  assert.deepEqual((await loadConsultationJobs(supabase, 7)).map((row) => row.manager_preparation), [
    { ...emptyManagerContext, training_status: "completed", backup_intent: "interested" },
    { ...emptyManagerContext, training_availability: { has_date: false, has_time: true }, backup_completed: true },
  ]);
});

test("최근 연락 기록과 열린 다음 할 일은 독립적으로 정제한다", async () => {
  const rows = database([job(1), job(2)], [candidate(1, 1), candidate(2, 2)]);
  const contact = { date: "2026-01-08", method: "sms", result: "연락 완료" };
  rows.pool_events = [preparationEvent(1, 1, { ...emptyPreparation,
    follow_up: { owner: "담당자만 있음", next_action: "", due_date: "", status: "open", last_contact: contact },
  }), preparationEvent(2, 2, { ...emptyPreparation,
    follow_up: { owner: "", next_action: "완료한 일", due_date: "", status: "done", last_contact: null },
  })];
  const { supabase } = client(rows);
  assert.deepEqual((await loadConsultationJobs(supabase, 7)).map((row) => row.manager_preparation), [
    { ...emptyManagerContext, last_contact_recorded: true }, emptyManagerContext,
  ]);
});

function paginatedPreparationRows() {
  const rows = database(Array.from({ length: 201 }, (_, i) => job(i + 1)), Array.from({ length: 201 }, (_, i) => candidate(i + 1, i + 1)));
  rows.pool_events = Array.from({ length: 1000 }, (_, i) => preparationEvent(i + 10, 1, emptyPreparation));
  rows.pool_events.push(preparationEvent(1, 200, { ...emptyPreparation, training_availability: "월요일 가능" }),
    preparationEvent(2, 201, { ...emptyPreparation, training_availability: "오후 가능" }));
  return rows;
}

test("1000행 이후 매니저 기록과 ID 묶음 이후 공고를 빠뜨리지 않는다", async () => {
  const { supabase, requests } = client(paginatedPreparationRows());
  const result = await loadConsultationJobs(supabase, 7);
  assert.deepEqual(result.find((row) => row.job_id === 200)?.manager_preparation, { ...emptyManagerContext, training_availability: { has_date: true, has_time: false } });
  assert.deepEqual(result.find((row) => row.job_id === 201)?.manager_preparation, { ...emptyManagerContext, training_availability: { has_date: false, has_time: true } });
  const events = requests.filter((url) => url.searchParams.get("event_type") === "eq.staffing_preparation");
  assert.ok(events.some((url) => url.searchParams.get("offset") === "1000"));
  assert.ok(events.every((url) => url.searchParams.get("job_id")!.split(",").length <= 200));
});

test("첫 페이지나 후속 페이지의 매니저 기록 조회 실패를 기록 없음으로 숨기지 않는다", async () => {
  for (const offset of ["0", "1000"]) {
    const { supabase } = client(paginatedPreparationRows(), (url) => url.searchParams.get("event_type") === "eq.staffing_preparation"
      && (url.searchParams.get("offset") ?? "0") === offset);
    await assert.rejects(loadConsultationJobs(supabase, 7), /failed|실패/);
  }
});
