import assert from "node:assert/strict";
import test from "node:test";

const options = [
  { id: 1, name: "활성 A", active: true },
  { id: 2, name: "비활성 B", active: false },
  { id: 3, name: "레거시 활성값 없음" },
];

test("a new job can select only active routing options", async () => {
  const optionModule = await import("./job-routing-options.ts").catch(() => null);
  const selectable = optionModule?.newJobRoutingOptions;

  assert.equal(typeof selectable, "function", "new-job routing option filtering should exist");
  if (typeof selectable !== "function") return;

  assert.deepEqual(selectable(options).map((item) => item.id), [1, 3]);
});

test("editing preserves the currently connected inactive option without exposing other inactive choices", async () => {
  const optionModule = await import("./job-routing-options.ts").catch(() => null);
  const selectable = optionModule?.editJobRoutingOptions;

  assert.equal(typeof selectable, "function", "edit-job routing option filtering should exist");
  if (typeof selectable !== "function") return;

  assert.deepEqual(selectable(options, 2).map((item) => item.id), [1, 2, 3]);
  assert.deepEqual(selectable(options, 1).map((item) => item.id), [1, 3]);
  assert.deepEqual(selectable(options, "").map((item) => item.id), [1, 3]);
});
