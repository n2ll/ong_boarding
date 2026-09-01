import { JOB_PUBLISH_CHANNELS, type JobPublishSource } from "./job-publishing.ts";

export type AcquisitionLinkRequest =
  | {
      ok: true;
      jobId: number;
      source: JobPublishSource;
      campaignName: string;
      channelLabel: string;
    }
  | { ok: false; reason: "invalid_job" | "invalid_source" };

export function parseAcquisitionLinkRequest(input: {
  jobId: unknown;
  source: unknown;
}): AcquisitionLinkRequest {
  const jobId = typeof input.jobId === "string" && input.jobId.trim()
    ? Number(input.jobId)
    : input.jobId;
  if (typeof jobId !== "number" || !Number.isSafeInteger(jobId) || jobId <= 0) {
    return { ok: false, reason: "invalid_job" };
  }

  const channel = JOB_PUBLISH_CHANNELS.find((candidate) => candidate.source === input.source);
  if (!channel) return { ok: false, reason: "invalid_source" };

  return {
    ok: true,
    jobId,
    source: channel.source,
    campaignName: `${channel.label} 모집 링크`,
    channelLabel: channel.label,
  };
}
