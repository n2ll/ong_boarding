export const SOURCE_LABELS: Record<string, string> = {
  danggeun: "당근",
  baemin: "배민",
  facebook: "페이스북",
  naver: "네이버 검색",
  homepage: "홈페이지",
  direct: "해당없음",
};

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "—";
  return SOURCE_LABELS[source] ?? source;
}
