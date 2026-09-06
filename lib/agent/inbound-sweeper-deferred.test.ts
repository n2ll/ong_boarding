import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

async function sweep(options: { deferred?: boolean; drafted?: boolean; paused?: boolean; mode?: string; manualReply?: boolean }) {
  let runs = 0;
  const current = '2026-09-06T03:00:00.000Z'; // noon KST
  const inbound = { id: 'in-2', applicant_id: 7, body: '추가 질문', created_at: '2026-09-06T02:40:00.000Z', agent_reply_deferred_at: options.deferred ? '2026-09-06T02:40:01.000Z' : null };
  const supabase = { from(table: string) {
    let direction: unknown;
    let manualOnly = false;
    const q = {
      select() { return q; }, eq(key: string, value: unknown) { if (key === 'direction') direction = value; return q; },
      or() { manualOnly = true; return q; },
      not() { return q; }, gt() { return q; }, gte() { return q; }, lte() { return q; }, order() { return q; }, limit() { return q; },
      maybeSingle: async () => ({ data: { name: '테스트', phone: null }, error: null }),
      then(resolve: (value: unknown) => unknown) {
        const data = table === 'messages' ? direction === 'inbound' ? [inbound] : manualOnly && !options.manualReply ? [] : [{ id: 'old-handler-response' }]
          : table === 'job_candidates' ? [{ agent_state: { meta: { last_run_at: current } } }]
          : table === 'message_drafts' && options.drafted ? [{ id: 'draft-for-in-2' }] : [];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    }; return q;
  } };
  const stubs: Record<string, unknown> = {
    'next/server': { NextResponse: { json: (value: unknown) => value } },
    '@/lib/supabase': { createServiceClient: () => supabase }, '@/lib/cron-auth': { requireCronAuth: () => null },
    '@/lib/slack': { sendSlackText: async () => {} }, '@/lib/agent/kill-switch': { getAgentMode: async () => options.mode ?? 'auto' },
    '@/lib/agent/router': { runAgentForCandidate: async () => { runs++; return { ok: true, reply_sent: true }; } },
    '@/lib/agent/inbound-routing': { pickCandidateForInbound: async () => options.paused ? { ok: false, reason: 'paused' } : { ok: true, candidate: { id: 22 } } },
    '@/lib/agent/availability': {}, '@/lib/solapi': {},
    '@/lib/sms-consent-policy': { isExplicitSmsOptOutText: () => false },
  };
  class FixedDate extends Date { constructor(value: string | number = current) { super(value); } static now() { return Date.parse(current); } }
  const exports: Record<string, unknown> = {};
  const source = readFileSync(new URL('../../app/api/admin/cron/inbound-sweeper/route.ts', import.meta.url), 'utf8');
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (name: string) => { if (!(name in stubs)) throw new Error(name); return stubs[name]; }, Date: FixedDate, console,
      setTimeout: (callback: () => void) => callback() });
  await (exports.GET as (req: unknown) => Promise<unknown>)({});
  return runs;
}
test('busy inbound is recovered despite an older turn finishing later', async () => assert.equal(await sweep({ deferred: true }), 1));
test('ordinary handled inbound is still skipped', async () => assert.equal(await sweep({}), 0));
test('exact inbound draft still prevents a duplicate reply', async () => assert.equal(await sweep({ deferred: true, drafted: true }), 0));
test('deferred inbound never bypasses paused routing or kill-switch', async () => {
  assert.equal(await sweep({ deferred: true, paused: true }), 0);
  assert.equal(await sweep({ deferred: true, mode: 'off' }), 0);
});

test('a manager reply resolves even a deferred inbound', async () => assert.equal(await sweep({ deferred: true, manualReply: true }), 0));
