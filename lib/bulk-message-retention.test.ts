import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type RetentionModule = {
  redactExpiredBulkMessageOutbox?: (
    supabase: unknown,
    options?: { batchLimit?: number; recipientLimit?: number },
  ) => Promise<{
    expiredGuards: number;
    redactedRecipients: number;
    redactedBatches: number;
  }>;
};

async function loadModule(): Promise<RetentionModule> {
  try {
    return await import(new URL("./bulk-message-retention.ts", import.meta.url).href) as RetentionModule;
  } catch {
    return {};
  }
}

test("the retention runner invokes only the bounded redaction RPC", async () => {
  const { redactExpiredBulkMessageOutbox } = await loadModule();
  const calls: Array<[string, Record<string, unknown>]> = [];
  const supabase = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push([name, args]);
      return {
        data: {
          expired_guards: 4,
          redacted_recipients: 3,
          redacted_batches: 1,
        },
        error: null,
      };
    },
  };

  assert.equal(typeof redactExpiredBulkMessageOutbox, "function");
  assert.deepEqual(await redactExpiredBulkMessageOutbox!(supabase), {
    expiredGuards: 4,
    redactedRecipients: 3,
    redactedBatches: 1,
  });
  assert.deepEqual(calls, [["redact_bulk_message_terminal_data", {
    p_batch_limit: 25,
    p_recipient_limit: 100,
  }]]);
});

test("the retention runner rejects database errors and malformed success payloads", async () => {
  const { redactExpiredBulkMessageOutbox } = await loadModule();

  assert.equal(typeof redactExpiredBulkMessageOutbox, "function");
  await assert.rejects(
    () => redactExpiredBulkMessageOutbox!({
      rpc: async () => ({ data: null, error: { message: "database unavailable" } }),
    }),
    /database unavailable/,
  );
  await assert.rejects(
    () => redactExpiredBulkMessageOutbox!({
      rpc: async () => ({ data: { redacted_recipients: -1 }, error: null }),
    }),
    /invalid bulk message retention result/i,
  );
  await assert.rejects(
    () => redactExpiredBulkMessageOutbox!({
      rpc: async () => ({ data: {}, error: null }),
    }, { recipientLimit: 501 }),
    /recipient limit must be between 1 and 500/i,
  );
});

test("the cumulative migration redacts terminal plaintext while preserving idempotency tombstones", async () => {
  const migration = await readFile(
    new URL("../docs/migrations/2026-09-bulk-message-retention.sql", import.meta.url),
    "utf8",
  ).catch(() => "");

  assert.match(migration, /add column if not exists redacted_at timestamptz/i);
  assert.match(migration, /status\s*=\s*'recorded'[\s\S]*?interval\s+'30 days'/i);
  assert.match(migration, /status\s*=\s*'failed'[\s\S]*?interval\s+'30 days'/i);
  assert.match(migration, /not exists\s*\([\s\S]*?bulk_message_phone_guards[\s\S]*?owner_key/i);
  assert.match(migration, /set[\s\S]*?applicant_phone\s*=\s*null[\s\S]*?body\s*=\s*null[\s\S]*?redacted_at\s*=\s*clock_timestamp\(\)/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.bulk_message_send_requests/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.bulk_message_batches/i);
  assert.match(migration, /status\s+in\s*\('sending',\s*'unknown',\s*'sent'\)[\s\S]*?redacted_at\s+is\s+null/i);
  assert.match(migration, /p_recipient_limit\s+integer\s+default\s+100/i);
  assert.match(migration, /limit\s+p_recipient_limit\s+-\s+v_redacted_recipients/i);
  assert.match(migration, /on\s+public\.bulk_message_send_requests\s*\(batch_id,\s*recipient_key\)[\s\S]*?where\s+redacted_at\s+is\s+null/i);
  assert.match(migration, /bulk_message_attention_idx[\s\S]*?\(created_at,\s*recipient_key\)[\s\S]*?status\s+in\s*\('sending',\s*'unknown',\s*'sent'\)/i);
});

test("retired batches remain replay-safe and the redaction RPC is service-role only", async () => {
  const migration = await readFile(
    new URL("../docs/migrations/2026-09-bulk-message-retention.sql", import.meta.url),
    "utf8",
  ).catch(() => "");

  assert.match(migration, /request_fingerprint\s+is\s+distinct\s+from\s+p_request_fingerprint/i);
  assert.match(migration, /redacted_at\s+is\s+not\s+null[\s\S]*?'batch_retired'/i);
  assert.match(migration, /create or replace function public\.redact_bulk_message_terminal_data/i);
  assert.match(migration, /security definer[\s\S]*?set search_path\s*=\s*public,\s*pg_temp/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /revoke execute on function public\.redact_bulk_message_terminal_data\(integer,\s*integer\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.redact_bulk_message_terminal_data\(integer,\s*integer\) to service_role/i);
});
