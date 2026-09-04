import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const migrationUrl = new URL(
  "../../docs/migrations/2026-09-function-search-path.sql",
  import.meta.url,
);

test("the mutable public functions receive a fixed search path", () => {
  assert.equal(existsSync(migrationUrl), true, "the corrective migration must exist");

  const migration = readFileSync(migrationUrl, "utf8");
  const normalizedMigration = migration.replace(/\s+/g, " ");
  const functions = [
    "trg_branches_updated_at()",
    "trg_jobs_updated_at()",
    "upsert_ai_usage_daily(date, text, text, integer, integer, integer)",
    "euc_kr_byte_length(text)",
    "classify_outbound_sms()",
    "match_applicant_on_message()",
  ];

  for (const fn of functions) {
    assert.match(
      normalizedMigration,
      new RegExp(`alter function public\\.${fn.replace(/[()]/g, "\\$&")} set search_path = public, pg_temp`, "i"),
    );
  }
});
