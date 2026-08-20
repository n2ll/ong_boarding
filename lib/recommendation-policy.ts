const RECOMMENDATION_POOL_EXCLUDED_STATUSES = new Set(["부적합", "이탈"]);

export function recommendationExcludedStatusFilter(): string {
  return "(부적합,이탈)";
}

export function isRecommendationPoolEligibleStatus(status: string | null | undefined): boolean {
  return !status || !RECOMMENDATION_POOL_EXCLUDED_STATUSES.has(status);
}
