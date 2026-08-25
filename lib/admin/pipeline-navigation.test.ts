import assert from "node:assert/strict";
import test from "node:test";

const pipelineNavigation = await import(
  new URL("./pipeline-navigation.ts", import.meta.url).href
) as typeof import("./pipeline-navigation");
const {
  getPipelineApplicantNavigation,
  recoverPipelineApplicantSelection,
} = pipelineNavigation;

test("navigation reports a one-based position and manual neighbors in filtered order", () => {
  assert.deepEqual(getPipelineApplicantNavigation([11, 12, 13], 12), {
    current: 2,
    total: 3,
    previousId: 11,
    nextId: 13,
    outsideFilter: false,
  });
});

test("navigation uses the full filtered order beyond the rendered row chunk", () => {
  const filteredIds = Array.from({ length: 101 }, (_, index) => index + 1);

  assert.deepEqual(getPipelineApplicantNavigation(filteredIds, 100), {
    current: 100,
    total: 101,
    previousId: 99,
    nextId: 101,
    outsideFilter: false,
  });
});

test("a selection outside the filters stays unanchored and is reported as outside", () => {
  assert.deepEqual(getPipelineApplicantNavigation([11, 12], 99), {
    current: null,
    total: 2,
    previousId: null,
    nextId: null,
    outsideFilter: true,
  });
  assert.equal(getPipelineApplicantNavigation([11, 12], null).outsideFilter, false);
});

test("successful deletion recovers the next survivor, then the nearest previous survivor", () => {
  assert.equal(recoverPipelineApplicantSelection([11, 12, 13], [11, 13], 12, "success"), 13);
  assert.equal(recoverPipelineApplicantSelection([11, 12, 13], [11, 12], 13, "success"), 12);
  assert.equal(recoverPipelineApplicantSelection([11], [], 11, "success"), null);
});

test("error and stale refreshes never consume the current selection", () => {
  assert.equal(recoverPipelineApplicantSelection([11, 12, 13], [11, 13], 12, "error"), 12);
  assert.equal(recoverPipelineApplicantSelection([11, 12, 13], [11, 13], 12, "stale"), 12);
});

test("successful refresh preserves a surviving or externally opened selection", () => {
  assert.equal(recoverPipelineApplicantSelection([11, 12], [11, 12], 12, "success"), 12);
  assert.equal(recoverPipelineApplicantSelection([11, 12], [11], 99, "success"), 99);
});
