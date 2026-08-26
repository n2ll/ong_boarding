export interface CurrentJobPostingLocation {
  pickupAddress: string;
  dropoffAddress: string;
}

function normalizeLocation(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function buildCurrentJobPostingLocationContext({
  pickupAddress,
  dropoffAddress,
}: CurrentJobPostingLocation): string | undefined {
  const pickup = normalizeLocation(pickupAddress);
  const dropoff = normalizeLocation(dropoffAddress);
  if (!pickup && !dropoff) return undefined;

  return [
    "[이번 공고 입력 위치 — 화주사·지점 마스터와 다르면 아래 값을 우선합니다]",
    pickup ? `상차지·집결지: ${pickup}` : null,
    dropoff ? `배송 권역·마지막 경유지: ${dropoff}` : null,
  ].filter(Boolean).join("\n");
}

export function formatCurrentJobPostingLocation({
  pickupAddress,
  dropoffAddress,
}: CurrentJobPostingLocation): string {
  const pickup = normalizeLocation(pickupAddress);
  const dropoff = normalizeLocation(dropoffAddress);

  return [
    pickup ? `상차·집결 ${pickup}` : null,
    dropoff ? `배송·종료 ${dropoff}` : null,
  ].filter(Boolean).join(" / ");
}
