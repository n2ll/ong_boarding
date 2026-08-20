import assert from "node:assert/strict";
import test from "node:test";

type AttentionMeta = {
  label: string;
  description: string;
};

type ConfirmationAction = {
  label: string;
  disabled: boolean;
  intent: "confirm" | "undo" | "blocked";
};

async function loadDetailModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./applicant-detail.js";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("a paused conversation becomes an explicit manager-attention task", async () => {
  const detail = await loadDetailModule();
  const applicantAttentionMeta = detail.applicantAttentionMeta as
    | ((stage: string | null, reason: string | null) => AttentionMeta | null)
    | undefined;

  assert.equal(typeof applicantAttentionMeta, "function");
  assert.deepEqual(
    applicantAttentionMeta!("paused", "지원자가 근무 시간을 다시 물었어요"),
    {
      label: "사람 확인 필요",
      description: "지원자가 근무 시간을 다시 물었어요",
    },
  );
  assert.equal(applicantAttentionMeta!("screening", null), null);
});

test("confirmation is blocked when there is no eligible job", async () => {
  const detail = await loadDetailModule();
  const applicantConfirmationAction = detail.applicantConfirmationAction as
    | ((status: string, confirmableJobCount: number) => ConfirmationAction)
    | undefined;

  assert.equal(typeof applicantConfirmationAction, "function");
  assert.deepEqual(
    applicantConfirmationAction!("스크리닝 중", 0),
    { label: "확정할 공고 없음", disabled: true, intent: "blocked" },
  );
  assert.deepEqual(
    applicantConfirmationAction!("스크리닝 완료", 2),
    { label: "확정", disabled: false, intent: "confirm" },
  );
});

test("an already confirmed applicant exposes the correction action", async () => {
  const detail = await loadDetailModule();
  const applicantConfirmationAction = detail.applicantConfirmationAction as
    | ((status: string, confirmableJobCount: number) => ConfirmationAction)
    | undefined;

  assert.equal(typeof applicantConfirmationAction, "function");
  assert.deepEqual(
    applicantConfirmationAction!("확정인력", 0),
    { label: "확정 취소", disabled: false, intent: "undo" },
  );
});
