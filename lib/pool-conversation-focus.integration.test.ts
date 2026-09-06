import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const auditDatabaseUrl = process.env.ONG_CONVERSATION_FOCUS_AUDIT_DATABASE_URL;

test("conversation focus and reply claims use the real Postgres interest/outbox contracts", {
  skip: !auditDatabaseUrl,
}, async (t) => {
  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString: auditDatabaseUrl });
  const competitor = new pg.default.Client({ connectionString: auditDatabaseUrl });
  await client.connect();
  await competitor.connect();
  try {
    const marker = await client.query<{ marker: string | null }>(
      "select current_setting('ongboarding.migration_audit', true) as marker",
    );
    assert.equal(marker.rows[0]?.marker, "enabled",
      "refusing to run outside a disposable audit database");
    await client.query("set statement_timeout = '10s'");
    await competitor.query("set statement_timeout = '10s'");
    for (const role of ["anon", "authenticated", "service_role"]) {
      await client.query(`create role ${role} nologin`).catch((error: unknown) => {
        if ((error as { code?: string }).code !== "42710") throw error;
      });
    }
    // Only the base schema is a fixture. Every business function is loaded from its actual migration.
    await client.query(`
      create table public.jobs (
        id bigint primary key, title text, status text default 'active',
        closes_at timestamptz, recruit_mode text default 'internal', exposure text
      );
      create table public.applicants (
        id bigint primary key, phone text default '01000000000', status text default '인력풀',
        sms_opt_out_at timestamptz, current_job_id bigint references public.jobs(id),
        availability text, availability_updated_at timestamptz
      );
      create table public.job_candidates (
        id bigint generated always as identity primary key,
        job_id bigint not null references public.jobs(id),
        applicant_id bigint not null references public.applicants(id),
        agent_stage text, closed_at timestamptz, closed_reason text,
        engage_queued_at timestamptz, contacted_at timestamptz, sent_at timestamptz,
        unique (job_id, applicant_id)
      );
      create table public.job_exposure_targets (
        job_id bigint references public.jobs(id), applicant_id bigint references public.applicants(id),
        mode text, added_by text, primary key (job_id, applicant_id)
      );
      create table public.messages (
        id bigint generated always as identity primary key,
        applicant_id bigint, applicant_phone text, direction text, body text,
        status text, sent_by text, solapi_msg_id text, message_type text, job_id bigint
      );
    `);
    for (const filename of [
      "2026-07-pool-events.sql",
      "2026-08-pool-actions-atomic.sql",
      "2026-08-pool-engage-claim.sql",
      "2026-08-pool-engage-recovery.sql",
      "2026-08-pool-engage-runtime-lock-order.sql",
      "2026-08-pool-engage-runtime-message-namespace.sql",
      "2026-08-pool-interest-engage-intent.sql",
    ]) {
      await client.query(await readFile(new URL(`../docs/migrations/${filename}`, import.meta.url), "utf8"));
    }
    const focusMigration = new URL("../docs/migrations/2026-09-pool-conversation-focus.sql", import.meta.url);
    // Missing migration in the RED run leaves the old database contract intact.
    const migration = await readFile(focusMigration, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (migration) await client.query(migration);
    await client.query("insert into public.jobs (id, title) values (31, '첫 공고'), (32, '둘째 공고'), (33, '셋째 공고')");

    let applicantSequence = 0;
    const applicant = async () => {
      const id = ++applicantSequence;
      await client.query("insert into public.applicants (id, current_job_id) values ($1, 31)", [id]);
      await client.query("insert into public.job_candidates (job_id, applicant_id, agent_stage) values (31, $1, 'screening')", [id]);
      return id;
    };
    const outcome = async (sql: string, args: unknown[]) =>
      (await client.query<{ outcome: string }>(`select ${sql} as outcome`, args)).rows[0]?.outcome;
    const selectFocus = (id: number, job: number, key = randomUUID(), intent = "auto_now") =>
      outcome("public.select_pool_conversation_focus($1, $2, $3, $4)", [job, id, key, intent]);
    const saveInterest = (id: number, job: number, key = randomUUID(), immediate = false) =>
      outcome("public.record_pool_interest_only($1, $2, $3, $4)", [job, id, immediate, key]);
    const claimReply = (id: number, job: number, key = randomUUID(), receivedAt?: Date | null) =>
      receivedAt === undefined
        ? outcome("public.claim_pool_agent_reply($1, $2, $3, clock_timestamp())", [id, job, key])
        : outcome("public.claim_pool_agent_reply($1, $2, $3, $4)", [id, job, key, receivedAt]);
    const releaseReply = (id: number, key: string) =>
      outcome("public.release_pool_agent_reply($1, $2)", [id, key]);
    const outbox = async (id: number, status: string, key = randomUUID()) => {
      await client.query(`
        insert into public.pool_engage_send_requests
          (action_key, applicant_id, job_id, applicant_phone, message_body, message_kind, source, status)
        values ($1, $2, 31, '01000000000', '테스트', 'screening', 'audit', $3)
      `, [key, id, status]);
      return key;
    };

    await t.test("selecting a different job atomically records interest, focus, intent and queue cleanup", async () => {
      const id = await applicant();
      const key = randomUUID();
      const oldKey = await outbox(id, "recorded");
      await client.query("update public.applicants set pool_engage_action_key = $2 where id = $1", [id, oldKey]);
      await client.query("update public.job_candidates set engage_queued_at = now() where applicant_id = $1", [id]);
      assert.equal(await selectFocus(id, 32, key, "auto_queue"), "recorded");
      const result = await client.query(`
        select a.current_job_id, a.conversation_focus_job_id, a.pool_engage_action_key,
          i.intent, i.queue_created, e.meta,
          (select count(*)::int from public.job_candidates where applicant_id = $1 and engage_queued_at is not null) as queued,
          (select agent_stage from public.job_candidates where applicant_id = $1 and job_id = 31) as previous_stage
        from public.applicants a
        join public.pool_interest_engage_intents i on i.action_key = $2
        join public.pool_events e on e.action_key = $2
        where a.id = $1
      `, [id, key]);
      assert.deepEqual(result.rows[0], {
        current_job_id: "32", conversation_focus_job_id: "32", pool_engage_action_key: null,
        intent: "auto_queue", queue_created: true,
        meta: { conversation_focus: true, from_job_id: 31 }, queued: 1, previous_stage: "screening",
      });
    });

    await t.test("an old replay never resets a later focus, even after confirmation or job closure", async () => {
      const id = await applicant();
      const key = randomUUID();
      assert.equal(await selectFocus(id, 32, key), "recorded");
      assert.equal(await selectFocus(id, 33), "recorded");
      await client.query("update public.applicants set status = '확정인력' where id = $1", [id]);
      await client.query("update public.jobs set status = 'closed' where id = 32");
      try {
        assert.equal(await selectFocus(id, 32, key, "off"), "deduped");
        const state = await client.query("select current_job_id, conversation_focus_job_id from public.applicants where id = $1", [id]);
        assert.deepEqual(state.rows[0], { current_job_id: "33", conversation_focus_job_id: "33" });
        await assert.rejects(selectFocus(id, 31, key), { code: "23505" });
        await assert.rejects(saveInterest(id, 32, key), { code: "23505" });
      } finally {
        await client.query("update public.jobs set status = 'active' where id = 32");
      }
    });

    await t.test("interest-only saves off intent and preserves focus, including replay mode separation", async () => {
      const id = await applicant();
      const key = randomUUID();
      await client.query("update public.applicants set conversation_focus_job_id = 31 where id = $1", [id]);
      assert.equal(await saveInterest(id, 32, key, true), "recorded");
      assert.equal(await saveInterest(id, 32, key, true), "deduped");
      await assert.rejects(selectFocus(id, 32, key), { code: "23505" });
      await assert.rejects(saveInterest(id, 32, key, false), { code: "23505" });
      const state = await client.query(`
        select a.current_job_id, a.conversation_focus_job_id, a.availability,
          i.intent, i.queue_created, e.meta, c.engage_queued_at
        from public.applicants a
        join public.pool_interest_engage_intents i on i.action_key = $2
        join public.pool_events e on e.action_key = $2
        join public.job_candidates c on c.applicant_id = a.id and c.job_id = 32
        where a.id = $1
      `, [id, key]);
      assert.deepEqual(state.rows[0], {
        current_job_id: "31", conversation_focus_job_id: "31", availability: "즉시가능",
        intent: "off", queue_created: false, meta: { interest_only: true, immediate: true }, engage_queued_at: null,
      });
      const ordinaryKey = randomUUID();
      assert.equal(await outcome("public.record_pool_interest_with_engage_intent(32, $1, false, $2, 'off')", [id, ordinaryKey]), "recorded");
      await assert.rejects(saveInterest(id, 32, ordinaryKey), { code: "23505" });
      await assert.rejects(selectFocus(id, 32, ordinaryKey), { code: "23505" });
    });

    await t.test("an intent failure rolls back candidate creation, interest and focus together", async () => {
      const id = await applicant();
      const key = randomUUID();
      await client.query(`
        create function public.reject_focus_audit_intent() returns trigger language plpgsql as $$
        begin raise exception 'audit rejection'; end; $$;
        create trigger reject_focus_audit_intent before insert on public.pool_interest_engage_intents
        for each row execute function public.reject_focus_audit_intent();
      `);
      try {
        await assert.rejects(selectFocus(id, 32, key), /audit rejection/);
      } finally {
        await client.query("drop trigger reject_focus_audit_intent on public.pool_interest_engage_intents");
      }
      const state = await client.query(`
        select current_job_id, conversation_focus_job_id,
          (select count(*)::int from public.pool_events where action_key = $2) as events,
          (select count(*)::int from public.pool_interest_engage_intents where action_key = $2) as intents,
          (select count(*)::int from public.job_candidates where applicant_id = $1 and job_id = 32) as candidates
        from public.applicants where id = $1
      `, [id, key]);
      assert.deepEqual(state.rows[0], { current_job_id: "31", conversation_focus_job_id: null, events: 0, intents: 0, candidates: 0 });
    });

    await t.test("confirmed, excluded, opted-out and invalid jobs cannot change focus", async () => {
      for (const status of ["확정인력", "인력풀 제외", "부적합", "이탈"]) {
        const id = await applicant();
        await client.query("update public.applicants set status = $2 where id = $1", [id, status]);
        assert.equal(await selectFocus(id, 32), "unavailable", status);
      }
      const optedOut = await applicant();
      await client.query("update public.applicants set sms_opt_out_at = now() where id = $1", [optedOut]);
      assert.equal(await selectFocus(optedOut, 32), "unavailable");
      const excluded = await applicant();
      await client.query("insert into public.job_exposure_targets values (32, $1, 'exclude', 'manager')", [excluded]);
      assert.equal(await selectFocus(excluded, 32), "unavailable");
      assert.equal(await selectFocus(99999, 32), "unavailable");
      const id = await applicant();
      assert.equal(await selectFocus(id, 99999), "unavailable");
      for (const change of ["status = 'closed'", "title = '__system'", "recruit_mode = 'external'", "closes_at = now() - interval '1 second'"]) {
        await client.query(`update public.jobs set ${change} where id = 32`);
        assert.equal(await selectFocus(id, 32), "unavailable", change);
        await client.query("update public.jobs set status = 'active', title = '둘째 공고', recruit_mode = 'internal', closes_at = null where id = 32");
      }
      const state = await client.query("select current_job_id, conversation_focus_job_id from public.applicants where id = $1", [id]);
      assert.deepEqual(state.rows[0], { current_job_id: "31", conversation_focus_job_id: null });
    });

    await t.test("paused, aborted and closed target candidates are preserved", async () => {
      for (const [stage, reason] of [["paused", null], ["abort", "manager: 보류"], [null, "종료"]]) {
        const id = await applicant();
        await client.query("insert into public.job_candidates (job_id, applicant_id, agent_stage, closed_reason) values (32, $1, $2, $3)", [id, stage, reason]);
        assert.equal(await selectFocus(id, 32), "unchanged_closed");
        const state = await client.query("select agent_stage, closed_reason from public.job_candidates where applicant_id = $1 and job_id = 32", [id]);
        assert.deepEqual(state.rows[0], { agent_stage: stage, closed_reason: reason });
      }
    });

    await t.test("resuming an automatic stage selects focus with off intent and keeps candidate state", async () => {
      for (const stage of ["exploration", "screening", "onboarding", "active"]) {
        const id = await applicant();
        const key = randomUUID();
        await client.query("insert into public.job_candidates (job_id, applicant_id, agent_stage) values (32, $1, $2)", [id, stage]);
        assert.equal(await selectFocus(id, 32, key, "auto_queue"), "recorded");
        const state = await client.query(`
          select i.intent, i.queue_created, c.agent_stage, c.engage_queued_at
          from public.pool_interest_engage_intents i
          join public.job_candidates c on c.applicant_id = i.applicant_id and c.job_id = i.job_id
          where i.action_key = $1
        `, [key]);
        assert.deepEqual(state.rows[0], { intent: "off", queue_created: false, agent_stage: stage, engage_queued_at: null });
      }
    });

    await t.test("every unresolved provider status and live reply claim blocks focus atomically", async () => {
      for (const status of ["sending", "unknown", "sent"]) {
        const id = await applicant();
        await outbox(id, status);
        assert.equal(await selectFocus(id, 32), "busy", status);
        assert.equal(await claimReply(id, 31), "busy", status);
        const state = await client.query("select conversation_focus_job_id from public.applicants where id = $1", [id]);
        assert.equal(state.rows[0]?.conversation_focus_job_id, null);
      }
      const id = await applicant();
      assert.equal(await claimReply(id, 31), "claimed");
      assert.equal(await selectFocus(id, 32), "busy");
      // Explicit interest still works while an old conversation is being answered.
      assert.equal(await saveInterest(id, 32), "recorded");
      const orphan = await applicant();
      await client.query("update public.applicants set pool_engage_action_key = $2 where id = $1", [orphan, randomUUID()]);
      assert.equal(await selectFocus(orphan, 32), "busy");
    });

    await t.test("legacy engage claims respect explicit focus and in-flight replies even with a cleared current job", async () => {
      const id = await applicant();
      const engageKey = randomUUID();
      const engageClaim = () => outcome(
        "public.claim_pool_engage(32, $1, $2, '01000000000', '테스트', 'screening', 'audit')",
        [id, engageKey],
      );
      await client.query("insert into public.job_candidates (job_id, applicant_id) values (32, $1)", [id]);
      await client.query("update public.applicants set current_job_id = null, conversation_focus_job_id = 31 where id = $1", [id]);
      assert.equal(await engageClaim(), "job_conflict");
      assert.equal(await selectFocus(id, 32, engageKey), "recorded");
      const replyKey = randomUUID();
      assert.equal(await claimReply(id, 32, replyKey), "claimed");
      assert.equal(await engageClaim(), "already_claimed");
      assert.equal(await releaseReply(id, replyKey), "released");
      assert.equal(await engageClaim(), "claimed");
    });

    await t.test("B to C to B never replays old focus or legacy interest into a newer off choice", async () => {
      const id = await applicant();
      const legacyKey = randomUUID();
      const firstKey = randomUUID();
      const lastKey = randomUUID();
      assert.equal(await outcome("public.record_pool_interest_with_engage_intent(32, $1, false, $2, 'auto_now')", [id, legacyKey]), "recorded");
      assert.equal(await selectFocus(id, 32, firstKey), "recorded");
      assert.equal(await selectFocus(id, 33, randomUUID(), "off"), "recorded");
      assert.equal(await outcome("public.defer_pool_interest_engage_intent($1, $2, 32)", [firstKey, id]), "not_queued");
      assert.equal(await selectFocus(id, 32, lastKey, "off"), "recorded");
      for (const oldKey of [firstKey, legacyKey, lastKey]) {
        assert.equal(await outcome("public.claim_pool_engage(32, $1, $2, '01000000000', '테스트', 'screening', 'interest_click')", [id, oldKey]), "job_conflict");
      }
      for (const oldKey of [firstKey, legacyKey]) {
        assert.equal(await outcome("public.defer_pool_interest_engage_intent($1, $2, 32)", [oldKey, id]), "not_queued");
      }
      assert.equal(await selectFocus(id, 32, firstKey), "deduped");
      const state = await client.query(`
        select a.conversation_focus_action_key, c.engage_queued_at,
          (select count(*)::int from public.pool_engage_send_requests where applicant_id = $1) as sends
        from public.applicants a join public.job_candidates c on c.applicant_id = a.id and c.job_id = 32
        where a.id = $1
      `, [id]);
      assert.deepEqual(state.rows[0], { conversation_focus_action_key: lastKey, engage_queued_at: null, sends: 0 });
    });

    await t.test("a new off or draft selection cancels an existing queue for the same target", async () => {
      for (const intent of ["off", "draft"]) {
        const id = await applicant();
        assert.equal(await selectFocus(id, 32, randomUUID(), "auto_queue"), "recorded");
        assert.equal(await selectFocus(id, 32, randomUUID(), intent), "recorded");
        const state = await client.query("select engage_queued_at from public.job_candidates where applicant_id = $1 and job_id = 32", [id]);
        assert.equal(state.rows[0]?.engage_queued_at, null);
      }
    });

    await t.test("queued cron uses a focus generation with fresh retry keys, and rejects stale or cancelled queues", async () => {
      const id = await applicant();
      const firstFocus = randomUUID();
      const finalFocus = randomUUID();
      const cronClaim = (key: string, focusKey: string) => outcome(
        "public.claim_pool_engage(32, $1, $2, '01000000000', '테스트', 'screening', 'engage_queued_cron', $3)",
        [id, key, focusKey],
      );
      assert.equal(await selectFocus(id, 32, firstFocus, "auto_queue"), "recorded");
      for (const key of [randomUUID(), randomUUID()]) {
        assert.equal(await cronClaim(key, firstFocus), "claimed");
        assert.equal(await outcome("public.record_pool_engage_provider_result($1, 'failed', null, 'audit declared failure')", [key]), "recorded");
      }
      assert.equal(await selectFocus(id, 33, randomUUID(), "off"), "recorded");
      assert.equal(await selectFocus(id, 32, finalFocus, "auto_queue"), "recorded");
      assert.equal(await cronClaim(randomUUID(), firstFocus), "job_conflict");
      await client.query("update public.job_candidates set engage_queued_at = null where applicant_id = $1 and job_id = 32", [id]);
      assert.equal(await cronClaim(randomUUID(), finalFocus), "unavailable");
      await client.query("update public.job_candidates set engage_queued_at = now() where applicant_id = $1 and job_id = 32", [id]);
      assert.equal(await cronClaim(randomUUID(), finalFocus), "claimed");
    });

    await t.test("queue cleanup cannot clear a newer same-job choice or another explicit focus", async () => {
      const id = await applicant();
      const oldKey = randomUUID();
      const newKey = randomUUID();
      assert.equal(await selectFocus(id, 32, oldKey, "auto_queue"), "recorded");
      const candidate = await client.query("select id from public.job_candidates where applicant_id = $1 and job_id = 32", [id]);
      const candidateId = candidate.rows[0].id;
      const clear = (key: string | null) => outcome("public.clear_pool_engage_queue($1, $2)", [candidateId, key]);
      assert.equal(await selectFocus(id, 32, newKey, "auto_queue"), "recorded");
      for (const staleKey of [null, oldKey]) assert.equal(await clear(staleKey), "superseded");
      assert.ok((await client.query("select engage_queued_at from public.job_candidates where id = $1", [candidateId])).rows[0]?.engage_queued_at instanceof Date);
      assert.equal(await clear(newKey), "cleared");
      assert.equal((await client.query("select engage_queued_at from public.job_candidates where id = $1", [candidateId])).rows[0]?.engage_queued_at, null);
      const otherKey = randomUUID();
      assert.equal(await selectFocus(id, 33, otherKey, "auto_queue"), "recorded");
      assert.equal(await clear(otherKey), "superseded");
      const legacy = await applicant();
      const legacyCandidate = await client.query("select id from public.job_candidates where applicant_id = $1", [legacy]);
      assert.equal(await outcome("public.clear_pool_engage_queue($1)", [legacyCandidate.rows[0].id]), "cleared");
    });

    await t.test("reply claims never replay or expire into a duplicate runner and only their owner releases", async () => {
      const id = await applicant();
      const key = randomUUID();
      await client.query("update public.applicants set conversation_focus_job_id = 31 where id = $1", [id]);
      assert.equal(await claimReply(id, 32, key), "job_conflict");
      assert.equal(await claimReply(id, 31, key), "claimed");
      await client.query("update public.applicants set agent_reply_claimed_at = now() - interval '1 day' where id = $1", [id]);
      assert.equal(await claimReply(id, 31, key), "busy");
      assert.equal(await claimReply(id, 31), "busy");
      assert.equal(await releaseReply(id, randomUUID()), "not_owner");
      assert.equal(await claimReply(id, 31), "busy");
      assert.equal(await releaseReply(id, key), "released");
      const state = await client.query("select agent_reply_claim_key, agent_reply_claimed_at from public.applicants where id = $1", [id]);
      assert.deepEqual(state.rows[0], { agent_reply_claim_key: null, agent_reply_claimed_at: null });
      assert.equal(await claimReply(id, 31), "claimed");
    });

    await t.test("busy inbound messages retain their own retry marker until their matching owner releases", async () => {
      const id = await applicant();
      const otherId = await applicant();
      const oldKey = randomUUID();
      const rows = await client.query(`
        insert into public.messages (applicant_id, direction, body)
        values ($1, 'inbound', '첫 답변'), ($1, 'inbound', '다음 답변'),
          ($1, 'outbound', '발신'), ($2, 'inbound', '다른 지원자') returning id
      `, [id, otherId]);
      const [oldId, nextId, outboundId, foreignId] = rows.rows.map((row: { id: string }) => row.id);
      const claim = (key: string, messageId: string) => outcome(
        "public.claim_pool_agent_reply($1, 31, $2, now(), $3)", [id, key, messageId],
      );
      const release = (key: string, messageId: string) => outcome(
        "public.release_pool_agent_reply($1, $2, $3)", [id, key, messageId],
      );
      assert.equal(await claim(oldKey, oldId), "claimed");
      for (const messageId of [oldId, nextId, outboundId, foreignId]) {
        assert.equal(await claim(randomUUID(), messageId), "busy");
      }
      assert.equal(await release(randomUUID(), nextId), "not_owner");
      const pending = await client.query("select id from public.messages where agent_reply_deferred_at is not null order by id");
      assert.deepEqual(pending.rows.map((row: { id: string }) => row.id), [oldId, nextId]);
      assert.equal(await release(oldKey, oldId), "released");
      const retained = await client.query("select id from public.messages where agent_reply_deferred_at is not null order by id");
      assert.deepEqual(retained.rows.map((row: { id: string }) => row.id), [nextId]);
      const nextKey = randomUUID();
      assert.equal(await claim(nextKey, nextId), "claimed");
      assert.equal(await release(nextKey, nextId), "released");
      assert.equal((await client.query("select count(*)::int as n from public.messages where agent_reply_deferred_at is not null")).rows[0]?.n, 0);
    });

    await t.test("unresolved initial sends also retain an inbound recovery marker", async () => {
      const id = await applicant();
      await outbox(id, "unknown");
      const message = await client.query("insert into public.messages (applicant_id, direction) values ($1, 'inbound') returning id", [id]);
      const messageId = message.rows[0].id;
      assert.equal(await outcome("public.claim_pool_agent_reply($1, 31, $2, now(), $3)", [id, randomUUID(), messageId]), "busy");
      assert.ok((await client.query("select agent_reply_deferred_at from public.messages where id = $1", [messageId])).rows[0]?.agent_reply_deferred_at instanceof Date);
    });

    await t.test("messages received before a switch cannot claim the new focus, including a later return to the same job", async () => {
      const id = await applicant();
      const originalReceivedAt = new Date("2026-01-01T00:00:00.000Z");
      const key = randomUUID();
      assert.equal(await selectFocus(id, 32, key, "off"), "recorded");
      const first = await client.query("select conversation_focus_at from public.applicants where id = $1", [id]);
      assert.ok(first.rows[0]?.conversation_focus_at instanceof Date);
      assert.equal(await claimReply(id, 32, randomUUID(), originalReceivedAt), "job_conflict");
      assert.equal(await claimReply(id, 32, randomUUID(), null), "job_conflict");
      assert.equal(await selectFocus(id, 33, randomUUID(), "off"), "recorded");
      assert.equal(await selectFocus(id, 32, randomUUID(), "off"), "recorded");
      assert.equal(await claimReply(id, 32, randomUUID(), first.rows[0].conversation_focus_at), "job_conflict");
      const beforeReplay = await client.query("select conversation_focus_at from public.applicants where id = $1", [id]);
      assert.equal(await selectFocus(id, 32, key, "off"), "deduped");
      const afterReplay = await client.query("select conversation_focus_at from public.applicants where id = $1", [id]);
      assert.deepEqual(afterReplay.rows, beforeReplay.rows);
      assert.equal(await claimReply(id, 32), "claimed");
    });

    await t.test("reply claims allow confirmed workers but reject missing, opted-out and excluded applicants", async () => {
      const confirmed = await applicant();
      await client.query("update public.applicants set status = '확정인력' where id = $1", [confirmed]);
      assert.equal(await claimReply(confirmed, 31), "claimed");
      for (const change of ["status = '인력풀 제외'", "status = '부적합'", "status = '이탈'", "sms_opt_out_at = now()"]) {
        const id = await applicant();
        await client.query(`update public.applicants set ${change} where id = $1`, [id]);
        assert.equal(await claimReply(id, 31), "unavailable");
      }
      assert.equal(await claimReply(99999, 31), "unavailable");
    });

    await t.test("concurrent runners serialize on the applicant row", async () => {
      const id = await applicant();
      const result = await Promise.all([
        claimReply(id, 31),
        competitor.query("select public.claim_pool_agent_reply($1, 31, $2) as outcome", [id, randomUUID()]),
      ]);
      assert.deepEqual([result[0], result[1].rows[0]?.outcome].sort(), ["busy", "claimed"]);
      const next = await applicant();
      await client.query("begin");
      try {
        assert.equal(await claimReply(next, 31), "claimed");
        const pending = competitor.query("select public.select_pool_conversation_focus(32, $1, $2, 'auto_now') as outcome", [next, randomUUID()]);
        await client.query("commit");
        assert.equal((await pending).rows[0]?.outcome, "busy");
      } finally {
        await client.query("rollback");
      }
    });

    await t.test("RPC execution is limited to service_role", async () => {
      const signatures = [
        "select_pool_conversation_focus(bigint,bigint,uuid,text)",
        "record_pool_interest_only(bigint,bigint,boolean,uuid)",
        "claim_pool_agent_reply(bigint,bigint,uuid,timestamp with time zone,text)",
        "release_pool_agent_reply(bigint,uuid,text)",
        "claim_pool_engage(bigint,bigint,uuid,text,text,text,text,uuid)",
        "defer_pool_interest_engage_intent(uuid,bigint,bigint)",
        "clear_pool_engage_queue(bigint,uuid)",
      ];
      for (const signature of signatures) {
        const result = await client.query(`
          select has_function_privilege('anon', $1, 'execute') as anon,
            has_function_privilege('authenticated', $1, 'execute') as authenticated,
            has_function_privilege('service_role', $1, 'execute') as service
        `, [`public.${signature}`]);
        assert.deepEqual(result.rows[0], { anon: false, authenticated: false, service: true });
      }
      const id = await applicant();
      await client.query("set role anon");
      try {
        await assert.rejects(selectFocus(id, 32), { code: "42501" });
      } finally {
        await client.query("reset role");
      }
      await client.query("set role service_role");
      try {
        assert.equal(await selectFocus(id, 32), "recorded");
      } finally {
        await client.query("reset role");
      }
    });
  } finally {
    await competitor.end();
    await client.end();
  }
});
