import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { fetchAllPostgrestRows } from "./postgrest-pagination.ts";
import { fetchPhoneMessageIdentityIndex } from "./phone-message-identity.ts";
import { normalizePhone } from "../ongmanaging.ts";
import { detectConfirmationNuance } from "../agent/outbound-safety.ts";
import * as authorization from "../recruitment-contact-authorization.ts";
import * as bulk from "../bulk-message-send.ts";

type Row = Record<string, any>;
const NOW = Date.now();
const BATCH = "11111111-1111-4111-8111-111111111111";
const applicant = (id = 1, extra: Row = {}): Row => ({
  id, name: `후보 ${id}`, phone: `010${String(id).padStart(8, "0")}`, source: "homepage",
  marketing_consent: false, marketing_consent_at: null, sms_opt_out_at: null,
  airtable_record_id: `record-${id}`, airtable_raw: { original_form: true },
  status: "대기", current_job_id: null, access_token: `token-${id}`, ...extra,
});
const job = (extra: Row = {}): Row => ({
  id: 7, title: "배송 모집", status: "active", closes_at: null,
  recruit_mode: "internal", exposure: "targeted", client: { client_type: "general" }, ...extra,
});
const payload = (extra: Row = {}): Row => ({
  mode: "authorize", bulk_request_id: BATCH, purpose: "new_job", job_id: 7,
  recruitment_job_ids: [7], recipients: [{ applicant_id: 1, phone: applicant().phone }],
  body: "새 배송 공고를 확인하고 관심 있으면 알려주세요. #{맞춤링크}",
  note: "원래 모집 설문에서 남긴 연락 동의 정보를 확인하고 이번 공고 안내만 승인했습니다.",
  ...extra,
});

type Options = { fail?: string; emptyInsert?: boolean; partialInsert?: boolean; race?: Row[] };
function harness(overrides: Record<string, Row[]> = {}, options: Options = {}) {
  const db: Record<string, Row[]> = {
    applicants: [applicant()], jobs: [job()], job_candidates: [], messages: [],
    recruitment_blacklist: [], pool_events: [],
    job_exposure_targets: [{ job_id: 7, applicant_id: 1, mode: "include" }], ...overrides,
  };
  const writes: Array<{ table: string; rows: Row[] }> = [];
  const calls: string[] = [];
  class Query {
    filters: Array<(row: Row) => boolean> = [];
    rows?: Row[];
    readonly table: string;
    constructor(table: string) { this.table = table; }
    select() { return this; }
    eq(key: string, value: unknown) {
      this.filters.push(row => (key.startsWith("meta->>") ? row.meta?.[key.slice(7)] : row[key]) === value);
      return this;
    }
    in(key: string, values: unknown[]) { this.filters.push(row => values.includes(row[key])); return this; }
    order() { return this; }
    insert(rows: Row[]) { this.rows = rows; return this; }
    result(from = 0, to = 999) {
      calls.push(this.table);
      if (options.fail === this.table) return { data: null, error: { message: "unavailable" } };
      if (this.rows) {
        if (options.race) { db.pool_events.push(...options.race); options.race = undefined; }
        if (this.rows.some(row => db[this.table].some(saved => saved.action_key === row.action_key))) {
          return { data: null, error: { code: "23505", message: "duplicate" } };
        }
        const saved = this.rows.map((row, i) => ({ ...row, id: db[this.table].length + i + 1 }));
        writes.push({ table: this.table, rows: saved });
        db[this.table].push(...saved);
        return { data: options.emptyInsert ? [] : options.partialInsert ? saved.slice(0, -1) : saved, error: null };
      }
      return { data: (db[this.table] ?? []).filter(row => this.filters.every(fn => fn(row))).slice(from, to + 1), error: null };
    }
    range(from: number, to: number) { return Promise.resolve(this.result(from, to)); }
    then(resolve: (result: ReturnType<Query["result"]>) => unknown) { return Promise.resolve(this.result()).then(resolve); }
  }
  const supabase = { from: (table: string) => new Query(table) };
  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: Row, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } },
    "node:crypto": crypto,
    "@/lib/supabase": { createServiceClient: () => supabase },
    "@/lib/admin/postgrest-pagination": { fetchAllPostgrestRows },
    "@/lib/admin/phone-message-identity": { fetchPhoneMessageIdentityIndex },
    "@/lib/ongmanaging": { normalizePhone },
    "@/lib/agent/outbound-safety": { detectConfirmationNuance },
    "@/lib/recruitment-contact-authorization": authorization,
    "@/lib/bulk-message-send": bulk,
    "@/lib/agent/general-line": {
      joinedClientType: (value: Row | Row[]) => (Array.isArray(value) ? value[0] : value)?.client_type ?? null,
      isGeneralLineJob: (value: Row) => !!value.title && !value.title.startsWith("__") && value.client_type !== "baemin_bmart",
    },
    "@/lib/jobs": { isJobEffectivelyClosed: (status: string, closes: string | null) => status !== "active" || (closes && Date.parse(closes) <= NOW) },
  };
  const compiled = { exports: {} as { POST: (req: unknown) => Promise<{ body: Row; status: number }> } };
  const source = readFileSync(new URL("../../app/api/admin/messages/recruitment-contact-authorization/route.ts", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText, {
    exports: compiled.exports, module: compiled, require: (name: string) => {
      if (!(name in stubs)) throw new Error(`Unexpected dependency ${name}`);
      return stubs[name];
    }, Date, Set, Map, Number, console: { error() {} },
  });
  return { db, writes, calls, post: (body = payload()) => compiled.exports.POST({ json: async () => body }) };
}

