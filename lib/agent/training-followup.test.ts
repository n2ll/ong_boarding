import assert from "node:assert/strict";
import test from "node:test";
import type { StageContext } from "./types";
import type { ConsultationObservation } from "./consultation-types";

const modulePath = "./training-followup.ts";
const policy = await import(modulePath).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const training = "앱 사용과 업무 파악 목적이며 약 2시간입니다. 선탑 후 실제 백업을 수행할 때만 교육비 3만원을 합산합니다.";
function context(history: StageContext["history"] = []): StageContext {
  return { job: { id: 11, title: "가상 동쪽 백업", client_type: "general" }, state: { meta: {} }, history,
    consultation: { jobs: [11, 22].map((id) => ({ job_id: id, title: id === 11 ? "가상 동쪽 백업" : "가상 서쪽 백업", expired: false, stage: "exploration", ai_facts: `백업 일정: 2027/4/22~24\n선탑·교육: ${training}` })), sourceMessages: [] },
  } as unknown as StageContext;
}
const turn = (direction: "inbound" | "outbound", body: string) => ({ direction, body, created_at: "2027-04-01T01:00:00Z" });
function followup(text: string, ctx = context(), jobIds = [11], kind: "interest" | "availability" = "interest") {
  assert.equal(typeof policy.buildTrainingFollowup, "function");
  const observations: ConsultationObservation[] = jobIds.map((job_id) => ({ job_id, kind, quote: text, source_message_id: "fixture" }));
  return policy.buildTrainingFollowup(ctx, observations, text) as string | null;
}

test("backup interest in jobs with identical training facts gets one willingness question", () => {
  const result = followup("두 백업 모두 관심 있습니다", context(), [11, 22]);
  assert.ok(result);
  assert.match(result, /가상 동쪽 백업/); assert.match(result, /가상 서쪽 백업/);
  assert.ok(result.includes(training));
  assert.equal(result.match(/참여를 희망하시나요/g)?.length, 1);
  assert.doesNotMatch(result, /4\/22|가능한 날짜|확정됐|예약/);
});

test("explicit training willingness asks applicant for dates and times without borrowing backup dates", () => {
  const result = followup("선탑 꼭 하고 싶습니다");
  assert.match(result!, /선탑 가능한 날짜와 시간대를 알려주시겠어요/);
  assert.doesNotMatch(result!, /참여를 희망|4\/22|22~24/);
});

test("partial training availability asks only for the missing date or time", () => {
  assert.match(followup("선탑은 화요일 가능해요", context(), [11], "availability")!, /가능한 시간대를 알려주시겠어요/);
  assert.doesNotMatch(followup("선탑은 화요일 가능해요", context(), [11], "availability")!, /날짜/);
  assert.match(followup("선탑은 오전에 가능해요", context(), [11], "availability")!, /가능한 날짜를 알려주시겠어요/);
});

test("explicit date and time leads to manager contact without another collection question", () => {
  const result = followup("선탑은 화요일 오전 가능, 정확한 날짜 미정", context(), [11], "availability");
  assert.match(result!, /매니저가.*문자나 전화로/);
  assert.doesNotMatch(result!, /[?？]|예약|확정됐/);
});

test("a reply to the training availability question uses prior willingness and asks only the missing part", () => {
  const ctx = context([turn("outbound", "가상 동쪽 백업\n선탑 가능한 날짜와 시간대를 알려주시겠어요?")]);
  assert.match(followup("화요일 가능해요", ctx, [11], "availability")!, /가능한 시간대를 알려주시겠어요/);
  const known = context([...ctx.history, turn("inbound", "화요일 가능해요"), turn("outbound", "가상 동쪽 백업\n선탑 가능한 시간대를 알려주시겠어요?")]);
  assert.match(followup("오전 가능해요", known, [11], "availability")!, /매니저가.*문자나 전화로/);
});

test("education questions, generic acknowledgement, refusal, and closing do not start training collection", () => {
  for (const text of ["교육비는 얼마인가요?", "선탑 시간이 궁금해요", "네", "선탑은 안 할게요", "백업 관심 있지만 제가 연락드릴게요"]) {
    assert.equal(followup(text), null, text);
  }
});

test("already asked or answered willingness and availability are not repeated", () => {
  const asked = context([turn("outbound", "가상 동쪽 백업\n선탑 참여를 희망하시나요?")]);
  assert.equal(followup("백업 관심 있어요", asked), null);
  const answered = context([...asked.history, turn("inbound", "선탑은 화요일 오전 가능해요"), turn("outbound", "매니저가 문자나 전화로 선탑 일정을 조율할 예정입니다.")]);
  assert.equal(followup("백업 관심 있어요", answered), null);
  const declined = context([...asked.history, turn("inbound", "선탑은 하지 않겠습니다")]);
  assert.equal(followup("백업 관심 있어요", declined), null);
});

test("different training conditions ask which job to discuss and unregistered conditions stay untouched", () => {
  const ctx = context();
  ctx.consultation!.jobs[1].ai_facts = "선탑·교육: 별도 교육 3시간";
  assert.match(followup("둘 다 관심 있어요", ctx, [11, 22])!, /어느 공고의 선탑/);
  ctx.consultation!.jobs[0].ai_facts = null;
  assert.equal(followup("백업 관심 있어요", ctx), null);
});

test("education information alone does not turn a later backup date into training availability", () => {
  const ctx = context([turn("outbound", `가상 동쪽 백업\n선탑·교육: ${training}`)]);
  const result = followup("백업은 22일 가능해요", ctx, [11], "availability");
  assert.match(result!, /선탑 참여를 희망하시나요/);
  assert.doesNotMatch(result!, /가능한 시간대를/);
});

test("current-job training availability already collected is not asked again", () => {
  const ctx = context();
  ctx.state.meta!.general_screening = { 선탑_가능시간: "화요일 오전 가능, 정확한 날짜 미정" };
  assert.equal(followup("백업 관심 있어요", ctx), null);
});


test("first-time applicant without saved metadata still receives the willingness question", () => {
  const ctx = context();
  ctx.state = {};
  assert.match(followup("백업 관심 있어요", ctx)!, /선탑 참여를 희망하시나요/);
});
