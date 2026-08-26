import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const notifyConsentMigrationUrl = new URL(
  "../docs/migrations/2026-08-pool-notify-marketing-consent.sql",
  import.meta.url,
);

test("pool action replay is resolved before mutable job eligibility", async () => {
  const migrationUrl = new URL("../docs/migrations/2026-08-pool-actions-atomic.sql", import.meta.url);
  const interestRouteUrl = new URL("../app/api/pool/[token]/interest/route.ts", import.meta.url);
  const notifyRouteUrl = new URL("../app/api/pool/[token]/notify/route.ts", import.meta.url);
  const [migration, interestRoute, notifyRoute] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(interestRouteUrl, "utf8"),
    readFile(notifyRouteUrl, "utf8"),
  ]);

  const interestFunction = migration.slice(
    migration.indexOf("create or replace function public.record_pool_interest"),
    migration.indexOf("create or replace function public.record_pool_notify_request"),
  );
  const notifyFunction = migration.slice(
    migration.indexOf("create or replace function public.record_pool_notify_request"),
  );

  for (const sql of [interestFunction, notifyFunction]) {
    assert.match(sql, /pg_advisory_xact_lock/i);
    assert.ok(sql.indexOf("where action_key = p_action_key") < sql.indexOf("from public.jobs"));
  }

  for (const route of [interestRoute, notifyRoute]) {
    const handler = route.slice(route.indexOf("export async function POST"));
    assert.ok(handler.indexOf('.eq("action_key", actionId)') < handler.indexOf('.from("jobs")'));
    assert.match(handler, /poolActionReplayDecision/);
  }
});

test("pool interest revives only an explicit manager hold and clears all closure fields", async () => {
  const migration = await readFile(
    new URL("../docs/migrations/2026-08-pool-actions-atomic.sql", import.meta.url),
    "utf8",
  );
  const interestFunction = migration.slice(
    migration.indexOf("create or replace function public.record_pool_interest"),
    migration.indexOf("create or replace function public.record_pool_notify_request"),
  );

  assert.match(interestFunction, /closed_reason\s*=\s*'manager: \uBCF4\uB958'/i);
  assert.match(interestFunction, /agent_stage\s*=\s*null/i);
  assert.match(interestFunction, /closed_at\s*=\s*null/i);
  assert.match(interestFunction, /closed_reason\s*=\s*null/i);
  assert.match(interestFunction, /return\s+'unchanged_closed'/i);
  assert.doesNotMatch(interestFunction, /agent_stage\s+is\s+null\s+or\s+agent_stage\s*=\s*'abort'/i);
  assert.ok(
    interestFunction.indexOf("return 'unchanged_closed'")
      < interestFunction.indexOf("insert into public.pool_events"),
  );
});

test("pool SQL metadata gates reject null status, title, and recruit mode", async () => {
  const migration = await readFile(
    new URL("../docs/migrations/2026-08-pool-actions-atomic.sql", import.meta.url),
    "utf8",
  );

  for (const marker of [
    "create or replace function public.record_pool_interest",
    "create or replace function public.record_pool_notify_request",
  ]) {
    const start = migration.indexOf(marker);
    const next = migration.indexOf("create or replace function", start + marker.length);
    const sql = migration.slice(start, next === -1 ? undefined : next);
    assert.match(sql, /v_status\s+is\s+null/i);
    assert.match(sql, /v_title\s+is\s+null/i);
    assert.match(sql, /v_recruit_mode\s+is\s+null/i);
  }
});

