import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public job application linking is an atomic locked database operation", async () => {
  const migrationUrl = new URL("../docs/migrations/2026-08-apply-public-job-link-atomic.sql", import.meta.url);
  const routeUrl = new URL("../app/api/apply/route.ts", import.meta.url);
  const [migration, route] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(routeUrl, "utf8"),
  ]);

  assert.match(migration, /create or replace function public\.link_public_job_candidate/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /v_status\s*<>\s*'active'/i);
  assert.match(migration, /v_title\s+is\s+null/i);
  assert.match(migration, /v_recruit_mode\s+is\s+null/i);
  assert.match(migration, /v_recruit_mode\s+not\s+in\s*\(\s*'external'\s*,\s*'both'\s*\)/i);
  assert.match(migration, /v_exposure\s*=\s*'targeted'/i);
  assert.match(migration, /v_closes_at\s*<=\s*now\(\)/i);
  assert.match(migration, /on conflict \(job_id, applicant_id\) do nothing/i);
  assert.match(migration, /return\s+'already_linked'/i);
  assert.match(migration, /return\s+'unchanged_closed'/i);
  assert.match(migration, /revoke execute on function public\.link_public_job_candidate/i);
  assert.match(route, /\.rpc\(\s*"link_public_job_candidate"/);
  assert.match(route, /availability\s*===\s*"hidden"[\s\S]*status:\s*404/);
  assert.match(route, /linkOutcome\s*===\s*"already_linked"/);
  assert.match(route, /linkOutcome\s*===\s*"unchanged_closed"/);
});
