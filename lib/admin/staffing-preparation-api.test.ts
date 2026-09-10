import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as crypto from "node:crypto";
import { isGeneralLineJob, joinedClientType } from "../agent/general-line.ts";
import * as preparationPolicy from "./staffing-preparation.ts";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";
import { isJobEffectivelyClosed } from "../jobs.ts";

type Row = Record<string, unknown>;
type Response = { status: number; body: Record<string, unknown> };
const KEY = "11111111-1111-4111-8111-111111111111";
const preparation = { source: "manager", dates: [{ date: "2026-09-15", availability: "available", role: "reserve_candidate" }], training_availability: "유급 교육 가능", note: "후보 검토" };
const context = (id = "7") => ({ params: Promise.resolve({ id }) });
const request = (patch: Row = {}) => ({ cookies: { getAll: () => [] }, json: async () => ({ applicant_id: 1, action_key: KEY, base_event_id: null, actor_name: "김운영", ...preparation, ...patch }) });
function event(id: number, meta: unknown = preparation, patch: Row = {}): Row {
  return { id, applicant_id: 1, job_id: 7, event_type: "staffing_preparation", meta, created_at: "2026-09-09T00:00:00.000Z", ...patch };
}

test("confirmed dates require a current editor and old editors cannot remove or clear them", async () => {
  const confirmed = { ...preparation, dates: [{ date: "2026-09-15", availability: "available", role: "primary_candidate", confirmation: "confirmed" }] };
  const h = harness();
  assert.equal((await h.route.POST(request(confirmed), context())).status, 409);
  assert.equal(h.writes.length, 0);
  const saved = await h.route.POST(request({ ...confirmed, confirmation_version: 1 }), context());
  assert.equal(saved.status, 200);
  assert.equal((saved.body.preparation as typeof confirmed).dates[0].confirmation, "confirmed");
  const retry = await h.route.POST(request({ ...confirmed, confirmation_version: 1 }), context());
  assert.equal(retry.status, 200);
  assert.equal(h.writes.length, 1);
  for (const dates of [[], preparation.dates]) {
    const oldEditor = await h.route.POST(request({ dates, base_event_id: saved.body.event_id, action_key: crypto.randomUUID() }), context());
    assert.equal(oldEditor.status, 409);
  }
  const cleared = await h.route.POST(request({ confirmation_version: 1, dates: [{ ...confirmed.dates[0], confirmation: "unconfirmed" }],
    base_event_id: saved.body.event_id, action_key: crypto.randomUUID() }), context());
  assert.equal(cleared.status, 200);
  assert.equal(h.writes.length, 2);
  assert.ok(h.writes.every((write) => write.table === "pool_events"));
});

