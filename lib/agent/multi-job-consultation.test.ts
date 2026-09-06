import assert from "node:assert/strict";
import test from "node:test";
import type { StageContext } from "./types";

const path = "./multi-job-consultation.ts";
const mod = await import(path).catch(() => ({}));
const ctx = (): StageContext => ({
  job: { id: 11, title: "성수 오전 배송" }, applicant: { id: 7 }, history: [],
  state: { screening: { 근무조건_확인: true }, meta: { previous: "keep" } },
  consultation: {
    jobs: [
      { job_id: 11, title: "성수 오전 배송", branch: "성수", candidate_id: 101, stage: "screening", expired: false, slot: "평일 09:00~12:00", pay_type: "일당", pay_amount: 70000, vehicle_required: false, pickup_address: "서울 성동구 성수동 123 비공개집결지" },
      { job_id: 22, title: "강남 오후 배송", branch: "강남", candidate_id: null, stage: null, expired: false, slot: "주말 13:00~17:00", pay_type: "일당", pay_amount: 90000, vehicle_required: true },
    ],
    sourceMessages: [{ id: "m1", body: "성수는 월요일 가능하고 강남은 주말 가능해요", created_at: "2026-09-06T01:00:00Z" }],
    force: false, ambiguousFollowup: false,
  },
} as unknown as StageContext);
function read(envelope: Record<string, unknown>, context = ctx(), text = "성수랑 강남 시간과 차량은요?") {
  assert.equal(typeof mod.readConsultationResult, "function");
  return mod.readConsultationResult({ consultation: { answers: [], observations: [], ...envelope } }, context, text);
}

test("answers both jobs from their own stored facts, ignoring invented freeform reply", () => {
  const result = read({ mode: "answer", job_ids: [11, 22], answers: [{ job_id: 11, fields: ["근무시간"] }, { job_id: 22, fields: ["본인 차량"] }], reply_text: "두 곳 모두 확정입니다" });
  assert.match(result.reply_text, /성수 오전 배송[\s\S]*09:00~12:00/);
  assert.match(result.reply_text, /강남 오후 배송[\s\S]*본인 차량[\s\S]*필요/);
  assert.doesNotMatch(result.reply_text, /확정입니다|비공개집결지/);
  assert.equal(result.transition.kind, "stay");
  assert.equal(result.applicant_patch, undefined);
  assert.deepEqual(result.state_update.screening, ctx().state.screening);
});

test("records separate quoted availability for each job without advancing either", () => {
  const result = read({ mode: "answer", job_ids: [11, 22], observations: [
    { job_id: 11, source_message_id: "m1", kind: "availability", quote: "성수는 월요일 가능" },
    { job_id: 22, source_message_id: "m1", kind: "availability", quote: "강남은 주말 가능해요" },
  ] });
  assert.equal(result.consultation.observations.length, 2);
  assert.equal(result.transition.kind, "stay");
  assert.match(result.reply_text, /성수 오전 배송/);
  assert.match(result.reply_text, /강남 오후 배송/);
});

for (const observation of [
  { job_id: 33, source_message_id: "m1", kind: "availability", quote: "월요일 가능" },
  { job_id: 11, source_message_id: "someone-else", kind: "availability", quote: "월요일 가능" },
  { job_id: 11, source_message_id: "m1", kind: "availability", quote: "화요일만 가능" },
]) test(`rejects ungrounded observation ${JSON.stringify(observation)}`, () => {
  const result = read({ mode: "answer", job_ids: [11], observations: [observation] });
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.reply_text, null);
  assert.equal(result.consultation, undefined);
});

test("asks about only the unresolved target and writes no availability", () => {
  const result = read({ mode: "clarify", job_ids: [11, 22] }, ctx(), "네 가능해요");
  assert.match(result.reply_text, /성수 오전 배송/);
  assert.match(result.reply_text, /강남 오후 배송/);
  assert.deepEqual(result.consultation.observations, []);
  assert.equal(result.transition.kind, "stay");
});

test("missing facts are labelled for manager review instead of borrowed from another job", () => {
  const result = read({ mode: "answer", job_ids: [11, 22], answers: [{ job_id: 11, fields: ["급여"] }, { job_id: 22, fields: ["집결지(대략)"] }] });
  assert.match(result.reply_text, /70,000/);
  assert.match(result.reply_text, /집결지[\s\S]*확인 필요/);
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.consultation.handoff, true);
});

test("unknown job or unsupported field cannot produce an automatic answer", () => {
  for (const answer of [{ job_id: 88, fields: ["급여"] }, { job_id: 11, fields: ["현장 연락처"] }]) {
    const result = read({ mode: "answer", job_ids: [answer.job_id], answers: [answer] });
    assert.equal(result.reply_text, null);
    assert.equal(result.transition.kind, "pause");
  }
});

