import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const auditDatabaseUrl = process.env.ONG_STAFFING_DEMAND_AUDIT_DATABASE_URL;

test("daily demand migration enforces append-only access and concurrent revisions in disposable Postgres", {
  skip: !auditDatabaseUrl,
}, async (t) => {
  const url = new URL(auditDatabaseUrl!);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "audit database must be local");
  assert.match(url.pathname, /^\/ong_staffing_demand_audit(?:_[a-z0-9]+)?$/, "audit database name is required");
  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString: auditDatabaseUrl });
  const competitor = new pg.default.Client({ connectionString: auditDatabaseUrl });
  await client.connect();
  try {
    const guard = await client.query(`
      select current_setting('ongboarding.migration_audit', true) as marker,
        current_setting('data_directory') as directory, current_database() as database,
        (select count(*)::int from pg_tables where schemaname = 'public') as tables
    `);
    assert.equal(guard.rows[0].marker, "enabled", "refusing to run outside a disposable audit database");
    assert.match(guard.rows[0].directory, /^\/(?:private\/)?tmp\/ong-staffing-demand-audit-[^/]+\/data$/,
      "a newly created dedicated temporary cluster is required");
    assert.equal(guard.rows[0].database, url.pathname.slice(1));
    assert.equal(guard.rows[0].tables, 0, "audit database must have an empty public schema");
    await competitor.connect();
    await client.query("set statement_timeout = '10s'");
    await competitor.query("set statement_timeout = '10s'");
    await client.query(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create table public.jobs (id bigint primary key);
      insert into public.jobs values (11), (12);
    `);
    const migration = await readFile(new URL("../../docs/migrations/2026-09-job-staffing-demand.sql", import.meta.url), "utf8");
    await client.query(migration);
    await client.query(migration);
    const actor = { account_id: "audit-account", name: "가상매니저" };
    const insertSql = `insert into public.job_staffing_demand_events
      (job_id, work_date, state, required_count, base_event_id, request_key, actor)
      values ($1, $2, $3, $4, $5, $6, $7) returning id, state, required_count`;
    const insert = (date: string, state: string, count: number | null, base: string | null = null, key = randomUUID(), job = 11) =>
      client.query(insertSql, [job, date, state, count, base, key, actor]);

    await t.test("applies twice and accepts only the documented state/count combinations", async () => {
      for (const [date, state, count] of [
        ["2099-09-01", "unknown", null], ["2099-09-02", "off", 0],
        ["2099-09-03", "operating", 1], ["2099-09-04", "operating", 999],
      ] as const) {
        const result = await insert(date, state, count);
        assert.equal(result.rows[0].state, state);
        assert.equal(result.rows[0].required_count, count);
      }
      for (const [state, count] of [
        ["unknown", 0], ["off", null], ["off", 1], ["off", -1],
        ["operating", null], ["operating", 0], ["operating", -1], ["operating", 1000], ["invalid", null],
      ] as const) {
        await assert.rejects(insert("2099-09-05", state, count), { code: "23514", constraint: "job_staffing_demand_state_count_check" });
      }
    });

    await t.test("browser roles cannot read or insert, and RLS still blocks them with temporary table grants", async () => {
      for (const role of ["anon", "authenticated"]) {
        await client.query(`set role ${role}`);
        try {
          await assert.rejects(client.query("select * from public.job_staffing_demand_events"), { code: "42501" });
          await assert.rejects(insert("2099-09-06", "operating", 1), { code: "42501" });
        } finally { await client.query("reset role"); }
      }
      await client.query(`
        grant select, insert on public.job_staffing_demand_events to anon, authenticated;
        grant usage on sequence public.job_staffing_demand_events_id_seq to anon, authenticated;
      `);
      try {
        for (const role of ["anon", "authenticated"]) {
          await client.query(`set role ${role}`);
          try {
            assert.equal((await client.query("select * from public.job_staffing_demand_events")).rowCount, 0);
            await assert.rejects(insert("2099-09-06", "operating", 1), { code: "42501" });
          } finally { await client.query("reset role"); }
        }
      } finally { await client.query(migration); }
    });

    await t.test("service role can append/read but cannot update or delete a demand event", async () => {
      await client.query("set role service_role");
      try {
        const result = await insert("2099-09-07", "operating", 2);
        const id = result.rows[0].id;
        assert.equal((await client.query("select required_count from public.job_staffing_demand_events where id = $1", [id])).rows[0].required_count, 2);
        await assert.rejects(client.query("update public.job_staffing_demand_events set required_count = 3 where id = $1", [id]), { code: "42501" });
        await assert.rejects(client.query("delete from public.job_staffing_demand_events where id = $1", [id]), { code: "42501" });
        assert.equal((await client.query("select required_count from public.job_staffing_demand_events where id = $1", [id])).rows[0].required_count, 2);
      } finally { await client.query("reset role"); }
    });

    await t.test("two simultaneous writers get one revision and one unique violation for both null and existing bases", async () => {
      const initial = await insert("2099-09-20", "unknown", null);
      await client.query("set role service_role");
      await competitor.query("set role service_role");
      try {
        for (const [date, base] of [["2099-09-20", initial.rows[0].id], ["2099-09-21", null]] as const) {
          const results = await Promise.allSettled([
            insert(date, "operating", 2, base),
            competitor.query(insertSql, [11, date, "operating", 3, base, randomUUID(), actor]),
          ]);
          assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
          const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
          assert.equal(failure.reason.code, "23505");
          assert.equal(failure.reason.constraint, "job_staffing_demand_one_successor_uidx");
          assert.equal((await client.query(`select count(*)::int as n from public.job_staffing_demand_events
            where job_id = 11 and work_date = $1 and base_event_id is not distinct from $2::bigint`, [date, base])).rows[0].n, 1);
        }
      } finally {
        await client.query("reset role");
        await competitor.query("reset role");
      }
    });

    await t.test("request keys are globally unique while separate dates and jobs retain independent demand", async () => {
      const key = randomUUID();
      const base = (await insert("2099-09-22", "operating", 2, null, key)).rows[0].id;
      await assert.rejects(insert("2099-09-23", "off", 0, null, key), { code: "23505", constraint: "job_staffing_demand_events_request_key_key" });
      await insert("2099-09-23", "off", 0);
      await insert("2099-09-22", "operating", 4, null, randomUUID(), 12);
      await assert.rejects(insert("2099-09-24", "operating", 3, base), { code: "23503", constraint: "job_staffing_demand_base_scope_fk" });
      await assert.rejects(insert("2099-09-22", "operating", 3, base, randomUUID(), 12), { code: "23503", constraint: "job_staffing_demand_base_scope_fk" });
      const rows = await client.query(`select job_id::int, work_date::text, state, required_count
        from public.job_staffing_demand_events where work_date between '2099-09-22' and '2099-09-24'
        order by job_id, work_date`);
      assert.deepEqual(rows.rows, [
        { job_id: 11, work_date: "2099-09-22", state: "operating", required_count: 2 },
        { job_id: 11, work_date: "2099-09-23", state: "off", required_count: 0 },
        { job_id: 12, work_date: "2099-09-22", state: "operating", required_count: 4 },
      ]);
    });
  } finally {
    await competitor.end();
    await client.end();
  }
});
