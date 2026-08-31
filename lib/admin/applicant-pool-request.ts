type ApplicantPoolResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

type ApplicantPoolFetcher = (input: string) => Promise<ApplicantPoolResponse>;

type ApplicantPoolPayload = {
  data?: unknown;
  error?: unknown;
};

/** 후보 피커는 실패 응답을 빈 인재풀로 오인하지 않고 명시적인 오류로 올린다. */
export async function fetchApplicantPool(
  fetcher: ApplicantPoolFetcher = fetch,
): Promise<unknown[]> {
  const response = await fetcher("/api/admin/applicants");
  const payload = await response.json().catch(() => null) as ApplicantPoolPayload | null;

  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : "인재풀을 불러오지 못했어요",
    );
  }
  if (!Array.isArray(payload?.data)) {
    throw new Error("인재풀 응답 형식이 올바르지 않아요");
  }

  return payload.data;
}
