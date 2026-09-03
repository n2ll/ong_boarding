import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const migrationUrl = new URL(
  "../../docs/migrations/2026-09-acquisition-attribution-service-role-grants.sql",
  import.meta.url,
);

test("the attribution grant repair revokes broad service-role access before granting the minimum", () => {
  assert.equal(existsSync(migrationUrl), true, "the corrective migration must exist");

  const migration = readFileSync(migrationUrl, "utf8");
  const relations = [
    "acquisition_campaigns",
    "acquisition_tracking_links",
    "application_submission_attributions",
    "application_submission_attribution_outcomes",
    "application_submission_attribution_performance",
  ];

  for (const relation of relations) {
    assert.match(
      migration,
      new RegExp(`revoke all on table public\\.${relation} from service_role`, "i"),
    );
  }

  assert.match(migration, /grant select, insert on table public\.acquisition_campaigns to service_role/i);
  assert.match(migration, /grant update \(archived_at\) on table public\.acquisition_campaigns to service_role/i);
  assert.match(migration, /grant select, insert on table public\.acquisition_tracking_links to service_role/i);
  assert.match(migration, /grant update \(archived_at\) on table public\.acquisition_tracking_links to service_role/i);
  assert.match(migration, /grant select on table public\.application_submission_attributions to service_role/i);
  assert.match(migration, /grant select on table public\.application_submission_attribution_outcomes to service_role/i);
  assert.match(migration, /grant select on table public\.application_submission_attribution_performance to service_role/i);
  assert.doesNotMatch(migration, /grant update on table/i);
});
