import assert from "node:assert/strict";
import test from "node:test";

async function loadNavigationModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./brain-navigation.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("brain tabs have stable deep links and keep the overview URL clean", async () => {
  const navigation = await loadNavigationModule();
  const brainTabHref = navigation.brainTabHref as ((tab: string) => string) | undefined;

  assert.equal(typeof brainTabHref, "function");
  assert.equal(brainTabHref!("overview"), "/brain");
  assert.equal(brainTabHref!("mode"), "/brain?tab=mode");
  assert.equal(brainTabHref!("knowledge"), "/brain?tab=knowledge");
});

test("unsupported brain tab URLs recover to the safe overview", async () => {
  const navigation = await loadNavigationModule();
  const brainTabFromParam = navigation.brainTabFromParam as
    | ((value: string | null) => string)
    | undefined;

  assert.equal(typeof brainTabFromParam, "function");
  assert.equal(brainTabFromParam!(null), "overview");
  assert.equal(brainTabFromParam!("unknown"), "overview");
  assert.equal(brainTabFromParam!("advanced"), "mode");
  assert.equal(brainTabFromParam!("rules"), "rules");
});