function harness(input: { authenticated?: boolean; events?: Row[]; candidates?: Row[]; jobs?: Row[]; messages?: Row[]; fail?: (table: string, write: boolean, from?: number) => boolean } = {}) {
  const database: Record<string, Row[]> = { jobs: input.jobs ?? [{ id: 7, title: "일반 A", status: "active", closes_at: null, start_date: "2027-04-20", work_period: "단기", client: null }], messages: input.messages ?? [], pool_events: input.events ?? [], job_candidates: input.candidates ?? [{ id: 11, job_id: 7, applicant_id: 1 }, { id: 12, job_id: 7, applicant_id: 2 }] };
  const writes: Array<{ table: string; row: Row }> = [];
  class Query {
    private table: string;
    private filters: Array<(row: Row) => boolean> = [];
    private orders: Array<[string, boolean]> = [];
    private insertRow: Row | null = null;
    constructor(table: string) { this.table = table; }
    select() { return this; }
    eq(key: string, value: unknown) { this.filters.push((row) => (key.startsWith("meta->>") ? (row.meta as Row)?.[key.slice(7)] : row[key]) === value); return this; }
    in(key: string, values: unknown[]) { this.filters.push((row) => values.includes(row[key])); return this; }
    order(key: string, options: { ascending: boolean }) { this.orders.push([key, options.ascending]); return this; }
    insert(row: Row) { this.insertRow = row; return this; }
    private result(from?: number, to?: number) {
      if (input.fail?.(this.table, !!this.insertRow, from)) return { data: null, error: { code: "XX000", message: "unavailable" } };
      if (this.insertRow) {
        if (database[this.table].some((row) => row.action_key === this.insertRow!.action_key)) return { data: null, error: { code: "23505", message: "duplicate action key" } };
        const row = { id: Math.max(0, ...database[this.table].map((item) => Number(item.id))) + 1, created_at: "2026-09-10T00:00:00.000Z", ...this.insertRow };
        database[this.table].push(row);
        writes.push({ table: this.table, row });
        return { data: [row], error: null };
      }
      const rows = database[this.table].filter((row) => this.filters.every((filter) => filter(row))).sort((a, b) => {
        for (const [key, ascending] of this.orders) {
          if (a[key] !== b[key]) return (a[key]! < b[key]! ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
      return { data: rows.slice(from ?? 0, to === undefined ? 1000 : to + 1), error: null };
    }
    async range(from: number, to: number) { return this.result(from, to); }
    async single() { const result = this.result(); return { ...result, data: result.data?.[0] ?? null }; }
    async maybeSingle() { return this.single(); }
  }
  const exports: Record<string, (req: unknown, context: unknown) => Promise<Response>> = {};
  const modules: Record<string, unknown> = {
    "node:crypto": crypto,
    "@supabase/ssr": { createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: input.authenticated === false ? null : { id: "verified-account", email: "manager@example.test" } }, error: null }) } }) },
    "next/server": { NextResponse: { json: (body: unknown, init?: { status: number }) => ({ body, status: init?.status ?? 200 }) } },
    "@/lib/supabase": { createServiceClient: () => ({ from: (table: string) => new Query(table) }) },
    "@/lib/admin/staffing-preparation": preparationPolicy,
    "@/lib/agent/general-line": { isGeneralLineJob, joinedClientType },
    "@/lib/admin/postgrest-pagination": { fetchAllPostgrestRows },
    "@/lib/jobs": { isJobEffectivelyClosed },
  };
  const routePath = new URL("../../app/api/admin/jobs/[id]/staffing-preparation/route.ts", import.meta.url);
  runInNewContext(ts.transpileModule(readFileSync(routePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (name: string) => modules[name] ?? {}, console: { error() {} }, Date, Map, Set, process: { env: { NEXT_PUBLIC_SUPABASE_URL: "http://auth.example.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture" } } });
  return { route: exports, database, writes };
}

const confirmedDate = { date: "2026-09-15", availability: "available", role: "primary_candidate", confirmation: "confirmed" };
const unavailableConfirmationScopes = [
  { candidates: [{ id: 11, applicant_id: 1, job_id: 7, agent_stage: "abort" }] },
  { jobs: [{ id: 7, status: "closed", closes_at: null }] },
  { jobs: [{ id: 7, status: "active", closes_at: "2020-01-01T00:00:00.000Z" }] },
];

test("new confirmed dates reject aborted candidates and closed jobs, while failed job reads remain errors", async () => {
  for (const scope of unavailableConfirmationScopes) {
    const h = harness(scope);
    assert.equal((await h.route.POST(request({ dates: [confirmedDate], confirmation_version: 1 }), context())).status, 409);
    assert.equal(h.writes.length, 0);
  }
  const unavailable = harness({ fail: (table) => table === "jobs" });
  assert.equal((await unavailable.route.POST(request({ dates: [confirmedDate], confirmation_version: 1 }), context())).status, 503);
  assert.equal(unavailable.writes.length, 0);
});

