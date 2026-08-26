function canonicalDraftValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalDraftValue)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalDraftValue(entry)]),
    );
  }

  return value;
}

/** 수정 폼의 순서 없는 칩 배열까지 정규화해 실제 내용 변경만 감지한다. */
export function hasJobEditDraftChanges(
  baseline: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): boolean {
  return JSON.stringify(canonicalDraftValue(baseline)) !== JSON.stringify(canonicalDraftValue(current));
}
