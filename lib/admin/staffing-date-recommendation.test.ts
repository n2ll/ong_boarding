import assert from "node:assert/strict";
import test from "node:test";
import type { StaffingPreparation, StaffingPreparationSnapshot, StaffingPrimaryCandidate } from "./staffing-preparation.ts";

const path = "./staffing-date-recommendation.ts";
const policy = await import(path).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const date = "2026-09-18";
const candidate = (applicant_id: number, own_vehicle: string | null = "있음", agent_stage = "active") => ({ applicant_id, agent_stage, applicants: { own_vehicle } });
const preparation = (patch: Partial<StaffingPreparation> = {}): StaffingPreparation => ({
  source: "manager", dates: [{ date, availability: "available", role: "unassigned" }],
  training_availability: "", training: { status: "completed", backup_intent: "interested", scheduled_at: "", first_loading_location: "", linked_pro: "" },
  records: [], note: "", ...patch,
});
const snapshot = (applicant_id: number, prep: StaffingPreparation | null, patch: Partial<StaffingPreparationSnapshot> = {}): StaffingPreparationSnapshot => ({
  applicant_id, preparation: prep, event_id: applicant_id, updated_at: "2026-09-15T00:00:00Z", invalid: false, actor: null, history: [], ...patch,
});
type Result = { applicant_id: number; rank: number; label: string; reasons: string[] };
function build(candidates: ReturnType<typeof candidate>[], snapshots: StaffingPreparationSnapshot[] = [], otherPrimaries: StaffingPrimaryCandidate[] = []): Result[] {
  assert.equal(typeof policy.buildStaffingDateRecommendations, "function");
  return policy.buildStaffingDateRecommendations({ date, candidates, snapshots, otherPrimaries });
}

test("선택일 가능·선탑 완료·진행 희망을 먼저 검토하며 동률과 모든 후보를 보존한다", () => {
  const candidates = [candidate(1), candidate(2), candidate(3), candidate(4)];
  const snapshots = [snapshot(2, preparation({ training: { ...preparation().training, status: "coordinating" } })), snapshot(3, preparation()), snapshot(4, preparation())];
  const before = JSON.stringify({ candidates, snapshots });
  const result = build(candidates, snapshots);
  assert.deepEqual(result.map((row) => row.applicant_id), [3, 4, 2, 1]);
  assert.equal(result[0].rank, result[1].rank);
  assert.ok(result[1].rank < result[2].rank && result[2].rank < result[3].rank);
  assert.equal(result[0].label, "우선 검토");
  assert.match(result[0].reasons.join(" "), /선택일 가능/);
  assert.match(result[0].reasons.join(" "), /선탑 완료/);
  assert.match(result[0].reasons.join(" "), /진행 희망/);
  assert.ok(result.every((row) => row.reasons.length >= 2 && row.reasons.length <= 3));
  assert.equal(JSON.stringify({ candidates, snapshots }), before);
});

test("자료 없음과 다른 날짜의 가능·확정 기록을 선택일 불가나 가능으로 바꾸지 않는다", () => {
  const otherDate = preparation({ dates: [{ date: "2026-09-19", availability: "available", role: "primary_candidate", confirmation: "confirmed" }] });
  const result = build([candidate(1), candidate(2), candidate(3)], [snapshot(2, null, { event_id: null }), snapshot(3, otherDate)]);
  assert.deepEqual(result.map((row) => row.applicant_id), [1, 2, 3]);
  assert.ok(result.every((row) => row.rank === result[0].rank && row.label === "가능 여부 확인"));
  assert.ok(result.every((row) => /선택일.*미확인/.test(row.reasons.join(" "))));
  assert.ok(result.every((row) => !/투입 확정|선택일 불가/.test(row.reasons.join(" "))));
});

test("선택일 불가·선탑 보류·진행 거절·후보 중단은 긍정 기록이 있어도 연락 보류다", () => {
  const result = build([candidate(1), candidate(2), candidate(3), candidate(4, "있음", "abort"), candidate(5)], [
    snapshot(1, preparation({ dates: [{ date, availability: "unavailable", role: "unassigned" }] })),
    snapshot(2, preparation({ training: { ...preparation().training, status: "on_hold" } })),
    snapshot(3, preparation({ training: { ...preparation().training, backup_intent: "declined" } })),
    snapshot(4, preparation()), snapshot(5, preparation()),
  ]);
  assert.deepEqual(result.map((row) => row.applicant_id), [5, 1, 2, 3, 4]);
  assert.ok(result.slice(1).every((row) => row.label === "연락 보류"));
  for (const [id, reason] of [[1, "불가"], [2, "보류"], [3, "진행 안 함"], [4, "중단"]] as const) {
    assert.match(result.find((row) => row.applicant_id === id)!.reasons.join(" "), new RegExp(reason));
  }
});

