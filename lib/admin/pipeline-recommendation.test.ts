import assert from "node:assert/strict";
import test from "node:test";

type RecommendationCard = {
  id: string;
  lat: number | null;
  lng: number | null;
  vehicleClass: "확정" | "도보" | "미확인";
  createdAtIso: string | null;
  appliedAtIso: string | null;
  lastMessageAtIso: string | null;
};

type RecommendationJob = {
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
  distanceBasis: "pickup" | "nearest" | null;
  vehicleRequired: boolean | null;
};

type RecommendationResult = {
  rankedApplicantIds: string[];
  matchByApplicantId: Record<string, {
    applicantId: string;
    rank: number;
    total: number;
    distance: number;
    vehicle: number;
    recency: number;
    distanceKm: number;
    activityAt: string | null;
    vehicleFit: "meets" | "does_not_meet" | "needs_review" | "not_required";
  }>;
  scoredCount: number;
  missingLocationCount: number;
};

type PipelineRecommendationModule = {
  pipelineJobRecommendations?: (
    cards: readonly RecommendationCard[],
    job: RecommendationJob,
    limit?: number,
  ) => RecommendationResult;
  prioritizePipelineRecommendations?: <T extends { id: string }>(
    cards: readonly T[],
    rankedApplicantIds: readonly string[],
    enabled: boolean,
  ) => T[];
};

async function loadModule(): Promise<PipelineRecommendationModule> {
  try {
    return await import(new URL("./pipeline-recommendation.ts", import.meta.url).href) as PipelineRecommendationModule;
  } catch {
    return {};
  }
}

const job: RecommendationJob = {
  pickupLat: 37.5665,
  pickupLng: 126.978,
  dropoffLat: 37.3943,
  dropoffLng: 127.1112,
  distanceBasis: "nearest",
  vehicleRequired: true,
};

const cards: RecommendationCard[] = [
  {
    id: "near-pickup",
    lat: 37.5666,
    lng: 126.9781,
    vehicleClass: "도보",
    createdAtIso: "2020-01-01T00:00:00.000Z",
    appliedAtIso: "2099-01-01T00:00:00.000Z",
    lastMessageAtIso: null,
  },
  {
    id: "near-dropoff",
    lat: 37.3944,
    lng: 127.1113,
    vehicleClass: "확정",
    createdAtIso: "2020-01-01T00:00:00.000Z",
    appliedAtIso: null,
    lastMessageAtIso: null,
  },
  {
    id: "unknown-location",
    lat: null,
    lng: null,
    vehicleClass: "확정",
    createdAtIso: "2099-01-01T00:00:00.000Z",
    appliedAtIso: null,
    lastMessageAtIso: null,
  },
];

test("pipeline recommendation uses the job's pickup-or-nearest distance rule", async () => {
  const { pipelineJobRecommendations } = await loadModule();
  assert.equal(typeof pipelineJobRecommendations, "function");

  const nearest = pipelineJobRecommendations!(cards, job);
  assert.deepEqual(nearest.rankedApplicantIds, ["near-dropoff", "near-pickup"]);
  assert.ok(nearest.matchByApplicantId["near-dropoff"].distanceKm < 0.1);
  assert.equal(nearest.matchByApplicantId["near-dropoff"].vehicleFit, "meets");
  assert.equal(nearest.matchByApplicantId["near-pickup"].vehicleFit, "does_not_meet");
  assert.equal(nearest.scoredCount, 2);
  assert.equal(nearest.missingLocationCount, 1);

  const pickupOnly = pipelineJobRecommendations!(cards, { ...job, distanceBasis: "pickup" });
  assert.ok(pickupOnly.matchByApplicantId["near-dropoff"].distanceKm > 10);
});

test("pipeline recommendation uses activity evidence without inventing missing facts", async () => {
  const { pipelineJobRecommendations } = await loadModule();
  assert.equal(typeof pipelineJobRecommendations, "function");

  const result = pipelineJobRecommendations!(cards, job);
  assert.equal(result.matchByApplicantId["near-pickup"].activityAt, "2099-01-01T00:00:00.000Z");
  assert.equal(result.matchByApplicantId["near-pickup"].recency, 10);
  assert.equal(result.matchByApplicantId["near-dropoff"].recency, 0);
  assert.equal(result.matchByApplicantId["near-dropoff"].total, 90);
});

