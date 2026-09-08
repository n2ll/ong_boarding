import test from "node:test";
import assert from "node:assert/strict";
import { isPilotCandidateEligible, type PilotCandidate } from "./agent-pilot-targets.ts";
const candidate: PilotCandidate = { id: 1, job_id: 2, applicant_id: 3, agent_stage: null, applicants: { id: 3, name: "가상 후보", phone: "01000000000", status: "대기자", sms_opt_out_at: null } };
test("pilot can prepare a new interest but never resume paused, aborted or opted-out candidates", () => {
  assert.equal(isPilotCandidateEligible(candidate), true);
  for (const stage of ["paused", "abort", "unknown"]) assert.equal(isPilotCandidateEligible({ ...candidate, agent_stage: stage }), false);
  assert.equal(isPilotCandidateEligible({ ...candidate, applicants: { ...candidate.applicants!, sms_opt_out_at: "2026-09-01" } }), false);
  for (const status of ["부적합", "이탈", "인력풀 제외", "확정인력"]) assert.equal(isPilotCandidateEligible({ ...candidate, applicants: { ...candidate.applicants!, status } }), false);
});
