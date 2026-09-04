import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("new-job exposure editor previews visible and SMS-eligible audiences from draft facts", () => {
  const editorSource = readFileSync(
    new URL("../../components/ExposureEditor.tsx", import.meta.url),
    "utf8",
  );
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );

  assert.match(editorSource, /draftJob\?:/);
  assert.match(editorSource, /draft_job:/);
  assert.match(editorSource, /pickup_address:/);
  assert.match(editorSource, /dropoff_address:/);
  assert.match(editorSource, /vehicle_required:/);
  assert.match(editorSource, /slot_keys:\s*draft\.slotKeys/);
  assert.match(editorSource, /capacity:\s*draft\.capacity/);
  assert.match(editorSource, /맞춤 링크 노출/);
  assert.match(editorSource, /현재 문자 안내 가능/);
  assert.match(editorSource, /추천 노출 대상/);
  assert.match(editorSource, /실제 발송 전에도 다시 확인/);

  assert.match(jobsSource, /draftJob=\{\{/);
  assert.match(jobsSource, /pickupAddress: newJobPickupAddress/);
  assert.match(jobsSource, /dropoffAddress: newJobDropoffAddress/);
  assert.match(jobsSource, /vehicleRequired: newJobVehicleRequired/);
  assert.match(jobsSource, /slotKeys: newJobSlotKeys/);
  assert.match(jobsSource, /capacity: newJobCapacity/);
});

test("draft addresses make radius filtering available before job creation", () => {
  const editorSource = readFileSync(
    new URL("../../components/ExposureEditor.tsx", import.meta.url),
    "utf8",
  );

  assert.match(editorSource, /const canUseRadius = Boolean\(jobId \|\| draftJob\)/);
  assert.match(editorSource, /canUseRadius \? \(/);
});

test("audience preview route geocodes the draft and remains read-only", () => {
  const routeSource = readFileSync(
    new URL("../../app/api/admin/exposure/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(routeSource, /geocodeAddressWithFallback\(pickupAddress\)/);
  assert.match(routeSource, /selectJobAudiencePreview\(\{/);
  assert.match(routeSource, /suggestJobAudienceRule\(\{/);
  assert.match(routeSource, /suggested_audience:/);
  assert.match(routeSource, /visible_count:\s*suggestedAudience\.visibleCount/);
  assert.match(routeSource, /sms_eligible_count:\s*suggestedAudience\.smsEligibleCount/);
  assert.match(routeSource, /contact_target:\s*suggestedAudience\.contactTarget/);
  assert.match(routeSource, /bulk_message_phone_guards/);
  assert.match(routeSource, /recentMessages/);
  assert.match(routeSource, /recentEvents/);
  assert.doesNotMatch(routeSource, /\.(?:insert|update|upsert|delete)\s*\(/);
});
