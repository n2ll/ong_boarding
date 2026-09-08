import test from "node:test";
import assert from "node:assert/strict";
import { parsePoolPreferences } from "./pool-preferences.ts";

test("pool registration keeps self-reported conditions without claiming availability or consent", () => {
  assert.deepEqual(parsePoolPreferences({ kind: "backup", area: " 성동구 ", schedule: "금요일 오후", vehicle: "미정", notice: "하루 전", marketing_consent: true, status: "확정인력" }), { kind: "backup", area: "성동구", schedule: "금요일 오후", vehicle: "미정", notice: "하루 전" });
});
test("pool preferences reject missing choice, empty conditions and oversized answers", () => {
  const valid = { kind: "both", area: "서울", schedule: "미정", vehicle: "없음", notice: "" };
  for (const patch of [{ kind: "unknown" }, { area: " " }, { schedule: 3 }, { vehicle: "x".repeat(241) }]) assert.equal(parsePoolPreferences({ ...valid, ...patch }), null);
});
