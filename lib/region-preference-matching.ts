/** 희망 권역 일치는 연락 검토 근거일 뿐 통근·차량 적합 판정이 아니다. */
export interface RegionPreferenceRow {
  applicant_id: number;
  meta: unknown;
}

function areaWords(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean).map((part) => {
    const bare = part.replace(/(?:특별자치도|특별자치시|특별시|광역시|도|시|군|구)$/, "");
    return bare.length >= 2 ? bare : part;
  });
}

/** 최신순 원장에서 지원자별 마지막 명시 희망만 적용한다. 주소의 도로명은 지역으로 쓰지 않는다. */
export function regionPreferredApplicantIds(rows: RegionPreferenceRow[], job: { pickup_address?: string | null; dropoff_address?: string | null }): number[] {
  const areas = [job.pickup_address, job.dropoff_address].filter((value): value is string => Boolean(value?.trim()))
    .map((address) => areaWords(address.split(/\s+/).slice(0, 2).join(" ")));
  const seen = new Set<number>();
  const matching: number[] = [];
  const sourceTime = (row: RegionPreferenceRow) => {
    const value = (row.meta as { source_created_at?: unknown } | null)?.source_created_at;
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : Infinity; // 손상된 새 이력은 옛 희망으로 되돌리지 않는다.
  };
  for (const row of [...rows].sort((a, b) => sourceTime(b) - sourceTime(a))) {
    if (seen.has(row.applicant_id)) continue;
    seen.add(row.applicant_id);
    if (!Number.isFinite(sourceTime(row))) continue;
    const meta = row.meta as { source?: unknown; regions?: unknown; quote?: unknown; source_message_id?: unknown } | null;
    const quote = meta?.quote;
    if (meta?.source !== "inbound_sms" || typeof quote !== "string" || typeof meta.source_message_id !== "string"
      || !Array.isArray(meta.regions) || !meta.regions.length
      || !meta.regions.every((region) => typeof region === "string" && region.trim().length >= 2 && quote.includes(region))) continue;
    const matches = (meta.regions as string[]).some((region) => {
      const words = areaWords(region);
      return words.length > 0 && areas.some((area) => words.every((word) => area.includes(word)));
    });
    if (matches) matching.push(row.applicant_id);
  }
  return matching;
}
