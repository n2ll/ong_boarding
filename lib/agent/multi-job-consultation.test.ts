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

test("one remaining job asks whether the reply refers to it without offering a plural choice", () => {
  const context = ctx();
  context.consultation!.jobs = context.consultation!.jobs.slice(0, 1);
  context.consultation!.ambiguousFollowup = true;
  context.consultation!.sourceMessages[0].body = "네";
  const result = read({ mode: "clarify", job_ids: [11] }, context, "네");
  assert.match(result.reply_text, /성수 오전 배송/);
  assert.match(result.reply_text, /대한 말씀인가요/);
  assert.doesNotMatch(result.reply_text, /중 어느|여러 공고라면/);
  assert.deepEqual(result.consultation.observations, []);
  assert.equal(result.transition.kind, "stay");
});

test("one explicitly named job asks for the missing question instead of asking to identify the job again", () => {
  const context = ctx();
  context.consultation!.sourceMessages[0].body = "성수 오전 배송이 궁금해요";
  const result = read({ mode: "clarify", job_ids: [11] }, context, "성수 오전 배송이 궁금해요");
  assert.match(result.reply_text, /어떤 조건/);
  assert.doesNotMatch(result.reply_text, /중 어느|대한 말씀인가요/);
  assert.deepEqual(result.consultation.observations, []);
});

test("missing facts are labelled for manager review instead of borrowed from another job", () => {
  const result = read({ mode: "answer", job_ids: [11, 22], answers: [{ job_id: 11, fields: ["급여"] }, { job_id: 22, fields: ["집결지(대략)"] }] });
  assert.match(result.reply_text, /70,000/);
  assert.match(result.reply_text, /집결지[\s\S]*확인 필요/);
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.consultation.handoff, true);
});

test("manager handoff preserves source questions instead of model claims of an unsent answer", () => {
  const text = "두 공고 주차비와 유류비는 지원하나요?";
  const result = read({ mode: "handoff", job_ids: [11, 22], reason: "유류비 개인 부담으로 직접 안내함" }, forMessage(text), text);
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.reply_text, "확인이 필요한 내용은 매니저에게 전달할게요.");
  for (const note of [result.transition.reason, result.reasoning, result.state_update.meta.last_reasoning]) {
    assert.match(note, /성수 오전 배송/);
    assert.match(note, /강남 오후 배송/);
    assert.ok(note.includes(text));
    assert.doesNotMatch(note, /직접 안내함|개인 부담/);
  }
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

function numberedContext(text = "1, 3번\n22일 가능"): StageContext {
  const context = forMessage(text);
  context.consultation!.jobs.push({ job_id: 33, candidate_id: 3, title: "용산 배송", branch: "용산", stage: "exploration", expired: false });
  context.consultation!.numberedReferences = [{ source_message_id: "notice-1", created_at: "2026-09-05T01:00:00Z", options: [
    { number: 1, job_id: 11, label: "성수" }, { number: 2, job_id: 22, label: "강남" }, { number: 3, job_id: 33, label: "용산" },
  ] }];
  return context;
}

test("번호 답장은 실제 안내의 번호로 두 공고에 연결하며 원문 줄바꿈과 단계를 보존한다", () => {
  const context = numberedContext();
  const text = context.consultation!.sourceMessages[0].body;
  const result = read({ mode: "answer", job_ids: [11, 33], observations: [11, 33].map((job_id) => ({ job_id, source_message_id: "m1", kind: "availability", quote: text })) }, context, text);
  assert.deepEqual(result.consultation.observations.map((item: { job_id: number }) => item.job_id), [11, 33]);
  assert.ok(result.consultation.observations.every((item: { quote: string }) => item.quote === text));
  assert.equal(result.transition.kind, "stay");
  assert.deepEqual(result.state_update.screening, context.state.screening);
  assert.equal(result.applicant_patch, undefined);
  assert.match(result.reply_text, /매니저가 확인 후 안내/);
  assert.doesNotMatch(result.reply_text, /확정(?:입니다|됐)|배정(?:됐|되었습니다)/);
});

test("원문 인용이 정확해도 번호에서 선택하지 않은 공고에는 가용성을 기록하지 않는다", () => {
  const context = numberedContext();
  const result = read({ mode: "answer", job_ids: [22], observations: [{ job_id: 22, source_message_id: "m1", kind: "availability", quote: "22일 가능" }] }, context, context.consultation!.sourceMessages[0].body);
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.consultation, undefined);
  assert.match(result.transition.reason, /번호.*대상/);
});

