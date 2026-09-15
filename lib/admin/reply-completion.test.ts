import assert from "node:assert/strict";
import test from "node:test";

const load = async () => import(new URL("./reply-completion.ts", import.meta.url).href).catch(() => ({}));

test("reply work is disjoint from current human handoffs and an explicit completion", async () => {
  const { isReplyActionable } = await load();
  assert.equal(typeof isReplyActionable, "function");
  assert.equal(isReplyActionable({ direction: "inbound" }), true);
  assert.equal(isReplyActionable({ direction: "inbound", body: "네" }), true);
  assert.equal(isReplyActionable({ direction: "inbound", reply_completed: true }), false);
  assert.equal(isReplyActionable({ direction: "inbound", handoff_required: true }), false);
  assert.equal(isReplyActionable({ direction: "outbound" }), false);
  assert.equal(isReplyActionable(undefined), false);
});
