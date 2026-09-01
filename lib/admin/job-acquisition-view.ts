export type JobAcquisitionAttributionMethod =
  | "verified_link"
  | "signed_internal"
  | "legacy_declared"
  | "direct"
  | "invalid_ref";

export type JobAcquisitionCandidateLinkOutcome =
  | "linked"
  | "already_linked"
  | "unchanged_closed"
  | "unavailable"
  | "failed"
  | "not_requested"
  | null;

export type JobAcquisitionPerformanceRow = {
  submission_id: string;
  source: string;
  attribution_method: JobAcquisitionAttributionMethod;
  candidate_link_outcome: JobAcquisitionCandidateLinkOutcome;
};

export type JobAcquisitionCounts = {
  submissions: number;
  verifiedExternal: number;
  trustedInternal: number;
  unverified: number;
  directOrganic: number;
  linked: number;
  repeatInterest: number;
  pending: number;
  failed: number;
};

export type JobAcquisitionChannel = JobAcquisitionCounts & { source: string };

export type JobAcquisitionView =
  | { state: "loading" }
  | { state: "error" }
  | { state: "empty"; summary: JobAcquisitionCounts; channels: [] }
  | {
      state: "ready" | "stale";
      summary: JobAcquisitionCounts;
      channels: JobAcquisitionChannel[];
    };

function emptyCounts(): JobAcquisitionCounts {
  return {
    submissions: 0,
    verifiedExternal: 0,
    trustedInternal: 0,
    unverified: 0,
    directOrganic: 0,
    linked: 0,
    repeatInterest: 0,
    pending: 0,
    failed: 0,
  };
}

function addRow(counts: JobAcquisitionCounts, row: JobAcquisitionPerformanceRow): void {
  counts.submissions += 1;

  if (row.attribution_method === "verified_link") counts.verifiedExternal += 1;
  if (row.attribution_method === "signed_internal") counts.trustedInternal += 1;
  if (row.attribution_method === "legacy_declared" || row.attribution_method === "invalid_ref") {
    counts.unverified += 1;
  }
  if (row.attribution_method === "direct") counts.directOrganic += 1;

  if (row.candidate_link_outcome === "linked") counts.linked += 1;
  if (row.candidate_link_outcome === "already_linked") counts.repeatInterest += 1;
  if (row.candidate_link_outcome === null) counts.pending += 1;
  if (row.candidate_link_outcome === "failed") counts.failed += 1;
}

export function jobAcquisitionView(input: {
  rows?: JobAcquisitionPerformanceRow[];
  error?: unknown;
}): JobAcquisitionView {
  if (input.rows === undefined) {
    return input.error ? { state: "error" } : { state: "loading" };
  }

  const summary = emptyCounts();
  const channelsBySource = new Map<string, JobAcquisitionChannel>();

  for (const row of input.rows) {
    addRow(summary, row);

    let channel = channelsBySource.get(row.source);
    if (!channel) {
      channel = { source: row.source, ...emptyCounts() };
      channelsBySource.set(row.source, channel);
    }
    addRow(channel, row);
  }

  const channels = [...channelsBySource.values()].sort(
    (left, right) => right.submissions - left.submissions || left.source.localeCompare(right.source),
  );

  if (input.error) return { state: "stale", summary, channels };
  if (input.rows.length === 0) return { state: "empty", summary, channels: [] };
  return { state: "ready", summary, channels };
}
