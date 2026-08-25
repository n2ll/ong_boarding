import assert from "node:assert/strict";
import test from "node:test";

async function loadAdminTypesModule(): Promise<Record<string, unknown>> {
  try {
    const modulePath = "./admin/types.ts";
    return await import(modulePath) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test("applicant age ignores impossible legacy birth dates", async () => {
  const adminTypesModule = await loadAdminTypesModule();
  const calcAge = adminTypesModule.calcAge as
    | ((birthDate: string | null | undefined) => number | null)
    | undefined;

  assert.equal(typeof calcAge, "function");
  assert.equal(typeof calcAge!("600101"), "number");
  assert.equal(calcAge!("000230"), null);
  assert.equal(calcAge!("991332"), null);
});
