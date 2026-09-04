import assert from "node:assert/strict";
import test from "node:test";

type TaskQueueResetModule = {
  parseTaskQueueResetAt?: (value: unknown) => string | null;
  hasTaskQueueActivityAfterReset?: (
    resetAt: string | null | undefined,
    ...activityAt: Array<string | null | undefined>
  ) => boolean;
};

async function loadModule(): Promise<TaskQueueResetModule> {
  try {
    return await import(new URL("./task-queue-reset.ts", import.meta.url).href) as TaskQueueResetModule;
  } catch {
    return {};
  }
}

test("the reset marker accepts only a real timestamp", async () => {
  const { parseTaskQueueResetAt } = await loadModule();

  assert.equal(typeof parseTaskQueueResetAt, "function");
  assert.equal(parseTaskQueueResetAt!("2026-09-04T07:40:00.000Z"), "2026-09-04T07:40:00.000Z");
  assert.equal(parseTaskQueueResetAt!("today"), null);
  assert.equal(parseTaskQueueResetAt!(null), null);
});

test("without a reset marker existing work remains visible", async () => {
  const { hasTaskQueueActivityAfterReset } = await loadModule();

  assert.equal(typeof hasTaskQueueActivityAfterReset, "function");
  assert.equal(hasTaskQueueActivityAfterReset!(null, "2026-05-28T09:12:10.000Z"), true);
  assert.equal(hasTaskQueueActivityAfterReset!(undefined, null), true);
});

test("a reset hides older work until a later message or stage change arrives", async () => {
  const { hasTaskQueueActivityAfterReset } = await loadModule();
  const resetAt = "2026-09-04T07:40:00.000Z";

  assert.equal(typeof hasTaskQueueActivityAfterReset, "function");
  assert.equal(hasTaskQueueActivityAfterReset!(resetAt, "2026-09-04T07:39:59.999Z"), false);
  assert.equal(hasTaskQueueActivityAfterReset!(resetAt, resetAt), false);
  assert.equal(hasTaskQueueActivityAfterReset!(resetAt, null, undefined), false);
  assert.equal(hasTaskQueueActivityAfterReset!(resetAt, "2026-06-01T00:00:00.000Z", "2026-09-04T07:40:00.001Z"), true);
});
