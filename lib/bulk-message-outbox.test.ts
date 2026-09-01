import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../docs/migrations/2026-09-bulk-message-outbox.sql",
  import.meta.url,
);

function functionBody(migration: string, name: string, nextName?: string): string {
  const lower = migration.toLowerCase();
  const start = lower.indexOf(`create or replace function public.${name}`);
  assert.ok(start >= 0, `${name} must be defined`);
  const end = nextName
    ? lower.indexOf(`create or replace function public.${nextName}`, start)
    : migration.length;
  return migration.slice(start, end >= 0 ? end : migration.length);
}

test("bulk outbox tables keep client batches, recipient delivery, and phone TTL guards durable", async () => {
  const migration = await readFile(migrationUrl, "utf8").catch(() => "");

  assert.match(migration, /create table if not exists public\.bulk_message_batches/i);
  assert.match(migration, /request_id\s+uuid\s+primary key/i);
  assert.match(migration, /request_fingerprint\s+text\s+not null/i);
  assert.match(migration, /create table if not exists public\.bulk_message_send_requests/i);
  assert.match(migration, /recipient_key\s+uuid\s+primary key/i);
  assert.match(migration, /status\s+text\s+not null[\s\S]*?'sending'[\s\S]*?'unknown'[\s\S]*?'failed'[\s\S]*?'sent'[\s\S]*?'recorded'/i);
  assert.match(migration, /provider_reconcile_claim_token\s+uuid/i);
  assert.match(migration, /provider_reconcile_claimed_until\s+timestamptz/i);
  assert.match(migration, /create table if not exists public\.bulk_message_phone_guards/i);
  assert.match(migration, /primary key\s*\(\s*applicant_phone\s*,\s*scope\s*\)/i);
  assert.match(migration, /scope[\s\S]*?'bulk_10m'[\s\S]*?'job_notice_24h'[\s\S]*?'new_job_7d'/i);
  assert.match(migration, /enable row level security/gi);
  assert.match(migration, /revoke all on table public\.bulk_message_send_requests from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.bulk_message_send_requests to service_role/i);
});

test("batch replay accepts only the immutable original body, subject, purpose, and job fingerprint", async () => {
  const migration = await readFile(migrationUrl, "utf8").catch(() => "");
  const claim = functionBody(migration, "claim_bulk_message_batch", "claim_bulk_message_recipient");

  assert.match(claim, /p_request_fingerprint/i);
  assert.match(claim, /v_batch\.request_fingerprint\s+is\s+distinct\s+from\s+p_request_fingerprint/i);
  assert.match(claim, /v_batch\.body\s+is\s+distinct\s+from\s+p_body/i);
  assert.match(claim, /v_batch\.subject\s+is\s+distinct\s+from\s+p_subject/i);
  assert.match(claim, /v_batch\.effective_purpose\s+is\s+distinct\s+from\s+p_effective_purpose/i);
  assert.match(claim, /v_batch\.job_id\s+is\s+distinct\s+from\s+p_job_id/i);
  assert.match(claim, /'outcome'\s*,\s*'conflict'/i);
});

test("recipient claims derive a stable key and block active same-intent or phone-guard races", async () => {
  const migration = await readFile(migrationUrl, "utf8").catch(() => "");
  const claim = functionBody(
    migration,
    "claim_bulk_message_recipient",
    "record_bulk_message_provider_result",
  );

  assert.match(claim, /md5\s*\(\s*'bulk-send:'\s*\|\|\s*p_batch_id::text\s*\|\|\s*':'\s*\|\|\s*v_phone\s*\)\s*\)::uuid/i);
  assert.match(claim, /pg_advisory_xact_lock[\s\S]*?bulk-message-phone:/i);
  assert.match(claim, /recipient_fingerprint\s*=\s*p_recipient_fingerprint/i);
  assert.match(claim, /status\s+in\s*\(\s*'sending'\s*,\s*'unknown'\s*,\s*'sent'\s*\)/i);
  assert.match(claim, /bulk_message_phone_guards[\s\S]*?expires_at\s*>\s*clock_timestamp\(\)/i);
  assert.match(claim, /'outcome'\s*,\s*'blocked'/i);
  assert.match(claim, /'outcome'\s*,\s*'existing'/i);
  assert.match(claim, /'outcome'\s*,\s*'claimed'/i);

  const activeIntentIndex = migration.match(
    /create unique index[^;]+bulk_message_send_requests[^;]+recipient_fingerprint[^;]+where\s+status\s+in\s*\([^;]+;/i,
  );
  assert.ok(activeIntentIndex, "active same-intent sends need a database uniqueness backstop");
  assert.doesNotMatch(activeIntentIndex[0], /batch_id/i, "the same-intent guard must not be bypassed with a new batch id");
});