test("pool notify changes consent only for a newly recorded explicit request", async () => {
  const migration = await readFile(notifyConsentMigrationUrl, "utf8").catch(() => "");
  const functionStart = migration.indexOf(
    "create or replace function public.record_pool_notify_request",
  );
  const functionEnd = migration.indexOf("revoke execute on function", functionStart);
  const notifyFunction = migration.slice(functionStart, functionEnd);

  assert.ok(functionStart >= 0, "the additive migration must replace record_pool_notify_request");
  assert.match(notifyFunction, /insert\s+into\s+public\.pool_events[\s\S]*?'notify_request'/i);

  const consentUpdates = notifyFunction.match(
    /update\s+public\.applicants[\s\S]*?set\s+marketing_consent\s*=\s*true[\s\S]*?marketing_consent_at\s*=[\s\S]*?where\s+id\s*=\s*p_applicant_id/gi,
  );
  assert.equal(
    consentUpdates?.length,
    1,
    "a replay or an older per-job request must never overwrite a later consent decision",
  );
  const optOutClears = notifyFunction.match(/sms_opt_out_at\s*=\s*null/gi);
  assert.equal(optOutClears?.length, 1, "only the new explicit request may restore future SMS delivery");
  assert.match(notifyFunction, /marketing_consent_at\s*=\s*now\(\)/i);
  assert.match(notifyFunction, /jsonb_build_object\([\s\S]*?'consent_version'[\s\S]*?'pool_notify_v1'/i);

  const replayLookup = notifyFunction.indexOf("where action_key = p_action_key");
  const replayReturn = notifyFunction.indexOf("return 'deduped'", replayLookup);
  const duplicateLookup = notifyFunction.indexOf("where applicant_id = p_applicant_id", replayReturn);
  const duplicateReturn = notifyFunction.indexOf("return 'deduped'", duplicateLookup);
  const eventInsert = notifyFunction.indexOf("insert into public.pool_events", duplicateLookup);
  const consentUpdate = notifyFunction.indexOf("update public.applicants", eventInsert);

  assert.ok(replayLookup >= 0 && replayLookup < replayReturn);
  assert.doesNotMatch(notifyFunction.slice(replayLookup, replayReturn), /update\s+public\.applicants/i);
  assert.ok(duplicateLookup >= 0 && duplicateLookup < duplicateReturn);
  assert.match(
    notifyFunction.slice(duplicateLookup, eventInsert),
    /marketing_consent[\s\S]*?true[\s\S]*?sms_opt_out_at[\s\S]*?null[\s\S]*?return\s+'deduped'/i,
  );
  assert.ok(duplicateReturn < eventInsert && eventInsert < consentUpdate);
});

test("legacy notify history allows a new explicit re-consent and the public CTA reflects effective consent", async () => {
  const [migration, poolRoute] = await Promise.all([
    readFile(notifyConsentMigrationUrl, "utf8"),
    readFile(new URL("../app/api/pool/[token]/route.ts", import.meta.url), "utf8"),
  ]);
  const functionStart = migration.indexOf(
    "create or replace function public.record_pool_notify_request",
  );
  const functionEnd = migration.indexOf("revoke execute on function", functionStart);
  const notifyFunction = migration.slice(functionStart, functionEnd);

  assert.match(notifyFunction, /select[\s\S]*?marketing_consent[\s\S]*?sms_opt_out_at[\s\S]*?from\s+public\.applicants[\s\S]*?for update/i);
  assert.match(notifyFunction, /if\s+found\s+and[\s\S]*?marketing_consent[\s\S]*?sms_opt_out_at[\s\S]*?return\s+'deduped'/i);
  assert.match(poolRoute, /marketing_consent, sms_opt_out_at/);
  assert.match(poolRoute, /marketing_consent\s*===\s*true[\s\S]*?!.*sms_opt_out_at/);
});

test("pool notify replay returns without rewriting consent and preserves RPC privileges", async () => {
  const notifyRouteUrl = new URL("../app/api/pool/[token]/notify/route.ts", import.meta.url);
  const [migration, notifyRoute] = await Promise.all([
    readFile(notifyConsentMigrationUrl, "utf8").catch(() => ""),
    readFile(notifyRouteUrl, "utf8"),
  ]);
  const functionStart = migration.indexOf(
    "create or replace function public.record_pool_notify_request",
  );
  const replayLookup = migration.indexOf("where action_key = p_action_key", functionStart);
  const replayReturn = migration.indexOf("return 'deduped'", replayLookup);
  const jobLookup = migration.indexOf("from public.jobs", functionStart);

  assert.ok(replayLookup >= functionStart);
  assert.doesNotMatch(migration.slice(replayLookup, replayReturn), /update\s+public\.applicants/i);
  assert.ok(replayReturn < jobLookup);

  const replayBranch = notifyRoute.indexOf('if (replay === "deduped")');
  const replayResponse = notifyRoute.indexOf("deduped: true", replayBranch);
  const routeJobLookup = notifyRoute.indexOf('.from("jobs")', replayBranch);
  assert.ok(replayBranch >= 0);
  assert.doesNotMatch(notifyRoute.slice(replayBranch, replayResponse), /\.rpc\(/);
  assert.ok(replayResponse < routeJobLookup);

  assert.match(
    migration,
    /revoke execute on function public\.record_pool_notify_request\(bigint, bigint, uuid\)\s+from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.record_pool_notify_request\(bigint, bigint, uuid\)\s+to service_role/i,
  );
});
