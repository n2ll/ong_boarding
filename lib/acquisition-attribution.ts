import {
  JOB_PUBLISH_CHANNELS,
  type JobPublishSource,
} from "./admin/job-publishing.ts";

export type AcquisitionSource = JobPublishSource | "homepage" | "baemin";

export type DeclaredAcquisitionSource = {
  source: AcquisitionSource;
  isRecognized: boolean;
  verified: false;
};

export type CanonicalAcquisitionAttribution = {
  verified: true;
  method: string;
  source: AcquisitionSource;
  jobId: number | null;
  campaignId: string | null;
  linkId: string | null;
  trackingRef: string | null;
};

export type AcquisitionClaimResult =
  | {
      kind: "admitted" | "replay";
      attribution: CanonicalAcquisitionAttribution;
    }
  | {
      kind: "error";
      reason: "conflict" | "rate_limited" | "context_mismatch" | "malformed";
      retryAfterSeconds?: number;
    };

const PUBLIC_TRACKING_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACQUISITION_SOURCES = new Set<string>([
  ...JOB_PUBLISH_CHANNELS.map((channel) => channel.source),
  "homepage",
  "baemin",
]);

export function normalizePublicTrackingRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trackingRef = value.trim();
  return PUBLIC_TRACKING_REF.test(trackingRef) ? trackingRef : null;
}

export function normalizeDeclaredAcquisitionSource(value: unknown): DeclaredAcquisitionSource {
  const source = typeof value === "string" ? value.trim() : "";
  if (ACQUISITION_SOURCES.has(source)) {
    return {
      source: source as AcquisitionSource,
      isRecognized: true,
      verified: false,
    };
  }
  return { source: "direct", isRecognized: false, verified: false };
}

function claimRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data)
    ? data.length === 1 ? data[0] : null
    : data;
  return row !== null && typeof row === "object" && !Array.isArray(row)
    ? row as Record<string, unknown>
    : null;
}

function nullableIdentifier(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim();
}

export function parseAcquisitionClaimResult(input: {
  data: unknown;
  error: unknown;
}): AcquisitionClaimResult {
  if (input.error) return { kind: "error", reason: "malformed" };

  const row = claimRow(input.data);
  if (!row || typeof row.outcome !== "string") {
    return { kind: "error", reason: "malformed" };
  }

  if (row.outcome === "conflict" || row.outcome === "context_mismatch") {
    return { kind: "error", reason: row.outcome };
  }
  if (row.outcome === "rate_limited") {
    const retryAfterSeconds = row.retry_after_seconds;
    if (!Number.isSafeInteger(retryAfterSeconds) || (retryAfterSeconds as number) < 0) {
      return { kind: "error", reason: "malformed" };
    }
    return {
      kind: "error",
      reason: "rate_limited",
      retryAfterSeconds: retryAfterSeconds as number,
    };
  }
  if (row.outcome !== "admitted" && row.outcome !== "replay") {
    return { kind: "error", reason: "malformed" };
  }

  const method = typeof row.canonical_method === "string"
    ? row.canonical_method.trim()
    : "";
  const source = normalizeDeclaredAcquisitionSource(row.canonical_source);
  const jobId = row.canonical_job_id;
  const campaignId = nullableIdentifier(row.canonical_campaign_id);
  const linkId = nullableIdentifier(row.canonical_link_id);
  const trackingRef = row.tracking_ref === null
    ? null
    : normalizePublicTrackingRef(row.tracking_ref);

  if (
    !method
    || !source.isRecognized
    || !(jobId === null || (Number.isSafeInteger(jobId) && (jobId as number) > 0))
    || campaignId === undefined
    || linkId === undefined
    || (trackingRef === null && row.tracking_ref !== null)
  ) {
    return { kind: "error", reason: "malformed" };
  }

  return {
    kind: row.outcome,
    attribution: {
      verified: true,
      method,
      source: source.source,
      jobId: jobId as number | null,
      campaignId,
      linkId,
      trackingRef,
    },
  };
}
