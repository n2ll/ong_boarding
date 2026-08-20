import assert from "node:assert/strict";
import test from "node:test";

async function loadPoolStatusModule(): Promise<Record<string, unknown>> {
  const modulePath = "./pool-status.ts";
  return await import(modulePath) as Record<string, unknown>;
}

test("candidate stages map to distinct applicant-facing states", async () => {
  const poolStatusModule = await loadPoolStatusModule();
  const poolJobStatus = poolStatusModule.poolJobStatus as
    (hasLink: boolean, stage: string | null | undefined) => string;

  assert.equal(poolJobStatus(false, null), "none");
  assert.equal(poolJobStatus(true, null), "interested");
  assert.equal(poolJobStatus(true, "screening"), "talking");
  assert.equal(poolJobStatus(true, "paused"), "paused");
  assert.equal(poolJobStatus(true, "abort"), "ended");
});

test("status labels avoid structural emoji and employment-confirmation wording", async () => {
  const poolStatusModule = await loadPoolStatusModule();
  const POOL_STATUS_DONE_LABEL = poolStatusModule.POOL_STATUS_DONE_LABEL as Record<string, string>;
  const labels = Object.values(POOL_STATUS_DONE_LABEL);
  const forbiddenConfirmation = /(확정|배정|합격|출근|시작하세요)/;
  const structuralEmoji = /[✓💬⚡⏰🔔]/u;
  const unguaranteedContactPromise = /(?:먼저\s*)?연락(?:드릴|드립니다|할게요)/;

  for (const label of labels) {
    assert.doesNotMatch(label, structuralEmoji);
    assert.doesNotMatch(label, forbiddenConfirmation);
    assert.doesNotMatch(label, unguaranteedContactPromise);
  }
});
