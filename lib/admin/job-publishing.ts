import { publicJobAvailability } from "../public-job.ts";

export const JOB_PUBLISH_CHANNELS = [
  { source: "facebook", label: "Meta 광고" },
  { source: "albamon", label: "알바몬" },
  { source: "jobkorea", label: "잡코리아" },
  { source: "openchat", label: "오픈카톡(용차방)" },
  { source: "referral", label: "지인 추천" },
  { source: "direct", label: "기타" },
] as const;

export type JobPublishSource = (typeof JOB_PUBLISH_CHANNELS)[number]["source"];

export type JobPublicPublishingAvailability =
  | { available: true }
  | { available: false; reason: "closed" | "hidden"; description: string };

export function jobPublicPublishingAvailability(input: {
  title: string | null;
  status: string | null;
  exposure: string | null;
  recruitMode: string | null;
  closesAt?: string | null;
}): JobPublicPublishingAvailability {
  const availability = publicJobAvailability(input);
  if (availability === "open") return { available: true };
  if (availability === "closed") {
    return {
      available: false,
      reason: "closed",
      description: "진행 중이고 마감 전인 공고에서만 지원 링크를 만들 수 있어요.",
    };
  }

  let description = "공고 상태를 안전하게 확인할 수 없어요.";
  if (input.title?.startsWith("__")) {
    description = "시스템 공고는 공개 지원 링크를 만들 수 없어요.";
  } else if (input.exposure === "targeted") {
    description = "지정 노출 공고는 공개 지원 링크를 만들 수 없어요.";
  } else if (input.recruitMode && input.recruitMode !== "external" && input.recruitMode !== "both") {
    description = "내부 모집 공고는 공개 지원 링크를 만들 수 없어요.";
  }

  return { available: false, reason: "hidden", description };
}

export function buildExternalPublishingBundle(input: {
  body: string | null | undefined;
  url: string;
}): string {
  const body = input.body?.trim();
  const applicationAction = `지원하기: ${input.url.trim()}`;
  return body ? `${body}\n\n${applicationAction}` : applicationAction;
}

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
