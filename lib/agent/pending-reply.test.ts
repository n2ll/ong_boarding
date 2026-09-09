import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPendingAgentReply } from './pending-reply.ts';

const inbound = { id: 'inbound-1', body: '1, 3번\n22일 가능', created_at: '2026-09-09T07:33:46Z', direction: 'inbound', applicant_id: 1 };
function db(patch: Record<string, any[]> = {}, fail?: string) {
  const rows: Record<string, any[]> = { messages: [inbound], applicants: [{ id: 1, status: '인력풀', sms_opt_out_at: null, agent_reply_claim_key: null }], message_drafts: [], pool_engage_send_requests: [], manual_message_send_requests: [], ...patch };
  return { from(table: string) {
    let selected = rows[table]; let max = 100;
    const q = {
      select() { return q; }, eq(k: string, v: unknown) { selected = selected.filter(r => r[k] === v); return q; },
      gte(k: string, v: string) { selected = selected.filter(r => r[k] >= v); return q; },
      in(k: string, v: unknown[]) { selected = selected.filter(r => v.includes(r[k])); return q; },
      order(k: string) { selected = [...selected].sort((a, b) => String(b[k]).localeCompare(String(a[k]))); return q; },
      limit(n: number) { max = n; return q; },
      maybeSingle() { return Promise.resolve({ data: selected[0] ?? null, error: fail === table ? { message: 'offline' } : null }); },
      then(resolve: (v: unknown) => void) { resolve({ data: selected.slice(0, max), error: fail === table ? { message: 'offline' } : null }); },
    }; return q;
  } } as any;
}
test('returns exact original text and received timestamp for unanswered input', async () => {
  const r = await loadPendingAgentReply(db(), 1, inbound.id, true);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.message, inbound);
});
test('blocks already answered, drafted, newer inbound and queued sending', async () => {
  for (const patch of ([
    { messages: [inbound, { ...inbound, id: 'out', direction: 'outbound', created_at: '2026-09-09T08:00:00Z' }] },
    { message_drafts: [{ inbound_message_id: inbound.id, status: 'auto_sent' }] },
    { messages: [inbound, { ...inbound, id: 'new', created_at: '2026-09-09T08:00:00Z' }] },
    { pool_engage_send_requests: [{ applicant_id: 1, status: 'unknown' }] },
    { manual_message_send_requests: [{ applicant_id: 1, status: 'sent' }] },
  ] as Array<Record<string, any[]>>)) assert.equal((await loadPendingAgentReply(db(patch), 1, inbound.id, true)).ok, false);
});
test('blocks opt-out, excluded applicant and an existing conversation claim before resuming', async () => {
  for (const patch of [{ sms_opt_out_at: 'today' }, { status: '부적합' }, { agent_reply_claim_key: 'busy' }]) {
    assert.equal((await loadPendingAgentReply(db({ applicants: [{ id: 1, ...patch }] }), 1, inbound.id, true)).ok, false);
  }
  assert.equal((await loadPendingAgentReply(db({ applicants: [{ id: 1, agent_reply_claim_key: 'own-claim' }] }), 1, inbound.id)).ok, true);
});
test('fails closed on lookup failures, missing applicant and empty inbox', async () => {
  for (const table of ['messages', 'applicants', 'message_drafts', 'pool_engage_send_requests', 'manual_message_send_requests']) {
    assert.equal((await loadPendingAgentReply(db({}, table), 1)).ok, false);
  }
  assert.equal((await loadPendingAgentReply(db({ messages: [] }), 1)).ok, false);
  assert.equal((await loadPendingAgentReply(db({ applicants: [] }), 1)).ok, false);
});
