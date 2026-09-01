export type JobRegistrationAnnouncement<T> =
  | { status: "checking" }
  | { status: "ready"; payload: T }
  | { status: "empty"; description: string | null }
  | { status: "error" };

export type JobRegistrationFollowup<T, TDuplicateSource> = {
  jobId: number;
  title: string;
  note: string | null;
  duplicateSource: TDuplicateSource;
  announcement: JobRegistrationAnnouncement<T>;
};

/** 외부 모집 전용 공고는 맞춤 공고 링크에 나오지 않아 인력풀 노출 명단을 만들 수 없다. */
export function shouldOfferSosCandidateSelection(
  sosId: string | null,
  recruitMode: string | null | undefined,
): boolean {
  return Boolean(sosId) && (recruitMode === "internal" || recruitMode === "both");
}

export function beginJobRegistrationFollowup<T, TDuplicateSource>(input: {
  jobId: number;
  title: string;
  note: string | null;
  duplicateSource: TDuplicateSource;
  announcement?: JobRegistrationAnnouncement<T>;
}): JobRegistrationFollowup<T, TDuplicateSource> {
  const { announcement = { status: "checking" }, ...followup } = input;
  return {
    ...followup,
    announcement,
  };
}

export function settleJobRegistrationFollowup<T, TDuplicateSource>(
  current: JobRegistrationFollowup<T, TDuplicateSource> | null,
  jobId: number,
  announcement: JobRegistrationAnnouncement<T>,
): JobRegistrationFollowup<T, TDuplicateSource> | null {
  if (!current || current.jobId !== jobId) return current;
  return { ...current, announcement };
}
