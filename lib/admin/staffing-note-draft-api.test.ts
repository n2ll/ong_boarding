import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Row = Record<string, unknown>;
type Reply = { status: number; body: Row };
const root = fileURLToPath(new URL("../../", import.meta.url));
const note = "통화 완료. 선탑은 평일 오전 가능. 백업도 희망.";
const proposal = { changes: [
  { field: "contact", value: { date: "2026-09-12", method: "phone", result: "통화 완료" }, evidence: "통화 완료" },
  { field: "training_availability", value: "평일 오전 가능", evidence: "선탑은 평일 오전 가능" },
  { field: "backup_intent", value: "interested", evidence: "백업도 희망" },
], questions: [] };
const request = (patch: Row = {}) => ({ cookies: { getAll: () => [] }, json: async () => ({ applicant_id: 1, note, reference_date: "2026-09-12", ...patch }) });
const context = (id = "7") => ({ params: Promise.resolve({ id }) });

function harness(input: { user?: Row | null; authError?: boolean; allowedEmails?: string; candidates?: Row[]; jobs?: Row[];
  dbFailure?: string; response?: unknown; httpStatus?: number; fetchError?: Error; apiKey?: string } = {}) {
  const database: Record<string, Row[]> = {
    jobs: input.jobs ?? [{ id: 7, title: "성수 배송", description: "PRIVATE_JOB_HISTORY" }],
    job_candidates: input.candidates ?? [{ id: 11, applicant_id: 1, job_id: 7, agent_state: "PRIVATE_APPLICANT_HISTORY" }],
  };
  const reads: Array<{ table: string; columns: string }> = [];
  const usage: Array<{ name: string; args: Row }> = [];
  const calls: Array<{ url: string; options: RequestInit; body: Row }> = [];
  const logs: unknown[] = [];
  class Query {
    private filters: Array<(row: Row) => boolean> = [];
    private columns = "";
    private table: string;
    constructor(table: string) { this.table = table; }
    select(columns: string) { this.columns = columns; reads.push({ table: this.table, columns }); return this; }
    eq(key: string, value: unknown) { this.filters.push((row) => row[key] === value); return this; }
    async maybeSingle() {
      if (input.dbFailure === this.table) return { data: null, error: new Error(note) };
      const row = database[this.table].find((row) => this.filters.every((filter) => filter(row)));
      return { data: row ? Object.fromEntries(this.columns.split(",").map((key) => [key.trim(), row[key.trim()]])) : null, error: null };
    }
  }
  const db = {
    from(table: string) { assert.ok(Object.hasOwn(database, table), `unexpected table: ${table}`); return new Query(table); },
    async rpc(name: string, args: Row) { usage.push({ name, args }); return { data: null, error: null }; },
  };
  const modules: Record<string, unknown> = {
    "@supabase/ssr": { createServerClient: () => ({ auth: { getUser: async () => ({
      data: { user: input.user === undefined ? { id: "verified-user", email: "manager@example.test" } : input.user },
      error: input.authError ? new Error(note) : null,
    }) } }) },
    "next/server": { NextResponse: { json: (body: unknown, init?: { status: number }) => ({ body, status: init?.status ?? 200 }) } },
    "@/lib/supabase": { createServiceClient: () => db },
  };
  function load(path: string): Record<string, unknown> {
    const exports: Record<string, unknown> = {};
    const source = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const require = (name: string): unknown => {
      if (Object.hasOwn(modules, name)) return modules[name];
      const local = name.startsWith("@/") ? resolve(root, name.slice(2)) : resolve(dirname(path), name);
      return load(local.endsWith(".ts") ? local : `${local}.ts`);
    };
    runInNewContext(source, { exports, require, Date, Map, Set, AbortSignal,
      console: { error: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) },
      process: { env: { NEXT_PUBLIC_SUPABASE_URL: "http://auth.example.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture",
        CLAUDE_API: input.apiKey ?? "fixture", ADMIN_ALLOWED_EMAILS: input.allowedEmails ?? "manager@example.test" } },
      fetch: async (url: string, options: RequestInit) => {
        calls.push({ url, options, body: JSON.parse(String(options.body)) });
        if (input.fetchError) throw input.fetchError;
        return { ok: (input.httpStatus ?? 200) === 200, status: input.httpStatus ?? 200,
          json: async () => Object.hasOwn(input, "response") ? input.response : { stop_reason: "tool_use", content: [{ type: "tool_use", name: "propose_staffing_note", input: proposal }],
            usage: { input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 10 } } };
      },
    });
    return exports;
  }
  const route = load(resolve(root, "app/api/admin/jobs/[id]/staffing-note-draft/route.ts")) as {
    POST: (request: unknown, context: unknown) => Promise<Reply>;
  };
  return { route, reads, calls, usage, logs };
}

// Removing route authentication would expose both the AI call and candidate data.
test("unauthenticated, invalid-session and non-allowlisted requests never read data or invoke AI", async () => {
  for (const input of [{ user: null }, { authError: true }, { user: { id: "outsider", email: "outsider@example.test" } }]) {
    const h = harness(input);
    const response = await h.route.POST(request(), context());
    assert.ok([401, 403].includes(response.status));
    assert.equal(h.reads.length, 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.usage.length, 0);
  }
});