test("closed or aborted scopes can maintain and cancel prior confirmation without permitting a new date", async () => {
  for (const scope of unavailableConfirmationScopes) {
    const h = harness({ ...scope, events: [event(1, { ...preparation, dates: [confirmedDate] })] });
    const added = await h.route.POST(request({ dates: [confirmedDate, { ...confirmedDate, date: "2026-09-16" }],
      base_event_id: 1, confirmation_version: 1 }), context());
    assert.equal(added.status, 409);
    const maintained = await h.route.POST(request({ dates: [confirmedDate], note: "마감 후 메모 정정", base_event_id: 1,
      confirmation_version: 1, action_key: crypto.randomUUID() }), context());
    assert.equal(maintained.status, 200);
    const cancelled = await h.route.POST(request({ dates: [{ ...confirmedDate, confirmation: "unconfirmed" }],
      base_event_id: maintained.body.event_id, confirmation_version: 1, action_key: crypto.randomUUID() }), context());
    assert.equal(cancelled.status, 200);
    assert.equal(h.writes.length, 2);
  }
});

test("GET returns only linked candidates and the latest timestamp/id, with empty snapshots included", async () => {
  const h = harness({ events: [event(1, { ...preparation, note: "old" }), event(2, { ...preparation, note: "latest" }),
    event(3, preparation, { job_id: 8 }), event(4, preparation, { applicant_id: 999 })] });
  const response = await h.route.GET({}, context());
  assert.equal(response.status, 200);
  const rows = response.body.preparations as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.equal((rows[0].preparation as Row).note, "latest");
  assert.equal(rows[0].event_id, 2);
  assert.equal(rows[1].applicant_id, 2);
  assert.equal(rows[1].preparation, null);
  assert.equal(rows[1].invalid, false);
});

test("GET never falls back to an older valid preparation when the latest is malformed", async () => {
  const h = harness({ events: [event(1), event(2, { ...preparation, dates: [{ date: "2026-02-30" }] })] });
  const response = await h.route.GET({}, context());
  const row = (response.body.preparations as Row[])[0];
  assert.equal(row.preparation, null);
  assert.equal(row.event_id, 2);
  assert.equal(row.invalid, true);
});

test("POST appends only manager review metadata and never changes candidate or applicant state", async () => {
  const h = harness();
  const response = await h.route.POST(request({ source: "applicant", status: "확정인력", agent_stage: "active" }), context());
  assert.equal(response.status, 200);
  assert.equal(response.body.deduplicated, false);
  assert.deepEqual(h.writes.map((write) => write.table), ["pool_events"]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.writes[0].row.meta)), { ...preparation,
    training: { status: "reviewing", backup_intent: "unknown", scheduled_at: "", first_loading_location: "", linked_pro: "" },
    records: [],
    actor: { account_id: "verified-account", name: "김운영" }, request_key: KEY, base_event_id: null });
  assert.equal(h.writes[0].row.job_id, 7);
  assert.equal(h.writes[0].row.applicant_id, 1);
  assert.equal(h.database.job_candidates[0].agent_stage, undefined);
});

test("concurrent retries with one action key save once and accept semantically identical field ordering", async () => {
  const h = harness();
  const reordered = { note: " 후보 검토 ", training_availability: "유급 교육 가능", dates: [{ role: "reserve_candidate", availability: "available", date: "2026-09-15" }] };
  const responses = await Promise.all([h.route.POST(request(), context()), h.route.POST(request(reordered), context())]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.deepEqual(responses.map((response) => response.body.deduplicated).sort(), [false, true]);
  assert.equal(h.writes.length, 1);
  assert.equal(responses[0].body.event_id, responses[1].body.event_id);
});

test("a reused action key with different content or scope returns conflict without overwriting", async () => {
  const h = harness();
  await h.route.POST(request(), context());
  for (const patch of [{ note: "다른 내용" }, { applicant_id: 2 }]) assert.equal((await h.route.POST(request(patch), context())).status, 409);
  assert.equal(h.writes.length, 1);
});

test("retry accepts the same actor after JSONB changes its key order", async () => {
  const h = harness();
  assert.equal((await h.route.POST(request(), context())).status, 200);
  const meta = h.database.pool_events[0].meta as Row;
  meta.actor = { name: "김운영", account_id: "verified-account" };
  const retry = await h.route.POST(request(), context());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.deduplicated, true);
  assert.equal(h.writes.length, 1);
});

