import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type JobCreateAttempt = {
  fingerprint: string;
  requestId: string;
};

type JobCreateIdempotencyModule = {
  validateJobCreateRequestId?: (
    value: unknown,
  ) => { ok: true; requestId: string } | { ok: false; reason: "required" | "invalid" };
  jobCreatePayloadFingerprint?: (payload: Record<string, unknown>) => string;
  jobCreatePayloadDigest?: (payload: Record<string, unknown>) => Promise<string>;
  nextJobCreateAttempt?: (
    current: JobCreateAttempt | null,
    payload: Record<string, unknown>,
    createRequestId: () => string,
  ) => JobCreateAttempt;
  jobCreateReplayDecision?: (
    existingFingerprint: string | null | undefined,
    requestFingerprint: string,
  ) => "replay" | "conflict";
};

async function loadModule(): Promise<JobCreateIdempotencyModule> {
  try {
    return await import("./job-create-idempotency.ts") as JobCreateIdempotencyModule;
  } catch {
    return {};
  }
}

test("job creation requires a caller-generated UUID request id", async () => {
  const { validateJobCreateRequestId } = await loadModule();
  assert.equal(typeof validateJobCreateRequestId, "function");

  assert.deepEqual(validateJobCreateRequestId!(null), { ok: false, reason: "required" });
  assert.deepEqual(validateJobCreateRequestId!("  "), { ok: false, reason: "required" });
  assert.deepEqual(validateJobCreateRequestId!("job-create-1"), { ok: false, reason: "invalid" });
  assert.deepEqual(
    validateJobCreateRequestId!(" 11111111-1111-4111-8111-111111111111 "),
    { ok: true, requestId: "11111111-1111-4111-8111-111111111111" },
  );
});

test("job payload fingerprint is stable across object key order and excludes only the request id", async () => {
  const { jobCreatePayloadFingerprint } = await loadModule();
  assert.equal(typeof jobCreatePayloadFingerprint, "function");

  const first = jobCreatePayloadFingerprint!({
    title: "공고",
    client_request_id: "11111111-1111-4111-8111-111111111111",
    exposure_rule: { vehicle: ["있음"], sido: ["서울특별시"] },
    body: "본문",
    channel_bodies: { sms: "문자", albamon: "본문" },
  });
  const replay = jobCreatePayloadFingerprint!({
    channel_bodies: { albamon: "본문", sms: "문자" },
    body: "본문",
    exposure_rule: { sido: ["서울특별시"], vehicle: ["있음"] },
    client_request_id: "22222222-2222-4222-8222-222222222222",
    title: "공고",
  });

  assert.equal(
    first,
    "{\"body\":\"본문\",\"channel_bodies\":{\"albamon\":\"본문\",\"sms\":\"문자\"},\"exposure_rule\":{\"sido\":[\"서울특별시\"],\"vehicle\":[\"있음\"]},\"title\":\"공고\"}",
  );
  assert.equal(replay, first);
  assert.notEqual(
    jobCreatePayloadFingerprint!({ title: "공고", body: "수정 본문" }),
    jobCreatePayloadFingerprint!({ title: "공고", body: "본문" }),
  );
  assert.notEqual(
    jobCreatePayloadFingerprint!({ slot_keys: ["평일오전", "주말오후"] }),
    jobCreatePayloadFingerprint!({ slot_keys: ["주말오후", "평일오전"] }),
    "array order is request data and must not be silently normalized by the idempotency layer",
  );
  assert.equal(
    jobCreatePayloadFingerprint!(JSON.parse('{"__proto__":{"marker":"kept"},"title":"공고"}')),
    "{\"__proto__\":{\"marker\":\"kept\"},\"title\":\"공고\"}",
    "canonicalization must not lose JSON keys through the object prototype setter",
  );
});

test("job payload digest stores a fixed-size SHA-256 fingerprint instead of draft content", async () => {
  const { jobCreatePayloadDigest } = await loadModule();
  assert.equal(typeof jobCreatePayloadDigest, "function");

  assert.equal(
    await jobCreatePayloadDigest!({ title: "공고", body: "본문" }),
    "8de9a4f50790902790362f830aac347f1227f3ff019ad2027e2cef89fcc9f224",
  );
});

