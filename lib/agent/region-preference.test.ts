import assert from "node:assert/strict";
import test from "node:test";

const modulePath = "./region-preference.ts";
const mod = await import(modulePath).catch(() => ({}));
function validate(body: string, regions: string[], quote = body) {
  assert.equal(typeof mod.validateRegionPreferences, "function");
  return mod.validateRegionPreferences([{ source_message_id: "m1", quote, regions }], [{ id: "m1", body, created_at: "2026-09-10T00:00:00Z" }]);
}

test("지역 사전 없이 새 지역 원문을 검증하고 기존 질문과 명시 선호를 허용한다", () => {
  for (const text of ["충청북도 제천 쪽 일자리 있나요?", "충청북도 제천에서 일하고 싶어요", "희망 지역은 충청북도 제천입니다"]) {
    assert.deepEqual(validate(text, ["충청북도 제천"])?.[0].regions, ["충청북도 제천"]);
  }
});

test("부정한 지역을 잘라내도 원문 절을 확인해 선호로 기록하지 않는다", () => {
  assert.equal(validate("인천은 원하지 않아요. 시흥 쪽 일자리 원해요", ["인천"], "인천"), null);
  assert.equal(validate("인천은 싫고 시흥 쪽 일자리 원해요", ["인천"], "인천"), null);
  assert.deepEqual(validate("인천은 싫고 시흥 쪽 일자리 원해요", ["시흥"], "시흥 쪽 일자리 원해요")?.[0].regions, ["시흥"]);
});

test("출신·거주·타인 질문·가정·마감 질문만으로 새 선호를 만들지 않는다", () => {
  for (const text of ["인천 출신이에요", "인천에 살아요", "친구가 인천 쪽 일자리 있나요? 라고 물었어요", "만약 인천 쪽 일자리 있으면 친구가 가나요?", "인천은 마감인가요?"]) {
    assert.equal(validate(text, ["인천"]), null, text);
  }
});

test("원문 지역의 일부만 취하거나 새 지역·요약을 만들어내면 거부한다", () => {
  assert.equal(validate("인천 쪽 일자리 있나요?", ["인"]), null);
  assert.equal(validate("경기도 안양시 쪽 일자리 있나요?", ["양시"]), null);
  assert.equal(validate("경기도 안양시 쪽 일자리 있나요?", ["서울"]), null);
  assert.equal(validate("경기도 안양시 쪽 일자리 있나요?", ["안양"], "안양에서 일하고 싶어요"), null);
});

test("단일 공고에서 지역 구직 문의는 상담으로 분기하고 인사·순수 조건 질문은 제외한다", () => {
  assert.equal(typeof mod.likelyRegionInquiry, "function");
  for (const text of ["인천이나 시흥은 공고 없나요?", "충청북도 제천에서 일하고 싶어요", "다른 지역 일자리도 있나요?", "희망 지역은 제천입니다"]) assert.equal(mod.likelyRegionInquiry(text), true, text);
  for (const text of ["감사합니다", "몇 시부터 일하나요?", "인천은 마감인가요?", "차량이 필요한가요?"]) assert.equal(mod.likelyRegionInquiry(text), false, text);
});

test("지역명 뒤의 다양한 조사와 미래 공고 안내 희망을 보존한다", () => {
  for (const [text, region] of [["인천이나 시흥에도 일자리 있나요?", "시흥"], ["시흥을 선호해요", "시흥"], ["시흥도 좋아요", "시흥"], ["제천 쪽 일자리 생기면 알려주세요", "제천"]]) {
    assert.deepEqual(validate(text, [region])?.[0].regions, [region], text);
  }
});

test("같은 지역을 말한 거주 문장 때문에 별도의 구직 문의 원문을 버리지 않는다", () => {
  const quote = "인천 쪽 일자리는 없나요?";
  assert.deepEqual(validate(`인천에 살아요. ${quote}`, ["인천"], quote)?.[0].regions, ["인천"]);
});

test("실제 수신 문자의 공고 명사 없는 지역 문의를 그대로 기록한다", () => {
  const text = "혹시 인천이나 시흥쪽에는 없을까요";
  assert.equal(mod.likelyRegionInquiry(text), true);
  assert.deepEqual(validate(text, ["인천", "시흥"]), [{ source_message_id: "m1", quote: text, regions: ["인천", "시흥"] }]);
});

test("부정 지역 뒤 직접 희망한 지역만 기록한다", () => {
  const text = "인천은 싫고 시흥 원해요";
  assert.deepEqual(validate(text, ["시흥"])?.[0].regions, ["시흥"]);
  assert.equal(validate(text, ["인천", "시흥"]), null);
});
