export const JOB_PUBLISH_CHANNELS = [
  { source: "facebook", label: "Meta 광고" },
  { source: "albamon", label: "알바몬" },
  { source: "jobkorea", label: "잡코리아" },
  { source: "openchat", label: "오픈카톡(용차방)" },
  { source: "referral", label: "지인 추천" },
  { source: "direct", label: "기타" },
] as const;

export type JobPublishSource = (typeof JOB_PUBLISH_CHANNELS)[number]["source"];

export function buildExistingPoolSearchAction(input: {
  jobId: number | string;
  effectivelyClosed: boolean;
  recruitMode: string;
  remaining: number | null;
  needsCandidateSourcing: boolean;
}): { href: string; label: string; description: string } | null {
  if (
    input.effectivelyClosed
    || (input.recruitMode !== "internal" && input.recruitMode !== "both")
    || !input.needsCandidateSourcing
    || input.remaining === null
    || input.remaining <= 0
  ) {
    return null;
  }

  return {
    href: `/pipeline?job=${encodeURIComponent(String(input.jobId))}`,
    label: `인력풀에서 남은 ${input.remaining}명 찾기`,
    description: "맞춤 공고를 보여줄 대상을 선별하세요",
  };
}

export function buildJobApplicationUrl(input: {
  origin: string;
  jobId: number | string;
  source: JobPublishSource;
  branch?: string | null;
  trackingRef?: string | null;
}): string {
  const params = new URLSearchParams({
    source: input.source,
    job: String(input.jobId),
  });
  const branch = input.branch?.trim();
  if (branch && branch !== "-") params.set("branch", branch);
  const trackingRef = input.trackingRef?.trim();
  if (trackingRef) params.set("ref", trackingRef);

  return `${input.origin.replace(/\/$/, "")}/apply?${params.toString()}`;
}