test("ordinary current-job progress still uses existing stage, but plural/forced context cannot", () => {
  const current = ctx(); current.consultation!.sourceMessages[0].body = "성수 공고 운전면허 있어요";
  assert.equal(read({ mode: "current", job_ids: [11] }, current, "성수 공고 운전면허 있어요"), null);
  const forced = ctx(); forced.consultation!.force = true;
  assert.equal(read({ mode: "current", job_ids: [11] }, forced).transition.kind, "pause");
  assert.equal(read({ mode: "current", job_ids: [11] }, ctx(), "둘 다 가능한가요?").transition.kind, "pause");
  const ambiguous = ctx(); ambiguous.consultation!.ambiguousFollowup = true;
  assert.equal(read({ mode: "current", job_ids: [11] }, ambiguous, "네 가능해요").transition.kind, "pause");
});

test("expired jobs only receive closure information, with no new interest record", () => {
  const expired = ctx(); expired.consultation!.jobs[1].expired = true;
  const result = read({ mode: "answer", job_ids: [22], answers: [{ job_id: 22, fields: ["급여"] }] }, expired);
  assert.match(result.reply_text, /마감/);
  assert.doesNotMatch(result.reply_text, /90,000/);
  const signal = read({ mode: "answer", job_ids: [22], observations: [{ job_id: 22, source_message_id: "m1", kind: "availability", quote: "강남은 주말 가능해요" }] }, expired);
  assert.equal(signal.consultation, undefined);
});

test("invalid envelope is a visible handoff, never silent normal-stage progress", () => {
  for (const envelope of [{}, { mode: "answer", job_ids: [] }, { mode: "clarify", job_ids: [999] }]) {
    const result = read(envelope);
    assert.equal(result.transition.kind, "pause");
    assert.equal(result.reply_text, null);
  }
});

test("model sees current source IDs and public facts, not private addresses", () => {
  assert.equal(typeof mod.formatConsultationContext, "function");
  const content = mod.formatConsultationContext(ctx());
  assert.match(content, /m1/);
  assert.match(content, /서울 성동구/);
  assert.doesNotMatch(content, /비공개집결지|성수동 123/);
  const tool = mod.withConsultationTool({ input_schema: { properties: {}, required: [] } }, ctx());
  assert.ok(tool.input_schema.required.includes("consultation"));
});

function forMessage(text: string): StageContext {
  const context = ctx();
  context.consultation!.sourceMessages[0].body = text;
  return context;
}

for (const quote of ["성수는 월요일 가능", "월요일 가능"]) {
  test(`rejects availability assigned to another explicitly named job: ${quote}`, () => {
    const text = "성수는 월요일 가능하고 강남은 주말 가능해요";
    const result = read({ mode: "answer", job_ids: [22], observations: [
      { job_id: 22, source_message_id: "m1", kind: "availability", quote },
    ] }, forMessage(text), text);
    assert.equal(result.transition.kind, "pause");
    assert.equal(result.reply_text, null);
    assert.equal(result.consultation, undefined);
  });
}

for (const { text, quote, kind } of [
  { text: "강남은 관심 없어요", quote: "강남은 관심 없어요", kind: "interest" },
  { text: "강남은 관심 없어요", quote: "강남은 관심", kind: "interest" },
  { text: "강남은 지원하고 싶지 않아요", quote: "강남은 지원하고 싶지 않아요", kind: "interest" },
  { text: "강남은 지원하고 싶지 않아요", quote: "강남은 지원", kind: "interest" },
  { text: "강남은 월요일 불가능해요", quote: "강남은 월요일 불가능해요", kind: "availability" },
  { text: "강남은 월요일 가능하지 않아요", quote: "강남은 월요일 가능", kind: "availability" },
  { text: "강남은 주말에 못 가요", quote: "강남은 주말에 못 가요", kind: "availability" },
  { text: "강남은 주말에 어려워요", quote: "강남은 주말에 어려워요", kind: "availability" },
  { text: "강남 지원 가능한가요", quote: "강남 지원 가능한가요", kind: "interest" },
  { text: "강남은 월요일 가능할까요?", quote: "강남은 월요일 가능", kind: "availability" },
  { text: "강남 월요일 가능?", quote: "강남 월요일 가능", kind: "availability" },
]) {
  test(`does not save a positive ${kind} observation from: ${text} / ${quote}`, () => {
    const result = read({ mode: "answer", job_ids: [22], observations: [
      { job_id: 22, source_message_id: "m1", kind, quote },
    ] }, forMessage(text), text);
    assert.equal(result.transition.kind, "pause");
    assert.equal(result.reply_text, null);
    assert.equal(result.consultation, undefined);
  });
}

