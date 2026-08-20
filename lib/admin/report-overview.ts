export type ReportRange = "이번 주" | "이번 달" | "올해";

export interface ReportApplicantRow {
  status: string;
  created_at: string | null;
  airtable_record_id?: string | null;
}

export interface ReportUsageRow {
  total_cost_krw: number | null;
}

export type ReportStageKey = "received" | "screening" | "review" | "confirmed" | "other";

export interface ReportStage {
  key: ReportStageKey;
  count: number;
}

export interface ReportTrendMonth {
  month: string;
  applicants: number;
  confirmed: number;
}

export type ReportOverview =
  | { state: "loading"; pending: ("applicants" | "usage")[] }
  | { state: "error"; failed: ("applicants" | "usage")[] }
  | {
      state: "ready";
      total: number;
      screening: number;
      reviewReady: number;
      confirmed: number;
      costLast30Days: number;
      excludedImports: number;
      stages: ReportStage[];
      trend: ReportTrendMonth[];
    };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstDate(ms: number): Date {
  return new Date(ms + KST_OFFSET_MS);
}

function kstTimestamp(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day) - KST_OFFSET_MS;
}

function rangeStart(range: ReportRange, now: Date): number {
  const current = kstDate(now.getTime());
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  const day = current.getUTCDate();

  if (range === "올해") return kstTimestamp(year, 0, 1);
  if (range === "이번 달") return kstTimestamp(year, month, 1);

  const mondayOffset = (current.getUTCDay() + 6) % 7;
  return kstTimestamp(year, month, day - mondayOffset);
}

function validTimestamp(createdAt: string | null): number | null {
  if (!createdAt) return null;
  const timestamp = new Date(createdAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isInRange(createdAt: string | null, range: ReportRange, now: Date): boolean {
  const timestamp = validTimestamp(createdAt);
  return timestamp !== null && timestamp >= rangeStart(range, now) && timestamp <= now.getTime();
}

function lastSixMonthKeys(now: Date): string[] {
  const current = kstDate(now.getTime());
  const currentMonth = current.getUTCFullYear() * 12 + current.getUTCMonth();

  return Array.from({ length: 6 }, (_, index) => {
    const monthIndex = currentMonth - 5 + index;
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    return `${year}-${String(month).padStart(2, "0")}`;
  });
}

function kstMonthKey(timestamp: number): string {
  const date = kstDate(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function reportOverview(input: {
  applicants?: ReportApplicantRow[];
  usage?: ReportUsageRow[];
  errors?: Partial<Record<"applicants" | "usage", unknown>>;
  range: ReportRange;
  now: Date;
}): ReportOverview {
  const sources = ["applicants", "usage"] as const;
  const failed = sources.filter((source) => Boolean(input.errors?.[source]));
  if (failed.length > 0) return { state: "error", failed };

  const pending = sources.filter((source) => input[source] === undefined);
  if (pending.length > 0) return { state: "loading", pending };

  const applicants = input.applicants!;
  const selectedApplicants = applicants.filter((applicant) => (
    !applicant.airtable_record_id && isInRange(applicant.created_at, input.range, input.now)
  ));
  const excludedImports = applicants.filter((applicant) => (
    Boolean(applicant.airtable_record_id) && isInRange(applicant.created_at, input.range, input.now)
  )).length;

  const count = (status: string) => selectedApplicants.filter((applicant) => applicant.status === status).length;
  const screening = count("스크리닝 중");
  const reviewReady = count("스크리닝 완료");
  const confirmed = count("확정인력");
  const received = count("스크리닝 전");
  const other = selectedApplicants.length - received - screening - reviewReady - confirmed;

  const monthKeys = lastSixMonthKeys(input.now);
  const trendByMonth = new Map(monthKeys.map((month) => [month, { applicants: 0, confirmed: 0 }]));
  for (const applicant of applicants) {
    if (applicant.airtable_record_id) continue;
    const timestamp = validTimestamp(applicant.created_at);
    if (timestamp === null || timestamp > input.now.getTime()) continue;
    const month = kstMonthKey(timestamp);
    const bucket = trendByMonth.get(month);
    if (!bucket) continue;
    bucket.applicants += 1;
    if (applicant.status === "확정인력") bucket.confirmed += 1;
  }

  const costLast30Days = input.usage!.reduce((sum, row) => (
    typeof row.total_cost_krw === "number" && Number.isFinite(row.total_cost_krw)
      ? sum + row.total_cost_krw
      : sum
  ), 0);

  return {
    state: "ready",
    total: selectedApplicants.length,
    screening,
    reviewReady,
    confirmed,
    costLast30Days,
    excludedImports,
    stages: [
      { key: "received", count: received },
      { key: "screening", count: screening },
      { key: "review", count: reviewReady },
      { key: "confirmed", count: confirmed },
      { key: "other", count: other },
    ],
    trend: monthKeys.map((month) => ({ month, ...trendByMonth.get(month)! })),
  };
}
