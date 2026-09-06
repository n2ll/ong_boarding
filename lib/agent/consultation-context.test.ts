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

function client(rows: ReturnType<typeof database>, failingTable?: string) {
  const requests: URL[] = [];
  const supabase = createClient("https://consultation.invalid", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        assert.equal(init?.method, "GET", "상담 목록 조회는 상태를 쓰지 않는다");
        const url = new URL(String(input));
        requests.push(url);
        const table = url.pathname.split("/").at(-1)!;
        if (table === failingTable) return Response.json({ message: "query failed" }, { status: 400 });
        let found = [...(rows[table as keyof typeof rows] ?? [])] as Row[];
        for (const [column, expression] of url.searchParams) {
          if (expression.startsWith("eq.")) found = found.filter((row) => String(row[column]) === expression.slice(3));
          if (expression.startsWith("in.(")) {
            const values = expression.slice(4, -1).split(",");
            found = found.filter((row) => values.includes(String(row[column])));
          }
        }
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