test("review recognizes legacy false/null as requiring basis, and never writes consent or events", async () => {
  for (const consent of [false, null]) {
    const h = harness({ applicants: [applicant(1, { marketing_consent: consent })] });
    const response = await h.post(payload({ mode: "review", note: undefined }));
    assert.equal(response.status, 200);
    assert.equal(response.body.recipients[0].state, "authorization_required");
    assert.equal(h.writes.length, 0);
  }
});

test("explicit authorization appends a bounded valid event, leaves actual consent unchanged, and retries idempotently", async () => {
  const h = harness();
  const before = JSON.stringify(h.db.applicants);
  const response = await h.post();
  assert.equal(response.status, 200);
  assert.equal(response.body.recipients[0].state, "authorized");
  assert.equal(h.db.pool_events.length, 1);
  const event = h.db.pool_events[0];
  assert.equal(authorization.recruitmentContactAuthorizationMatches(event, {
    purpose: "new_job", batchId: BATCH, applicantId: 1, phone: applicant().phone,
    jobIds: [7], requestFingerprint: bulk.bulkBatchRequestFingerprint({ body: payload().body, subject: "옹고잉 채용 안내", purpose: "new_job", jobId: 7 }),
    recipientFingerprint: event.meta.recipient_fingerprint,
  }), true);
  assert.equal(Date.parse(event.meta.expires_at) - Date.parse(event.created_at), authorization.RECRUITMENT_CONTACT_AUTHORIZATION_TTL_MS);
  assert.equal((await h.post()).status, 200);
  assert.equal(h.writes.length, 1);
  assert.equal(JSON.stringify(h.db.applicants), before);
});

test("same batch rejects changed body or recipient set, including a removed legacy recipient", async () => {
  const h = harness({ applicants: [applicant(), applicant(2)], job_exposure_targets: [1, 2].map(applicant_id => ({ applicant_id, job_id: 7, mode: "include" })) });
  const two = payload({ recipients: [1, 2].map(id => ({ applicant_id: id, phone: applicant(id).phone })) });
  assert.equal((await h.post(two)).status, 200);
  assert.equal((await h.post({ ...two, body: `${two.body} 추가 문구` })).status, 409);
  assert.equal((await h.post()).status, 409);
  assert.equal(h.writes.length, 1);
});

test("forged approval fields, invalid scope, duplicate phone, and insufficient manager note cannot authorize", async () => {
  for (const invalid of [
    { note: "승인" }, { mode: "authorize", confirmed_by: "manager", note: undefined },
    { job_id: 9 }, { recruitment_job_ids: [] }, { recruitment_job_ids: [7, 7] },
    { purpose: "campaign" }, { bulk_request_id: "bad" }, { body: "근무 확정입니다. #{맞춤링크}" },
    { recipients: [{ applicant_id: 1, phone: "01099999999" }] },
    { recipients: [{ applicant_id: 1, phone: applicant().phone }, { applicant_id: 2, phone: applicant().phone }] },
  ]) {
    const h = harness();
    assert.ok((await h.post(payload(invalid))).status >= 400, JSON.stringify(invalid));
    assert.equal(h.writes.length, 0);
  }
});

test("Bmart jobs, closed/public jobs, and unexposed applicants cannot obtain authorization", async () => {
  for (const change of [{ client: { client_type: "baemin_bmart" } }, { status: "closed" }, { recruit_mode: "both" }, { exposure: "all" }]) {
    const h = harness({ jobs: [job(change)] });
    assert.equal((await h.post()).status, 409);
    assert.equal(h.writes.length, 0);
  }
  const h = harness({ job_exposure_targets: [] });
  assert.equal((await h.post()).status, 409);
  assert.equal(h.writes.length, 0);
});