test("different action keys preserve history and a valid explicit reset can replace a malformed latest row", async () => {
  const h = harness({ events: [event(1, { broken: true })] });
  const response = await h.route.POST(request({ base_event_id: 1, dates: [], training_availability: "", note: "" }), context());
  assert.equal(response.status, 200);
  assert.equal(h.database.pool_events.length, 2);
  assert.equal((response.body.preparation as Row).note, "");
  assert.equal(response.body.invalid, false);
});

test("POST rejects unlinked candidates and malformed IDs, action keys or date roles without writes", async () => {
  const h = harness();
  assert.equal((await h.route.POST(request({ applicant_id: 999 }), context())).status, 404);
  for (const patch of [{ action_key: "bad" }, { applicant_id: 0 }, { dates: [{ date: "2026-09-15", availability: "unknown", role: "primary_candidate" }] }]) {
    assert.equal((await h.route.POST(request(patch), context())).status, 400);
  }
  assert.equal((await h.route.GET({}, context("-1"))).status, 400);
  assert.equal(h.writes.length, 0);
});

test("candidate, history and write failures remain errors instead of empty or successful data", async () => {
  for (const table of ["job_candidates", "pool_events"]) {
    const h = harness({ fail: (name) => name === table });
    assert.equal((await h.route.GET({}, context())).status, 503);
    assert.equal((await h.route.POST(request(), context())).status, 503);
    assert.equal(h.writes.length, 0);
  }
});

test("GET reads the complete history and fails closed when a later page is unavailable", async () => {
  const events = Array.from({ length: 1001 }, (_, i) => event(i + 1, { ...preparation, note: `${i + 1}` }));
  const h = harness({ events });
  const response = await h.route.GET({}, context());
  assert.equal(((response.body.preparations as Row[])[0].preparation as Row).note, "1001");
  const failing = harness({ events, fail: (table, write, from) => table === "pool_events" && !write && from === 1000 });
  assert.equal((await failing.route.GET({}, context())).status, 503);
});


const source = { id: "sms-1", applicant_id: 1, direction: "inbound", body: "22일 가능", created_at: "2027-04-09T00:00:00Z" };
const observed = event(20, { source: "inbound_sms", source_message_id: source.id, source_created_at: source.created_at,
  observations: [{ kind: "availability", quote: source.body }] }, { event_type: "job_consultation_observation" });
const primary = { ...preparation, dates: [{ date: "2027-04-22", availability: "available", role: "primary_candidate" }] };

test("GET links verified suggestions without writing or changing saved manager dates, and hides unlinked evidence", async () => {
  const h = harness({ events: [event(1), observed, { ...observed, id: 21, applicant_id: 999 }], messages: [source] });
  const response = await h.route.GET({}, context());
  assert.equal(response.status, 200);
  const suggestions = response.body.suggestions as Row[];
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].date, "2027-04-22");
  assert.equal(suggestions[0].source_message_id, "sms-1");
  assert.equal(((response.body.preparations as Row[])[0].preparation as Row).note, preparation.note);
  assert.deepEqual(h.writes, []);
});

test("cross-job primary warnings use linked real general jobs and latest preparation only", async () => {
  const h = harness({
    candidates: [7, 8, 9, 10, 11, 12].map((job_id) => ({ id: job_id, job_id, applicant_id: 1 })),
    jobs: [
      { id: 7, title: "A", start_date: "2027-04-20", work_period: "단기", client: null },
      { id: 8, title: "일반 B", client: { client_type: "general" } },
      { id: 9, title: "__system", client: null },
      { id: 10, title: "비마트", client: [{ client_type: "baemin_bmart" }] },
      { id: 11, title: "해제된 일반 C", client: null },
      { id: 12, title: "손상된 일반 D", client: null },
    ],
    events: [event(1, primary), ...[8, 9, 10, 11, 12, 99].map((job_id) => event(job_id, primary, { job_id })),
      event(30, { ...primary, dates: [] }, { job_id: 11 }), event(31, null, { job_id: 12 })],
  });
  const response = await h.route.GET({}, context());
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.primary_candidates)), [{ applicant_id: 1, job_id: 8, job_title: "일반 B", date: "2027-04-22" }]);
  assert.equal(response.body.conflict_check_incomplete, true);
  assert.deepEqual(h.writes, []);
});

