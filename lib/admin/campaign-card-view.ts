export interface CampaignJobBreakdown {
  job_id: number;
  title: string;
  count: number;
  immediate_count: number;
}

export interface CampaignCardData {
  window_days: number;
  sent: number;
  sent_messages: number;
  failed: number;
  viewed: number;
  interested: number;
  by_job: CampaignJobBreakdown[];
  replied: number;
  opted_out: number;
  confirmed: number;
  last_sent_at: string | null;
  stale: boolean;
}

export type CampaignStep = {
  key: "sent" | "viewed" | "interested" | "replied" | "confirmed";
  count: number;
  percent: number | null;
  confirmationSource?: "manager";
};

export type CampaignCardView =
  | { state: "loading" }
  | { state: "error" }
  | { state: "empty"; windowDays: number }
  | {
      state: "ready" | "stale";
      data: CampaignCardData;
      denominator: { count: number; basis: "unique_recipients" };
      steps: CampaignStep[];
    };

export function campaignCardView(input: {
  data?: CampaignCardData;
  error?: unknown;
}): CampaignCardView {
  if (input.error) return { state: "error" };
  if (!input.data) return { state: "loading" };
  if (input.data.sent === 0) return { state: "empty", windowDays: input.data.window_days };

  const data = input.data;
  const percentOfRecipients = (count: number) => Math.round((count / data.sent) * 100);

  return {
    state: data.stale ? "stale" : "ready",
    data,
    denominator: { count: data.sent, basis: "unique_recipients" },
    steps: [
      { key: "sent", count: data.sent, percent: null },
      { key: "viewed", count: data.viewed, percent: percentOfRecipients(data.viewed) },
      { key: "interested", count: data.interested, percent: percentOfRecipients(data.interested) },
      { key: "replied", count: data.replied, percent: percentOfRecipients(data.replied) },
      {
        key: "confirmed",
        count: data.confirmed,
        percent: percentOfRecipients(data.confirmed),
        confirmationSource: "manager",
      },
    ],
  };
}
