import assert from "node:assert/strict";
import test from "node:test";

type TopbarStateModule = {
  topbarCollectionState?: (input: { items?: unknown[]; error?: unknown }) =>
    | "loading"
    | "error"
    | "empty"
    | "ready";
  topbarRouteCapabilities?: (pathname: string) => {
    showBranchScope: boolean;
    showCreateJobAction: boolean;
  };
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

test("topbar only exposes controls that affect the current page", async () => {
  const { topbarRouteCapabilities } = await loadModule();

  assert.equal(typeof topbarRouteCapabilities, "function");
  assert.deepEqual(topbarRouteCapabilities!("/"), {
    showBranchScope: true,
    showCreateJobAction: true,
  });
  assert.deepEqual(topbarRouteCapabilities!("/pipeline"), {
    showBranchScope: true,
    showCreateJobAction: true,
  });
  assert.deepEqual(topbarRouteCapabilities!("/live"), {
    showBranchScope: false,
    showCreateJobAction: true,
  });
  assert.deepEqual(topbarRouteCapabilities!("/jobs"), {
    showBranchScope: false,
    showCreateJobAction: false,
  });
});