test("explicit refusal, duplicate-phone optout, Bmart sources, existing candidates and blacklist always block", async () => {
  const cases: Record<string, Row[]>[] = [
    { messages: [{ id: 1, applicant_id: 1, direction: "inbound", body: "수신 거부", created_at: new Date(NOW - 1000).toISOString() }] },
    { applicants: [applicant(), applicant(2, { phone: applicant().phone, sms_opt_out_at: new Date(NOW - 1000).toISOString() })] },
    { applicants: [applicant(1, { source: "baemin" })] },
    { job_candidates: [{ id: 1, applicant_id: 1, job_id: 99, agent_stage: "paused" }] },
    { recruitment_blacklist: [{ phone: applicant().phone }] },
    { applicants: [applicant(1, { airtable_raw: null })] },
  ];
  for (const database of cases) {
    const h = harness(database);
    assert.equal((await h.post(payload({ mode: "review" }))).body.recipients[0].state, "blocked");
    assert.equal((await h.post()).status, 409);
    assert.equal(h.writes.length, 0);
  }
});

test("read failures and empty/partial insert responses never return approval success", async () => {
  for (const table of ["applicants", "jobs", "job_exposure_targets", "job_candidates", "messages", "recruitment_blacklist", "pool_events"]) {
    const h = harness({}, { fail: table });
    assert.equal((await h.post()).status, 503, table);
    assert.equal(h.writes.length, 0);
  }
  for (const options of [{ emptyInsert: true }, { partialInsert: true }]) {
    assert.equal((await harness({}, options).post()).status, 503);
  }
});

test("current explicit consent needs no legacy event; mixed batch writes only legacy rows", async () => {
  const h = harness({
    applicants: [applicant(), applicant(2, { marketing_consent: true, marketing_consent_at: new Date(NOW - 1000).toISOString(), airtable_raw: null })],
    job_exposure_targets: [1, 2].map(applicant_id => ({ applicant_id, job_id: 7, mode: "include" })),
  });
  const result = await h.post(payload({ recipients: [1, 2].map(id => ({ applicant_id: id, phone: applicant(id).phone })) }));
  assert.equal(result.status, 200);
  assert.deepEqual(Array.from(result.body.recipients, (row: any) => row.state), ["authorized", "consented"]);
  assert.equal(h.db.pool_events.length, 1);
  assert.equal(h.db.pool_events[0].applicant_id, 1);
});

test("approval races return stored success only for the same batch scope", async () => {
  const initial = harness();
  assert.equal((await initial.post()).status, 200);
  const same = harness({}, { race: initial.db.pool_events });
  assert.equal((await same.post()).status, 200);
  assert.equal(same.writes.length, 0);
  const changed = harness({}, { race: initial.db.pool_events });
  assert.equal((await changed.post(payload({ body: `${payload().body} 다른 안내` }))).status, 409);
  assert.equal(changed.writes.length, 0);
});

test("expired approval is not extended or appended by repeated authorization", async () => {
  const h = harness();
  await h.post();
  h.db.pool_events[0].meta.expires_at = new Date(NOW - 1).toISOString();
  assert.equal((await h.post()).status, 409);
  assert.equal(h.writes.length, 1);
});

test("complete duplicate-phone history includes a contextual refusal after the first page", async () => {
  const prior = new Date(NOW - 2000).toISOString();
  const after = new Date(NOW - 1000).toISOString();
  const h = harness({
    applicants: [applicant(), applicant(2, { phone: applicant().phone })],
    messages: [
      ...Array.from({ length: 1000 }, (_, id) => ({ id, applicant_id: 1, direction: "inbound", body: "확인", created_at: prior })),
      { id: 1001, applicant_id: 2, direction: "outbound", body: "새 일자리 안내 문자 수신에 동의하시나요?", created_at: prior },
      { id: 1002, applicant_id: 2, direction: "inbound", body: "아니요", created_at: after },
    ],
  });
  assert.equal((await h.post()).status, 409);
  assert.equal(h.writes.length, 0);
});

test("general delivery branch names and raw question labels are not evidence of Bmart involvement", async () => {
  const h = harness({ applicants: [applicant(1, { branch1: "서울 강남", airtable_raw: { "비마트 경험 여부": "없음", "일반배송 지역": "서울" } })] });
  assert.equal((await h.post()).status, 200);
});

test("empty SMS subject uses the bulk sender default and approval remains reusable", async () => {
  const h = harness();
  assert.equal((await h.post()).status, 200);
  assert.equal((await h.post(payload({ subject: "" }))).status, 200);
  assert.equal(h.writes.length, 1);
});