test("evidence/job lookup errors are not reported as absent suggestions or conflict-free", async () => {
  for (const table of ["jobs", "messages"]) {
    const h = harness({ events: [observed], messages: [source], fail: (name) => name === table });
    assert.equal((await h.route.GET({}, context())).status, 503);
    assert.deepEqual(h.writes, []);
  }
});

test("GET reads later actual inbound even when no consultation observation was written for its refusal", async () => {
  const h = harness({ events: [observed], messages: [source, { ...source, id: "sms-new", body: "22일 불가", created_at: "2027-04-10T00:00:00Z" }] });
  const response = await h.route.GET({}, context());
  assert.equal(response.status, 200);
  const suggestion = (response.body.suggestions as Row[])[0];
  assert.equal(suggestion.date, null);
  assert.equal(suggestion.availability, "unknown");
  assert.match(suggestion.reason as string, /22일 불가/);
  assert.deepEqual(h.writes, []);
});


test("team changes retain prior notes, author and training progress scoped to the candidate's job", async () => {
  const h = harness({ events: [event(1, { ...preparation, note: "처음 연락" }), event(2, { ...preparation, note: "다른 공고 메모" }, { job_id: 8 })] });
  const training = { status: "completed", backup_intent: "declined", scheduled_at: "2026-09-15T07:30:00+09:00", first_loading_location: "첫 상차 교육장", linked_pro: "담당 프로" };
  const saved = await h.route.POST(request({ base_event_id: 1, training, note: "선탑 후 본인 백업 진행 안 함", actor: { account_id: "spoofed" } }), context());
  assert.equal(saved.status, 200);
  assert.equal(((saved.body.preparation as Row).training as Row)?.backup_intent, "declined");
  assert.deepEqual(JSON.parse(JSON.stringify(saved.body.actor)), { account_id: "verified-account", name: "김운영" });
  const result = await h.route.GET({}, context());
  const history = ((result.body.preparations as Row[])[0].history ?? []) as Row[];
  assert.equal(history.length, 2);
  assert.equal((history[1].preparation as Row).note, "처음 연락");
  assert.equal(history[1].actor, null);
  assert.deepEqual(h.writes.map((write) => write.table), ["pool_events"]);
});

test("actual participation additions, edits and deletions append revisions without changing planned work", async () => {
  const h = harness({ events: [event(1)] });
  const training = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "training", date: "2026-01-08", note: "동승 확인" };
  const backup = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", kind: "backup", date: "2026-01-09", note: "배송 수행 확인" };
  const added = await h.route.POST(request({ base_event_id: 1, records: [training, backup] }), context());
  assert.equal(added.status, 200);
  assert.deepEqual((added.body.preparation as Row).records, [backup, training]);
  const edited = { ...backup, date: "2026-01-10", note: "실제 수행일 정정" };
  assert.equal((await h.route.POST(request({ base_event_id: 2, action_key: "22222222-2222-4222-8222-222222222222", records: [training, edited] }), context())).status, 200);
  assert.equal((await h.route.POST(request({ base_event_id: 3, action_key: "33333333-3333-4333-8333-333333333333", records: [edited] }), context())).status, 200);
  const result = await h.route.GET({}, context());
  const history = ((result.body.preparations as Row[])[0].history ?? []) as Row[];
  assert.deepEqual(Array.from(history, (revision) => (revision.preparation as Row).records), [[edited], [edited, training], [backup, training], []]);
  assert.ok(history.every((revision) => JSON.stringify((revision.preparation as Row).dates) === JSON.stringify(preparation.dates)));
  assert.deepEqual(h.writes.map((write) => write.table), ["pool_events", "pool_events", "pool_events"]);
  assert.equal(h.database.job_candidates[0].agent_stage, undefined);
});

test("future actual participation is rejected before any write", async () => {
  const h = harness();
  const result = await h.route.POST(request({ records: [{ id: KEY, kind: "backup", date: "9999-01-01", note: "" }] }), context());
  assert.equal(result.status, 400);
  assert.equal(h.writes.length, 0);
});

