import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type AttributionMethod =
  | "verified_link"
  | "signed_internal"
  | "legacy_declared"
  | "direct"
  | "invalid_ref";

type CandidateLinkOutcome = "linked" | "already_linked" | "failed" | null;

type JobAcquisitionPerformanceRow = {
  submission_id: string;
  source: string;
  attribution_method: AttributionMethod;
  candidate_link_outcome: CandidateLinkOutcome;
};

type AcquisitionCounts = {
  submissions: number;
  verifiedExternal: number;
  trustedInternal: number;
  unverified: number;
  directOrganic: number;
  linked: number;
  repeatInterest: number;
  pending: number;
  failed: number;
};

type JobAcquisitionView =
  | { state: "loading" }
  | { state: "error" }
  | { state: "empty"; summary: AcquisitionCounts; channels: [] }
  | {
      state: "ready" | "stale";
      summary: AcquisitionCounts;
      channels: Array<AcquisitionCounts & { source: string }>;
    };

type JobAcquisitionViewModule = {
  jobAcquisitionView?: (input: {
    rows?: JobAcquisitionPerformanceRow[];
    error?: unknown;
  }) => JobAcquisitionView;
};

async function loadModule(): Promise<JobAcquisitionViewModule> {
  try {
    return await import(new URL("./job-acquisition-view.ts", import.meta.url).href) as JobAcquisitionViewModule;
  } catch {
    return {};
  }
}

const zeroCounts: AcquisitionCounts = {
  submissions: 0,
  verifiedExternal: 0,
  trustedInternal: 0,
  unverified: 0,
  directOrganic: 0,
  linked: 0,
  repeatInterest: 0,
  pending: 0,
  failed: 0,
};

test("the candidate API orders by a timestamp exposed by the attribution view", () => {
  const route = readFileSync(
    new URL("../../app/api/admin/jobs/[id]/candidates/route.ts", import.meta.url),
    "utf8",
  );
  const migration = readFileSync(
    new URL("../../docs/migrations/2026-09-acquisition-attribution-ledger.sql", import.meta.url),
    "utf8",
  );

  assert.match(route, /\.select\("submission_id, source, attribution_method, candidate_link_outcome, submitted_at"\)/);
  assert.match(route, /\.order\("submitted_at", \{ ascending: false \}\)/);
  assert.match(migration, /attribution\.created_at as submitted_at/i);
});

test("acquisition availability never turns missing or failed data into zero", async () => {
  const { jobAcquisitionView } = await loadModule();

  assert.equal(typeof jobAcquisitionView, "function");
  assert.deepEqual(jobAcquisitionView!({}), { state: "loading" });
  assert.deepEqual(jobAcquisitionView!({ error: new Error("offline") }), { state: "error" });
  assert.deepEqual(jobAcquisitionView!({ rows: [] }), {
    state: "empty",
    summary: zeroCounts,
    channels: [],
  });
});

test("the summary separates attribution trust from candidate-link outcomes", async () => {
  const { jobAcquisitionView } = await loadModule();
  const rows: JobAcquisitionPerformanceRow[] = [
    { submission_id: "submission-1", source: "naver", attribution_method: "verified_link", candidate_link_outcome: "linked" },
    { submission_id: "submission-2", source: "sms", attribution_method: "signed_internal", candidate_link_outcome: "already_linked" },
    { submission_id: "submission-3", source: "facebook", attribution_method: "legacy_declared", candidate_link_outcome: null },
    { submission_id: "submission-4", source: "direct", attribution_method: "direct", candidate_link_outcome: "failed" },
    { submission_id: "submission-5", source: "unknown", attribution_method: "invalid_ref", candidate_link_outcome: null },
  ];

  assert.equal(typeof jobAcquisitionView, "function");
  const view = jobAcquisitionView!({ rows });

  assert.equal(view.state, "ready");
  if (view.state !== "ready") return;
  assert.deepEqual(view.summary, {
    submissions: 5,
    verifiedExternal: 1,
    trustedInternal: 1,
    unverified: 2,
    directOrganic: 1,
    linked: 1,
    repeatInterest: 1,
    pending: 2,
    failed: 1,
  });
});

test("channel rows aggregate independently and sort by submissions then source", async () => {
  const { jobAcquisitionView } = await loadModule();
  const rows: JobAcquisitionPerformanceRow[] = [
    { submission_id: "submission-1", source: "zeta", attribution_method: "legacy_declared", candidate_link_outcome: "linked" },
    { submission_id: "submission-2", source: "alpha", attribution_method: "verified_link", candidate_link_outcome: "already_linked" },
    { submission_id: "submission-3", source: "popular", attribution_method: "verified_link", candidate_link_outcome: "linked" },
    { submission_id: "submission-4", source: "popular", attribution_method: "signed_internal", candidate_link_outcome: null },
  ];

  assert.equal(typeof jobAcquisitionView, "function");
  const view = jobAcquisitionView!({ rows, error: new Error("refresh failed") });

  assert.equal(view.state, "stale");
  if (view.state !== "stale") return;
  assert.deepEqual(view.summary, {
    submissions: 4,
    verifiedExternal: 2,
    trustedInternal: 1,
    unverified: 1,
    directOrganic: 0,
    linked: 2,
    repeatInterest: 1,
    pending: 1,
    failed: 0,
  });
  assert.deepEqual(view.channels, [
    {
      source: "popular",
      submissions: 2,
      verifiedExternal: 1,
      trustedInternal: 1,
      unverified: 0,
      directOrganic: 0,
      linked: 1,
      repeatInterest: 0,
      pending: 1,
      failed: 0,
    },
    {
      source: "alpha",
      submissions: 1,
      verifiedExternal: 1,
      trustedInternal: 0,
      unverified: 0,
      directOrganic: 0,
      linked: 0,
      repeatInterest: 1,
      pending: 0,
      failed: 0,
    },
    {
      source: "zeta",
      submissions: 1,
      verifiedExternal: 0,
      trustedInternal: 0,
      unverified: 1,
      directOrganic: 0,
      linked: 1,
      repeatInterest: 0,
      pending: 0,
      failed: 0,
    },
  ]);
});
