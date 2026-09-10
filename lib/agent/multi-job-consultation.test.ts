import assert from "node:assert/strict";
import test from "node:test";
import type { StageContext } from "./types";
import { hasNoAnswerableFacts } from "./cross-job.ts";

const path = "./multi-job-consultation.ts";
const mod = await import(path).catch(() => ({}));
const ctx = (): StageContext => ({
  job: { id: 11, title: "성수 오전 배송" }, applicant: { id: 7, marketing_consent: true }, history: [],
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

test("수거 미기재 안내만으로 조건이 비어 있는 다른 공고의 백스톱을 해제하지 않는다", () => {
  assert.equal(hasNoAnswerableFacts({ job_id: 11, title: "배송 모집", body: "배송원 모집합니다.", branch: null, stage: "exploration", vehicle_required: true }), true);
});

test("수거 방식은 각 공고 원문 그대로 답하고 모델이 만든 반납 시간·장소는 보내지 않는다", () => {
  const text = "성수와 강남은 각각 가방을 어떻게 수거하나요?";
  const context = forMessage(text);
  const first = "배송하면서 전날 가방을 맞수거합니다.";
  const second = "당일 오후 재방문해 당일 가방을 수거합니다.";
  context.consultation!.jobs[0].body = `배송 안내\n${first}\n문의는 매니저에게 해주세요.`;
  context.consultation!.jobs[1].body = `업무 안내\n${second}`;
  const result = read({ mode: "answer", job_ids: [11, 22], answers: [{ job_id: 11, fields: ["수거·반납"] }, { job_id: 22, fields: ["수거·반납"] }], reply_text: "두 공고 모두 오후 3시 창고로 반납하세요." }, context, text);
  assert.equal(result.reply_text, `성수 오전 배송\n수거·반납: ${first}\n\n강남 오후 배송\n수거·반납: ${second}`);
  assert.equal(result.transition.kind, "stay");
});

test("수거 미기재는 공고의 기재 상태만 답하고 다른 공고·운영 메모·배송시간으로 메우지 않는다", () => {
  const text = "성수와 강남 가방 수거는요?";
  const context = forMessage(text);
  context.consultation!.jobs[0].body = "배송하면서 전날 가방을 맞수거합니다.";
  context.consultation!.jobs[1].body = "오후 배송 업무입니다.";
  context.consultation!.jobs[1].ai_facts = "수거·반납: 오후 3시 창고 반납";
  const result = read({ mode: "answer", job_ids: [11, 22], answers: [{ job_id: 11, fields: ["수거·반납"] }, { job_id: 22, fields: ["수거·반납"] }] }, context, text);
  assert.match(result.reply_text, /강남 오후 배송\n수거·반납: 이 공고에는 수거·반납 업무가 안내되어 있지 않아요/);
  assert.doesNotMatch(result.reply_text, /오후 3시|창고|13:00|수거.*없/);
  assert.equal(result.consultation.handoff, false);
  assert.equal(result.transition.kind, "stay");
});

test("수거 원문의 일부 배송지·반납 시각 미정은 보존하고 가방 날짜·상세 주소는 더하지 않는다", () => {
  const text = "성수 공고 가방 수거와 반납은 어떻게 하나요?";
  const context = forMessage(text);
  context.consultation!.jobs[0].body = "• 업무: 중식 배송, 일부 배송지 맞수거, 당일 서쪽 구역 반납까지 포함\n• 반납지: 가상시 검수로 123. 반납 완료 시각은 확인 후 안내드립니다.";
  const result = read({ mode: "answer", job_ids: [11], answers: [{ job_id: 11, fields: ["수거·반납"] }] }, context, text);
  assert.match(result.reply_text, /일부 배송지 맞수거, 당일 서쪽 구역 반납까지 포함/);
  assert.match(result.reply_text, /반납 완료 시각은 확인 후 안내드립니다/);
  assert.doesNotMatch(result.reply_text, /전날|당일 가방|검수로 123|재방문/);
});

test("수거만 물은 질문에 배송시간·집결지를 대신 대입하는 자동 답변을 보류한다", () => {
  const text = "성수 가방 수거는 몇 시에 어디서 하나요?";
  for (const fields of [["근무시간"], ["집결지(대략)"]]) {
    const result = read({ mode: "answer", job_ids: [11], answers: [{ job_id: 11, fields }] }, forMessage(text), text);
    assert.equal(result.reply_text, null);
    assert.equal(result.transition.kind, "pause");
  }
});

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

const regionInquiry = (quote = "인천이나 시흥 쪽 일자리는 없나요?", regions = ["인천", "시흥"]) => ({ source_message_id: "m1", quote, regions });

test("노출 공고 밖 지역 문의는 전체 서비스 부재를 단정하지 않고 후속 질문 없이 마친다", () => {
  const quote = "인천이나 시흥 쪽 일자리는 없나요?";
  const result = read({ mode: "region", job_ids: [], region_preferences: [regionInquiry()] }, forMessage(quote), quote);
  assert.equal(result.transition.kind, "stay");
  assert.match(result.reply_text, /현재 안내드릴 수 있는 공고/);
  assert.match(result.reply_text, /인천.*시흥/);
  assert.match(result.reply_text, /공고가 생기면.*안내/);
  assert.doesNotMatch(result.reply_text, /[?？]|서비스.*없|전국.*없|성수|강남|확정|가까|출퇴근.*가능/);
  assert.deepEqual(result.consultation.region_preferences, [regionInquiry()]);
  assert.deepEqual(result.consultation.observations, []);
  assert.deepEqual(result.state_update.screening, ctx().state.screening);
});

test("지역 문의와 실제 공고 질문·관심을 같은 응답에서 보존한다", () => {
  const quote = "인천 쪽 일자리 있나요?";
  const text = `${quote} 강남 오전 배송에 관심 있어요. 강남 근무시간은요?`;
  const context = forMessage(text);
  const result = read({ mode: "answer", job_ids: [22], region_preferences: [regionInquiry(quote, ["인천"])], answers: [{ job_id: 22, fields: ["근무시간"] }], observations: [{ job_id: 22, source_message_id: "m1", kind: "interest", quote: "강남 오전 배송에 관심 있어요" }] }, context, text);
  assert.equal(result.transition.kind, "stay");
  assert.match(result.reply_text, /인천/);
  assert.match(result.reply_text, /13:00~17:00/);
  assert.equal(result.consultation.observations.length, 1);
  assert.deepEqual(result.consultation.region_preferences[0].regions, ["인천"]);
});

test("실제 집결 지역 공고는 등록 시간·차량 조건을 비교 자료로만 제공한다", () => {
  const text = "경기 고양 쪽 일자리는 있나요?";
  const context = forMessage(text);
  context.consultation!.jobs[1] = { ...context.consultation!.jobs[1], title: "북부 배송", branch: "다른 지점명", pickup_address: "경기도 고양시 덕양구 비공개로 12", vehicle_required: true };
  const result = read({ mode: "region", job_ids: [], region_preferences: [regionInquiry(text, ["고양"])] }, context, text);
  assert.equal(result.transition.kind, "stay");
  assert.match(result.reply_text, /북부 배송/);
  assert.match(result.reply_text, /경기도 고양시/);
  assert.match(result.reply_text, /13:00~17:00/);
  assert.match(result.reply_text, /본인 차량.*필요/);
  assert.match(result.reply_text, /이동.*시간.*차량|시간.*차량.*이동/);
  assert.doesNotMatch(result.reply_text, /비공개로|덕양구|출퇴근.*가능|가까|확정|배정/);
});

for (const patch of [{ stage: "paused" }, { stage: "abort" }, { expired: true }, { pickup_address: null }, { slot: null }, { vehicle_required: null }]) test(`노출 범위 밖 또는 이동 판단 근거가 모자란 공고는 지역 대안으로 제안하지 않는다 ${JSON.stringify(patch)}`, () => {
  const text = "고양 쪽 일자리 있나요?";
  const context = forMessage(text);
  context.consultation!.jobs[1] = { ...context.consultation!.jobs[1], title: "고양 비공개 배송", pickup_address: "경기도 고양시 비밀 장소", ...patch } as NonNullable<StageContext["consultation"]>["jobs"][number];
  const result = read({ mode: "region", job_ids: [], region_preferences: [regionInquiry(text, ["고양"])] }, context, text);
  assert.equal(result.transition.kind, "stay");
  assert.doesNotMatch(result.reply_text, /고양 비공개 배송|비밀 장소|90,000|13:00/);
  assert.match(result.reply_text, /공고가 생기면/);
});

for (const signal of [
  regionInquiry("인천 쪽 일자리 있나요?", ["시흥"]),
  { ...regionInquiry(), source_message_id: "old-message" },
  regionInquiry("인천은 싫고 시흥 쪽 일자리 원해요", ["인천", "시흥"]),
  regionInquiry("친구가 인천 쪽 일자리 있냐고 물었어요", ["인천"]),
  regionInquiry("인천은 마감인가요?", ["인천"]),
]) test(`근거 없는 선호 지역은 기록과 발송을 차단한다 ${JSON.stringify(signal)}`, () => {
  const result = read({ mode: "region", job_ids: [], region_preferences: [signal] }, forMessage(signal.quote), signal.quote);
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.reply_text, null);
  assert.equal(result.consultation, undefined);
});

test("지역 요청이 있는 문자를 현재 공고 체크리스트로 잘못 진행하지 않는다", () => {
  const quote = "인천 쪽 일자리는 없나요?";
  const result = read({ mode: "current", job_ids: [11], region_preferences: [regionInquiry(quote, ["인천"])] }, forMessage(quote), quote);
  assert.equal(result.transition.kind, "pause");
});

test("단일 노출 공고의 지역 문의에서 누락된 region_preferences로 기존 단계에 빠지지 않는다", () => {
  const text = "인천 쪽 일자리는 없나요?";
  const context = forMessage(text);
  context.consultation!.jobs = context.consultation!.jobs.slice(0, 1);
  const result = read({ mode: "current", job_ids: [11] }, context, text);
  assert.equal(result?.transition.kind, "pause");
  assert.equal(result?.reply_text, null);
});

test("실제 인천·시흥 문의를 후속 수집 없이 마치며 두 지역 원문을 보존한다", () => {
  const text = "혹시 인천이나 시흥쪽에는 없을까요";
  const context = forMessage(text);
  context.consultation!.jobs = context.consultation!.jobs.slice(0, 1);
  const result = read({ mode: "region", job_ids: [], region_preferences: [regionInquiry(text)] }, context, text);
  assert.equal(result?.transition.kind, "stay");
  assert.deepEqual(result.consultation.region_preferences[0], regionInquiry(text));
  assert.match(result.reply_text, /공고가 생기면.*안내/);
  assert.doesNotMatch(result.reply_text, /[?？]|어느 공고|성수/);
});

for (const consent of [false, null]) test(`마케팅 동의 없는 지역 문의는 연락 약속이나 동의 수집 없이 마친다 ${consent}`, () => {
  const text = "혹시 인천이나 시흥쪽에는 없을까요";
  const context = forMessage(text);
  context.applicant.marketing_consent = consent;
  const result = read({ mode: "region", job_ids: [], region_preferences: [regionInquiry(text)] }, context, text);
  assert.equal(result.transition.kind, "stay");
  assert.doesNotMatch(result.reply_text, /생기면|안내드릴게요|연락드릴|동의|[?？]/);
  assert.match(result.reply_text, /감사합니다/);
  assert.deepEqual(result.consultation.region_preferences[0].regions, ["인천", "시흥"]);
  assert.equal(result.applicant_patch, undefined);
});

test("등록된 교육 안내가 있는 공고의 검증된 관심 다음에는 선탑 의사를 묻는다", () => {
  const text = "성수에 관심 있어요";
  const context = forMessage(text);
  context.consultation!.jobs[0].ai_facts = "선탑·교육: 배송 동승 교육, 가능한 시간은 매니저와 조율";
  const result = read({ mode: "answer", job_ids: [11], observations: [{ job_id: 11, source_message_id: "m1", kind: "interest", quote: text }] }, context, text);
  assert.equal(result.transition.kind, "stay");
  assert.match(result.reply_text, /배송 동승 교육/);
  assert.match(result.reply_text, /선탑 참여를 희망하시나요/);
});

test("지역 문의와 관심을 함께 보낸 경우 질문 답변 뒤 무관한 교육 수집을 붙이지 않는다", () => {
  const text = "혹시 인천이나 시흥쪽에는 없을까요. 성수에 관심 있어요";
  const context = forMessage(text);
  context.consultation!.jobs[0].ai_facts = "선탑·교육: 배송 동승 교육, 가능한 시간은 매니저와 조율";
  const result = read({ mode: "answer", job_ids: [11], region_preferences: [regionInquiry("혹시 인천이나 시흥쪽에는 없을까요")], observations: [{ job_id: 11, source_message_id: "m1", kind: "interest", quote: "성수에 관심 있어요" }] }, context, text);
  assert.equal(result.transition.kind, "stay");
  assert.doesNotMatch(result.reply_text, /선탑 참여를 희망하시나요/);
  assert.equal(result.consultation.observations.length, 1);
});

test("지역 모드가 별도로 명시된 공고의 질문을 누락하면 발송과 기록을 보류한다", () => {
  const text = "인천 쪽 일자리는 없나요? 강남 근무시간은요?";
  const result = read({ mode: "region", job_ids: [], region_preferences: [regionInquiry("인천 쪽 일자리는 없나요?", ["인천"])] }, forMessage(text), text);
  assert.equal(result.transition.kind, "pause");
  assert.equal(result.reply_text, null);
  assert.equal(result.consultation, undefined);
});

test("안내 번호를 다시 확인하더라도 같은 문자의 검증된 지역 문의는 보존한다", () => {
  const text = "인천 쪽 일자리 있나요? 1번에 관심 있어요";
  const context = numberedContext(text);
  context.consultation!.numberedReferences = [];
  const result = read({ mode: "answer", job_ids: [11], region_preferences: [regionInquiry("인천 쪽 일자리 있나요?", ["인천"])], observations: [{ job_id: 11, source_message_id: "m1", kind: "interest", quote: "1번에 관심 있어요" }] }, context, text);
  assert.equal(result.transition.kind, "stay");
  assert.equal(result.consultation.clarification, true);
  assert.deepEqual(result.consultation.region_preferences[0].regions, ["인천"]);
  assert.match(result.reply_text, /어느 공고/);
});
