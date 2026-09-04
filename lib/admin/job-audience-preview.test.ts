import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import type { AudiencePreviewApplicant } from "./job-audience-preview.ts";

const moduleUrl = new URL("./job-audience-preview.ts", import.meta.url);

test("audience preview selector exists", () => {
  assert.equal(
    existsSync(moduleUrl),
    true,
    "job-audience-preview.ts must provide the read-only audience selector",
  );
});

function applicant(
  id: number,
  overrides: Partial<AudiencePreviewApplicant> = {},
): AudiencePreviewApplicant {
  return {
    id,
    name: `지원자 ${id}`,
    phone: `0100000000${id}`,
    access_token: `token-${id}`,
    status: "인력풀",
    sms_opt_out_at: null,
    marketing_consent: true,
    sido: "서울특별시",
    sigungu: "강남구",
    availability: "즉시",
    own_vehicle: "있음",
    work_hours: null,
    available_slots: null,
    lat: 37.4979,
    lng: 127.0276,
    applied_at: "2026-08-20T00:00:00.000Z",
    created_at: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

test("all exposure separates visible applicants from unique SMS-eligible phone identities", async () => {
  const module = await import("./job-audience-preview.ts");
  assert.equal(typeof module.selectJobAudiencePreview, "function");
  if (typeof module.selectJobAudiencePreview !== "function") return;

  const result = module.selectJobAudiencePreview({
    applicants: [
      applicant(1, { name: "가까운 지원자", phone: "010-1111-2222" }),
      applicant(2, { name: "중복 번호", phone: "01011112222" }),
      applicant(3, { marketing_consent: false }),
      applicant(4, { access_token: null }),
      applicant(5, { status: "확정인력" }),
      applicant(6, { sms_opt_out_at: "2026-08-30T00:00:00.000Z" }),
      applicant(7, { lat: 35.1796, lng: 129.0756, availability: "협의" }),
      applicant(8),
      applicant(9),
    ],
    exposure: "all",
    rule: null,
    job: {
      pickup_lat: 37.4979,
      pickup_lng: 127.0276,
      dropoff_lat: null,
      dropoff_lng: null,
      distance_basis: "pickup",
    },
    vehicleRequired: true,
    blacklistedPhones: new Set(["01000000008"]),
    guardedPhones: new Set(["01000000009"]),
  });

  assert.equal(result.visibleCount, 9);
  assert.equal(result.smsEligibleCount, 2);
  assert.equal(result.recommendations.length, 5);
  assert.equal(result.recommendations.filter((candidate) => candidate.sms_eligible).length, 1);
  assert.equal(new Set(result.recommendations.map((candidate) => candidate.name)).has("중복 번호"), false);
  assert.deepEqual(Object.keys(result.recommendations[0]!).sort(), [
    "applicant_id",
    "availability",
    "distance_km",
    "name",
    "own_vehicle",
    "reasons",
    "sms_eligible",
  ]);
});

test("targeted exposure uses the shared rule matcher and draft job radius", async () => {
  const module = await import("./job-audience-preview.ts");
  assert.equal(typeof module.selectJobAudiencePreview, "function");
  if (typeof module.selectJobAudiencePreview !== "function") return;

  const result = module.selectJobAudiencePreview({
    applicants: [
      applicant(1),
      applicant(2, { lat: 37.5665, lng: 126.978 }),
      applicant(3, { lat: null, lng: null }),
    ],
    exposure: "targeted",
    rule: { radiusKm: 3 },
    job: {
      pickup_lat: 37.4979,
      pickup_lng: 127.0276,
      dropoff_lat: null,
      dropoff_lng: null,
      distance_basis: "pickup",
    },
    vehicleRequired: false,
  });

  assert.equal(result.visibleCount, 1);
  assert.equal(result.smsEligibleCount, 1);
  assert.equal(result.recommendations[0]?.applicant_id, 1);
  assert.equal(result.recommendations[0]?.distance_km, 0);
});

test("targeted exposure without a rule remains empty", async () => {
  const { selectJobAudiencePreview } = await import("./job-audience-preview.ts");
  const result = selectJobAudiencePreview({
    applicants: [applicant(1)],
    exposure: "targeted",
    rule: null,
    job: null,
    vehicleRequired: false,
  });

  assert.equal(result.visibleCount, 0);
  assert.equal(result.smsEligibleCount, 0);
  assert.deepEqual(result.recommendations, []);
});
