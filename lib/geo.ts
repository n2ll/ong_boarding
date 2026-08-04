/**
 * 거리 판정 단일 공식 — 공고와 지원자 사이 거리를 재는 곳은 **여기 하나**다.
 *
 * 왜 만들었나: 같은 질문에 세 가지 답이 있었다.
 *  · `app/api/pool/[token]/route.ts`가 사설 `distKm`으로 **집결지만** 재서 지원자 카드에 표시
 *  · `app/api/admin/jobs/[id]/announce-targets/route.ts`가 `haversineKm`으로 **집결지·마지막 경유지 중 가까운 쪽**을 재서 15km 대상 산정
 *  · 파이프라인 '공고 근거리순' 정렬은 또 자체 계산
 * 실측(2026-07-29): 공고 33(용산·한남)은 집결지↔경유지가 13.8km 떨어져 15km 대상이
 * **190명(집결지) ↔ 296명(가까운 쪽)** 으로 갈렸다. 화면마다 다른 숫자가 나오면 매니저가 믿을 수 없다.
 *
 * 기준은 **공고가 정한다**(`jobs.distance_basis`) — 라인마다 집결지·경유지 관계가 달라서다.
 */

/** 거리 계산 기준 — 공고 컬럼 `jobs.distance_basis`와 같은 값 집합. */
export type DistanceBasis = "pickup" | "nearest";

export const DISTANCE_BASIS_VALUES: readonly DistanceBasis[] = ["pickup", "nearest"];

/** 기본값 — '대기자에게 안내' 조건 매칭이 이미 이 기준이라, 기본을 바꾸면 기존 대상이 조용히 좁아진다. */
export const DEFAULT_DISTANCE_BASIS: DistanceBasis = "nearest";

export const DISTANCE_BASIS_LABEL: Record<DistanceBasis, string> = {
  pickup: "집결지에서",
  nearest: "집결지·마지막 경유지 중 가까운 곳에서",
};

/** 들어온 값을 안전한 기준으로 — 알 수 없는 값은 기본값(넓은 쪽)으로 본다. */
export function normalizeDistanceBasis(v: unknown): DistanceBasis {
  return v === "pickup" ? "pickup" : DEFAULT_DISTANCE_BASIS;
}

/** 거리 판정에 필요한 공고 필드. select에서 이 컬럼들을 빠뜨리면 거리 판정이 조용히 죽는다. */
export interface GeoJob {
  pickup_lat: number | null;
  pickup_lng: number | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  distance_basis?: string | null;
}

/**
 * 거리 판정용 공고 select 컬럼 — 판정 지점이 모두 같은 문자열을 쓰게 해서
 * `grep EXPOSURE_JOB_GEO_COLUMNS`로 누락 점검이 성립하게 한다.
 */
export const EXPOSURE_JOB_GEO_COLUMNS =
  "pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_basis";

/** 하버사인 거리(km). 지구 반지름 6371km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 이 공고의 거리 기준점들 — basis에 따라 집결지만, 또는 집결지+마지막 경유지. */
export function jobAnchors(job: GeoJob | null | undefined): { lat: number; lng: number }[] {
  if (!job) return [];
  const basis = normalizeDistanceBasis(job.distance_basis);
  const out: { lat: number; lng: number }[] = [];
  if (typeof job.pickup_lat === "number" && typeof job.pickup_lng === "number") {
    out.push({ lat: job.pickup_lat, lng: job.pickup_lng });
  }
  if (basis === "nearest" && typeof job.dropoff_lat === "number" && typeof job.dropoff_lng === "number") {
    out.push({ lat: job.dropoff_lat, lng: job.dropoff_lng });
  }
  return out;
}

/**
 * 지원자 ↔ 공고 거리(km). 재료가 없으면 **null**(0이 아니다 — 0으로 두면 '아주 가까움'으로 오판된다).
 * null인 경우: 지원자 좌표 없음(실측 186명 — 주소가 '미지정'·'미확인' 플레이스홀더라 지오코딩 불가) ·
 * 공고 좌표 없음(주소 미입력·지오코딩 실패).
 */
export function distanceToJobKm(
  applicant: { lat: number | null; lng: number | null },
  job: GeoJob | null | undefined
): number | null {
  if (typeof applicant.lat !== "number" || typeof applicant.lng !== "number") return null;
  const anchors = jobAnchors(job);
  if (anchors.length === 0) return null;
  return Math.min(...anchors.map((p) => haversineKm(applicant.lat as number, applicant.lng as number, p.lat, p.lng)));
}

/** 이 공고로 거리 판정이 가능한가 — 반경 규칙을 저장해도 되는지 판단하는 데 쓴다. */
export function jobSupportsRadius(job: GeoJob | null | undefined): boolean {
  return jobAnchors(job).length > 0;
}
