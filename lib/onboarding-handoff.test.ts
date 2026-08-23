import assert from "node:assert/strict";
import test from "node:test";

const {
  buildOnboardingHandoffMarkerUpdate,
  processOnboardingHandoffAttempt,
  shouldAttemptOnboardingHandoff,
} = await import(
  new URL("./onboarding-handoff.ts", import.meta.url).href
) as typeof import("./onboarding-handoff");

test("handoff markers update dedicated columns instead of replacing agent_state", () => {
  const markedAt = "2026-08-24T04:00:00.000Z";

  assert.deepEqual(buildOnboardingHandoffMarkerUpdate("delivered", markedAt), {
    manager_handoff_alerted_at: markedAt,
  });
  assert.deepEqual(buildOnboardingHandoffMarkerUpdate("suppressed", markedAt), {
    manager_handoff_slack_suppressed_at: markedAt,
  });
});

test("a suppressed handoff is never eligible for later replay", () => {
  assert.equal(shouldAttemptOnboardingHandoff({
    onboarding_reminder_sent_at: "2026-08-24T01:00:00.000Z",
    manager_handoff_slack_suppressed_at: "2026-08-24T04:00:00.000Z",
  }, "2026-08-24T05:00:00.000Z"), false);
});

test("only a due unrecorded handoff is eligible for delivery", () => {
  const cutoff = "2026-08-24T05:00:00.000Z";
  assert.equal(shouldAttemptOnboardingHandoff({
    onboarding_reminder_sent_at: "2026-08-24T01:00:00.000Z",
  }, cutoff), true);
  assert.equal(shouldAttemptOnboardingHandoff({
    onboarding_reminder_sent_at: "2026-08-24T06:00:00.000Z",
  }, cutoff), false);
  assert.equal(shouldAttemptOnboardingHandoff({
    onboarding_reminder_sent_at: "2026-08-24T01:00:00.000Z",
    manager_handoff_alerted_at: "2026-08-24T04:00:00.000Z",
  }, cutoff), false);
  assert.equal(shouldAttemptOnboardingHandoff({}, cutoff), false);
});

test("switch OFF records suppression so the handoff is not replayed later", async () => {
  let marker: "delivered" | "suppressed" | null = null;

  const result = await processOnboardingHandoffAttempt({
    practice: false,
    deliver: async () => ({ kind: "disabled", reason: "switch_off" }),
    mark: async (nextMarker) => {
      marker = nextMarker;
    },
  });

  assert.deepEqual(result, { kind: "suppressed", reason: "switch_off" });
  assert.equal(marker, "suppressed");
});

test("practice candidates are suppressed without contacting Slack", async () => {
  let marker: "delivered" | "suppressed" | null = null;

  const result = await processOnboardingHandoffAttempt({
    practice: true,
    deliver: async () => {
      throw new Error("Slack must not be called for practice candidates");
    },
    mark: async (nextMarker) => {
      marker = nextMarker;
    },
  });

  assert.deepEqual(result, { kind: "suppressed", reason: "practice" });
  assert.equal(marker, "suppressed");
});

test("a delivered handoff records the actual Slack delivery marker", async () => {
  let marker: "delivered" | "suppressed" | null = null;

  const result = await processOnboardingHandoffAttempt({
    practice: false,
    deliver: async () => ({ kind: "delivered" }),
    mark: async (nextMarker) => {
      marker = nextMarker;
    },
  });

  assert.deepEqual(result, { kind: "delivered" });
  assert.equal(marker, "delivered");
});

test("a Slack failure stays retryable and records no marker", async () => {
  let marker: "delivered" | "suppressed" | null = null;

  const result = await processOnboardingHandoffAttempt({
    practice: false,
    deliver: async () => ({ kind: "failed", error: "Slack returned HTTP 503" }),
    mark: async (nextMarker) => {
      marker = nextMarker;
    },
  });

  assert.deepEqual(result, { kind: "delivery_failed", error: "Slack returned HTTP 503" });
  assert.equal(marker, null);
});

test("a marker write failure is visible instead of claiming completion", async () => {
  const result = await processOnboardingHandoffAttempt({
    practice: false,
    deliver: async () => ({ kind: "delivered" }),
    mark: async () => {
      throw new Error("candidate changed before marker write");
    },
  });

  assert.deepEqual(result, {
    kind: "mark_failed",
    marker: "delivered",
    error: "candidate changed before marker write",
  });
});
