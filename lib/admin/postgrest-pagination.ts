const POSTGREST_PAGE_SIZE = 1_000;

type PostgrestPage<T> = {
  data: T[] | null;
  error: { message?: string } | null;
};

/** PostgREST의 기본 1000행 상한을 넘어도 부분 결과를 정상값으로 돌려보내지 않는다. */
export async function fetchAllPostgrestRows<T>(
  fetchPage: (from: number, to: number) => Promise<PostgrestPage<T>>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];

  for (let from = 0; ; from += POSTGREST_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + POSTGREST_PAGE_SIZE - 1);
    if (error) {
      throw new Error(`${label} 조회 실패: ${error.message ?? "알 수 없는 오류"}`);
    }
    if (!Array.isArray(data)) {
      throw new Error(`${label} 응답 형식이 올바르지 않습니다.`);
    }

    rows.push(...data);
    if (data.length < POSTGREST_PAGE_SIZE) return rows;
  }
}