test("one open job form keeps its request id even when the manager edits the payload", async () => {
  const { nextJobCreateAttempt } = await loadModule();
  assert.equal(typeof nextJobCreateAttempt, "function");

  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const createRequestId = () => ids.shift()!;
  const first = nextJobCreateAttempt!(null, { title: "공고", body: "본문" }, createRequestId);
  const replay = nextJobCreateAttempt!(
    first,
    {
      body: "본문",
      client_request_id: first.requestId,
      title: "공고",
    },
    createRequestId,
  );
  const edited = nextJobCreateAttempt!(first, { title: "공고", body: "수정 본문" }, createRequestId);
  const nextForm = nextJobCreateAttempt!(null, { title: "다음 공고", body: "새 본문" }, createRequestId);

  assert.equal(replay, first);
  assert.equal(edited, first);
  assert.equal(first.requestId, "11111111-1111-4111-8111-111111111111");
  assert.equal(nextForm.requestId, "22222222-2222-4222-8222-222222222222");
  assert.notEqual(nextForm.fingerprint, first.fingerprint);
});

test("the server replays only an existing job with the same payload digest", async () => {
  const { jobCreateReplayDecision } = await loadModule();
  assert.equal(typeof jobCreateReplayDecision, "function");

  const digest = "8de9a4f50790902790362f830aac347f1227f3ff019ad2027e2cef89fcc9f224";
  assert.equal(jobCreateReplayDecision!(digest, digest), "replay");
  assert.equal(jobCreateReplayDecision!("", ""), "conflict");
  assert.equal(jobCreateReplayDecision!(null, digest), "conflict");
  assert.equal(jobCreateReplayDecision!("different", digest), "conflict");
});

test("job creation wires one form-owned request id through the client, API, and database row", () => {
  const jobsSource = readFileSync(
    new URL("../../components/Jobs.tsx", import.meta.url),
    "utf8",
  );
  const routeSource = readFileSync(
    new URL("../../app/api/admin/jobs/route.ts", import.meta.url),
    "utf8",
  );

  const resetStart = jobsSource.indexOf("const resetNewJobForm = () => {");
  const resetEnd = jobsSource.indexOf("};", resetStart);
  const registrationStart = jobsSource.indexOf("const handleRegisterJob = async () => {");
  const registrationEnd = jobsSource.indexOf("const q = query.trim()", registrationStart);
  const registrationSource = jobsSource.slice(registrationStart, registrationEnd);

  assert.match(jobsSource.slice(resetStart, resetEnd), /jobCreateAttemptRef\.current = null/);
  assert.match(registrationSource, /const jobPayload(?:: Record<string, unknown>)? = \{/);
  assert.match(
    registrationSource,
    /nextJobCreateAttempt\(\s*jobCreateAttemptRef\.current,\s*jobPayload,\s*\(\) => crypto\.randomUUID\(\),?\s*\)/,
  );
  assert.match(registrationSource, /jobCreateAttemptRef\.current = createAttempt/);
  assert.match(registrationSource, /client_request_id: createAttempt\.requestId/);

  const requestValidation = routeSource.indexOf("validateJobCreateRequestId(body.client_request_id)");
  const requestDigest = routeSource.indexOf("jobCreatePayloadDigest(body)");
  const existingRequestLookup = routeSource.indexOf('.eq("client_request_id", createRequestId)');
  const businessValidation = routeSource.indexOf("if (!title?.trim() || !jobBody?.trim())");
  const geocode = routeSource.indexOf("geocodeAddressWithFallback(normalizedPickupAddress)");
  assert.ok(requestValidation >= 0, "the API should require a caller request id");
  assert.ok(requestDigest > requestValidation, "the API should fingerprint after request-id validation");
  assert.ok(existingRequestLookup > requestDigest, "the API should look up a prior request after hashing");
  assert.ok(
    existingRequestLookup < businessValidation,
    "an existing request must replay or conflict before mutable business validation",
  );
  assert.ok(requestDigest < geocode, "an idempotent replay must return before geocoding");
  assert.match(routeSource, /client_request_id: createRequestId/);
  assert.match(routeSource, /creation_request_fingerprint: createRequestFingerprint/);
  assert.match(routeSource, /jobCreateReplayDecision\(/);
  assert.match(routeSource, /error\?\.code === "23505"/);
  assert.match(routeSource, /\{ status: 409 \}/);
  assert.match(registrationSource, /if \(res\.status === 409\) \{\s*loadJobs\(\);\s*\}/);
});

test("the cumulative repair migration requires request id and fingerprint as a pair", () => {
  const migration = readFileSync(
    new URL("../../docs/migrations/2026-08-jobs-idempotency-pair-not-null.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /^begin;/im);
  assert.match(migration, /^commit;/im);
  assert.match(migration, /raise exception/i);
  assert.match(migration, /drop constraint if exists jobs_creation_request_pair_check/i);
  assert.match(migration, /add constraint jobs_creation_request_pair_check/i);
  assert.match(
    migration,
    /client_request_id is not null\s+and creation_request_fingerprint is not null\s+and creation_request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i,
  );
});
