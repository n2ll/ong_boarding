import assert from "node:assert/strict";
import test from "node:test";

import type { AudiencePreviewApplicant } from "./job-audience-preview.ts";

function applicant(id: number, lng: number): AudiencePreviewApplicant {
  return {
    id,
    name: `지원자 ${id}`,
    phone: `0100000${String(id).padStart(4, "0")}`,
    access_token: `token-${id}`,
    status: "인력풀",
    sms_opt_out_at: null,
    marketing_consent: true,
    sido: "서울특별시",
    sigungu: "강남구",
    availability: "즉시",
    own_vehicle: "있음",
    work_hours: null,
    available_slots: ["평일오전"],
    lat: 0,
    lng,
    applied_at: "2026-08-20T00:00:00.000Z",
    created_at: "2026-08-20T00:00:00.000Z",
  };
}

test("audience agent keeps enough contactable candidates while applying job requirements", async () => {
  const suggestionModule = await import("./job-audience-suggestion.ts").catch(() => null);
  assert.equal(typeof suggestionModule?.suggestJobAudienceRule, "function");
  if (typeof suggestionModule?.suggestJobAudienceRule !== "function") return;

  const applicants = [
    ...Array.from({ length: 8 }, (_, index) => applicant(index + 1, 0.02)),
    applicant(9, 0.06),
    { ...applicant(10, 0.06), lat: null, lng: null },
    applicant(11, 0.2),
    applicant(12, 0.2),
  ];
  const suggestion = suggestionModule.suggestJobAudienceRule({
    applicants,
    job: {
      pickup_lat: 0,
      pickup_lng: 0,
      dropoff_lat: null,
      dropoff_lng: null,
      distance_basis: "pickup",
    },
    vehicleRequired: true,
    slotKeys: ["평일오전"],
    capacity: 2,
    nowMs: Date.parse("2026-09-04T00:00:00.000Z"),
  });

  assert.deepEqual(suggestion?.rule.vehicle, ["있음"]);
  assert.deepEqual(suggestion?.rule.slot, ["평일오전", "미확인"]);
  assert.equal(suggestion?.rule.radiusKm, 10);
  assert.equal(suggestion?.rule.radiusIncludeUnknown, true);
  assert.equal(suggestion?.smsEligibleCount, 10);
  assert.equal(suggestion?.contactTarget, 10);
});

test("audience agent does not narrow all exposure below the contact target", async () => {
  const { suggestJobAudienceRule } = await import("./job-audience-suggestion.ts");
  const suggestion = suggestJobAudienceRule({
    applicants: [applicant(1, 0.02), applicant(2, 0.02)],
    job: null,
    vehicleRequired: true,
    slotKeys: [],
    capacity: 1,
  });

  assert.equal(suggestion, null);
});

test("audience agent never sets a contact target below a large hiring capacity", async () => {
  const { suggestJobAudienceRule } = await import("./job-audience-suggestion.ts");
  const suggestion = suggestJobAudienceRule({
    applicants: Array.from({ length: 40 }, (_, index) => applicant(index + 1, 0.02)),
    job: null,
    vehicleRequired: true,
    slotKeys: [],
    capacity: 50,
  });

  assert.equal(suggestion, null);
});

test("audience agent does not offer a rule that exposes the job to nobody", async () => {
  const { suggestJobAudienceRule } = await import("./job-audience-suggestion.ts");
  const noVehicle = applicant(1, 0.02);
  noVehicle.own_vehicle = "없음";

  const suggestion = suggestJobAudienceRule({
    applicants: [noVehicle],
    job: null,
    vehicleRequired: true,
    slotKeys: [],
    capacity: 1,
  });

  assert.equal(suggestion, null);
});
