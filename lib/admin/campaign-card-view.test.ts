import assert from "node:assert/strict";
import test from "node:test";

interface CampaignData {
  window_days: number;
  sent: number;
  sent_messages: number;
  failed: number;
  viewed: number;
  interested: number;
  by_job: Array<{ job_id: number; title: string; count: number; immediate_count: number }>;
  replied: number;
  opted_out: number;
  confirmed: number;
  last_sent_at: string | null;
  stale: boolean;
}

type CampaignCardViewModule = {
  campaignCardView?: (input: { data?: CampaignData; error?: unknown }) =>
    | { state: "loading" }
    | { state: "error" }
    | { state: "empty"; windowDays: number }
    | {
        state: "ready" | "stale";
        data: CampaignData;
        denominator: { count: number; basis: "unique_recipients" };
        steps: Array<{
          key: "sent" | "viewed" | "interested" | "replied" | "confirmed";
          count: number;
          percent: number | null;
          confirmationSource?: "manager";
        }>;
      };
};

async function loadModule(): Promise<CampaignCardViewModule> {
  try {
    return await import(new URL("./campaign-card-view.ts", import.meta.url).href) as CampaignCardViewModule;
  } catch {
    return {};
  }
}

function campaignData(overrides: Partial<CampaignData> = {}): CampaignData {
  return {
    window_days: 14,
    sent: 8,
    sent_messages: 10,
    failed: 1,
    viewed: 4,
    interested: 2,
    by_job: [],
    replied: 1,
    opted_out: 0,
    confirmed: 1,
    last_sent_at: "2026-08-19T03:00:00.000Z",
    stale: false,
    ...overrides,
  };
}

test("missing campaign data stays loading instead of looking like no sends", async () => {
  const { campaignCardView } = await loadModule();

  assert.equal(typeof campaignCardView, "function");
  assert.deepEqual(campaignCardView!({}), { state: "loading" });
});

test("a failed campaign request is explicit instead of disappearing", async () => {
  const { campaignCardView } = await loadModule();

  assert.equal(typeof campaignCardView, "function");
  assert.deepEqual(campaignCardView!({ error: new Error("offline") }), { state: "error" });
});

test("only a loaded zero-recipient response is the no-send state", async () => {
  const { campaignCardView } = await loadModule();

  assert.equal(typeof campaignCardView, "function");
  assert.deepEqual(campaignCardView!({ data: campaignData({ sent: 0, sent_messages: 0 }) }), {
    state: "empty",
    windowDays: 14,
  });
});

test("a recent campaign and a historical fallback remain distinguishable", async () => {
  const { campaignCardView } = await loadModule();

  assert.equal(typeof campaignCardView, "function");
  assert.equal(campaignCardView!({ data: campaignData() }).state, "ready");
  assert.equal(campaignCardView!({ data: campaignData({ stale: true }) }).state, "stale");
});

test("every campaign rate uses unique recipients and confirmation stays manager-controlled", async () => {
  const { campaignCardView } = await loadModule();

  assert.equal(typeof campaignCardView, "function");
  const view = campaignCardView!({ data: campaignData() });

  assert.equal(view.state, "ready");
  if (view.state !== "ready" && view.state !== "stale") return;
  assert.deepEqual(view.denominator, { count: 8, basis: "unique_recipients" });
  assert.deepEqual(view.steps, [
    { key: "sent", count: 8, percent: null },
    { key: "viewed", count: 4, percent: 50 },
    { key: "interested", count: 2, percent: 25 },
    { key: "replied", count: 1, percent: 13 },
    { key: "confirmed", count: 1, percent: 13, confirmationSource: "manager" },
  ]);
});