test("only a provider-declared failure releases phone guards", async () => {
  const migration = await readFile(migrationUrl, "utf8").catch(() => "");
  const provider = functionBody(
    migration,
    "record_bulk_message_provider_result",
    "finalize_bulk_message_send",
  );

  assert.match(provider, /p_result\s*=\s*'failed'[\s\S]*?delete\s+from\s+public\.bulk_message_phone_guards[\s\S]*?owner_key\s*=\s*p_recipient_key/i);
  const unknownBranch = provider.slice(
    provider.indexOf("p_result = 'unknown'"),
    provider.indexOf("p_result = 'failed'"),
  );
  assert.doesNotMatch(unknownBranch, /delete\s+from\s+public\.bulk_message_phone_guards/i);
  assert.match(unknownBranch, /status\s*=\s*'unknown'/i);
});

test("finalization atomically records one domain-separated message and its pool events", async () => {
  const migration = await readFile(migrationUrl, "utf8").catch(() => "");
  const finalize = functionBody(
    migration,
    "finalize_bulk_message_send",
    "claim_bulk_message_provider_reconciliation",
  );

  assert.match(finalize, /for update/i);
  assert.match(finalize, /md5\s*\(\s*'bulk-message:'\s*\|\|\s*p_recipient_key::text\s*\)\s*\)::uuid/i);
  assert.match(finalize, /insert into public\.messages/i);
  assert.match(finalize, /on conflict\s*\(\s*client_request_id\s*\)[\s\S]*?do nothing/i);
  assert.match(finalize, /insert into public\.pool_events[\s\S]*?'ping_sent'/i);
  assert.match(finalize, /effective_purpose\s*=\s*'job_closed'[\s\S]*?'waitlist_notice'/i);
  assert.match(finalize, /update public\.bulk_message_send_requests[\s\S]*?status\s*=\s*'recorded'/i);
  assert.match(finalize, /return\s+'conflict'/i);
});

test("provider reconciliation is bounded and exact matches alone advance unknown delivery to sent", async () => {
  const migration = await readFile(migrationUrl, "utf8").catch(() => "");
  const claim = functionBody(
    migration,
    "claim_bulk_message_provider_reconciliation",
    "record_bulk_message_provider_match",
  );
  const match = functionBody(
    migration,
    "record_bulk_message_provider_match",
    "record_bulk_message_provider_miss",
  );
  const miss = functionBody(migration, "record_bulk_message_provider_miss");

  assert.match(claim, /provider_reconcile_attempts\s*>=\s*p_max_attempts/i);
  assert.match(claim, /provider_reconcile_status\s*=\s*'unresolved'/i);
  assert.match(claim, /p_claim_token\s+uuid/i);
  assert.match(claim, /provider_reconcile_claimed_until\s*>\s*clock_timestamp\(\)/i);
  assert.match(claim, /provider_reconcile_claim_token\s*=\s*p_claim_token/i);
  assert.match(match, /p_claim_token\s+uuid/i);
  assert.match(match, /provider_reconcile_claim_token\s+is\s+distinct\s+from\s+p_claim_token/i);
  assert.match(miss, /p_claim_token\s+uuid/i);
  assert.match(miss, /provider_reconcile_claim_token\s+is\s+distinct\s+from\s+p_claim_token/i);
  assert.match(match, /provider_correlation_attached\s+is\s+not\s+true/i);
  assert.match(match, /status\s+not\s+in\s*\(\s*'sending'\s*,\s*'unknown'\s*\)/i);
  assert.match(match, /status\s*=\s*'sent'/i);
  assert.match(miss, /case[\s\S]*?provider_reconcile_attempts\s*>=\s*p_max_attempts[\s\S]*?'unresolved'[\s\S]*?'pending'/i);
  assert.doesNotMatch(miss, /status\s*=\s*'failed'/i);
});

