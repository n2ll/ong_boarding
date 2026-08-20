import assert from "node:assert/strict";
import test from "node:test";

type SearchDialogModule = {
  nextSearchDialogFocusIndex?: (
    currentIndex: number,
    focusableCount: number,
    direction: "forward" | "backward",
  ) => number;
};

async function loadModule(): Promise<SearchDialogModule> {
  try {
    return await import(new URL("./search-dialog.ts", import.meta.url).href) as SearchDialogModule;
  } catch {
    return {};
  }
}

test("search dialog focus wraps at both edges", async () => {
  const { nextSearchDialogFocusIndex } = await loadModule();

  assert.equal(typeof nextSearchDialogFocusIndex, "function");
  assert.equal(nextSearchDialogFocusIndex!(2, 3, "forward"), 0);
  assert.equal(nextSearchDialogFocusIndex!(0, 3, "backward"), 2);
  assert.equal(nextSearchDialogFocusIndex!(1, 3, "forward"), 2);
  assert.equal(nextSearchDialogFocusIndex!(1, 3, "backward"), 0);
  assert.equal(nextSearchDialogFocusIndex!(-1, 3, "forward"), 0);
  assert.equal(nextSearchDialogFocusIndex!(-1, 3, "backward"), 2);
});

test("an empty dialog focus list never returns a usable index", async () => {
  const { nextSearchDialogFocusIndex } = await loadModule();

  assert.equal(typeof nextSearchDialogFocusIndex, "function");
  assert.equal(nextSearchDialogFocusIndex!(0, 0, "forward"), -1);
});