test("pipeline recommendation returns no invented ranking when the job has no coordinates", async () => {
  const { pipelineJobRecommendations } = await loadModule();
  assert.equal(typeof pipelineJobRecommendations, "function");

  const result = pipelineJobRecommendations!(cards, {
    ...job,
    pickupLat: null,
    pickupLng: null,
    dropoffLat: null,
    dropoffLng: null,
  });
  assert.deepEqual(result.rankedApplicantIds, []);
  assert.deepEqual(result.matchByApplicantId, {});
  assert.equal(result.scoredCount, 0);
});

test("recommendation priority reorders rows without hiding unranked people", async () => {
  const { prioritizePipelineRecommendations } = await loadModule();
  assert.equal(typeof prioritizePipelineRecommendations, "function");

  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(
    prioritizePipelineRecommendations!(rows, ["c", "a"], true).map((row) => row.id),
    ["c", "a", "b", "d"],
  );
  assert.deepEqual(
    prioritizePipelineRecommendations!(rows, ["c", "a"], false).map((row) => row.id),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(rows.map((row) => row.id), ["a", "b", "c", "d"], "source order stays untouched");
});

test("recommendation limit affects highlighted ranks but keeps the scored pool count", async () => {
  const { pipelineJobRecommendations } = await loadModule();
  assert.equal(typeof pipelineJobRecommendations, "function");

  const result = pipelineJobRecommendations!(cards, job, 1);
  assert.deepEqual(result.rankedApplicantIds, ["near-dropoff"]);
  assert.equal(result.scoredCount, 2);
  assert.equal(Object.keys(result.matchByApplicantId).length, 1);
});

test("a job without a vehicle requirement does not imply a vehicle advantage", async () => {
  const { pipelineJobRecommendations } = await loadModule();
  assert.equal(typeof pipelineJobRecommendations, "function");

  const result = pipelineJobRecommendations!(cards, { ...job, vehicleRequired: false });
  assert.equal(result.matchByApplicantId["near-pickup"].vehicle, 0);
  assert.equal(result.matchByApplicantId["near-pickup"].vehicleFit, "not_required");
  assert.equal(result.matchByApplicantId["near-dropoff"].vehicle, 0);
  assert.equal(result.matchByApplicantId["near-dropoff"].vehicleFit, "not_required");
});

test("equal scores have a stable distance, activity, then id tie-break", async () => {
  const { pipelineJobRecommendations } = await loadModule();
  assert.equal(typeof pipelineJobRecommendations, "function");

  const tied = [
    { ...cards[0], id: "12", vehicleClass: "확정" as const },
    { ...cards[0], id: "2", vehicleClass: "확정" as const },
  ];
  assert.deepEqual(pipelineJobRecommendations!(tied, job).rankedApplicantIds, ["2", "12"]);
  assert.deepEqual(pipelineJobRecommendations!([...tied].reverse(), job).rankedApplicantIds, ["2", "12"]);
});

test("invalid coordinates and activity timestamps stay unknown instead of becoming evidence", async () => {
  const { pipelineJobRecommendations } = await loadModule();
  assert.equal(typeof pipelineJobRecommendations, "function");

  const result = pipelineJobRecommendations!([
    {
      ...cards[0],
      id: "valid-fallback",
      lastMessageAtIso: "not-a-date",
      appliedAtIso: "2099-02-01T00:00:00.000Z",
    },
    {
      ...cards[0],
      id: "invalid-location",
      lat: Number.NaN,
      lng: Number.POSITIVE_INFINITY,
    },
  ], job);

  assert.deepEqual(result.rankedApplicantIds, ["valid-fallback"]);
  assert.equal(result.matchByApplicantId["valid-fallback"].activityAt, "2099-02-01T00:00:00.000Z");
  assert.equal(result.missingLocationCount, 1);
});
