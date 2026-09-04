export type JobRegistrationFollowup<TDuplicateSource> = {
  jobId: number;
  title: string;
  note: string | null;
  duplicateSource: TDuplicateSource;
};

/** 외부 모집 전용 공고는 맞춤 공고 링크에 나오지 않아 인력풀 노출 명단을 만들 수 없다. */
export function shouldOfferSosCandidateSelection(
  sosId: string | null,
  recruitMode: string | null | undefined,
): boolean {
  return Boolean(sosId) && (recruitMode === "internal" || recruitMode === "both");
}

export function beginJobRegistrationFollowup<TDuplicateSource>(input: {
  jobId: number;
  title: string;
  note: string | null;
  duplicateSource: TDuplicateSource;
}): JobRegistrationFollowup<TDuplicateSource> {
  return input;
}
