import assert from "node:assert/strict";
import test from "node:test";
import type { buildStaffingDateRecommendations, StaffingDateRecommendation } from "./staffing-date-recommendation.ts";
import type { StaffingPreparation, StaffingPreparationSnapshot } from "./staffing-preparation.ts";

const path = "./staffing-replacement-comparison.ts";
const policy = await import(path).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const date = "2026-09-18";
const today = "2026-09-16";
const candidate = (applicant_id: number, own_vehicle: string | null = "있음", agent_stage = "active") => ({ applicant_id, agent_stage, applicants: { own_vehicle } });
const preparation = (patch: Partial<StaffingPreparation> = {}): StaffingPreparation => ({
  source: "manager", dates: [{ date, availability: "available", role: "unassigned" }],
  training_availability: "", training: { status: "completed", backup_intent: "interested", scheduled_at: "", first_loading_location: "", linked_pro: "" },
  records: [], note: "", ...patch,
});
const confirmed = (day = date) => preparation({ dates: [{ date: day, availability: "available", role: "primary_candidate", confirmation: "confirmed" }] });
const snapshot = (applicant_id: number, prep: StaffingPreparation | null, patch: Partial<StaffingPreparationSnapshot> = {}): StaffingPreparationSnapshot => ({
  applicant_id, preparation: prep, event_id: applicant_id, updated_at: "2026-09-15T00:00:00Z", invalid: false, actor: null, history: [], ...patch,
});
type Input = Parameters<typeof buildStaffingDateRecommendations>[0] & { absentApplicantId: number | null; today: string };
function build(patch: Partial<Input> = {}): { confirmedApplicantIds: number[]; alternatives: StaffingDateRecommendation[] } {
  assert.equal(typeof policy.buildStaffingReplacementComparison, "function");
  return policy.buildStaffingReplacementComparison({ date, today, candidates: [candidate(1), candidate(2)],
    snapshots: [snapshot(1, confirmed())], otherPrimaries: [], absentApplicantId: 1, ...patch });
}

test("선택일의 유효한 명시적 확정자만 입력 순서로 기준 목록에 포함한다", () => {
  const result = build({ candidates: [candidate(2), candidate(1), candidate(3), candidate(4), candidate(5)], snapshots: [
    snapshot(1, confirmed()), snapshot(2, confirmed()), snapshot(3, confirmed("2026-09-19")),
    snapshot(4, confirmed(), { invalid: true }),
    snapshot(5, preparation({ dates: [{ date, availability: "available", role: "primary_candidate" }] })),
    snapshot(99, confirmed()),
  ], absentApplicantId: null });
  assert.deepEqual(result.confirmedApplicantIds, [2, 1]);
  assert.deepEqual(result.alternatives, []);
});

test("다른 날짜·손상된 최신 기록·옛 확정·현재 후보에 없는 사람은 비교 기준이 될 수 없다", () => {
  const old = { event_id: 40, updated_at: "2026-09-14T00:00:00Z", actor: null, preparation: confirmed(), invalid: false };
  const candidates = [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)];
  const snapshots = [snapshot(1, confirmed()), snapshot(2, preparation()), snapshot(3, confirmed("2026-09-19")),
    snapshot(4, null, { invalid: true, history: [old] }), snapshot(5, confirmed(), { invalid: true }), snapshot(99, confirmed())];
  for (const absentApplicantId of [null, 2, 3, 4, 5, 99]) {
    const result = build({ candidates, snapshots, absentApplicantId });
    assert.deepEqual(result.confirmedApplicantIds, [1]);
    assert.deepEqual(result.alternatives, [], `기준 ${absentApplicantId}`);
  }
});

test("빠지는 사람과 같은 날 다른 확정자 및 불가·보류·거절·중단 후보를 대체 목록에서 제외한다", () => {
  const result = build({ candidates: [1, 2, 3, 4, 5, 6, 7].map((id) => candidate(id, "있음", id === 6 ? "abort" : "active")), snapshots: [
    snapshot(1, confirmed()), snapshot(2, confirmed()),
    snapshot(3, preparation({ dates: [{ date, availability: "unavailable", role: "unassigned" }] })),
    snapshot(4, preparation({ training: { ...preparation().training, status: "on_hold" } })),
    snapshot(5, preparation({ training: { ...preparation().training, backup_intent: "declined" } })),
    snapshot(6, preparation()), snapshot(7, preparation()),
  ] });
  assert.deepEqual(result.confirmedApplicantIds, [1, 2]);
  assert.deepEqual(result.alternatives.map((row) => row.applicant_id), [7]);
});

