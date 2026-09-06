import assert from "node:assert/strict";
import test from "node:test";

async function load() { return await import("./conversation-reply-claim.ts"); }
for (const outcome of ["busy", "job_conflict", "unavailable"]) {
  test(`${outcome} prevents executing an outdated or concurrent agent turn`, async () => {
    const { withConversationReplyClaim } = await load();
    let ran = false;
    const result = await withConversationReplyClaim({ applicantId: 7, jobId: 22,
      rpc: async () => ({ data: outcome, error: null }),
      run: async () => { ran = true; return "sent"; },
    });
    assert.equal(ran, false);
    assert.deepEqual(result, { executed: false, reason: outcome });
  });
}
test("the reply claim stays held throughout work and only its owner releases it", async () => {
  const { withConversationReplyClaim } = await load();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const result = await withConversationReplyClaim({ applicantId: 7, jobId: 22,
    rpc: async (name, args) => { calls.push({ name, args }); return { data: name.startsWith("claim_") ? "claimed" : "released", error: null }; },
    run: async () => { assert.equal(calls.length, 1); return "done"; },
  });
  assert.deepEqual(result, { executed: true, result: "done" });
  assert.equal(calls[1].name, "release_pool_agent_reply");
  assert.equal(calls[1].args.p_claim_key, calls[0].args.p_claim_key);
});
test("uncertain execution keeps the claim for operator review", async () => {
  const { withConversationReplyClaim } = await load();
  const calls: string[] = [];
  await assert.rejects(() => withConversationReplyClaim({ applicantId: 7, jobId: 22,
    rpc: async (name) => { calls.push(name); return { data: "claimed", error: null }; },
    run: async () => { throw new Error("provider uncertain"); },
  }), /provider uncertain/);
  assert.deepEqual(calls, ["claim_pool_agent_reply"]);
});
