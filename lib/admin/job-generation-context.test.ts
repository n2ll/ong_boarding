import assert from "node:assert/strict";
import test from "node:test";

test("job generation context ignores formatting-only changes", async () => {
  const contextModule = await import("./job-generation-context.ts").catch(() => null);
  const createContext = contextModule?.createJobGenerationContext;
  const changedFields = contextModule?.changedJobGenerationContextFields;

  assert.equal(typeof createContext, "function", "job generation context snapshot should exist");
  assert.equal(typeof changedFields, "function", "job generation context comparison should exist");
  if (typeof createContext !== "function" || typeof changedFields !== "function") return;

  const baseline = createContext({
    prompt: "  새벽 배송 기사  ",
    clientId: 12,
    branchId: 34,
    pickupAddress: "성수동   물류센터",
    dropoffAddress: "하남 미사 일대  ",
    capacity: 3,
    payInfo: "건당 3,500원 · 매주 금요일 정산",
  });
  const formattedOnly = createContext({
    prompt: "새벽 배송 기사",
    clientId: 12,
    branchId: 34,
    pickupAddress: " 성수동 물류센터 ",
    dropoffAddress: "하남   미사 일대",
    capacity: 3,
    payInfo: " 건당 3,500원  ·  매주 금요일 정산 ",
  });

  assert.deepEqual(changedFields(baseline, formattedOnly), []);

  assert.equal(
    createContext({
      prompt: "  주 5일\n- 새벽 3시 시작\n- 건당 3,500원  ",
      clientId: "",
      branchId: "",
      pickupAddress: "성수동 물류센터",
      dropoffAddress: "하남 일대",
      capacity: "",
      payInfo: "",
    }).prompt,
    "주 5일\n- 새벽 3시 시작\n- 건당 3,500원",
    "multi-line manager instructions should keep their structure in the generation request",
  );
});

test("job generation context reports every changed AI input in a stable order", async () => {
  const contextModule = await import("./job-generation-context.ts");
  const baseline = contextModule.createJobGenerationContext({
    prompt: "새벽 배송 기사",
    clientId: 12,
    branchId: 34,
    pickupAddress: "성수동 물류센터",
    dropoffAddress: "하남 미사 일대",
    capacity: 3,
    payInfo: "건당 3,500원",
  });
  const changed = contextModule.createJobGenerationContext({
    prompt: "주간 배송 기사",
    clientId: "",
    branchId: "",
    pickupAddress: "송파 물류센터",
    dropoffAddress: "강동구 일대",
    capacity: 5,
    payInfo: "건당 4,000원 · 익주 금요일 정산",
  });

  assert.deepEqual(
    contextModule.changedJobGenerationContextFields(baseline, changed),
    ["prompt", "client", "branch", "pickupAddress", "dropoffAddress", "capacity", "payInfo"],
  );
  assert.deepEqual(
    contextModule.changedJobGenerationContextFields(baseline, baseline),
    [],
    "returning every field to the generated values should make the draft current again",
  );
  assert.deepEqual(
    contextModule.changedJobGenerationContextFields(null, changed),
    [],
    "copied and directly written drafts do not have an AI generation baseline",
  );
});

test("regeneration replaces AI autofills without overwriting manager edits", async () => {
  const contextModule = await import("./job-generation-context.ts");
  const resolveAutofill = contextModule.resolveJobGenerationAutofill;

  assert.equal(typeof resolveAutofill, "function", "job generation autofill ownership should be explicit");
  if (typeof resolveAutofill !== "function") return;

  assert.deepEqual(
    resolveAutofill({
      currentValue: "건당 3,500원",
      previousGeneratedValue: "건당 3,500원",
      nextGeneratedValue: "건당 4,200원",
    }),
    { value: "건당 4,200원", generatedValue: "건당 4,200원" },
    "an untouched AI value should follow the regenerated draft",
  );
  assert.deepEqual(
    resolveAutofill({
      currentValue: "건당 3,500원 · 매주 금요일 정산",
      previousGeneratedValue: "건당 3,500원",
      nextGeneratedValue: "건당 4,200원",
    }),
    { value: "건당 3,500원 · 매주 금요일 정산", generatedValue: null },
    "a manager-edited value should remain authoritative",
  );
  assert.deepEqual(
    resolveAutofill({ currentValue: "", previousGeneratedValue: null, nextGeneratedValue: "주 5일" }),
    { value: "주 5일", generatedValue: "주 5일" },
  );
});
