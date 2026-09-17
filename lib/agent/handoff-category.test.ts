import test from "node:test";
import assert from "node:assert/strict";
import { classifyHandoff, getCategory } from "./handoff-category.ts";

test("provider length failures are delivery issues, not missing job policy", () => {
  const result = classifyHandoff("SMS 발송 실패: 발송 등록 실패: SMS는 90byte LMS, MMS는 2000byte까지 사용 가능 합니다.");
  assert.equal(result.id, "delivery");
  assert.doesNotMatch(result.action, /공고|정책/);
  assert.match(result.action, /발송/);
});

test("delivery audit failures and model handoffs stay distinct", () => {
  assert.equal(classifyHandoff("SMS 발송 후 원장 저장 실패 — 공급자 결과 확인 필요").id, "delivery");
  assert.equal(classifyHandoff("매니저 직접 응답 — 자동 전환").id, "auto");
  assert.equal(getCategory("delivery").label, "문자 발송");
});
