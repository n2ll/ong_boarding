import assert from "node:assert/strict";
import test from "node:test";

type UsageWindowModule = {
  usageWindowKst?: (now: Date, days: number) => { start: string; end: string };
};

async function loadModule(): Promise<UsageWindowModule> {
  try {
    return await import(new URL("./usage-window.ts", import.meta.url).href) as UsageWindowModule;
  } catch {
    return {};
  }
}

test("the 30-day usage window includes today and 29 prior Korea dates", async () => {
  const { usageWindowKst } = await loadModule();

  assert.equal(typeof usageWindowKst, "function");
  assert.deepEqual(usageWindowKst!(new Date("2026-08-20T00:30:00+09:00"), 30), {
    start: "2026-07-22",
    end: "2026-08-20",
  });
});

test("the Korea date stays correct near the UTC date boundary", async () => {
  const { usageWindowKst } = await loadModule();

  assert.equal(typeof usageWindowKst, "function");
  assert.deepEqual(usageWindowKst!(new Date("2026-08-19T15:30:00Z"), 1), {
    start: "2026-08-20",
    end: "2026-08-20",
  });
  assert.throws(() => usageWindowKst!(new Date(), 0), /positive/i);
});