test("이미 선택일 투입 확정된 사람은 추가 충원 추천 뒤에 두고 중복 기록도 알린다", () => {
  const confirmed = preparation({ dates: [{ date, availability: "available", role: "primary_candidate", confirmation: "confirmed" }] });
  const result = build([candidate(1), candidate(2), candidate(3)], [snapshot(1, confirmed), snapshot(2, preparation())],
    [{ applicant_id: 1, job_id: 2, job_title: "다른 라인", date }]);
  assert.deepEqual(result.map((row) => row.applicant_id), [2, 3, 1]);
  assert.equal(result[2].label, "투입 확정");
  assert.match(result[2].reasons.join(" "), /다른 라인/);
  assert.match(result[2].reasons.join(" "), /시간 확인/);
});

test("투입 확정과 다른 라인 일정이 함께 있어도 중단·거절 재확인 사유를 가리지 않는다", () => {
  const confirmed = preparation({
    dates: [{ date, availability: "available", role: "primary_candidate", confirmation: "confirmed" }],
    training: { ...preparation().training, backup_intent: "declined" },
  });
  const [result] = build([candidate(1, null, "abort")], [snapshot(1, confirmed)],
    [{ applicant_id: 1, job_id: 2, job_title: "다른 라인", date }]);
  assert.equal(result.label, "투입 확정");
  const reasons = result.reasons.join(" ");
  assert.match(reasons, /다른 라인/);
  assert.match(reasons, /시간 확인/);
  assert.match(reasons, /진행 안 함/);
  assert.match(reasons, /후보 진행 중단/);
  assert.match(reasons, /관리자 재확인/);
  assert.match(reasons, /차량 미확인/);
  assert.ok(result.reasons.length <= 3);
});

test("다른 라인의 같은 날 본담당 후보는 내 역할과 무관하게 중복 일정 확인으로 내린다", () => {
  const result = build([candidate(1), candidate(2), candidate(3)], [snapshot(1, preparation()), snapshot(2, preparation()), snapshot(3, preparation())], [
    { applicant_id: 1, job_id: 2, job_title: "오후 라인", date },
    { applicant_id: 2, job_id: 3, job_title: "다른 날짜 라인", date: "2026-09-19" },
  ]);
  assert.deepEqual(result.map((row) => row.applicant_id), [2, 3, 1]);
  assert.equal(result[2].label, "중복 일정 확인");
  assert.match(result[2].reasons.join(" "), /시간 확인/);
  assert.doesNotMatch(result[2].reasons.join(" "), /근무 불가|시간 충돌|배정 불가/);
});

test("손상된 최신 snapshot은 과거의 긍정 기록을 되살리지 않고 기록 확인으로 내린다", () => {
  const old = { event_id: 1, updated_at: "2026-09-14T00:00:00Z", actor: null, preparation: preparation(), invalid: false };
  const result = build([candidate(1), candidate(2), candidate(3)], [
    snapshot(1, null, { invalid: true, history: [old] }),
    snapshot(2, preparation(), { invalid: true }), snapshot(3, preparation()),
  ]);
  assert.deepEqual(result.map((row) => row.applicant_id), [3, 1, 2]);
  assert.ok(result.slice(1).every((row) => row.label === "기록 확인 필요"));
  assert.ok(result.slice(1).every((row) => !/선탑 완료|선택일 가능/.test(row.reasons.join(" "))));
});

test("선탑 참여 기록이나 지난 예정 일시만으로 선탑 완료를 추정하지 않는다", () => {
  const result = build([candidate(1), candidate(2), candidate(3)], [
    snapshot(1, preparation({ training: { ...preparation().training, status: "reviewing" }, records: [{ id: "1", kind: "training", date: "2026-09-01", note: "참여" }] })),
    snapshot(2, preparation({ training: { ...preparation().training, status: "scheduled", scheduled_at: "2026-09-01T09:00:00+09:00" } })),
    snapshot(3, preparation()),
  ]);
  assert.deepEqual(result.map((row) => row.applicant_id), [3, 1, 2]);
  assert.equal(result[1].rank, result[2].rank);
  assert.notEqual(result[1].label, "우선 검토");
  assert.notEqual(result[2].label, "우선 검토");
  assert.ok(result.slice(1).every((row) => /완료.*확인/.test(row.reasons.join(" "))));
});

test("차량 미확인은 이유에만 표시하고 나이·거리·차량 보유로 순서를 바꾸지 않는다", () => {
  const candidates = [
    { ...candidate(1, null), birth_date: "2000-01-01", distance_km: 100 },
    { ...candidate(2, "있음"), birth_date: "1950-01-01", distance_km: 1 },
    { ...candidate(3, "없음"), birth_date: "1980-01-01", distance_km: 0 },
  ];
  const result = build(candidates, [snapshot(1, preparation()), snapshot(2, preparation()), snapshot(3, preparation())]);
  assert.deepEqual(result.map((row) => row.applicant_id), [1, 2, 3]);
  assert.ok(result.every((row) => row.rank === result[0].rank && row.label === "우선 검토"));
  assert.match(result[0].reasons.join(" "), /차량 미확인/);
  assert.doesNotMatch(result[0].reasons.join(" "), /부적합|불가/);
  assert.doesNotMatch(result[1].reasons.join(" "), /차량 미확인/);
});
