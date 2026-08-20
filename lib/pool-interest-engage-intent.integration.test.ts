import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const auditDatabaseUrl = process.env.ONG_INTEREST_INTENT_AUDIT_DATABASE_URL;

test(
  "interest and engage intent commit atomically and a replay preserves the original plan",
  { skip: !auditDatabaseUrl },
  async () => {
    const pg = await import("pg");
    const client = new pg.default.Client({ connectionString: auditDatabaseUrl });
    await client.connect();
    try {
      const marker = await client.query<{ marker: string | null }>(
        "select current_setting('ongboarding.migration_audit', true) as marker",
      );
      assert.equal(
        marker.rows[0]?.marker,
        "enabled",
        "refusing to run intent migration test outside a disposable audit database",
      );

      for (const role of ["anon", "authenticated", "service_role"]) {
        await client.query(`create role ${role} nologin`).catch((error: unknown) => {
          if ((error as { code?: string }).code !== "42710") throw error;
        });
      }
      await client.query(`
        create table public.jobs (id bigint primary key);
        create table public.applicants (id bigint primary key);
        create table public.job_candidates (
          job_id bigint not null references public.jobs(id),
          applicant_id bigint not null references public.applicants(id),
          agent_stage text,
          closed_at timestamptz,
          closed_reason text,
          engage_queued_at timestamptz,
          primary key (job_id, applicant_id)
        );
        create table public.pool_events (
          id bigint generated always as identity primary key,
          applicant_id bigint not null references public.applicants(id),
          job_id bigint references public.jobs(id),
          event_type text not null,
          action_key uuid unique
        );
        create or replace function public.record_pool_interest(
          p_job_id bigint,
          p_applicant_id bigint,
          p_immediate boolean,
          p_action_key uuid
        ) returns text
        language plpgsql
        security definer
        set search_path = public
        as $$
        begin
          if exists (select 1 from public.pool_events where action_key = p_action_key) then
            return 'deduped';
          end if;
          insert into public.pool_events (applicant_id, job_id, event_type, action_key)
          values (p_applicant_id, p_job_id, 'interest_click', p_action_key);
          return 'recorded';
        end;
        $$;
      `);
      const migration = await readFile(
        new URL("../docs/migrations/2026-08-pool-interest-engage-intent.sql", import.meta.url),
        "utf8",
      );
      await client.query(migration);

      await client.query("insert into public.jobs (id) values (31)");
      await client.query("insert into public.applicants (id) values (7)");
      await client.query(
        "insert into public.job_candidates (job_id, applicant_id) values (31, 7)",
      );

      const daytimeAction = "11111111-1111-4111-8111-111111111111";
      const first = await client.query<{ outcome: string }>(
        "select public.record_pool_interest_with_engage_intent(31, 7, false, $1, 'auto_now') as outcome",
        [daytimeAction],
      );
      assert.equal(first.rows[0]?.outcome, "recorded");
      const daytime = await client.query<{
        event_count: string;
        intent: string;
        queue_created: boolean;
        status: string;
      }>(`
        select
          (select count(*) from public.pool_events where action_key = $1) as event_count,
          intent,
          queue_created,
          status
        from public.pool_interest_engage_intents
        where action_key = $1
      `, [daytimeAction]);
      assert.deepEqual(daytime.rows[0], {
        event_count: "1",
        intent: "auto_now",
        queue_created: false,
        status: "pending",
      });

      const replay = await client.query<{ outcome: string }>(
        "select public.record_pool_interest_with_engage_intent(31, 7, false, $1, 'off') as outcome",
        [daytimeAction],
      );
      assert.equal(replay.rows[0]?.outcome, "deduped");
      const replayIntent = await client.query<{ intent: string }>(
        "select intent from public.pool_interest_engage_intents where action_key = $1",
        [daytimeAction],
      );
      assert.equal(replayIntent.rows[0]?.intent, "auto_now");

      const queuedAction = "22222222-2222-4222-8222-222222222222";
      const queued = await client.query<{ outcome: string }>(
        "select public.record_pool_interest_with_engage_intent(31, 7, false, $1, 'auto_queue') as outcome",
        [queuedAction],
      );
      assert.equal(queued.rows[0]?.outcome, "recorded");
      const queueState = await client.query<{
        queue_created: boolean;
        engage_queued_at: Date | null;
      }>(`
        select i.queue_created, c.engage_queued_at
        from public.pool_interest_engage_intents i
        join public.job_candidates c
          on c.job_id = i.job_id and c.applicant_id = i.applicant_id
        where i.action_key = $1
      `, [queuedAction]);
      assert.equal(queueState.rows[0]?.queue_created, true);
      assert.ok(queueState.rows[0]?.engage_queued_at instanceof Date);

      const rejectedAction = "33333333-3333-4333-8333-333333333333";
      await client.query(`
        create function public.reject_audit_intent() returns trigger
        language plpgsql as $$
        begin
          if new.action_key = '${rejectedAction}'::uuid then
            raise exception 'audit rejection';
          end if;
          return new;
        end;
        $$;
        create trigger reject_audit_intent
        before insert on public.pool_interest_engage_intents
        for each row execute function public.reject_audit_intent();
      `);
      await assert.rejects(
        client.query(
          "select public.record_pool_interest_with_engage_intent(31, 7, false, $1, 'auto_now')",
          [rejectedAction],
        ),
        /audit rejection/,
      );
      const partial = await client.query<{ events: string; intents: string }>(`
        select
          (select count(*) from public.pool_events where action_key = $1) as events,
          (select count(*) from public.pool_interest_engage_intents where action_key = $1) as intents
      `, [rejectedAction]);
      assert.deepEqual(partial.rows[0], { events: "0", intents: "0" });

      const deferred = await client.query<{ outcome: string }>(
        "select public.defer_pool_interest_engage_intent($1, 7, 31) as outcome",
        [daytimeAction],
      );
      assert.equal(deferred.rows[0]?.outcome, "queued");
      const completed = await client.query<{ outcome: string }>(
        "select public.complete_pool_interest_engage_intent($1, 7, 31, 'queued') as outcome",
        [daytimeAction],
      );
      assert.equal(completed.rows[0]?.outcome, "recorded");
      const completedReplay = await client.query<{ outcome: string }>(
        "select public.complete_pool_interest_engage_intent($1, 7, 31, 'queued') as outcome",
        [daytimeAction],
      );
      assert.equal(completedReplay.rows[0]?.outcome, "deduped");
      const conflictingCompletion = await client.query<{ outcome: string }>(
        "select public.complete_pool_interest_engage_intent($1, 7, 31, 'engaged') as outcome",
        [daytimeAction],
      );
      assert.equal(conflictingCompletion.rows[0]?.outcome, "conflict");
    } finally {
      await client.end();
    }
  },
);
