import assert from "node:assert/strict";
import test from "node:test";

const baseline = {
  title: "성수 새벽 배송",
  capacity: 3,
  slotKeys: ["평일오전", "주말오전"],
  exposure: {
    exposure: "targeted",
    rule: { sido: ["서울", "경기"], vehicle: ["있음", "미확인"] },
  },
};

test("job edit dirty detection ignores object keys and set-like option order", async () => {
  const draftModule = await import("./job-edit-draft.ts").catch(() => null);
  const changed = draftModule?.hasJobEditDraftChanges;

  assert.equal(typeof changed, "function", "job edit draft comparison should exist");
  if (typeof changed !== "function") return;

  assert.equal(
    changed(baseline, {
      exposure: {
        rule: { vehicle: ["미확인", "있음"], sido: ["경기", "서울"] },
        exposure: "targeted",
      },
      slotKeys: ["주말오전", "평일오전"],
      capacity: 3,
      title: "성수 새벽 배송",
    }),
    false,
  );
});

test("job edit dirty detection catches a meaningful field change", async () => {
  const draftModule = await import("./job-edit-draft.ts").catch(() => null);
  const changed = draftModule?.hasJobEditDraftChanges;

  assert.equal(typeof changed, "function", "job edit draft comparison should exist");
  if (typeof changed !== "function") return;

  assert.equal(changed(baseline, { ...baseline, capacity: 4 }), true);
  assert.equal(changed(baseline, { ...baseline, title: "성수 주간 배송" }), true);
});
