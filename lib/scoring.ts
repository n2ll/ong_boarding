/**
 * 후보자 추천 점수 계산
 *
 * 만점 100점:
 *   - 거리: 0~70 (위치 근접도, 가장 중요)
 *   - 차량: 0~20
 *   - 최신성: 0~10
 */

import { haversineKm } from "./kakao-geocode";

export interface CandidateForScoring {
  id: number;
  source: "applicant" | "legacy";
  name: string;
  phone: string;
  lat: number;
  lng: number;
  own_vehicle?: string | null;
  created_at: string;
  /**
   * 최신성 판정에 쓰는 '실제 지원/활동 시점'. Airtable 임포트 인원은 created_at이
   * 임포트일(전원 동일)이라 무의미하므로, API가 실제 제출일·마지막 활동으로 보정해 내려준다.
   * 미지정이면 created_at으로 폴백한다.
   */
  recency_at?: string | null;
  sigungu?: string | null;
  location?: string | null;
  birth_date?: string | null;
}

export interface ScoreBreakdown {
  total: number;
  distance: number;
  vehicle: number;
  recency: number;
  distanceKm: number;
}

export interface ScoredCandidate extends CandidateForScoring {
  score: ScoreBreakdown;
}

export function distanceScore(km: number): number {
  if (km <= 3) return 70;
  if (km <= 7) return 50;
  if (km <= 15) return 30;
  if (km <= 25) return 15;
  return 0;
}

export function vehicleScore(
  ownVehicle: string | null | undefined,
  required: boolean
): number {
  if (!required) return 12;
  return ownVehicle === "있음" ? 20 : 0;
}

/**
 * 최신성 점수. iso는 '실제 지원/활동 시점'(recency_at)을 우선 넘긴다.
 * 파싱 불가·미지정이면 0점(최근 아님)으로 취급해 임포트 인원이 거짓 '최근'으로 뜨지 않게 한다.
 */
export function recencyScore(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  const days = (Date.now() - t) / 86400000;
  if (days <= 30) return 10;
  if (days <= 90) return 8;
  if (days <= 180) return 5;
  return 0;
}

export function scoreCandidate(
  c: CandidateForScoring,
  jobLat: number,
  jobLng: number,
  vehicleRequired: boolean
): ScoredCandidate {
  const km = haversineKm(c.lat, c.lng, jobLat, jobLng);
  const d = distanceScore(km);
  const v = vehicleScore(c.own_vehicle, vehicleRequired);
  // 실제 지원/활동 시점 우선, 없으면 created_at 폴백.
  const r = recencyScore(c.recency_at ?? c.created_at);
  return {
    ...c,
    score: {
      total: d + v + r,
      distance: d,
      vehicle: v,
      recency: r,
      distanceKm: km,
    },
  };
}

export function rankCandidates(
  candidates: CandidateForScoring[],
  jobLat: number,
  jobLng: number,
  vehicleRequired: boolean,
  topN = 10
): ScoredCandidate[] {
  return candidates
    .map((c) => scoreCandidate(c, jobLat, jobLng, vehicleRequired))
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, topN);
}