test("번호 대응 근거가 없으면 모델이 공고 순서를 추측해도 재확인하고 기록하지 않는다", () => {
  const context = numberedContext();
  context.consultation!.numberedReferences = [];
  const result = read({ mode: "answer", job_ids: [11, 33], observations: [{ job_id: 11, source_message_id: "m1", kind: "availability", quote: "22일 가능" }] }, context, context.consultation!.sourceMessages[0].body);
  assert.equal(result.transition.kind, "stay");
  assert.equal(result.consultation.clarification, true);
  assert.deepEqual(result.consultation.observations, []);
  assert.match(result.reply_text, /어느 공고/);
});

test("번호 답장은 현재 공고 절차로 진행하지 않는다", () => {
  const context = numberedContext();
  assert.equal(read({ mode: "current", job_ids: [11] }, context, context.consultation!.sourceMessages[0].body)?.transition.kind, "pause");
});

test("수신 문자 ID 오류와 인용 변형을 구분하고 원문 검증을 유지한다", () => {
  for (const [source_message_id, quote, reason] of [
    ["wrong-source", "22일 가능", /수신 문자 ID/],
    ["m1", "1, 3번 22일 가능", /수신 문자에 없는 원문/],
    ["m1", "성수 22일 가능", /수신 문자에 없는 원문/],
  ] as const) {
    const context = numberedContext();
    const result = read({ mode: "answer", job_ids: [11], observations: [{ job_id: 11, source_message_id, kind: "availability", quote }] }, context, context.consultation!.sourceMessages[0].body);
    assert.equal(result.transition.kind, "pause");
    assert.equal(result.reply_text, null);
    assert.match(result.transition.reason, reason);
  }
});

test("번호 선택과 별도로 이름을 명시한 공고의 질문도 함께 답한다", () => {
  const text = "1번 22일 가능. 강남 근무시간은요?";
  const context = numberedContext(text);
  const result = read({ mode: "answer", job_ids: [11, 22], answers: [{ job_id: 22, fields: ["근무시간"] }], observations: [
    { job_id: 11, source_message_id: "m1", kind: "availability", quote: "1번 22일 가능" },
  ] }, context, text);
  assert.equal(result.transition.kind, "stay");
  assert.deepEqual(result.consultation.observations.map((item: { job_id: number }) => item.job_id), [11]);
  assert.match(result.reply_text, /13:00~17:00/);
});

test("번호 근거가 없는 인계 판단도 공고별 가용성을 저장하지 않는다", () => {
  const context = numberedContext();
  context.consultation!.numberedReferences = [];
  const result = read({ mode: "handoff", job_ids: [11], observations: [{ job_id: 11, source_message_id: "m1", kind: "availability", quote: "22일 가능" }] }, context, context.consultation!.sourceMessages[0].body);
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.consultation, undefined);
});

test("연속 수신마다 번호를 검증해 다른 원문의 선택에 긍정 발언을 붙이지 않는다", () => {
  const context = numberedContext("1번 가능");
  context.consultation!.sourceMessages.push({ id: "m2", body: "3번 불가", created_at: "2026-09-06T01:00:01Z" });
  const result = read({ mode: "answer", job_ids: [11, 33], observations: [{ job_id: 33, source_message_id: "m1", kind: "availability", quote: "1번 가능" }] }, context, "3번 불가");
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.consultation, undefined);
});

test("실제 번호 안내가 있을 때 '1번 공고'는 안내 번호로 해석한다", () => {
  const text = "1번 공고 22일 가능";
  const context = numberedContext(text);
  const result = read({ mode: "answer", job_ids: [11], observations: [{ job_id: 11, source_message_id: "m1", kind: "availability", quote: text }] }, context, text);
  assert.equal(result.transition.kind, "stay");
  assert.deepEqual(result.consultation.observations.map((item: { job_id: number }) => item.job_id), [11]);
});

test("a past interest quote attached to the new question's source ID cannot be sent or recorded", () => {
  const text = "성수와 강남의 시간과 급여 알려주세요";
  const context = forMessage(text);
  context.history = [{ direction: "inbound", body: "성수 배송 관심 있어요", created_at: "2026-09-05T01:00:00Z" }];
  const result = read({ mode: "answer", job_ids: [11, 22],
    answers: [{ job_id: 11, fields: ["근무시간", "급여"] }, { job_id: 22, fields: ["근무시간", "급여"] }],
    observations: [{ job_id: 11, source_message_id: "m1", kind: "interest", quote: "성수 배송 관심 있어요" }],
  }, context, text);
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.reply_text, null);
  assert.equal(result.consultation, undefined);
  assert.equal(result.applicant_patch, undefined);
});

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

