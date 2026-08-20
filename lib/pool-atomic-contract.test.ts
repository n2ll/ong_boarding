import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
