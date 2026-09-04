import assert from "node:assert/strict";
import test from "node:test";

test("AI follow-up asks only for required facts the memo did not provide", async () => {
  const followupModule = await import("./job-create-followup.ts").catch(() => null);
  const missingFields = followupModule?.missingJobCreateFollowupFields;

  assert.equal(typeof missingFields, "function");
  if (typeof missingFields !== "function") return;

  assert.deepEqual(
    missingFields({
      capacity: "",
      pickupAddress: "성수 물류센터 3번 게이트",
      dropoffAddress: "",
      payInfo: "건당 3,500원 · 매주 금요일 정산",
    }),
    ["capacity", "dropoffAddress"],
  );

  assert.deepEqual(
    missingFields({
      capacity: 3,
      pickupAddress: "성수 물류센터 3번 게이트",
      dropoffAddress: "하남 미사 일대",
      payInfo: "건당 3,500원 · 매주 금요일 정산",
    }),
    [],
  );
});
