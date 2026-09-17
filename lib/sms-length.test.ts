import test from "node:test";
import assert from "node:assert/strict";
import { smsByteLength, SMS_MAX_BYTES } from "./sms-length.ts";

test("LMS boundaries count Korean, ASCII, spaces and newlines", () => {
  assert.equal(smsByteLength("가".repeat(1000)), SMS_MAX_BYTES);
  assert.equal(smsByteLength("a".repeat(2000)), SMS_MAX_BYTES);
  assert.equal(smsByteLength("가a \n"), 5);
  assert.equal(smsByteLength("가".repeat(1000) + "a"), 2001);
  assert.equal(smsByteLength("🚚"), 4);
});
