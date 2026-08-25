import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type TallyWebhookModule = {
  tallySubmissionUuid?: (input: {
    eventId: string | null;
    formId: string | null;
    responseId: string | null;
    submissionId: string | null;
    rawPayload: string;
  }) => string;
  blocksTallyFallback?: (status: number, errorBody: unknown) => boolean;
  normalizeTallyVehicleOwnership?: (value: string) => "있음" | "없음" | "";
  normalizeTallySelfOwnership?: (value: string) => "문제 없음" | "문제 있음" | "";
};

async function loadTallyWebhookModule(): Promise<TallyWebhookModule> {
  try {
    return await import(new URL("./tally-webhook.ts", import.meta.url).href) as TallyWebhookModule;
  } catch {
    return {};
  }
}

test("Tally retries of one response receive the same valid submission UUID", async () => {
  const { tallySubmissionUuid } = await loadTallyWebhookModule();

  assert.equal(typeof tallySubmissionUuid, "function");
  const first = tallySubmissionUuid!({
    eventId: "event-first",
    formId: "form-1",
    responseId: "response-1",
    submissionId: "submission-1",
    rawPayload: '{"attempt":1}',
  });
  const retry = tallySubmissionUuid!({
    eventId: "event-retry",
    formId: "form-1",
    responseId: "response-1",
    submissionId: "submission-1",
    rawPayload: '{"attempt":2}',
  });
  const nextResponse = tallySubmissionUuid!({
    eventId: "event-next",
    formId: "form-1",
    responseId: "response-2",
    submissionId: "submission-2",
    rawPayload: '{"attempt":1}',
  });

  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(retry, first);
  assert.notEqual(nextResponse, first);
});

test("Tally event ID and raw payload remain deterministic fallbacks", async () => {
  const { tallySubmissionUuid } = await loadTallyWebhookModule();

  assert.equal(typeof tallySubmissionUuid, "function");
  const eventOnly = {
    eventId: "a4cb511e-d513-4fa5-baee-b815d718dfd1",
    formId: null,
    responseId: null,
    submissionId: null,
    rawPayload: '{"eventId":"a4cb511e-d513-4fa5-baee-b815d718dfd1"}',
  };
  assert.equal(tallySubmissionUuid!(eventOnly), tallySubmissionUuid!({ ...eventOnly }));

  const rawOnly = {
    eventId: null,
    formId: null,
    responseId: null,
    submissionId: null,
    rawPayload: '{"eventType":"FORM_RESPONSE","data":{"fields":[]}}',
  };
  assert.equal(tallySubmissionUuid!(rawOnly), tallySubmissionUuid!({ ...rawOnly }));
});

test("the Tally adapter supplies its stable UUID to the canonical apply route", async () => {
  const route = await readFile(
    new URL("../app/api/webhooks/tally/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /const submissionId = tallySubmissionUuid\(/);
  assert.match(route, /data\?:\s*\{[\s\S]*submissionId\?:\s*string/);
  assert.match(route, /fetch\(`\$\{req\.nextUrl\.origin\}\/api\/apply`/);
  assert.match(route, /body:\s*JSON\.stringify\(applyBody\)/);
});

test("Tally keeps legacy raw labels in its durable fingerprint and canonicalizes only after trust", async () => {
  const {
    normalizeTallyVehicleOwnership,
    normalizeTallySelfOwnership,
  } = await loadTallyWebhookModule();

  assert.equal(typeof normalizeTallyVehicleOwnership, "function");
  assert.equal(typeof normalizeTallySelfOwnership, "function");
  assert.equal(normalizeTallyVehicleOwnership!("네"), "있음");
  assert.equal(normalizeTallyVehicleOwnership!("예"), "있음");
  assert.equal(normalizeTallyVehicleOwnership!("아니요"), "없음");
  assert.equal(normalizeTallyVehicleOwnership!(""), "");
  assert.equal(normalizeTallySelfOwnership!("네, 이상 없습니다"), "문제 없음");
  assert.equal(normalizeTallySelfOwnership!("아니요"), "문제 있음");
  assert.equal(normalizeTallySelfOwnership!(""), "");

  const route = await readFile(
    new URL("../app/api/webhooks/tally/route.ts", import.meta.url),
    "utf8",
  );
  const applyRoute = await readFile(
    new URL("../app/api/apply/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /const ownVehicle = pick\(fields, "자차"\)/);
  assert.match(route, /const vehicleType = pick\(fields, "차량 종류"\)/);
  assert.match(route, /const selfOwnership = pick\(fields, "본인 계좌"\)/);
  assert.ok(
    route.indexOf("const requestFingerprint") < route.indexOf("const canonicalOwnVehicle"),
    "the already-deployed raw Tally payload must retain its durable fingerprint",
  );
  assert.match(applyRoute, /const canonicalSubmittedForm = trustedInternal/);
  assert.ok(
    applyRoute.indexOf("const trustedInternal") < applyRoute.indexOf("const canonicalSubmittedForm"),
    "Tally labels may be normalized only after the signed raw fingerprint is trusted",
  );
});

test("a generic JSON 503 from canonical apply blocks the direct Tally fallback", async () => {
  const { blocksTallyFallback } = await loadTallyWebhookModule();
  const route = await readFile(
    new URL("../app/api/webhooks/tally/route.ts", import.meta.url),
    "utf8",
  );

  assert.equal(typeof blocksTallyFallback, "function");
  assert.equal(blocksTallyFallback!(503, { error: "service unavailable" }), true);
  assert.equal(blocksTallyFallback!(429, null), true);
  assert.equal(blocksTallyFallback!(500, { code: "APPLICATION_ADMISSION_UNAVAILABLE" }), true);
  assert.match(route, /if \(blocksTallyFallback\(res\.status, errJson\)\)/);
  assert.match(route, /"Retry-After": retryAfter/);
});

test("a non-JSON 503 from canonical apply blocks the direct Tally fallback", async () => {
  const { blocksTallyFallback } = await loadTallyWebhookModule();

  assert.equal(typeof blocksTallyFallback, "function");
  assert.equal(blocksTallyFallback!(503, null), true);
  assert.equal(blocksTallyFallback!(400, { error: "invalid application" }), false);
  assert.equal(blocksTallyFallback!(500, null), false);
});

test("the Tally direct fallback atomically claims the stable submission ledger", async () => {
  const [route, migration] = await Promise.all([
    readFile(new URL("../app/api/webhooks/tally/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../docs/migrations/2026-08-tally-fallback-idempotency.sql", import.meta.url),
      "utf8",
    ).catch(() => ""),
  ]);

  assert.match(route, /const submissionId = tallySubmissionUuid\(/);
  assert.match(route, /applicationSubmissionPayloadDigest\(/);
  assert.match(route, /\.rpc\(\s*"claim_tally_fallback_submission"/);
  assert.doesNotMatch(route, /supabase\.from\("applicants"\)\.insert/);

  assert.match(migration, /create or replace function public\.claim_tally_fallback_submission/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /from public\.application_submission_mappings/i);
  assert.match(migration, /v_existing_fingerprint is distinct from p_request_fingerprint/i);
  assert.match(migration, /insert into public\.applicants/i);
  assert.match(migration, /insert into public\.application_submission_mappings/i);
  assert.match(migration, /grant execute on function public\.claim_tally_fallback_submission[\s\S]*to service_role/i);
  assert.match(migration, /revoke execute on function public\.claim_tally_fallback_submission[\s\S]*from anon, authenticated/i);
});