test("가능일·차량 미확인 후보를 남기고 참여 기록에서 준비 완료를 추론하지 않으며 기존 검토 순서를 보존한다", () => {
  const result = build({ candidates: [candidate(1), candidate(2, null), candidate(3), candidate(4), candidate(5), candidate(6, null), candidate(7), candidate(8)], snapshots: [
    snapshot(1, confirmed()), snapshot(3, preparation({ training: { ...preparation().training, status: "coordinating" },
      records: [{ id: "a", kind: "training", date: "2026-09-01", note: "참여" }] })),
    snapshot(4, preparation()), snapshot(5, preparation()), snapshot(6, preparation()),
    snapshot(7, preparation({ dates: [{ date: "2026-09-19", availability: "unavailable", role: "unassigned" }] })),
    snapshot(8, confirmed("2026-09-19")),
  ] });
  assert.deepEqual(result.alternatives.map((row) => row.applicant_id), [4, 5, 6, 3, 2, 7, 8]);
  assert.deepEqual(result.alternatives.map((row) => row.rank), [0, 0, 0, 1, 2, 2, 2]);
  assert.match(result.alternatives.find((row) => row.applicant_id === 3)!.reasons.join(" "), /선탑 완료 여부 확인/);
  const unknown = result.alternatives.find((row) => row.applicant_id === 2)!;
  assert.equal(unknown.label, "가능 여부 확인");
  assert.match(unknown.reasons.join(" "), /선택일 가능 여부 미확인/);
  assert.match(unknown.reasons.join(" "), /차량 미확인/);
  assert.match(result.alternatives.find((row) => row.applicant_id === 6)!.reasons.join(" "), /차량 미확인/);
});

test("같은 날 다른 라인 본담당 후보는 제거하지 않고 중복 일정 확인 사유를 보존한다", () => {
  const result = build({ candidates: [candidate(1), candidate(2), candidate(3)], snapshots: [snapshot(1, confirmed()), snapshot(2, preparation()), snapshot(3, preparation())],
    otherPrimaries: [{ applicant_id: 2, job_id: 20, job_title: "다른 라인", date }] });
  assert.deepEqual(result.alternatives.map((row) => row.applicant_id), [3, 2]);
  const duplicate = result.alternatives[1];
  assert.equal(duplicate.label, "중복 일정 확인");
  assert.match(duplicate.reasons.join(" "), /시간 확인/);
  assert.doesNotMatch(duplicate.reasons.join(" "), /시간 충돌|배정 불가/);
});

test("손상된 최신 기록은 과거 기록으로 복원하지 않고 기록 확인으로 남기되 중단 후보는 제외한다", () => {
  const old = { event_id: 20, updated_at: "2026-09-14T00:00:00Z", actor: null, preparation: confirmed(), invalid: false };
  const result = build({ candidates: [candidate(1), candidate(2), candidate(3), candidate(4, "있음", "abort")], snapshots: [
    snapshot(1, confirmed()), snapshot(2, null, { invalid: true, history: [old] }),
    snapshot(3, preparation({ training: { ...preparation().training, status: "on_hold" } }), { invalid: true }),
    snapshot(4, null, { invalid: true, history: [old] }),
  ] });
  assert.deepEqual(result.confirmedApplicantIds, [1]);
  assert.deepEqual(result.alternatives.map((row) => row.applicant_id), [2, 3]);
  assert.ok(result.alternatives.every((row) => row.label === "기록 확인 필요"));
  assert.ok(result.alternatives.every((row) => !/선탑 완료|투입 확정|선택일 가능/.test(row.reasons.join(" "))));
});

test("잘못된 날짜와 과거 날짜는 빈 결과를 반환하고 오늘 비교도 입력 상태를 바꾸지 않는다", () => {
  for (const day of ["", "2026-09-17", "2026-02-30", "2026-13-01", "2026-9-18", "invalid"]) {
    assert.deepEqual(build({ date: day, today: date }), { confirmedApplicantIds: [], alternatives: [] }, day);
  }
  assert.deepEqual(build({ today: "invalid" }), { confirmedApplicantIds: [], alternatives: [] });
  const input = { date, today: date, candidates: [candidate(1), candidate(2), candidate(3)], snapshots: [snapshot(1, confirmed()), snapshot(3, preparation())],
    otherPrimaries: [{ applicant_id: 3, job_id: 20, job_title: "다른 라인", date }], absentApplicantId: 1 };
  const before = JSON.stringify(input);
  const result = build(input);
  assert.deepEqual(result.confirmedApplicantIds, [1]);
  assert.deepEqual(result.alternatives.map((row) => row.applicant_id), [2, 3]);
  assert.equal(JSON.stringify(input), before);
});
