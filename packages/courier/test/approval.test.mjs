import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, requestHash } from '../dist/canonical.js';
import { verifyApproval, consumeApproval, approvalIsUsed } from '../dist/approval.js';
import { Watcher } from '../dist/watch.js';
import { k } from '../dist/keys.js';

test('canonical JSON: shared vector with the /courier view', () => {
  const canonical = canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }] });
  assert.equal(canonical, '{"a":[{"c":"x","d":2}],"b":1}');
  assert.equal(requestHash({ b: 1, a: [{ d: 2, c: 'x' }] }), createHash('sha256').update(canonical).digest('hex'));
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }), 'key order does not matter');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]), 'array order does');
});

test('canonical JSON keeps a parsed "__proto__" key, like the view\'s string-built version', () => {
  assert.equal(canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":1}')), '{"__proto__":{"x":1},"a":1}');
  assert.notEqual(requestHash(JSON.parse('{"__proto__":{"x":1},"a":1}')), requestHash({ a: 1 }));
});

const NOW = Date.parse('2026-10-20T12:00:00Z');
const request = {
  id: '01M5CBKA6RNA3RZ2819T9M7NDZ', peer: 'hunter', threadId: '01M5C9EDF03QMRZS2DJXGN5A4C', taskId: '01M5CBKA6RNA3RZ2819T9M7NK1', verb: 'merge', target: 'tinycloudlabs/docs#42', summary: 'Merge docs PR 42',
  action: 'gh pr merge 42', reason: 'docs only', risk: 'low',
  requestedBy: { owner: 'did:pkh:o', agent: 'did:key:a' },
  createdAt: '2026-10-20T10:00:00Z', expiresAt: '2026-10-21T10:00:00Z', status: 'pending',
};
const approval = (over = {}, req = request) => ({
  requestId: '01M5CBKA6RNA3RZ2819T9M7NDZ', requestHash: requestHash(req), decision: 'approved', note: 'ok', decidedAt: '2026-10-20T11:00:00Z', ...over,
});
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no error'; };

test('verifyApproval accepts a matching, current approval and returns what was approved', () => {
  const v = verifyApproval('01M5CBKA6RNA3RZ2819T9M7NDZ', request, approval(), { now: NOW, verb: 'merge', target: 'tinycloudlabs/docs#42' });
  assert.deepEqual([v.decision, v.verb, v.target, v.summary, v.peer, v.threadId, v.taskId], ['approved', 'merge', 'tinycloudlabs/docs#42', 'Merge docs PR 42', 'hunter', '01M5C9EDF03QMRZS2DJXGN5A4C', '01M5CBKA6RNA3RZ2819T9M7NK1']);
});

test('verifyApproval refuses anything that is not exactly this request, decision and time window', () => {
  const v = (a, opts = {}, req = request) => code(() => verifyApproval('01M5CBKA6RNA3RZ2819T9M7NDZ', req, a, { now: NOW, ...opts }));
  assert.equal(v(undefined), 'approval-missing');
  assert.equal(v(approval({ requestId: 'R2' })), 'approval-mismatch');
  assert.equal(v(approval({ decision: 'approve' })), 'approval-mismatch', 'decision literals are "approved"/"denied"');
  assert.equal(v(approval({ requestHash: '0'.repeat(64) })), 'approval-mismatch');
  assert.equal(v(approval(), {}, { ...request, target: 'tinycloudlabs/docs#43' }), 'approval-mismatch', 'the request was edited after the decision');
  assert.equal(v(approval(), { verb: 'merge', target: 'tinycloudlabs/docs#43' }), 'approval-mismatch', 'caller is about to merge a different PR');
  assert.equal(v(approval(), { verb: 'deploy', target: 'tinycloudlabs/docs#42' }), 'approval-mismatch', 'caller is about to do a different kind of thing');
  const older = { ...request, createdAt: '2026-10-19T00:00:00Z', expiresAt: '2026-10-20T00:00:00Z' };
  assert.equal(v(approval({ decidedAt: '2026-10-19T11:00:00Z' }, older), {}, older), 'approval-expired', 'decided 25 h ago');
  assert.equal(v(approval({ decidedAt: '2026-10-20T05:00:00Z' }, older), {}, older), 'approval-expired', 'decided after the request expired');
  assert.equal(v(approval({ decidedAt: '2026-10-20T15:00:00Z' })), 'approval-mismatch', 'dated in the future');
  assert.equal(v(approval({ decidedAt: '2026-10-20T09:00:00Z' })), 'approval-mismatch', 'dated before the request existed');
  assert.equal(v(approval({ decidedAt: '2026-10-20T09:59:59Z' })), 'approval-mismatch', 'one second before createdAt: no skew allowance');
  assert.equal(v(approval({ decidedAt: '2026-10-20T10:00:00Z' })), 'no error', 'createdAt itself is inside the window');
  assert.equal(v(approval({ decidedAt: '2026-10-21T10:00:00Z' }), { now: Date.parse('2026-10-21T10:00:30Z') }), 'approval-expired', 'expiresAt itself is outside the window');
  assert.equal(v(approval({ decidedAt: 'yesterday' })), 'approval-mismatch');
});

test('a denial verifies as a denial, never as an approval', () => {
  const v = verifyApproval('01M5CBKA6RNA3RZ2819T9M7NDZ', request, approval({ decision: 'denied', note: 'not now' }), { now: NOW });
  assert.equal(v.decision, 'denied');
});

function memoryKv() {
  const rows = new Map();
  let n = 0;
  return {
    rows,
    async list({ prefix }) { return { ok: true, data: { keys: [...rows.keys()].filter((key) => key.startsWith(prefix)) } }; },
    async get(key) {
      const row = rows.get(key);
      return row ? { ok: true, data: { data: row.value, headers: { etag: row.etag } } } : { ok: false, error: { status: 404, message: 'not found' } };
    },
    async put(key, value, o = {}) {
      const prior = rows.get(key);
      if (o.ifNoneMatch === '*' && prior) return { ok: false, error: { status: 412, message: 'precondition failed' } };
      if (o.ifMatch && o.ifMatch !== prior?.etag) return { ok: false, error: { status: 412, message: 'precondition failed' } };
      rows.set(key, { value: structuredClone(value), etag: `e${++n}` });
      return { ok: true, data: { data: undefined, headers: { etag: `e${n}` } } };
    },
  };
}

test('an approval is single use: the second consume fails and a peek sees it as used', async () => {
  const kv = memoryKv();
  assert.equal(await approvalIsUsed(kv, '01M5CBKA6RNA3RZ2819T9M7NDZ'), false);
  await consumeApproval(kv, '01M5CBKA6RNA3RZ2819T9M7NDZ');
  assert.equal(await approvalIsUsed(kv, '01M5CBKA6RNA3RZ2819T9M7NDZ'), true);
  await assert.rejects(consumeApproval(kv, '01M5CBKA6RNA3RZ2819T9M7NDZ'), (e) => e.code === 'approval-used');
});

function watcherWith(selfKv, wakes, clock) {
  return new Watcher({
    selfKv, spaceId: 's', selfHooks: {}, peerHooks: async () => ({}), loadPeers: () => [], kvFor: async () => selfKv,
    wake: async (r) => { wakes.push(r); }, log: () => {}, now: () => clock.t,
  }, { debounceMs: 30_000, pollMs: 60_000, ticketSeconds: 25 });
}

test('a new approval wakes the thread\'s agent at once, without waiting out the debounce; seen approvals do not wake again', async () => {
  const selfKv = memoryKv();
  const clock = { t: NOW };
  const wakes = [];
  selfKv.rows.set(k.request('01M5CBKA6RNA3RZ2819T9M7NDZ'), { value: request, etag: 'q' });
  selfKv.rows.set(k.threadMeta('hunter', '01M5C9EDF03QMRZS2DJXGN5A4C'), { value: { subject: 'Merge docs' }, etag: 'm' });
  selfKv.rows.set(k.approval('01M5CBKA6RNA3RZ2819T9M7NDZ'), { value: approval(), etag: 'a' });
  const watcher = watcherWith(selfKv, wakes, clock);
  await watcher.syncApprovals('hook');
  await watcher.tick();
  assert.equal(wakes.length, 1);
  assert.deepEqual(wakes[0].approvals, [{ approvalId: '01M5CBKA6RNA3RZ2819T9M7NDZ', requestId: '01M5CBKA6RNA3RZ2819T9M7NDZ', decision: 'approved' }]);
  assert.equal(wakes[0].subject, 'Merge docs');
  assert.deepEqual([wakes[0].peer, wakes[0].threadId, wakes[0].messages.length], ['hunter', '01M5C9EDF03QMRZS2DJXGN5A4C', 0]);
  await watcher.syncApprovals('poll');
  clock.t += 120_000;
  await watcher.tick();
  assert.equal(wakes.length, 1);
});

test('approvals that cannot be acted on wake nobody: used, stale, malformed, or without a request', async () => {
  const selfKv = memoryKv();
  const clock = { t: NOW };
  const wakes = [];
  const put = (key, value) => selfKv.rows.set(key, { value, etag: 'x' });
  put(k.request('USED'), { ...request, id: 'USED' }); put(k.approval('USED'), approval({ requestId: 'USED' })); put(k.approvalUsed('USED'), { usedAt: 'x' });
  put(k.request('OLD'), { ...request, id: 'OLD' }); put(k.approval('OLD'), approval({ requestId: 'OLD', decidedAt: '2026-10-18T00:00:00Z' }));
  put(k.approval('BAD'), { requestId: 'OTHER', decision: 'approved' });
  put(k.approval('NOREQ'), approval({ requestId: 'NOREQ' }));
  const watcher = watcherWith(selfKv, wakes, clock);
  await watcher.syncApprovals('startup');
  clock.t += 120_000;
  await watcher.tick();
  assert.equal(wakes.length, 0);
  assert.deepEqual(watcher.snapshot().approvalsSeen, ['BAD', 'NOREQ', 'OLD', 'USED'], 'all four are marked seen, so they are not re-read every poll');
});

test('a denial wakes the agent too, so it can stop and update the task', async () => {
  const selfKv = memoryKv();
  const wakes = [];
  selfKv.rows.set(k.request('01M5CBKA6RNA3RZ2819T9M7NDZ'), { value: request, etag: 'q' });
  selfKv.rows.set(k.approval('01M5CBKA6RNA3RZ2819T9M7NDZ'), { value: approval({ decision: 'denied' }), etag: 'a' });
  const watcher = watcherWith(selfKv, wakes, { t: NOW });
  await watcher.syncApprovals('hook');
  await watcher.tick();
  assert.equal(wakes[0].approvals[0].decision, 'denied');
});

test('the request hash covers verb, target and summary: changing any of them changes it', () => {
  const base = requestHash(request);
  for (const change of [{ verb: 'deploy' }, { target: 'tinycloudlabs/docs#43' }, { summary: 'Merge docs PR 43' }]) {
    assert.notEqual(requestHash({ ...request, ...change }), base, JSON.stringify(change));
  }
});

test('a request without valid structured fields cannot be approved', () => {
  const v = (req) => code(() => verifyApproval('01M5CBKA6RNA3RZ2819T9M7NDZ', req, approval({}, req), { now: NOW }));
  const { verb, target, summary, ...bare } = request;
  assert.equal(v(bare), 'approval-mismatch', 'an older request with only free-text action');
  assert.equal(v({ ...request, verb: 'MERGE' }), 'approval-mismatch', 'verbs are exact lowercase');
  assert.equal(v({ ...request, verb: 'yolo' }), 'approval-mismatch');
  assert.equal(v({ ...request, target: '' }), 'approval-mismatch');
  assert.equal(v({ ...request, target: 'x'.repeat(201) }), 'approval-mismatch');
  assert.equal(v({ ...request, summary: 'two\nlines' }), 'approval-mismatch');
  assert.equal(v({ ...request, summary: 5 }), 'approval-mismatch');
});