for (const { text, quote, kind } of [
  { text: "성수는 어렵지만 강남은 월요일 가능해요", quote: "강남은 월요일 가능해요", kind: "availability" },
  { text: "성수는 관심 없지만 강남은 관심 있어요", quote: "강남은 관심 있어요", kind: "interest" },
  { text: "성수는 관심 없고 강남은 관심 있어요", quote: "강남은 관심 있어요", kind: "interest" },
  { text: "강남은 월요일 일이 없어서 가능해요", quote: "강남은 월요일 일이 없어서 가능해요", kind: "availability" },
  { text: "강남은 어려운 업무도 가능해요", quote: "강남은 어려운 업무도 가능해요", kind: "availability" },
  { text: "강남은 월요일 근무가 어렵지 않아요", quote: "강남은 월요일 근무가 어렵지 않아요", kind: "availability" },
  { text: "강남 관심 있어요. 차량 없어도 되나요?", quote: "강남 관심 있어요.", kind: "interest" },
  { text: "성수와 강남 둘 다 월요일 가능해요", quote: "성수와 강남 둘 다 월요일 가능해요", kind: "availability" },
]) {
  test(`preserves explicit positive evidence despite other clauses: ${text}`, () => {
    const result = read({ mode: "answer", job_ids: [22], observations: [
      { job_id: 22, source_message_id: "m1", kind, quote },
    ] }, forMessage(text), text);
    assert.equal(result.transition.kind, "stay");
    assert.equal(result.consultation.observations[0].quote, quote);
  });
}

for (const text of ["22번 공고는 자차 있어요", "공고 22는 자차 있어요", "#22 자차 있어요", "999번 공고는 자차 있어요"]) {
  test(`explicit numeric reference cannot progress another current job: ${text}`, () => {
    const result = read({ mode: "current", job_ids: [11] }, forMessage(text), text);
    assert.equal(result?.transition.kind, "pause");
    assert.equal(result?.reply_text, null);
  });
}

for (const text of ["11번 공고는 자차 있어요", "성수는 22시 가능해요", "성수 공고 자차와 운전면허 모두 있어요", "성수 공고 체크리스트 모두 확인했어요"]) {
  test(`current-job progress does not confuse quantities or checklist completion with job comparison: ${text}`, () => {
    assert.equal(read({ mode: "current", job_ids: [11] }, forMessage(text), text), null);
  });
}

for (const text of ["공고 모두 가능해요", "모든 공고 가능해요"]) {
  test(`all-job availability cannot progress only the current job: ${text}`, () => {
    const result = read({ mode: "current", job_ids: [11] }, forMessage(text), text);
    assert.equal(result?.transition.kind, "pause");
  });
}

test("clarification about explicitly named jobs asks for conditions without requiring one job selection", () => {
  const text = "성수와 강남 근무시간 각각 알려주세요";
  const result = read({ mode: "clarify", job_ids: [11, 22] }, forMessage(text), text);
  assert.match(result.reply_text, /성수 오전 배송/);
  assert.match(result.reply_text, /강남 오후 배송/);
  assert.match(result.reply_text, /조건/);
  assert.doesNotMatch(result.reply_text, /어느 공고|중 하나|선택/);
  assert.equal(result.transition.kind, "stay");
  assert.deepEqual(result.consultation.observations, []);
});

test("an ambiguous acknowledgement still asks which jobs it concerns", () => {
  const text = "네 가능해요";
  const result = read({ mode: "clarify", job_ids: [11, 22] }, forMessage(text), text);
  assert.match(result.reply_text, /어느 공고/);
  assert.equal(result.consultation.clarification, true);
});

test("an ambiguous reply cannot progress the only remaining visible job", () => {
  const text = "네 가능해요";
  const context = forMessage(text);
  context.consultation!.jobs = [context.consultation!.jobs[0]];
  context.consultation!.ambiguousFollowup = true;
  const result = read({ mode: "current", job_ids: [11] }, context, text);
  assert.equal(result?.transition.kind, "pause");
  const clarification = read({ mode: "clarify", job_ids: [11] }, context, text);
  assert.equal(clarification?.consultation?.clarification, true);
  const tool = mod.withConsultationTool({ input_schema: { properties: {}, required: [] } }, context);
  assert.ok(tool.input_schema.required.includes("consultation"));
});

test("an explicit remaining job name resolves an earlier ambiguous followup without forcing consultation", () => {
  const text = "성수 공고에 지원할게요";
  const context = forMessage(text);
  context.consultation!.jobs = [context.consultation!.jobs[0]];
  context.consultation!.ambiguousFollowup = true;
  assert.equal(read({ mode: "current", job_ids: [11] }, context, text), null);
});
