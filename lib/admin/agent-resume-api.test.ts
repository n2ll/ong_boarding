import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Row = Record<string, any>;
function harness(options: { mode?: string; pending?: boolean; cas?: boolean; result?: Row } = {}) {
  let row: Row = { id: 3, applicant_id: 1, job_id: 2, agent_stage: 'paused', agent_state: { meta: { paused_from_stage: 'exploration' } }, paused_reason: 'validation', updated_at: 'old' };
  const writes: Row[] = []; const calls: Row[] = [];
  const db = { from() {
    let update: Row | undefined; const filters: [string, unknown][] = [];
    const q = { select() { return q; }, update(value: Row) { update = value; return q; },
      eq(k: string, v: unknown) { filters.push([k, v]); return q; },
      async maybeSingle() {
        if (filters.some(([k,v]) => row[k] !== v) || (update && options.cas === false)) return { data: null, error: null };
        if (update) { writes.push(update); row = { ...row, ...update }; }
        return { data: { ...row }, error: null };
      },
    }; return q;
  } };
  const exports: Row = {};
  const modules: Row = {
    'next/server': { NextResponse: { json: (body: unknown, init?: { status: number }) => ({ body, status: init?.status ?? 200 }) } },
    '@/lib/supabase': { createServiceClient: () => db },
    '@/lib/agent/candidate-target': { resolveCandidateTarget: async () => ({ ok: true, candidate: { ...row } }) },
    '@/lib/agent/pending-reply': { loadPendingAgentReply: async () => options.pending === false ? { ok: false, error: 'already answered' } : { ok: true, message: { id: 'original', body: '1, 3번\n22일 가능', created_at: '2026-09-09T07:33:46Z' } } },
    '@/lib/agent/kill-switch': { getAgentMode: async () => options.mode ?? 'auto' },
    '@/lib/agent/router': { runAgentForCandidate: async (input: Row) => { calls.push(input); return options.result ?? { ok: true, reply_sent: true }; } },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../../app/api/admin/agent/resume/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (name: string) => modules[name] ?? {}, console: { error() {} }, Date, Number });
  return { post: (patch: Row = {}) => exports.POST({ json: async () => ({ applicant_id: 1, job_id: 2, reply_to_latest: true, ...patch }) }), writes, calls, state: () => row };
}
test('explicit pending reply reuses real inbound and requires unanswered guard', async () => {
  const h = harness(); const r = await h.post();
  assert.equal(r.status, 200); assert.equal(r.body.reply_sent, true); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].received_at, '2026-09-09T07:33:46Z');
  assert.equal(h.calls[0].inbound_text, '1, 3번\n22일 가능'); assert.equal(h.calls[0].onlyIfUnanswered, true);
});
test('ordinary resume does not replay or invoke AI', async () => {
  const h = harness(); assert.equal((await h.post({ reply_to_latest: false })).status, 200);
  assert.equal(h.calls.length, 0); assert.equal(h.state().agent_stage, 'exploration');
});
test('a delivered transition message counts as a successful response without rollback', async () => {
  const h = harness({ result: { ok: true, reply_sent: false, auto_sent_messages: 1, next_stage: 'screening' } });
  const r = await h.post(); assert.equal(r.status, 200); assert.equal(r.body.reply_sent, true); assert.equal(h.writes.length, 1);
});
test('off/draft, answered input, stale CAS and malformed target never call AI', async () => {
  for (const options of [{ mode: 'off' }, { mode: 'draft' }, { pending: false }, { cas: false }]) {
    const h = harness(options); assert.equal((await h.post()).status, 409); assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
  }
  const h = harness(); for (const patch of [{ applicant_id: -1 }, { job_id: 'bad' }, { reply_to_latest: 'true' }]) assert.equal((await h.post(patch)).status, 400);
});
test('known unsent failure returns to paused without claiming success', async () => {
  const h = harness({ result: { ok: false, error: 'validation failed' } });
  assert.equal((await h.post()).status, 409); assert.equal(h.state().agent_stage, 'paused');
  assert.equal(h.state().paused_reason, 'validation');
});
test('uncertain delivery is not replayed or rolled back as an unsent response', async () => {
  const h = harness({ result: { ok: false, delivery_uncertain: true } }); const r = await h.post();
  assert.equal(r.status, 503); assert.equal(r.body.delivery_uncertain, true); assert.equal(h.writes.length, 1);
});
