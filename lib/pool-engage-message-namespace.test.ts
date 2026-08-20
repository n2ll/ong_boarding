import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../docs/migrations/2026-08-pool-engage-runtime-message-namespace.sql",
  import.meta.url,
);

test("pool engage messages use a domain key and verify exact ownership", async () => {
  const migration = await readFile(migrationUrl, "utf8").catch(() => "");
  assert.match(migration, /create or replace function public\.finalize_pool_engage/i);
  assert.match(migration, /md5\s*\(\s*'pool-engage:'/i);
  assert.match(
    migration,
    /from\s+public\.applicants\b(?:(?!;)[\s\S])*?for\s+update\s*;[\s\S]*from\s+public\.pool_engage_send_requests\b(?:(?!;)[\s\S])*?for\s+update\s*;/i,
  );
  assert.match(
    migration,
    /client_request_id\s*=\s*p_action_key[\s\S]*is not distinct from[\s\S]*v_message_client_request_id/i,
  );
  assert.match(migration, /return\s+'conflict'/i);
});

const auditDatabaseUrl = process.env.ONG_MIGRATION_AUDIT_DATABASE_URL;

test(
  "an apply message with the external action UUID cannot swallow the pool message",
  { skip: !auditDatabaseUrl },
  async () => {
    const pg = await import("pg");
    const Client = pg.default.Client;
    const client = new Client({ connectionString: auditDatabaseUrl });
    const applicantId = Number.parseInt(
      randomUUID().replaceAll("-", "").slice(0, 12),
      16,
    );
    const jobId = applicantId;
    const actionKey = randomUUID();

    await client.connect();
    try {
      const marker = await client.query<{ marker: string | null }>(
        "select current_setting('ongboarding.migration_audit', true) as marker",
      );
      assert.equal(
        marker.rows[0]?.marker,
        "enabled",
        "refusing to run message-key test outside a disposable migration-audit database",
      );

      await client.query(
        `insert into public.jobs (id, title, status, exposure, recruit_mode, closes_at)
         values ($1, 'message namespace audit', 'active', 'all', 'both', now() + interval '1 day')`,
        [jobId],
      );
      await client.query(
        `insert into public.applicants (id, phone, status, current_job_id, pool_engage_action_key)
         values ($1, '01088888888', '스크리닝 전', $2, $3)`,
        [applicantId, jobId, actionKey],
      );
      await client.query(
        "insert into public.job_candidates (job_id, applicant_id) values ($1, $2)",
        [jobId, applicantId],
      );
      await client.query(
        `insert into public.pool_engage_send_requests (
           action_key, applicant_id, job_id, applicant_phone, message_body,
           message_kind, source, status, provider_message_id, sent_at
         ) values (
           $1, $2, $3, '01088888888', 'pool screening text',
           'screening', 'audit', 'sent', 'pool-provider-id', now()
         )`,
        [actionKey, applicantId, jobId],
      );
      await client.query(
        `insert into public.messages (
           applicant_id, applicant_phone, direction, body, status, sent_by,
           solapi_msg_id, message_type, job_id, client_request_id
         ) values (
           $1, '01088888888', 'outbound', 'apply receipt text', 'sent', 'system-auto',
           'apply-provider-id', 'sms', $2, $3
         )`,
        [applicantId, jobId, actionKey],
      );

      const first = await client.query<{ outcome: string }>(
        "select public.finalize_pool_engage($1) as outcome",
        [actionKey],
      );
      assert.equal(first.rows[0]?.outcome, "recorded");

      const messages = await client.query<{
        body: string;
        client_request_id: string;
        sent_by: string;
      }>(
        `select body, client_request_id, sent_by
           from public.messages
          where applicant_id = $1
          order by sent_by`,
        [applicantId],
      );
      assert.equal(messages.rowCount, 2);
      const poolMessage = messages.rows.find((row) => row.sent_by === "agent-engage");
      assert.deepEqual(poolMessage?.body, "pool screening text");
      assert.notEqual(poolMessage?.client_request_id, actionKey);

      const replay = await client.query<{ outcome: string }>(
        "select public.finalize_pool_engage($1) as outcome",
        [actionKey],
      );
      assert.equal(replay.rows[0]?.outcome, "deduped");
      const count = await client.query<{ count: string }>(
        "select count(*)::text as count from public.messages where applicant_id = $1",
        [applicantId],
      );
      assert.equal(count.rows[0]?.count, "2");
    } finally {
      await client.query("delete from public.pool_events where applicant_id = $1", [applicantId]);
      await client.query("delete from public.messages where applicant_id = $1", [applicantId]);
      await client.query("delete from public.pool_engage_send_requests where action_key = $1", [actionKey]);
      await client.query("delete from public.job_candidates where applicant_id = $1", [applicantId]);
      await client.query("delete from public.applicants where id = $1", [applicantId]);
      await client.query("delete from public.jobs where id = $1", [jobId]);
      await client.end();
    }
  },
);
