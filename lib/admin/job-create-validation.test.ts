import assert from "node:assert/strict";
import test from "node:test";

test("job creation requires a positive hiring capacity", async () => {
  const validationModule = await import("./job-create-validation.ts");
  const validate = validationModule.validateJobCreateCapacity;

  assert.equal(typeof validate, "function", "job-create capacity validation should exist");
  if (typeof validate !== "function") return;

  assert.equal(validate("")?.field, "capacity");
  assert.equal(validate(0)?.field, "capacity");
  assert.equal(validate(-1)?.field, "capacity");
  assert.equal(validate(1.5)?.field, "capacity");
  assert.equal(validate(Number.POSITIVE_INFINITY)?.field, "capacity");
  assert.equal(validate(1), null);
  assert.equal(validate(6), null);
});

test("job creation requires applicant-facing pay and settlement guidance", async () => {
  const validationModule = await import("./job-create-validation.ts").catch(() => null);
  const validate = validationModule?.validateJobCreateCompensation;

  assert.equal(typeof validate, "function", "job-create compensation validation should exist");
  if (typeof validate !== "function") return;

  const bareRate = validate({ payType: "건당", payAmount: 3500, payInfo: "   " });
  assert.equal(bareRate?.field, "payInfo");
  assert.match(bareRate?.message ?? "", /급여/);

  assert.equal(
    validate({ payType: "", payAmount: "", payInfo: "건당 3,500원 · 매주 금요일 정산" }),
    null,
  );
  assert.equal(
    validate({ payType: "협의", payAmount: "", payInfo: "면접 후 협의 · 익월 5일 정산" }),
    null,
  );
});

test("job creation requires the current posting's pickup and delivery details", async () => {
  const validationModule = await import("./job-create-validation.ts");
  const validate = validationModule.validateJobCreateWorkLocation;

  assert.equal(typeof validate, "function", "job-create work-location validation should exist");
  if (typeof validate !== "function") return;

  assert.equal(
    validate({ pickupAddress: "   ", dropoffAddress: "하남 미사강변도시 일대" })?.field,
    "pickupAddress",
  );
  assert.equal(
    validate({ pickupAddress: "성수동 물류센터 3번 게이트", dropoffAddress: "   " })?.field,
    "dropoffAddress",
  );
  assert.equal(
    validate({
      pickupAddress: "성수동 물류센터 3번 게이트",
      dropoffAddress: "하남 미사강변도시 일대",
    }),
    null,
  );
});
