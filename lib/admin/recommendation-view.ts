type RecommendationEvidenceInput = {
  ownVehicle?: string | null;
  recencyAt?: string | null;
  createdAt?: string | null;
  score?: {
    total?: number | null;
    distance?: number | null;
    vehicle?: number | null;
    recency?: number | null;
    distanceKm?: number | null;
  } | null;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validDate(value: string | null | undefined): string | null {
  if (!value?.trim() || Number.isNaN(Date.parse(value))) return null;
  return value;
}

export function recommendationJobsView(input: { jobs?: unknown[]; error?: unknown }):
  | { state: "loading" }
  | { state: "error" }
  | { state: "empty" }
  | { state: "ready"; count: number } {
  if (input.error) return { state: "error" };
  if (input.jobs === undefined) return { state: "loading" };
  if (input.jobs.length === 0) return { state: "empty" };
  return { state: "ready", count: input.jobs.length };
}

export function recommendationResultView(input: {
  requested: boolean;
  loading: boolean;
  error?: string | null;
  candidates?: unknown[];
}): "idle" | "loading" | "error" | "empty" | "ready" {
  if (input.loading) return "loading";
  if (input.error) return "error";
  if (!input.requested) return "idle";
  if (!input.candidates || input.candidates.length === 0) return "empty";
  return "ready";
}

export function recommendationEvidence(input: RecommendationEvidenceInput) {
  const activityAt = validDate(input.recencyAt)
    ?? (input.recencyAt?.trim() ? null : validDate(input.createdAt));

  return {
    total: finiteNumber(input.score?.total),
    distancePoints: finiteNumber(input.score?.distance),
    vehiclePoints: finiteNumber(input.score?.vehicle),
    recencyPoints: finiteNumber(input.score?.recency),
    distanceKm: finiteNumber(input.score?.distanceKm),
    vehicle: input.ownVehicle === "있음"
      ? "owned" as const
      : input.ownVehicle === "없음"
        ? "not_owned" as const
        : "unknown" as const,
    activityAt,
  };
}

export function recommendationAddOutcome(input: {
  ok: boolean;
  added?: unknown;
  error?: unknown;
  partial?: unknown;
}): "added" | "already_added" | "partial_error" | "error" {
  if (!input.ok) return input.partial ? "partial_error" : "error";
  return typeof input.added === "number" && input.added > 0 ? "added" : "already_added";
}

export function recommendationVehicleFit(
  vehicle: "owned" | "not_owned" | "unknown",
  required: boolean,
): "meets" | "does_not_meet" | "needs_review" | "not_required" {
  if (!required) return "not_required";
  if (vehicle === "owned") return "meets";
  if (vehicle === "not_owned") return "does_not_meet";
  return "needs_review";
}
