export type JobRegistrationAnnouncement<T> =
  | { status: "checking" }
  | { status: "ready"; payload: T }
  | { status: "empty"; description: string | null }
  | { status: "error" };

export type JobRegistrationFollowup<T> = {
  jobId: number;
  title: string;
  note: string | null;
  announcement: JobRegistrationAnnouncement<T>;
};

export function beginJobRegistrationFollowup<T>(input: {
  jobId: number;
  title: string;
  note: string | null;
}): JobRegistrationFollowup<T> {
  return {
    ...input,
    announcement: { status: "checking" },
  };
}

export function settleJobRegistrationFollowup<T>(
  current: JobRegistrationFollowup<T> | null,
  jobId: number,
  announcement: JobRegistrationAnnouncement<T>,
): JobRegistrationFollowup<T> | null {
  if (!current || current.jobId !== jobId) return current;
  return { ...current, announcement };
}