test("all bulk outbox RPCs are service-role only", async () => {
  const migration = await readFile(migrationUrl, "utf8").catch(() => "");
  for (const signature of [
    "claim_bulk_message_batch(UUID, TEXT, TEXT, TEXT, TEXT, BIGINT)",
    "claim_bulk_message_recipient(UUID, BIGINT, TEXT, TEXT, TEXT)",
    "record_bulk_message_provider_result(UUID, TEXT, TEXT, TEXT)",
    "finalize_bulk_message_send(UUID)",
    "claim_bulk_message_provider_reconciliation(UUID, INTEGER, UUID)",
    "record_bulk_message_provider_match(UUID, TEXT, UUID)",
    "record_bulk_message_provider_miss(UUID, INTEGER, UUID, TEXT)",
  ]) {
    const escaped = signature.replace(/[()]/g, "\\$&").replace(/, /g, "\\s*,\\s*");
    assert.match(migration, new RegExp(`revoke execute on function public\\.${escaped} from public, anon, authenticated`, "i"));
    assert.match(migration, new RegExp(`grant execute on function public\\.${escaped} to service_role`, "i"));
  }
});

const auditDatabaseUrl = process.env.ONG_MIGRATION_AUDIT_DATABASE_URL;

test(
  "the database gives one concurrent recovery worker the lease and rejects the stale worker",
  { skip: !auditDatabaseUrl },
  async () => {
    const pg = await import("pg");
    const Client = pg.default.Client;
    const admin = new Client({ connectionString: auditDatabaseUrl });
    const first = new Client({ connectionString: auditDatabaseUrl });
    const second = new Client({ connectionString: auditDatabaseUrl });
    await Promise.all([admin.connect(), first.connect(), second.connect()]);

    const batchId = randomUUID();
    const firstToken = randomUUID();
    const secondToken = randomUUID();
    try {
      const marker = await admin.query<{ marker: string | null }>(
        "select current_setting('ongboarding.migration_audit', true) as marker",
      );
      assert.equal(
        marker.rows[0]?.marker,
        "enabled",
        "refusing to run bulk outbox test outside a disposable migration-audit database",
      );

      const claimedBatch = await admin.query<{ result: { outcome: string } }>(
        "select public.claim_bulk_message_batch($1, 'batch-fingerprint', 'hello', 'subject', 'campaign', null) as result",
        [batchId],
      );
      assert.equal(claimedBatch.rows[0]?.result.outcome, "claimed");
      const claimedRecipient = await admin.query<{ result: { recipient_key: string } }>(
        "select public.claim_bulk_message_recipient($1, 7, '01012345678', 'hello', 'recipient-fingerprint') as result",
        [batchId],
      );
      const recipientKey = claimedRecipient.rows[0]?.result.recipient_key;
      assert.ok(recipientKey);

      const claim = (client: import("pg").Client, token: string) => client.query<{ result: string }>(
        "select public.claim_bulk_message_provider_reconciliation($1, 3, $2) as result",
        [recipientKey, token],
      );
      const claims = await Promise.all([
        claim(first, firstToken),
        claim(second, secondToken),
      ]);
      assert.deepEqual(
        claims.map((result) => result.rows[0]?.result).sort(),
        ["claimed", "leased"],
      );
      const winnerToken = claims[0]?.rows[0]?.result === "claimed" ? firstToken : secondToken;
      const staleToken = winnerToken === firstToken ? secondToken : firstToken;

      const staleMiss = await admin.query<{ result: string }>(
        "select public.record_bulk_message_provider_miss($1, 3, $2, null) as result",
        [recipientKey, staleToken],
      );
      assert.equal(staleMiss.rows[0]?.result, "stale_claim");
      const exactMatch = await admin.query<{ result: string }>(
        "select public.record_bulk_message_provider_match($1, 'provider-message-1', $2) as result",
        [recipientKey, winnerToken],
      );
      assert.equal(exactMatch.rows[0]?.result, "matched");

      const outbox = await admin.query<{
        status: string;
        provider_reconcile_status: string;
        provider_reconcile_attempts: number;
        provider_reconcile_claim_token: string | null;
      }>(
        `select status, provider_reconcile_status, provider_reconcile_attempts,
                provider_reconcile_claim_token
         from public.bulk_message_send_requests
         where recipient_key = $1`,
        [recipientKey],
      );
      assert.deepEqual(outbox.rows[0], {
        status: "sent",
        provider_reconcile_status: "matched",
        provider_reconcile_attempts: 1,
        provider_reconcile_claim_token: null,
      });
    } finally {
      await admin.query(
        "delete from public.bulk_message_send_requests where batch_id = $1",
        [batchId],
      ).catch(() => undefined);
      await admin.query(
        "delete from public.bulk_message_batches where request_id = $1",
        [batchId],
      ).catch(() => undefined);
      await Promise.allSettled([admin.end(), first.end(), second.end()]);
    }
  },
);
