import assert from "node:assert/strict";
import test from "node:test";

import { jobDuplicateSource } from "./job-duplicate-source.ts";

test("job duplicate source keeps only reusable fields from a successful create response", () => {
  const source = jobDuplicateSource({
    id: 91,
    title: "강남 배송원 모집",
    body: "현재 공고 본문",
    channel_bodies: { danggeun: "당근 본문", albamon: "알바몬 본문", sms: "문자 본문", ignored: "제외" },
    client_id: 7,
    branch_id: 12,
    site_manager_id: 3,
    recruit_mode: "internal",
    exposure: "targeted",
    exposure_rule: { sido: ["서울특별시"], radiusKm: 8 },
    capacity: 4,
    pay_type: "건당",
    pay_amount: 3500,
    work_period: "정기",
    slot: "월~토 오전 7시",
    slot_keys: ["평일오전", null, 3],
    start_date: "2026-09-01",
    pickup_address: "서울 강남구 테헤란로 1",
    dropoff_address: "서울 송파구 올림픽로 1",
    vehicle_required: true,
    pay_info: "건당 3,500원",
    policy_notes: "우천 시 별도 안내",
    ai_facts: "매니저 확인 후 근무 확정",
    client_request_id: "11111111-1111-4111-8111-111111111111",
    creation_request_fingerprint: "secret-ish-digest",
    pickup_lat: 37.5,
    pickup_lng: 127.0,
    sos_request_id: 55,
    status: "active",
  });

  assert.deepEqual(source, {
    title: "강남 배송원 모집",
    body: "현재 공고 본문",
    channelBodies: { danggeun: "당근 본문", albamon: "알바몬 본문", sms: "문자 본문" },
    clientId: 7,
    branchId: 12,
    siteManagerId: 3,
    recruitMode: "internal",
    exposure: "targeted",
    exposureRule: { sido: ["서울특별시"], radiusKm: 8 },
    capacity: 4,
    payType: "건당",
    payAmount: 3500,
    workPeriod: "정기",
    slot: "월~토 오전 7시",
    slotKeys: ["평일오전"],
    startDate: "2026-09-01",
    pickupAddress: "서울 강남구 테헤란로 1",
    dropoffAddress: "서울 송파구 올림픽로 1",
    vehicleRequired: true,
    payInfo: "건당 3,500원",
    policyNotes: "우천 시 별도 안내",
    aiFacts: "매니저 확인 후 근무 확정",
  });
  assert.equal("id" in source, false);
  assert.equal("client_request_id" in source, false);
  assert.equal("pickup_lat" in source, false);
  assert.equal("sos_request_id" in source, false);
});

test("job duplicate source normalizes absent and malformed optional values safely", () => {
  assert.deepEqual(jobDuplicateSource(null), {
    title: "",
    body: "",
    channelBodies: null,
    clientId: null,
    branchId: null,
    siteManagerId: null,
    recruitMode: "external",
    exposure: "all",
    exposureRule: null,
    capacity: null,
    payType: "",
    payAmount: null,
    workPeriod: "",
    slot: "",
    slotKeys: [],
    startDate: "",
    pickupAddress: "",
    dropoffAddress: "",
    vehicleRequired: true,
    payInfo: "",
    policyNotes: "",
    aiFacts: "",
  });
});
