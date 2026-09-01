import assert from "node:assert/strict";
import test from "node:test";

import { JOB_PUBLISH_CHANNELS } from "./admin/job-publishing.ts";

type DeclaredAcquisitionSource = {
  source: string;
  isRecognized: boolean;
  verified: false;
};

type CanonicalAcquisitionAttribution = {
  verified: true;
  method: string;
  source: string;
  jobId: number | null;
  campaignId: string | null;
  linkId: string | null;
  trackingRef: string | null;
};

type AcquisitionClaimResult =
  | {
      kind: "admitted" | "replay";
      attribution: CanonicalAcquisitionAttribution;
    }
  | {
      kind: "error";
      reason: "conflict" | "rate_limited" | "context_mismatch" | "malformed";
      retryAfterSeconds?: number;
    };

type AcquisitionAttributionModule = {
  normalizePublicTrackingRef?: (value: unknown) => string | null;
  normalizeDeclaredAcquisitionSource?: (value: unknown) => DeclaredAcquisitionSource;
  parseAcquisitionClaimResult?: (input: {
    data: unknown;
    error: unknown;
  }) => AcquisitionClaimResult;
};

async function loadModule(): Promise<AcquisitionAttributionModule> {
  try {
    return await import(new URL("./acquisition-attribution.ts", import.meta.url).href) as AcquisitionAttributionModule;
  } catch {
    return {};
  }
}

test("public tracking refs accept a trimmed UUID and reject caller-controlled text", async () => {
  const { normalizePublicTrackingRef } = await loadModule();
  assert.equal(typeof normalizePublicTrackingRef, "function");

  const trackingRef = "91e65ed2-aa20-4f2a-8442-14d11c788ca2";
  assert.equal(normalizePublicTrackingRef!(`  ${trackingRef}  `), trackingRef);
  for (const invalid of [
    "",
    "facebook",
    `${trackingRef}/extra`,
    "91e65ed2-aa20-1f2a-0442-14d11c788ca2",
    42,
    null,
  ]) {
    assert.equal(normalizePublicTrackingRef!(invalid), null);
  }
});

test("declared sources admit only publishing and trusted legacy channels without verifying them", async () => {
  const { normalizeDeclaredAcquisitionSource } = await loadModule();
  assert.equal(typeof normalizeDeclaredAcquisitionSource, "function");

  const acceptedSources = [
    ...JOB_PUBLISH_CHANNELS.map((channel) => channel.source),
    "homepage",
    "baemin",
  ];
  for (const source of acceptedSources) {
    assert.deepEqual(normalizeDeclaredAcquisitionSource!(source), {
      source,
      isRecognized: true,
      verified: false,
    });
  }

  const unknown = normalizeDeclaredAcquisitionSource!("forged-affiliate");
  assert.deepEqual(unknown, {
    source: "direct",
    isRecognized: false,
    verified: false,
  });
  assert.notDeepEqual(unknown, normalizeDeclaredAcquisitionSource!("direct"));
});

test("an admitted DB claim exposes only its canonical attribution context", async () => {
  const { parseAcquisitionClaimResult } = await loadModule();
  assert.equal(typeof parseAcquisitionClaimResult, "function");

  const trackingRef = "91e65ed2-aa20-4f2a-8442-14d11c788ca2";
  assert.deepEqual(parseAcquisitionClaimResult!({
    data: [{
      outcome: "admitted",
      canonical_method: "tracking_ref",
      canonical_source: "facebook",
      canonical_job_id: 42,
      canonical_campaign_id: "1dfaf018-1f6b-4bc5-b2a8-c600da11cb7e",
      canonical_link_id: "4097dfa7-28d3-4250-bb5b-81535038f3f1",
      tracking_ref: trackingRef,
    }],
    error: null,
  }), {
    kind: "admitted",
    attribution: {
      verified: true,
      method: "tracking_ref",
      source: "facebook",
      jobId: 42,
      campaignId: "1dfaf018-1f6b-4bc5-b2a8-c600da11cb7e",
      linkId: "4097dfa7-28d3-4250-bb5b-81535038f3f1",
      trackingRef,
    },
  });
});

test("a replay keeps the same complete canonical attribution shape", async () => {
  const { parseAcquisitionClaimResult } = await loadModule();
  assert.equal(typeof parseAcquisitionClaimResult, "function");

  assert.deepEqual(parseAcquisitionClaimResult!({
    data: {
      outcome: "replay",
      canonical_method: "declared_source",
      canonical_source: "albamon",
      canonical_job_id: 73,
      canonical_campaign_id: null,
      canonical_link_id: null,
      tracking_ref: null,
    },
    error: null,
  }), {
    kind: "replay",
    attribution: {
      verified: true,
      method: "declared_source",
      source: "albamon",
      jobId: 73,
      campaignId: null,
      linkId: null,
      trackingRef: null,
    },
  });
});

test("claim conflicts and context mismatches fail closed", async () => {
  const { parseAcquisitionClaimResult } = await loadModule();
  assert.equal(typeof parseAcquisitionClaimResult, "function");

  assert.deepEqual(parseAcquisitionClaimResult!({
    data: [{ outcome: "conflict" }],
    error: null,
  }), { kind: "error", reason: "conflict" });
  assert.deepEqual(parseAcquisitionClaimResult!({
    data: [{ outcome: "context_mismatch" }],
    error: null,
  }), { kind: "error", reason: "context_mismatch" });
});

test("rate-limited claims preserve the retry delay while remaining errors", async () => {
  const { parseAcquisitionClaimResult } = await loadModule();
  assert.equal(typeof parseAcquisitionClaimResult, "function");

  assert.deepEqual(parseAcquisitionClaimResult!({
    data: [{ outcome: "rate_limited", retry_after_seconds: 87 }],
    error: null,
  }), {
    kind: "error",
    reason: "rate_limited",
    retryAfterSeconds: 87,
  });
});

test("database failures and incomplete canonical rows are malformed errors", async () => {
  const { parseAcquisitionClaimResult } = await loadModule();
  assert.equal(typeof parseAcquisitionClaimResult, "function");

  for (const input of [
    { data: null, error: { message: "database unavailable" } },
    { data: null, error: null },
    { data: [], error: null },
    { data: [{ outcome: "unexpected" }], error: null },
    {
      data: [{
        outcome: "admitted",
        canonical_method: "tracking_ref",
        canonical_source: "facebook",
        canonical_job_id: 42,
      }],
      error: null,
    },
  ]) {
    assert.deepEqual(parseAcquisitionClaimResult!(input), {
      kind: "error",
      reason: "malformed",
    });
  }
});

test("raw public source declarations never become verified canonical context", async () => {
  const {
    normalizeDeclaredAcquisitionSource,
    parseAcquisitionClaimResult,
  } = await loadModule();
  assert.equal(typeof normalizeDeclaredAcquisitionSource, "function");
  assert.equal(typeof parseAcquisitionClaimResult, "function");

  const declaredSource = normalizeDeclaredAcquisitionSource!("facebook");
  assert.deepEqual(declaredSource, {
    source: "facebook",
    isRecognized: true,
    verified: false,
  });

  const publicOnlyInput = {
    data: null,
    error: null,
    rawPublicSource: declaredSource.source,
    rawPublicJobId: 42,
  };
  assert.deepEqual(parseAcquisitionClaimResult!(publicOnlyInput), {
    kind: "error",
    reason: "malformed",
  });
});
