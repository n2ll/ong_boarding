import assert from "node:assert/strict";
import test from "node:test";

async function classify(input: Record<string, unknown>) {
  const module = await import(new URL("./handoff-disposition.ts", import.meta.url).href).catch(() => ({}));
  assert.equal(typeof module.getHandoffDisposition, "function", "the shared queue classification is available");
  return module.getHandoffDisposition(input);
}

test("only explicit manager stops and review fixtures leave the action queue", async () => {
  for (const input of [
    { paused_reason: "매니저 수동 일시정지", agent_state: { meta: { pause: { category: "complaint" } } } },
    { paused_reason: "관리자 자동 응대 검수 종료" },
    { paused_reason: "본인 한정 자동 응대 검수 종료" },
    { job_title: "[검수] 새벽 배송", paused_reason: "단가 확인 필요" },
    { job_title: "[검수 0907] 낮 배송", paused_reason: "매니저 직접 응답 — 자동 전환" },
    { job_title: "[운영 검증] 비공개 E2E 테스트", paused_reason: null },
  ]) {
    const result = await classify(input);
    assert.equal(result.state, "intentional_pause", JSON.stringify(input));
    assert.ok(result.holdLabel);
    assert.ok(result.holdReason);
  }
});

test("unclear reasons, live manual conversations and ordinary test wording remain actionable", async () => {
  for (const input of [
    {}, { paused_reason: "매니저 직접 응답 — 자동 전환" },
    { paused_reason: "매니저 수동 일시정지 후 추가 문의" },
    { paused_reason: "검수 종료 여부를 문의함" },
    { job_title: "테스트 배송" }, { job_title: "E2E 테스트" },
    { job_title: "[운영 검증] 실제 배송" }, { job_title: "배송 [검수]" },
    { agent_state: { meta: { pause: { category: "manual" } } } },
    { agent_state: { meta: { pause: { category: "auto" } } } },
  ]) assert.equal((await classify(input)).state, "action_required", JSON.stringify(input));
});

test("dated completion resolves legacy pauses and only the current known pause", async () => {
  const pausedAt = "2026-09-09T01:00:00Z";
  for (const [resolved, paused_at, expected] of [
    [{ at: "2026-09-09T02:00:00Z" }, pausedAt, "resolved"],
    [{ at: pausedAt }, pausedAt, "resolved"],
    [{ at: "2026-09-08T01:00:00Z" }, pausedAt, "action_required"],
    [{ outcome: "done" }, pausedAt, "action_required"],
    [{ at: "invalid" }, pausedAt, "action_required"],
    [{ at: "2026-09-09T02:00:00Z" }, "invalid", "action_required"],
    [{ at: "2026-09-09T02:00:00Z" }, undefined, "resolved"],
    [{ at: "2026-09-09T02:00:00Z" }, null, "resolved"],
    [true, pausedAt, "action_required"],
  ] as const) {
    assert.equal((await classify({ agent_state: { meta: { paused_at, handoff_resolved: resolved } } })).state, expected);
  }
});

test("manager guidance preserves emitted actions and checks cross-job evidence before replying", async () => {
  const direct = await classify({ paused_reason: "매니저 직접 응답 — 자동 전환", agent_state: { meta: { pause: { category: "pay", suggested_action: "옛 급여 문의 확인" } } } });
  assert.equal(direct.state, "action_required");
  assert.equal(direct.category.id, "auto");
  assert.match(direct.suggestedAction, /추가 문의/);
  const emitted = await classify({ paused_reason: "단가 문의", agent_state: { meta: { pause: { category: "pay", suggested_action: "건당 비용을 확인해 회신" } } } });
  assert.equal(emitted.category.id, "pay");
  assert.equal(emitted.suggestedAction, "건당 비용을 확인해 회신");
  const auto = await classify({ paused_reason: "매니저 직접 응답 — 자동 전환" });
  assert.match(auto.suggestedAction, /추가 문의/);
  assert.match(auto.suggestedAction, /답변|처리 완료/);
  assert.doesNotMatch(auto.suggestedAction, /AI 재개/);
  const validation = await classify({ paused_reason: "복수 공고 상담 검증 실패: 근거 불일치" });
  assert.equal(validation.category.id, "cross_job");
  assert.match(validation.suggestedAction, /원문|근거/);
  assert.match(validation.suggestedAction, /공고별/);
  assert.doesNotMatch(validation.suggestedAction, /담당.*인계/);
});
