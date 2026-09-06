import assert from "node:assert/strict";
import test from "node:test";
import { chooseInboundCandidate } from "./inbound-routing.ts";

type Candidate = {
  id: number;
  job_id: number;
  agent_stage: string;
  agent_state: null;
  responded_at: string | null;
  job_title: string;
  job_branch: string;
};

async function loadRoutingModule(): Promise<Record<string, unknown>> {
  return await import("./inbound-routing.ts") as Record<string, unknown>;
}

const candidates: Candidate[] = [
  {
    id: 101,
    job_id: 11,
    agent_stage: "screening",
    agent_state: null,
    responded_at: null,
    job_title: "강서 주말 도시락 배송",
    job_branch: "강서",
  },
  {
    id: 202,
    job_id: 22,
    agent_stage: "screening",
    agent_state: null,
    responded_at: null,
    job_title: "마포 평일 식자재 배송",
    job_branch: "마포",
  },
];

for (const text of ["강서랑 마포 시간은요?", "강서 자리도 관심 있어요"]) {
  test(`consultation keeps the current execution owner without forcing a single job: ${text}`, () => {
    assert.deepEqual(chooseInboundCandidate({ candidates, inboundText: text, focusJobId: 22, anchorJobId: 11, allowConsultation: true }), {
      ok: true, candidate: candidates[1], how: "consultation",
    });
  });
}
test("consultation without a focus or anchor stays readonly instead of choosing a workflow", () => {
  assert.deepEqual(chooseInboundCandidate({ candidates, inboundText: "둘 다 가능한가요?", focusJobId: null, anchorJobId: null, allowConsultation: true }), {
    ok: true, candidate: candidates[0], how: "consultation",
  });
});
test("an interest-only other job can be discussed without starting that candidate", () => {
  const pool = candidates.map((candidate, index) => index === 0 ? { ...candidate, agent_stage: null } : candidate);
  assert.deepEqual(chooseInboundCandidate({ candidates: pool, inboundText: "강서도 궁금해요", focusJobId: 22, anchorJobId: null, allowConsultation: true }), {
    ok: true, candidate: candidates[1], how: "consultation",
  });
});
test("consultation never bypasses paused focus or pre-focus inbound", () => {
  for (const args of [
    { candidates: candidates.map((c) => ({ ...c, agent_stage: "paused" })) },
    { candidates, focusAt: "2026-09-06T10:00:00Z", receivedAt: "2026-09-06T09:00:00Z" },
  ]) assert.deepEqual(chooseInboundCandidate({ ...args, inboundText: "강서 마포", focusJobId: 22, anchorJobId: null, allowConsultation: true }), { ok: false, reason: "paused" });
});

test("the explicit conversation focus wins over an older outbound anchor for an ordinary reply", async () => {
  const routing = await loadRoutingModule();
  const choose = routing.chooseInboundCandidate as undefined | ((args: {
    candidates: Candidate[];
    inboundText: string;
    focusJobId: number | null;
    anchorJobId: number | null;
  }) => unknown);

  assert.equal(typeof choose, "function");
  assert.deepEqual(choose!({
    candidates,
    inboundText: "네, 가능합니다",
    focusJobId: 22,
    anchorJobId: 11,
  }), {
    ok: true,
    candidate: candidates[1],
    how: "focus",
  });
});

test("naming another job does not silently override the explicit conversation focus", async () => {
  const routing = await loadRoutingModule();
  const choose = routing.chooseInboundCandidate as undefined | ((args: {
    candidates: Candidate[];
    inboundText: string;
    focusJobId: number | null;
    anchorJobId: number | null;
  }) => unknown);

  assert.equal(typeof choose, "function");
  assert.deepEqual(choose!({
    candidates,
    inboundText: "강서 자리로 진행하고 싶어요",
    focusJobId: 22,
    anchorJobId: 22,
  }), {
    ok: false,
    reason: "ambiguous",
    options: [
      { job_id: 11, title: "강서 주말 도시락 배송", branch: "강서" },
      { job_id: 22, title: "마포 평일 식자재 배송", branch: "마포" },
    ],
    why: "text_vs_focus",
    focusJobId: 22,
  });
});

test("the conversational outbound anchor remains the fallback when no focus exists", async () => {
  const routing = await loadRoutingModule();
  const choose = routing.chooseInboundCandidate as undefined | ((args: {
    candidates: Candidate[];
    inboundText: string;
    focusJobId: number | null;
    anchorJobId: number | null;
  }) => unknown);

  assert.equal(typeof choose, "function");
  assert.deepEqual(choose!({
    candidates,
    inboundText: "네",
    focusJobId: null,
    anchorJobId: 11,
  }), {
    ok: true,
    candidate: candidates[0],
    how: "anchor",
  });
});

for (const stage of [null, "paused", "abort"]) {
  test(`a ${stage} focus does not fall back to another active conversation`, async () => {
    const routing = await loadRoutingModule();
    const choose = routing.chooseInboundCandidate as (args: unknown) => unknown;
    assert.deepEqual(choose({ candidates: [candidates[0], { ...candidates[1], agent_stage: stage }], inboundText: "네", focusJobId: 22, anchorJobId: 11 }), { ok: false, reason: "paused" });
  });
}
test("a missing focus candidate fails closed even with a single other candidate", async () => {
  const routing = await loadRoutingModule();
  const choose = routing.chooseInboundCandidate as (args: unknown) => unknown;
  assert.deepEqual(choose({ candidates: [candidates[0]], inboundText: "네", focusJobId: 22, anchorJobId: 11 }), { ok: false, reason: "paused" });
});

test("an inbound received before a switch is not reinterpreted as a new-job answer", async () => {
  const routing = await loadRoutingModule();
  const choose = routing.chooseInboundCandidate as (args: unknown) => unknown;
  assert.deepEqual(choose({ candidates, inboundText: "네", focusJobId: 22, anchorJobId: 11,
    focusAt: "2026-09-06T01:00:00Z", receivedAt: "2026-09-06T00:59:59Z" }), { ok: false, reason: "paused" });
});

for (const decision of ['busy', 'job_conflict']) {
  test(`ambiguous handling cannot send or pause candidates after ${decision}`, async () => {
    const { handleAmbiguousInbound } = await import('./inbound-routing.ts');
    const calls: string[] = [];
    const supabase = {
      rpc: async (name: string) => { calls.push(name); return { data: decision, error: null }; },
      from: () => { throw new Error('must not mutate or query candidates outside the claim'); },
    };
    const result = await handleAmbiguousInbound(supabase as never, {
      applicantId: 7, phone: null, applicantName: null,
      options: [{ job_id: 22, title: '마포', branch: '마포' }], why: 'text_vs_focus', mode: 'auto',
      sendSms: async () => { throw new Error('must not send'); },
    });
    assert.deepEqual(result, { asked: false, pausedCandidates: 0 });
    assert.deepEqual(calls, ['claim_pool_agent_reply']);
  });
}

test('a closed explicit focus stops but legacy closed-job replies retain their routing', async () => {
  const { chooseInboundCandidate } = await import('./inbound-routing.ts');
  const closed = { ...candidates[1], unavailable: true };
  assert.deepEqual(chooseInboundCandidate({ candidates: [closed], inboundText: '네', focusJobId: 22, anchorJobId: 22 }), { ok: false, reason: 'paused' });
  const legacy = chooseInboundCandidate({ candidates: [closed], inboundText: '네', focusJobId: null, anchorJobId: 22 });
  assert.equal(legacy.ok, true);
});
