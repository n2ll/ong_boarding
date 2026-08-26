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

export function beginJobRegistrationFollowup<T, TDuplicateSource>(input: {
  jobId: number;
  title: string;
  note: string | null;
  duplicateSource: TDuplicateSource;
}): JobRegistrationFollowup<T, TDuplicateSource> {
  return {
    ...input,
    announcement: { status: "checking" },
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