test("validates bounded memo, IDs, calendar dates and future reference dates before calling AI", async () => {
  for (const patch of [{ applicant_id: 0 }, { applicant_id: "1" }, { note: " " }, { note: "가".repeat(1001) },
    { note: null }, { reference_date: "2026-02-30" }, { reference_date: "2999-01-01" }, { reference_date: "2026-9-12" }, { reference_date: null }]) {
    const h = harness();
    assert.equal((await h.route.POST(request(patch), context())).status, 400);
    assert.equal(h.calls.length, 0);
    assert.equal(h.usage.length, 0);
  }
  const h = harness();
  assert.equal((await h.route.POST(request(), context("7x"))).status, 400);
  assert.equal((await h.route.POST({ cookies: { getAll: () => [] }, json: async () => { throw new Error(note); } }, context())).status, 400);
});

test("candidate must belong to the requested job and job must exist before generating", async () => {
  for (const input of [{ candidates: [] }, { candidates: [{ id: 11, applicant_id: 1, job_id: 8 }] }, { jobs: [] }]) {
    const h = harness(input);
    assert.equal((await h.route.POST(request(), context())).status, 404);
    assert.equal(h.calls.length, 0);
    assert.equal(h.usage.length, 0);
  }
});

test("returns a validated proposal using only the note, selected reference date and job title; records usage once", async () => {
  const h = harness({ allowedEmails: " MANAGER@EXAMPLE.TEST " });
  const response = await h.route.POST(request(), context());
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body)), { proposal });
  assert.equal(h.calls.length, 1);
  const { body, options } = h.calls[0];
  assert.equal(body.model, "claude-haiku-4-5-20251001");
  assert.equal(body.max_tokens, 1500);
  assert.deepEqual(body.tool_choice, { type: "tool", name: "propose_staffing_note" });
  assert.ok(options.signal instanceof AbortSignal);
  const messages = JSON.stringify(body.messages);
  assert.ok(messages.includes(note));
  assert.ok(messages.includes("2026-09-12"));
  assert.ok(messages.includes("성수 배송"));
  assert.ok(!messages.includes("PRIVATE_"));
  assert.ok(h.reads.every((read) => ["job_candidates", "jobs"].includes(read.table)));
  assert.equal(h.usage.length, 1);
  assert.deepEqual({ ...h.usage[0].args, p_day: "kst-day" }, { p_day: "kst-day", p_model: "claude-haiku-4-5-20251001",
    p_purpose: "staffing_note", p_in: 120, p_out: 80, p_cache: 10 });
  assert.equal(h.usage[0].name, "upsert_ai_usage_daily");
  assert.equal(h.logs.length, 0);
});

test("missing key or database failure cannot create a proposal or leak memo into logs", async () => {
  for (const input of [{ apiKey: "" }, { dbFailure: "jobs" }, { dbFailure: "job_candidates" }]) {
    const h = harness(input);
    const response = await h.route.POST(request(), context());
    assert.equal(response.status, 503);
    assert.equal(h.calls.length, 0);
    assert.equal(h.usage.length, 0);
    assert.ok(!JSON.stringify([response, h.logs]).includes(note));
  }
});

test("malformed, truncated and unsupported model results fail closed while still recording successful-call usage", async () => {
  const output = (value: unknown, patch: Row = {}) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "propose_staffing_note", input: value }], usage: { input_tokens: 120, output_tokens: 80 }, ...patch });
  for (const response of [null, {}, output({ changes: [{ field: "confirmation", value: "confirmed", evidence: "백업도 희망" }], questions: [] }),
    output({ changes: [{ field: "backup_intent", value: "interested", evidence: "메모에 없는 근거" }], questions: [] }),
    output({ changes: [{ field: "next_action", value: "다시 전화", evidence: "통화 완료", due_date: "2026-09-13" }], questions: [] }),
    output(proposal, { stop_reason: "max_tokens" }), output(proposal, { content: [{ type: "text", text: JSON.stringify(proposal) }] }),
    output(proposal, { content: [{ type: "tool_use", name: "another_tool", input: proposal }] })]) {
    const h = harness({ response });
    assert.equal((await h.route.POST(request(), context())).status, 503);
    assert.equal(h.calls.length, 1);
    assert.equal(h.usage.length, 1);
    assert.equal(h.logs.length, 0);
  }
});

test("rate limits and timeout errors make one attempt, record failed-call usage and return a retryable generic error", async () => {
  for (const input of [{ httpStatus: 429 }, { fetchError: new Error(note) }, { fetchError: Object.assign(new Error(note), { name: "TimeoutError" }) }]) {
    const h = harness(input);
    const response = await h.route.POST(request(), context());
    assert.equal(response.status, 503);
    assert.equal(h.calls.length, 1);
    assert.equal(h.usage.length, 1);
    assert.equal(h.usage[0].args.p_in, 0);
    assert.ok(!JSON.stringify([response, h.logs]).includes(note));
  }
});

test("limits job context to 1000 characters before sending the bounded AI request", async () => {
  const h = harness({ jobs: [{ id: 7, title: `${"공".repeat(1000)}SHOULD_NOT_BE_SENT` }] });
  assert.equal((await h.route.POST(request(), context())).status, 200);
  const messages = h.calls[0].body.messages as Array<{ content: string }>;
  const content = JSON.parse(messages[0].content);
  assert.equal(content.job_title.length, 1000);
  assert.ok(!content.job_title.includes("SHOULD_NOT_BE_SENT"));
});
