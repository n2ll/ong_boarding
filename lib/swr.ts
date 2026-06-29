// 어드민 화면 공용 SWR fetcher. JSON 응답을 그대로 반환한다.
// 네트워크/HTTP 오류는 throw하여 SWR의 error 상태로 흐르게 한다.
export async function jsonFetcher<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`요청 실패 (${res.status})`);
  }
  return (await res.json()) as T;
}
