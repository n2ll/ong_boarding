import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../docs/migrations/2026-08-pool-engage-runtime-lock-order.sql",
  import.meta.url,
);

function functionBody(migration: string, name: string, nextName?: string): string {
  const start = migration.toLowerCase().indexOf(`create or replace function public.${name}`);
  assert.ok(start >= 0, `${name} must be replaced by the cumulative migration`);
  const end = nextName
    ? migration.toLowerCase().indexOf(`create or replace function public.${nextName}`, start)
    : migration.length;
  return migration.slice(start, end >= 0 ? end : migration.length);
}

function rowLockTargets(body: string): string[] {
  return Array.from(
    body.matchAll(
      /from\s+public\.(applicants|pool_engage_send_requests)\b(?:(?!;)[\s\S])*?for\s+update\s*;/gi,
    ),
    (match) => match[1]!.toLowerCase(),
  );
}

test("provider result and finalize lock applicant before outbox", async () => {
  const migration = await readFile(migrationUrl, "utf8").catch(() => "");
  const provider = functionBody(
    migration,
    "record_pool_engage_provider_result",
    "finalize_pool_engage",
  );
  const finalize = functionBody(migration, "finalize_pool_engage");

  assert.deepEqual(rowLockTargets(provider).slice(0, 2), [
    "applicants",
    "pool_engage_send_requests",
  ]);
  assert.deepEqual(rowLockTargets(finalize).slice(0, 2), [
    "applicants",
    "pool_engage_send_requests",
  ]);
});

const auditDatabaseUrl = process.env.ONG_MIGRATION_AUDIT_DATABASE_URL;

test(
  "a concurrent retry cannot deadlock a declared provider failure",
  { skip: !auditDatabaseUrl },
  async () => {
    const pg = await import("pg");
    const Client = pg.default.Client;
    const admin = new Client({ connectionString: auditDatabaseUrl });
    const holder = new Client({ connectionString: auditDatabaseUrl });
    const retry = new Client({ connectionString: auditDatabaseUrl });
    const provider = new Client({ connectionString: auditDatabaseUrl });
    const applicantId = Number.parseInt(
      randomUUID().replaceAll("-", "").slice(0, 12),
      16,
    );
    const jobId = applicantId;
    const actionKey = randomUUID();

    await Promise.all([admin.connect(), holder.connect(), retry.connect(), provider.connect()]);
    try {
      const marker = await admin.query<{ marker: string | null }>(
        "select current_setting('ongboarding.migration_audit', true) as marker",
      );
      assert.equal(
        marker.rows[0]?.marker,
        "enabled",
        "refusing to run lock test outside a disposable migration-audit database",
      );

      await admin.query(
        `insert into public.jobs (id, title, status, exposure, recruit_mode, closes_at)
         values ($1, 'lock audit job', 'active', 'all', 'both', now() + interval '1 day')`,
        [jobId],
      );
      await admin.query(
        `insert into public.applicants (id, phone, status, current_job_id, pool_engage_action_key)
         values ($1, '01099999999', '스크리닝 전', $2, $3)`,
        [applicantId, jobId, actionKey],
      );
      await admin.query(
        `insert into public.job_candidates (job_id, applicant_id)
         values ($1, $2)`,
        [jobId, applicantId],
      );
      await admin.query(
        `insert into public.pool_engage_send_requests (
           action_key, applicant_id, job_id, applicant_phone,
           message_body, message_kind, source, status
         ) values ($1, $2, $3, '01099999999', 'lock audit', 'screening', 'audit', 'sending')`,
        [actionKey, applicantId, jobId],
      );

      await Promise.all([
        holder.query("set deadlock_timeout = '100ms'"),
        retry.query("set deadlock_timeout = '100ms'"),
        provider.query("set deadlock_timeout = '100ms'"),
      ]);
      const retryPid = (await retry.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0]!.pid;
      const providerPid = (await provider.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0]!.pid;
      await holder.query("begin");
      await holder.query("select 1 from public.applicants where id = $1 for update", [applicantId]);

      await retry.query("begin");
      const retryWork = (async () => {
        const result = await retry.query<{ result: { outcome: string } }>(
          "select public.reconcile_pool_engage($1, $2, $3) as result",
          [actionKey, applicantId, jobId],
        );
        await retry.query("commit");
        return result.rows[0]?.result;
      })();

      await waitUntilBlocked(admin, retryPid);

      await provider.query("begin");
      const providerWork = (async () => {
        const result = await provider.query<{ result: string }>(
          "select public.record_pool_engage_provider_result($1, 'failed', null, 'declared') as result",
          [actionKey],
        );
        await provider.query("commit");
        return result.rows[0]?.result;
      })();

      await waitUntilBlocked(admin, providerPid);
      await holder.query("commit");

      const [retryResult, providerResult] = await Promise.all([retryWork, providerWork]);
      assert.equal(retryResult?.outcome, "sending");
      assert.equal(providerResult, "recorded");

      const outbox = await admin.query<{ status: string }>(
        "select status from public.pool_engage_send_requests where action_key = $1",
        [actionKey],
      );
      assert.equal(outbox.rows[0]?.status, "failed");
    } finally {
      await Promise.allSettled([
        holder.query("rollback"),
        retry.query("rollback"),
        provider.query("rollback"),
      ]);
      await admin.query("delete from public.pool_engage_send_requests where action_key = $1", [actionKey]);
      await admin.query("delete from public.job_candidates where applicant_id = $1", [applicantId]);
      await admin.query("delete from public.applicants where id = $1", [applicantId]);
      await admin.query("delete from public.jobs where id = $1", [jobId]);
      await Promise.allSettled([admin.end(), holder.end(), retry.end(), provider.end()]);
    }
  },
);

async function waitUntilBlocked(
  admin: import("pg").Client,
  processId: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await admin.query<{ wait_event_type: string | null }>(
      "select wait_event_type from pg_stat_activity where pid = $1",
      [processId],
    );
    if (result.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process ${processId} did not block on the expected row lock`);
}
