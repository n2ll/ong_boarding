import assert from "node:assert/strict";
import test from "node:test";

type MobileNavigationModule = {
  mobileNavigationGridClass?: (itemCount: number) => string;
};

async function loadModule(): Promise<MobileNavigationModule> {
  try {
    return await import(new URL("./mobile-navigation.ts", import.meta.url).href) as MobileNavigationModule;
  } catch {
    return {};
  }
}

test("five primary mobile destinations stay in one row", async () => {
  const { mobileNavigationGridClass } = await loadModule();

  assert.equal(typeof mobileNavigationGridClass, "function");
  assert.equal(mobileNavigationGridClass!(5), "grid-cols-5");
});

test("mobile primary navigation rejects more than five destinations", async () => {
  const { mobileNavigationGridClass } = await loadModule();

  assert.equal(typeof mobileNavigationGridClass, "function");
  assert.throws(() => mobileNavigationGridClass!(6), /five/i);
});