test("legacy requests cannot silently clear actual participation but explicit empty records can", async () => {
  const records = [{ id: KEY, kind: "training", date: "2026-01-08", note: "실제 동승 확인" }];
  const h = harness({ events: [event(1, { ...preparation, records })] });
  const omitted = await h.route.POST(request({ base_event_id: 1, note: "구버전 화면의 메모 수정" }), context());
  assert.equal(omitted.status, 409);
  assert.match(String(omitted.body.error), /새로고침/);
  assert.equal(h.writes.length, 0);
  assert.deepEqual((h.database.pool_events[0].meta as Row).records, records);
  const explicit = await h.route.POST(request({ base_event_id: 1, records: [] }), context());
  assert.equal(explicit.status, 200);
  assert.deepEqual((explicit.body.preparation as Row).records, []);
  assert.deepEqual((h.database.pool_events[0].meta as Row).records, records);
  assert.equal(h.writes.length, 1);
  const legacy = harness({ events: [event(1)] });
  assert.equal((await legacy.route.POST(request({ base_event_id: 1 }), context())).status, 200);
});

const followUp = { owner: "김담당", next_action: "다음 일정 연락", due_date: "2026-09-15", status: "open",
  last_contact: { date: "2026-01-08", method: "phone", result: "다음 주 연락 요청" } };

test("follow-up edits and explicit clearing preserve revisions without changing candidate state", async () => {
  const h = harness({ events: [event(1)] });
  const added = await h.route.POST(request({ base_event_id: 1, follow_up: followUp }), context());
  assert.equal(added.status, 200);
  assert.deepEqual((added.body.preparation as Row).follow_up, followUp);
  const done = { ...followUp, status: "done" };
  const completed = await h.route.POST(request({ base_event_id: 2, action_key: crypto.randomUUID(), follow_up: done }), context());
  assert.equal(completed.status, 200);
  assert.equal((await h.route.POST(request({ base_event_id: 3, action_key: crypto.randomUUID(), follow_up: null }), context())).status, 200);
  const response = await h.route.GET({}, context());
  const row = (response.body.preparations as Row[])[0];
  assert.equal((row.preparation as Row).follow_up, null);
  assert.deepEqual(Array.from(row.history as Row[], (revision) => (revision.preparation as Row).follow_up), [null, done, followUp, undefined]);
  assert.ok((row.history as Row[]).every((revision) => JSON.stringify((revision.preparation as Row).dates) === JSON.stringify(preparation.dates)));
  assert.deepEqual(h.writes.map((write) => write.table), ["pool_events", "pool_events", "pool_events"]);
  assert.equal(h.database.job_candidates[0].agent_stage, undefined);
});

test("legacy omission cannot clear even malformed follow-up metadata, while null is an explicit reset", async () => {
  for (const follow_up of [followUp, { ...followUp, status: "broken" }]) {
    const h = harness({ events: [event(1, { ...preparation, follow_up })] });
    const omitted = await h.route.POST(request({ base_event_id: 1 }), context());
    assert.equal(omitted.status, 409);
    assert.match(String(omitted.body.error), /새로고침/);
    assert.equal(h.writes.length, 0);
    const cleared = await h.route.POST(request({ base_event_id: 1, follow_up: null }), context());
    assert.equal(cleared.status, 200);
    assert.equal((cleared.body.preparation as Row).follow_up, null);
    assert.deepEqual((h.database.pool_events[0].meta as Row).follow_up, follow_up);
    assert.equal((await h.route.POST(request({ base_event_id: 2, action_key: crypto.randomUUID() }), context())).status, 200);
  }
});

