import assert from "node:assert/strict";
import test from "node:test";
import { shouldSuppressConversationReply } from "./conversation-closing.ts";
import type { ConversationTurn } from "./types";

const turn = (direction: "inbound" | "outbound", body: string): ConversationTurn => ({ direction, body, created_at: "2026-09-09T00:00:00Z" });
const waiting = [turn("outbound", "어떤 차종으로 운행 가능하세요? 알려주세요.")];
const closing = [turn("outbound", "확인했습니다. 일정은 매니저가 확인한 뒤 안내드릴게요.")];

for (const body of ["오늘은 여기까지 할게요", "대화는 그만할게요", "나중에요", "제가 연락드릴게요", "지금은 바빠요. 나중에 연락할게요", "22일 가능합니다. 제가 다시 연락드릴게요", "네 감사합니다. 다음에 이야기할게요"]) {
  test(`explicit conversation close silences further replies: ${body}`, () => assert.equal(shouldSuppressConversationReply(body, waiting), true));
}
for (const body of ["네", "감사합니다", "네 감사합니다~", "알겠습니다.", "넵 고맙습니다"]) {
  test(`acknowledgement after final information needs no further reply: ${body}`, () => assert.equal(shouldSuppressConversationReply(body, closing), true));
}
for (const body of ["네", "감사합니다", "알겠습니다", "아니요", "괜찮습니다", "22일 가능해요", "차가 없어요"]) {
  test(`an answer to a real request still processes normally: ${body}`, () => assert.equal(shouldSuppressConversationReply(body, waiting), false));
}
for (const body of ["교육은 나중에 받아도 되나요?", "제가 연락드릴게요. 그런데 교육비는 얼마인가요", "감사합니다. 장소는 어디예요?", "나중에 전화 주실 수 있나요", "22일 가능해요"]) {
  test(`substantive new content is not treated as an acknowledgement: ${body}`, () => assert.equal(shouldSuppressConversationReply(body, closing), false));
}
test("an acknowledgement after an explicit close remains quiet despite the older question", () => {
  assert.equal(shouldSuppressConversationReply("감사합니다", [...waiting, turn("inbound", "제가 연락드릴게요")]), true);
  assert.equal(shouldSuppressConversationReply("교육비는 얼마인가요?", [...waiting, turn("inbound", "제가 연락드릴게요")]), false);
});
test("unanswered intervening question or information does not make a reply redundant", () => {
  assert.equal(shouldSuppressConversationReply("네", [...closing, turn("inbound", "22일 가능합니다")]), false);
  assert.equal(shouldSuppressConversationReply("감사합니다", [...closing, turn("inbound", "장소가 어디인가요?")]), false);
});
test("a short reply without context stays available to the stage", () => assert.equal(shouldSuppressConversationReply("네", []), false));
for (const body of ["문자 안내에 동의하시면 네라고 회신해 주세요.", "차종을 알려주세요.", "가능 날짜를 부탁드립니다.", "신청 여부를 확인해 주시겠어요", "새 일자리 문자 안내를 받아보시겠어요"]) {
  test(`a request without punctuation is not a closing: ${body}`, () => assert.equal(shouldSuppressConversationReply("네", [turn("outbound", body)]), false));
}

import { canSkipConversationProcessing } from "./conversation-closing.ts";
for (const body of ["나중에요", "제가 연락드릴게요", "네 감사합니다", "오늘은 여기까지 할게요"]) {
  test(`a pure closing needs no model processing: ${body}`, () => assert.equal(canSkipConversationProcessing(body, closing), true));
}
for (const body of ["22일 가능합니다. 제가 연락드릴게요", "이번 공고는 안 할게요. 제가 연락드릴게요", "네", "감사합니다"]) {
  test(`actual answers or mixed information still reach the stage: ${body}`, () => assert.equal(canSkipConversationProcessing(body, waiting), false));
}
test("a pure closing does not discard earlier unanswered information", () => {
  assert.equal(canSkipConversationProcessing("제가 연락드릴게요", [...closing, turn("inbound", "22일 가능해요")]), false);
});
