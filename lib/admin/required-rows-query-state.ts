type RowsQueryResult = {
  data?: unknown;
  error?: unknown;
};

export type RequiredRowsQueryState =
  | { ok: false; failed: string[]; cause: unknown }
  | { ok: true; rows: Record<string, unknown[]> };

/**
 * 필수 목록 조회는 실제 빈 배열만 성공으로 인정한다.
 * 오류나 불완전한 200 응답을 `?? []`로 축약해 정상 0건처럼 보이지 않게 한다.
 */
export function requiredRowsQueryState(
  sources: Record<string, RowsQueryResult>,
): RequiredRowsQueryState {
  const entries = Object.entries(sources);
  const failed = entries.filter(([, result]) => result.error != null || !Array.isArray(result.data));

  if (failed.length > 0) {
    const [firstName, firstResult] = failed[0];
    return {
      ok: false,
      failed: failed.map(([name]) => name),
      cause: firstResult.error ?? `${firstName} 응답 형식이 올바르지 않습니다.`,
    };
  }

  return {
    ok: true,
    rows: Object.fromEntries(entries.map(([name, result]) => [name, result.data as unknown[]])),
  };
}