test("follow-up respects stale-write conflicts and permits committed legacy retries after a later follow-up edit", async () => {
  const h = harness({ events: [event(1)] });
  const legacy = await h.route.POST(request({ base_event_id: 1 }), context());
  const followUpKey = crypto.randomUUID();
  const saved = await h.route.POST(request({ base_event_id: 2, action_key: followUpKey, follow_up: followUp }), context());
  assert.equal(saved.status, 200);
  const retry = await h.route.POST(request({ base_event_id: 1 }), context());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.deduplicated, true);
  assert.equal(retry.body.event_id, legacy.body.event_id);
  const orderedDifferently = { status: "open", due_date: "2026-09-15", next_action: " 다음 일정 연락 ", owner: "김담당",
    last_contact: { result: "다음 주 연락 요청", method: "phone", date: "2026-01-08" } };
  const followUpRetry = await h.route.POST(request({ base_event_id: 2, action_key: followUpKey, follow_up: orderedDifferently }), context());
  assert.equal(followUpRetry.status, 200);
  assert.equal(followUpRetry.body.deduplicated, true);
  assert.deepEqual((followUpRetry.body.preparation as Row).follow_up, followUp);
  const stale = await h.route.POST(request({ base_event_id: 2, action_key: crypto.randomUUID(), follow_up: null }), context());
  assert.equal(stale.status, 409);
  assert.equal(stale.body.conflict, true);
  assert.equal(h.writes.length, 2);
});

test("different editors racing on one base preserve the winner and return conflict to the other", async () => {
  const h = harness({ events: [event(1)] });
  const responses = await Promise.all([
    h.route.POST(request({ base_event_id: 1, note: "A가 조율 중" }), context()),
    h.route.POST(request({ base_event_id: 1, action_key: "22222222-2222-4222-8222-222222222222", actor_name: "이운영", note: "B가 완료 확인" }), context()),
  ]);
  assert.deepEqual(responses.map((result) => result.status).sort(), [200, 409]);
  assert.equal(h.writes.length, 1);
  assert.equal(h.database.pool_events.length, 2);
  const loser = responses.find((result) => result.status === 409)!;
  assert.equal(loser.body.conflict, true);
  assert.equal((loser.body.latest as Row).event_id, 2);
});

test("a stale editor cannot overwrite a teammate and retries still return their original committed result", async () => {
  const h = harness({ events: [event(1)] });
  const first = await h.route.POST(request({ base_event_id: 1, note: "첫 편집" }), context());
  const second = await h.route.POST(request({ base_event_id: 2, action_key: "22222222-2222-4222-8222-222222222222", note: "다음 편집" }), context());
  assert.equal(second.status, 200);
  const retry = await h.route.POST(request({ base_event_id: 1, note: "첫 편집" }), context());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.event_id, first.body.event_id);
  assert.equal(retry.body.deduplicated, true);
  const stale = await h.route.POST(request({ base_event_id: 1, action_key: "33333333-3333-4333-8333-333333333333", note: "지난 초안" }), context());
  assert.equal(stale.status, 409);
  assert.equal(h.writes.length, 2);
});

test("an attributed save needs an authenticated account, author name and explicit base version", async () => {
  const h = harness();
  for (const patch of [{ actor_name: " " }, { actor_name: "가".repeat(81) }, { base_event_id: undefined }, { base_event_id: -1 }]) {
    assert.equal((await h.route.POST(request(patch), context())).status, 400);
  }
  const unauthenticated = harness({ authenticated: false });
  assert.equal((await unauthenticated.route.POST(request(), context())).status, 401);
  assert.equal(unauthenticated.writes.length, 0);
  assert.equal(h.writes.length, 0);
});


test("the initial version rejects concurrent editors but stays independent for each linked candidate", async () => {
  const h = harness();
  const responses = await Promise.all([
    h.route.POST(request({ note: "첫 담당자" }), context()),
    h.route.POST(request({ action_key: "22222222-2222-4222-8222-222222222222", note: "다른 첫 담당자" }), context()),
    h.route.POST(request({ applicant_id: 2, action_key: "33333333-3333-4333-8333-333333333333", note: "다른 후보 담당자" }), context()),
  ]);
  assert.deepEqual(responses.slice(0, 2).map((result) => result.status).sort(), [200, 409]);
  assert.equal(responses[2].status, 200);
  assert.equal(h.writes.length, 2);
});
