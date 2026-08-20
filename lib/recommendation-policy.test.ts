import assert from "node:assert/strict";
import test from "node:test";

type RecommendationPolicyModule = {
  recommendationExcludedStatusFilter?: () => string;
  isRecommendationPoolEligibleStatus?: (status: string | null | undefined) => boolean;
};

async function loadModule(): Promise<RecommendationPolicyModule> {
  try {
    return await import(new URL("./recommendation-policy.ts", import.meta.url).href) as RecommendationPolicyModule;
  } catch {
    return {};
  }
}

test("recommendation excludes only person-level pool removals", async () => {
  const { recommendationExcludedStatusFilter, isRecommendationPoolEligibleStatus } = await loadModule();

  assert.equal(typeof recommendationExcludedStatusFilter, "function");
  assert.equal(typeof isRecommendationPoolEligibleStatus, "function");
  assert.equal(recommendationExcludedStatusFilter!(), "(부적합,이탈)");
  assert.equal(isRecommendationPoolEligibleStatus!("부적합"), false);
  assert.equal(isRecommendationPoolEligibleStatus!("이탈"), false);
  assert.equal(isRecommendationPoolEligibleStatus!("확정인력"), true);
  assert.equal(isRecommendationPoolEligibleStatus!("스크리닝 완료"), true);
});