test("training questions use the job's explicit training facts instead of delivery hours", () => {
  const context = ctx();
  const text = "네 교육일정과 시간, 교육비도 궁금합니다";
  context.consultation!.sourceMessages[0].body = text;
  context.consultation!.jobs[0].ai_facts = "다른 운영 참고.\n선탑·교육: 앱 사용과 업무를 익히는 동승교육. 9월 셋째 주 예정, 소요시간 확인 후 안내. 교육비 3만 원은 백업 대금에 합산해 익월 5일 지급.\n다른 내부 참고.";
  const result = read({ mode: "answer", job_ids: [11], answers: [{ job_id: 11, fields: ["선탑·교육"] }] }, context, text);
  assert.equal(result.transition.kind, "stay");
  assert.match(result.reply_text, /9월 셋째 주/);
  assert.match(result.reply_text, /소요시간 확인 후 안내/);
  assert.match(result.reply_text, /3만 원.*익월 5일/);
  assert.doesNotMatch(result.reply_text, /09:00~12:00|다른 내부 참고/);
});

test("a model cannot answer a training-only question with delivery hours and pay", () => {
  const context = ctx();
  const text = "네 교육일정과 시간, 교육비도 궁금합니다";
  context.consultation!.sourceMessages[0].body = text;
  const result = read({ mode: "answer", job_ids: [11], answers: [{ job_id: 11, fields: ["근무시간", "급여"] }] }, context, text);
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.reply_text, null);
});

test("unregistered training details cannot be inferred from delivery facts", () => {
  const context = ctx();
  context.consultation!.jobs[0].ai_facts = "배송시간 09:00~12:00. 교육비는 임의로 계산하지 말 것.";
  const text = "선탑 시간은요?";
  context.consultation!.sourceMessages[0].body = text;
  const result = read({ mode: "answer", job_ids: [11], answers: [{ job_id: 11, fields: ["선탑·교육"] }] }, context, text);
  assert.equal(result.transition.kind, "pause");
  assert.match(result.reply_text, /선탑·교육: 매니저 확인 필요/);
  assert.doesNotMatch(result.reply_text, /09:00~12:00/);
});

test("agreeing to training does not block a separate delivery pay question", () => {
  const context = ctx();
  const text = "교육은 가능합니다. 배송 대금은 얼마인가요?";
  context.consultation!.sourceMessages[0].body = text;
  const result = read({ mode: "answer", job_ids: [11], answers: [{ job_id: 11, fields: ["급여"] }] }, context, text);
  assert.equal(result.transition.kind, "stay");
  assert.match(result.reply_text, /70,000/);
});

test("malformed training answer fields are rejected without throwing", () => {
  const context = ctx();
  const text = "교육시간 궁금합니다";
  context.consultation!.sourceMessages[0].body = text;
  const result = read({ mode: "answer", job_ids: [11], answers: [{ job_id: 11, fields: "근무시간" }] }, context, text);
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.reply_text, null);
});

test("an empty training header never exposes the following internal note", () => {
  const context = ctx();
  const text = "교육 시간은요?";
  context.consultation!.sourceMessages[0].body = text;
  context.consultation!.jobs[0].ai_facts = "선탑·교육:\n내부 메모: 협의 중인 비공개 장소";
  const result = read({ mode: "answer", job_ids: [11], answers: [{ job_id: 11, fields: ["선탑·교육"] }] }, context, text);
  assert.equal(result.transition.kind, "pause");
  assert.match(result.reply_text, /매니저 확인 필요/);
  assert.doesNotMatch(result.reply_text, /내부 메모|비공개 장소/);
});

test("training-only questions with a verb cannot be substituted with delivery facts", () => {
  const context = ctx();
  const text = "교육을 받는 시간과 비용이 궁금해요";
  context.consultation!.sourceMessages[0].body = text;
  const result = read({ mode: "answer", job_ids: [11], answers: [{ job_id: 11, fields: ["근무시간", "급여"] }] }, context, text);
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.reply_text, null);
});
