export type SlackDeliveryResult =
  | { kind: "disabled"; reason: "switch_off" }
  | { kind: "delivered" }
  | { kind: "failed"; error: string };

export type HandoffMarker = "delivered" | "suppressed";

export function buildOnboardingHandoffMarkerUpdate(
  marker: HandoffMarker,
  markedAt: string,
): { manager_handoff_alerted_at: string } | { manager_handoff_slack_suppressed_at: string } {
  return marker === "delivered"
    ? { manager_handoff_alerted_at: markedAt }
    : { manager_handoff_slack_suppressed_at: markedAt };
}

type HandoffAttemptResult =
  | { kind: "suppressed"; reason: "switch_off" | "practice" }
  | { kind: "delivered" }
  | { kind: "delivery_failed"; error: string }
  | { kind: "mark_failed"; marker: HandoffMarker; error: string };

export function shouldAttemptOnboardingHandoff(
  meta: {
    onboarding_reminder_sent_at?: string;
    manager_handoff_alerted_at?: string;
    manager_handoff_slack_suppressed_at?: string;
  },
  cutoff: string,
): boolean {
  return !!meta.onboarding_reminder_sent_at
    && !meta.manager_handoff_alerted_at
    && !meta.manager_handoff_slack_suppressed_at
    && meta.onboarding_reminder_sent_at <= cutoff;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function processOnboardingHandoffAttempt(input: {
  practice: boolean;
  deliver: () => Promise<SlackDeliveryResult>;
  mark: (marker: HandoffMarker) => Promise<void>;
}): Promise<HandoffAttemptResult> {
  if (input.practice) {
    try {
      await input.mark("suppressed");
      return { kind: "suppressed", reason: "practice" };
    } catch (error) {
      return { kind: "mark_failed", marker: "suppressed", error: errorMessage(error) };
    }
  }

  const delivery = await input.deliver();
  if (delivery.kind === "failed") {
    return { kind: "delivery_failed", error: delivery.error };
  }

  const marker: HandoffMarker = delivery.kind === "delivered" ? "delivered" : "suppressed";
  try {
    await input.mark(marker);
  } catch (error) {
    return { kind: "mark_failed", marker, error: errorMessage(error) };
  }

  return delivery.kind === "delivered"
    ? { kind: "delivered" }
    : { kind: "suppressed", reason: "switch_off" };
}
