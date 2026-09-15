import assert from "node:assert/strict";
import test from "node:test";

const load = async () => import(new URL("./reply-completion.ts", import.meta.url).href).catch(() => ({}));

test("message identity accepts production UUIDs and legacy integers without coercion", async () => {
  const { isReplyMessageId } = await load();
  assert.equal(typeof isReplyMessageId, "function");
  for (const id of ["4bd5096c-0790-4eb2-b1bd-e46ecfd78b81", 1]) assert.equal(isReplyMessageId(id), true);
  for (const id of ["", "1", "not-an-id", " 4bd5096c-0790-4eb2-b1bd-e46ecfd78b81 ", 0, 1.2, null, undefined, Number.MAX_SAFE_INTEGER + 1]) assert.equal(isReplyMessageId(id), false);
});

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
