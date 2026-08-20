import assert from "node:assert/strict";
import test from "node:test";

type TopbarStateModule = {
  topbarCollectionState?: (input: { items?: unknown[]; error?: unknown }) =>
    | "loading"
    | "error"
    | "empty"
    | "ready";
};

async function loadModule(): Promise<TopbarStateModule> {
  try {
    return await import(new URL("./topbar-state.ts", import.meta.url).href) as TopbarStateModule;
  } catch {
    return {};
  }
}

test("topbar remote collections do not collapse loading or failure into empty", async () => {
  const { topbarCollectionState } = await loadModule();

  assert.equal(typeof topbarCollectionState, "function");
  assert.equal(topbarCollectionState!({}), "loading");
  assert.equal(topbarCollectionState!({ items: [], error: new Error("offline") }), "error");
  assert.equal(topbarCollectionState!({ items: [] }), "empty");
  assert.equal(topbarCollectionState!({ items: [{}] }), "ready");
});
