import assert from "node:assert/strict";
import test from "node:test";

type BlacklistActionModule = {
  normalizedBlacklistReason?: (value: unknown) => string | null;
};

async function loadModule(): Promise<BlacklistActionModule> {
  try {
    return await import(new URL("./blacklist-action.ts", import.meta.url).href) as BlacklistActionModule;
  } catch {
    return {};
  }
}

test("blacklist registration requires a concrete manager reason", async () => {
  const { normalizedBlacklistReason } = await loadModule();

  assert.equal(typeof normalizedBlacklistReason, "function");
  assert.equal(normalizedBlacklistReason!("   "), null);
  assert.equal(normalizedBlacklistReason!(null), null);
  assert.equal(normalizedBlacklistReason!(" 반복적인 연락 두절 "), "반복적인 연락 두절");
});
