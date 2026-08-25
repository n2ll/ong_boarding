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
