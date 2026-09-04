import assert from "node:assert/strict";
import test from "node:test";

async function loadReservedModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./prompt-example-reserved.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("the global AI mode storage key is reserved from generic prompt editing", async () => {
  const reservedModule = await loadReservedModule();
  const isReserved = reservedModule.isReservedPromptExampleKey as
    | ((category: unknown, title: unknown) => boolean)
    | undefined;

  assert.equal(typeof isReserved, "function");
  assert.equal(isReserved?.("system_message", "agent_kill_switch"), true);
  assert.equal(isReserved?.("system_message", " agent_kill_switch "), true);
  assert.equal(isReserved?.("conversation", "agent_kill_switch"), false);
  assert.equal(isReserved?.("system_message", "onboarding_reminder"), false);
});

test("the admin task reset marker cannot be edited as an AI prompt", async () => {
  const reservedModule = await loadReservedModule();
  const isReserved = reservedModule.isReservedPromptExampleKey as
    | ((category: unknown, title: unknown) => boolean)
    | undefined;

  assert.equal(typeof isReserved, "function");
  assert.equal(isReserved?.("system_message", "__admin_task_queue_reset__"), true);
  assert.equal(isReserved?.("system_message", " __admin_task_queue_reset__ "), true);
  assert.equal(isReserved?.("conversation", "__admin_task_queue_reset__"), false);
});
