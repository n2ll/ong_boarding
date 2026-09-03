import { distanceToJobKm, type GeoJob } from "../geo.ts";
import { distanceScore, recencyScore, vehicleScore } from "../scoring.ts";

export interface PipelineRecommendationCard {
  id: string;
  lat: number | null;
  lng: number | null;
  vehicleClass: "확정" | "도보" | "미확인";
  createdAtIso: string | null;
  appliedAtIso: string | null;
  lastMessageAtIso: string | null;
}

export interface PipelineRecommendationJob {
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
  distanceBasis: "pickup" | "nearest" | null;
  vehicleRequired: boolean | null;
}

export interface PipelineRecommendationMatch {
  applicantId: string;
  rank: number;
  total: number;
  distance: number;
  vehicle: number;
  recency: number;
  distanceKm: number;
  activityAt: string | null;
  vehicleFit: "meets" | "does_not_meet" | "needs_review" | "not_required";
}

export interface PipelineRecommendationResult {
  rankedApplicantIds: string[];
  matchByApplicantId: Record<string, PipelineRecommendationMatch>;
  scoredCount: number;
  missingLocationCount: number;
}

function recommendationActivityAt(card: PipelineRecommendationCard): string | null {
  for (const value of [card.lastMessageAtIso, card.appliedAtIso, card.createdAtIso]) {
    if (value && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

function recommendationVehicle(card: PipelineRecommendationCard): string | null {
  if (card.vehicleClass === "확정") return "있음";
  if (card.vehicleClass === "도보") return "없음";
  return null;
}

function recommendationVehicleFit(
  vehicleClass: PipelineRecommendationCard["vehicleClass"],
  vehicleRequired: boolean,
): PipelineRecommendationMatch["vehicleFit"] {
  if (!vehicleRequired) return "not_required";
  if (vehicleClass === "확정") return "meets";
  if (vehicleClass === "도보") return "does_not_meet";
  return "needs_review";
}

/**
 * 이미 화면에 로드된 인재풀과 공고 좌표로 설명 가능한 규칙 순위를 만든다.
 * 거리 공식은 공고 노출·근거리 정렬과 같은 distanceToJobKm만 사용한다.
 * 순위는 선택·노출·연락을 일으키지 않으며, 좌표가 없는 사람은 사실을 만들지 않고 미추천으로 둔다.
 */
export function pipelineJobRecommendations(
  cards: readonly PipelineRecommendationCard[],
  job: PipelineRecommendationJob,
  limit = 50,
): PipelineRecommendationResult {
  const geoJob: GeoJob = {
    pickup_lat: job.pickupLat,
    pickup_lng: job.pickupLng,
    dropoff_lat: job.dropoffLat,
    dropoff_lng: job.dropoffLng,
    distance_basis: job.distanceBasis,
  };
  const vehicleRequired = job.vehicleRequired === true;
  const scored = cards.flatMap((card) => {
    if (!Number.isFinite(card.lat) || !Number.isFinite(card.lng)) return [];
    const distanceKm = distanceToJobKm(card, geoJob);
    if (distanceKm === null || !Number.isFinite(distanceKm)) return [];

    const activityAt = recommendationActivityAt(card);
    const distance = distanceScore(distanceKm);
    const vehicle = vehicleRequired ? vehicleScore(recommendationVehicle(card), true) : 0;
    const recency = recencyScore(activityAt);
    return [{
      applicantId: card.id,
      rank: 0,
      total: distance + vehicle + recency,
      distance,
      vehicle,
      recency,
      distanceKm,
      activityAt,
      vehicleFit: recommendationVehicleFit(card.vehicleClass, vehicleRequired),
    } satisfies PipelineRecommendationMatch];
  });

  scored.sort((a, b) => {
    if (a.total !== b.total) return b.total - a.total;
    if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    const aActivity = a.activityAt ? Date.parse(a.activityAt) : Number.NEGATIVE_INFINITY;
    const bActivity = b.activityAt ? Date.parse(b.activityAt) : Number.NEGATIVE_INFINITY;
    if (aActivity !== bActivity) return bActivity - aActivity;
    return a.applicantId.localeCompare(b.applicantId, "ko", { numeric: true });
  });

  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 50));
  const matches = scored.slice(0, safeLimit).map((match, index) => ({ ...match, rank: index + 1 }));
  return {
    rankedApplicantIds: matches.map((match) => match.applicantId),
    matchByApplicantId: Object.fromEntries(matches.map((match) => [match.applicantId, match])),
    scoredCount: scored.length,
    missingLocationCount: cards.length - scored.length,
  };
}

/** 추천 우선은 행을 숨기지 않는다. 추천 밖의 기존 필터 결과와 그 순서를 그대로 뒤에 보존한다. */
export function prioritizePipelineRecommendations<T extends { id: string }>(
  cards: readonly T[],
  rankedApplicantIds: readonly string[],
  enabled: boolean,
): T[] {
  if (!enabled || rankedApplicantIds.length === 0) return [...cards];
  const rank = new Map(rankedApplicantIds.map((id, index) => [id, index]));
  return [...cards].sort((a, b) => {
    const aRank = rank.get(a.id);
    const bRank = rank.get(b.id);
    if (aRank === undefined && bRank === undefined) return 0;
    if (aRank === undefined) return 1;
    if (bRank === undefined) return -1;
    return aRank - bRank;
  });
}
