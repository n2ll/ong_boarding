import test from "node:test";
import assert from "node:assert/strict";
import { parsePoolPreferences, matchesPoolPreferences } from "./pool-preferences.ts";

test("both matches regular and backup while missing preferences are not treated as a refusal", () => {
  const regular = { kind: "regular" as const, area: "성동구", schedule: "금요일 오후", vehicle: "세단", notice: "하루 전" };
  assert.equal(matchesPoolPreferences(regular, "backup", ""), false);
  assert.equal(matchesPoolPreferences({ ...regular, kind: "both" }, "backup", ""), true);
  assert.equal(matchesPoolPreferences({ ...regular, kind: "both" }, "regular", ""), true);
  assert.equal(matchesPoolPreferences(null, "all", ""), true);
  assert.equal(matchesPoolPreferences(null, "unregistered", ""), true);
  assert.equal(matchesPoolPreferences(null, "regular", ""), false);
  assert.equal(matchesPoolPreferences(regular, "unregistered", ""), false);
});

test("preference search requires each literal keyword without inferring availability", () => {
  const value = { kind: "backup" as const, area: "성동구", schedule: "금요일 오후", vehicle: "세단", notice: "하루 전" };
  assert.equal(matchesPoolPreferences(value, "backup", "성동 금요일 세단"), true);
  assert.equal(matchesPoolPreferences(value, "backup", "성동 토요일"), false);
  assert.equal(matchesPoolPreferences(value, "backup", "하루"), true);
  assert.equal(matchesPoolPreferences(null, "all", "성동"), false);
});

test("pool registration keeps self-reported conditions without claiming availability or consent", () => {
  assert.deepEqual(parsePoolPreferences({ kind: "backup", area: " 성동구 ", schedule: "금요일 오후", vehicle: "미정", notice: "하루 전", marketing_consent: true, status: "확정인력" }), { kind: "backup", area: "성동구", schedule: "금요일 오후", vehicle: "미정", notice: "하루 전" });
});
test("pool preferences reject missing choice, empty conditions and oversized answers", () => {
  const valid = { kind: "both", area: "서울", schedule: "미정", vehicle: "없음", notice: "" };
  for (const patch of [{ kind: "unknown" }, { area: " " }, { schedule: 3 }, { vehicle: "x".repeat(241) }]) assert.equal(parsePoolPreferences({ ...valid, ...patch }), null);
});
