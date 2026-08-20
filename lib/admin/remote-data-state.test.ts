import assert from "node:assert/strict";
import test from "node:test";

type RemoteDataStateModule = {
  remoteCollectionState?: (input: { items?: unknown[]; error?: unknown }) =>
    | "loading"
    | "error"
    | "empty"
    | "ready";
  remoteSourcesState?: (sources: Record<string, { data?: unknown; error?: unknown }>) =>
    | { state: "loading"; pending: string[] }
    | { state: "error"; failed: string[] }
    | { state: "ready" };
};

async function loadModule(): Promise<RemoteDataStateModule> {
  try {
    return await import(new URL("./remote-data-state.ts", import.meta.url).href) as RemoteDataStateModule;
  } catch {
    return {};
  }
}

test("a collection is loading until a response supplies its items", async () => {
  const { remoteCollectionState } = await loadModule();

  assert.equal(typeof remoteCollectionState, "function");
  assert.equal(remoteCollectionState!({}), "loading");
});

test("a failed collection is not reported as an empty collection", async () => {
  const { remoteCollectionState } = await loadModule();

  assert.equal(typeof remoteCollectionState, "function");
  assert.equal(remoteCollectionState!({ items: [], error: new Error("offline") }), "error");
});

test("only a loaded collection can be empty or ready", async () => {
  const { remoteCollectionState } = await loadModule();

  assert.equal(typeof remoteCollectionState, "function");
  assert.equal(remoteCollectionState!({ items: [] }), "empty");
  assert.equal(remoteCollectionState!({ items: [{ id: 1 }] }), "ready");
});

test("a multi-source view stays loading until every required source responds", async () => {
  const { remoteSourcesState } = await loadModule();

  assert.equal(typeof remoteSourcesState, "function");
  assert.deepEqual(remoteSourcesState!({
    inbox: { data: [] },
    handoffs: {},
    confirmations: { data: [] },
  }), { state: "loading", pending: ["handoffs"] });
});

test("a multi-source view reports every failed source before considering readiness", async () => {
  const { remoteSourcesState } = await loadModule();

  assert.equal(typeof remoteSourcesState, "function");
  assert.deepEqual(remoteSourcesState!({
    inbox: { data: [], error: new Error("offline") },
    handoffs: { error: new Error("timeout") },
    confirmations: { data: [] },
  }), { state: "error", failed: ["inbox", "handoffs"] });
});

test("zero-valued responses are loaded data rather than missing data", async () => {
  const { remoteSourcesState } = await loadModule();

  assert.equal(typeof remoteSourcesState, "function");
  assert.deepEqual(remoteSourcesState!({
    inbox: { data: [] },
    notifications: { data: { count: 0 } },
    confirmations: { data: 0 },
  }), { state: "ready" });
});
