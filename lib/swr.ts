// 어드민 화면 공용 SWR fetcher. JSON 응답을 그대로 반환한다.
// 네트워크/HTTP 오류는 throw하여 SWR의 error 상태로 흐르게 한다.
// 401(세션 만료)은 로그인 페이지로 보낸다(I-2) — 죽은 화면 대신 재로그인 유도.
export async function jsonFetcher<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url);
  if (res.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  if (!res.ok) {
    throw new Error(`요청 실패 (${res.status})`);
  }
  return (await res.json()) as T;
}
