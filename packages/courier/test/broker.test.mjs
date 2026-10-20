import { privateScratch } from './private-scratch.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { runApproved, templateFor, brokerEnv, sanitizeOutput, MAX_OUTPUT, loadBrokerCredential } from '../dist/broker.js';
import fs from 'node:fs';
import path from 'node:path';
import { loadBrokerConfig } from '../dist/broker-config.js';
const scratchRoot = privateScratch('tc712-broker-test-');
after(() => fs.rmSync(scratchRoot, { recursive: true, force: true }));
import { requestHash } from '../dist/canonical.js';
import { k } from '../dist/keys.js';

const ID = '01JTR100000000000000000000';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const SHA = 'a'.repeat(40);
const BASE = 'master';
const TOKEN = `ghp_${'d'.repeat(36)}`; // Dummy only.
function fixture({ verb = 'merge', target = 'a/b#42', request = {}, approval = {} } = {}) {
  const req = { id: ID, peer: 'bob', threadId: ID, taskId: ID, verb, target, ...(verb === 'merge' ? { headSha: SHA, base: BASE } : {}), summary: 'Merge docs', reason: 'test', risk: 'low', requestedBy: { owner: 'did:pkh:o', agent: 'did:key:a' }, createdAt: '2026-10-20T10:00:00Z', expiresAt: '2026-10-21T10:00:00Z', status: 'pending', ...request };
  const rows = new Map([[k.request(ID), req], [k.approval(ID), { requestId: ID, requestHash: requestHash(req), decision: 'approved', decidedAt: '2026-10-20T11:00:00Z', ...approval }]]);
  const calls = [];
  const kv = {
    async get(key, options) {
      if (key === k.approvalUsed(ID)) assert.equal(options.source, 'network');
      return rows.has(key) ? { ok: true, data: { data: rows.get(key), headers: {} } } : { ok: false, error: { code: 'KV_NOT_FOUND', message: 'Key not found' } };
    },
    async put(key, value, options) {
      assert.equal(options.ifNoneMatch, '*');
      if (rows.has(key)) return { ok: false, error: { status: 412 } };
      rows.set(key, value);
      return { ok: true, data: { headers: {} } };
    },
  };
  const deps = {
    kv, scratchRoot, now: () => NOW,
    credential: () => ({ ghBin: '/stub/gh', token: TOKEN }),
    exec: async (bin, args, options) => {
      calls.push({ bin, args, options });
      assert.equal(bin, '/stub/gh');
      assert.equal(options.env.GH_TOKEN, TOKEN);
      if (args[1] === 'view') {
        assert.ok(!rows.has(k.approvalUsed(ID)), 'read-only preflight is before consumption');
        return { code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: SHA, baseRefName: BASE, isDraft: false }), stderr: '' };
      }
      assert.ok(rows.has(k.approvalUsed(ID)), 'marker exists BEFORE merge exec');
      return { code: 0, stdout: `untrusted output ${TOKEN}`, stderr: '' };
    },
  };
  return { deps, rows, calls };
}
const unused = f => assert.ok(!f.rows.has(k.approvalUsed(ID)), 'nothing consumed');

test('broker builds only the fixed argv, consumes BEFORE exec, and refuses replay and marker overwrite', async () => {
  const f = fixture();
  const out = await runApproved(ID, f.deps);
  assert.equal(out.ok, true);
  assert.equal(out.consumed, true);
  assert.equal(out.headSha, SHA);
  assert.match(out.output, /untrusted output \[redacted\]/);
  assert.deepEqual(f.calls.map(c => c.args), [
    ['pr', 'view', '42', '--repo=a/b', '--json', 'state,headRefOid,isDraft,baseRefName'],
    ['pr', 'merge', '42', '--repo=a/b', '--squash', `--match-head-commit=${SHA}`],
  ]);
  await assert.rejects(runApproved(ID, f.deps), { code: 'approval-used' });
  f.rows.set(k.approvalUsed(ID), 'overwritten garbage');
  await assert.rejects(runApproved(ID, f.deps), { code: 'approval-used' });
  assert.equal(f.calls.length, 2);
});

test('hash mismatch, expired, denied, missing and forged approval refuse before execution or consume', async () => {
  const cases = [
    [f => { f.rows.get(k.request(ID)).target = 'a/b#43'; }, 'approval-mismatch'],
    [f => { f.rows.get(k.request(ID)).headSha = 'b'.repeat(40); }, 'approval-mismatch'],
    [f => { f.rows.get(k.request(ID)).base = 'release'; }, 'approval-mismatch'],
    [f => { f.deps.now = () => NOW + 25 * 3600_000; }, 'approval-expired'],
    [f => { f.rows.get(k.approval(ID)).decision = 'denied'; }, 'approval-denied'],
    [f => { f.rows.delete(k.approval(ID)); }, 'approval-missing'],
    [f => { f.rows.get(k.approval(ID)).requestId = 'OTHER'; }, 'approval-mismatch'],
    [f => { f.rows.get(k.approval(ID)).requestHash = 'invented'; }, 'approval-mismatch'],
    [f => { f.rows.set(k.approval(ID), { decision: 'approved' }); }, 'approval-mismatch'],
  ];
  for (const [change, code] of cases) {
    const f = fixture(); change(f);
    await assert.rejects(runApproved(ID, f.deps), { code });
    unused(f); assert.equal(f.calls.length, 0);
  }
});

test('non-merge verbs and direct pushes refuse before consuming or loading credentials', async () => {
  for (const [verb, target] of [['publish', 'npm:@x/y@1.0.0'], ['deploy', 'phala:app'], ['spend', 'spend:one dollar'], ['other', 'workflow:a/b:ci.yml'], ['merge', 'a/b@main']]) {
    const f = fixture({ verb, target });
    f.deps.credential = () => { throw new Error('must not load'); };
    await assert.rejects(runApproved(ID, f.deps), { code: 'broker-unsupported' });
    unused(f); assert.equal(f.calls.length, 0);
  }
});

test('credential missing, unavailable marker and create failure consume nothing and run no merge', async () => {
  const f = fixture();
  f.deps.credential = () => loadBrokerConfig('a'.repeat(24), scratchRoot);
  await assert.rejects(runApproved(ID, f.deps), { code: 'broker-not-configured' });
  unused(f); assert.equal(f.calls.length, 0);
  const g = fixture();
  const get = g.deps.kv.get;
  g.deps.kv.get = (key, opts) => key === k.approvalUsed(ID) ? { ok: false, error: { status: 503 } } : get(key, opts);
  await assert.rejects(runApproved(ID, g.deps), { code: 'approval-state-unknown' });
  unused(g); assert.equal(g.calls.length, 0);
  const h = fixture(); h.deps.kv.put = async () => ({ ok: false, error: { status: 500, message: 'down' } });
  await assert.rejects(runApproved(ID, h.deps));
  unused(h); assert.equal(h.calls.length, 1);
});

test('closed, merged, draft, missing head and failed view refuse with nothing consumed', async () => {
  for (const state of [{ state: 'CLOSED', headRefOid: SHA }, { state: 'MERGED', headRefOid: SHA }, { state: 'OPEN', isDraft: true, headRefOid: SHA }, { state: 'OPEN', headRefOid: 'bad' }, undefined]) {
    const f = fixture();
    f.deps.exec = async () => ({ code: state ? 0 : 1, stdout: state ? JSON.stringify(state) : '', stderr: '' });
    await assert.rejects(runApproved(ID, f.deps), /nothing was consumed/);
    unused(f);
  }
});

test('one of two racing brokers wins the create-only marker', async () => {
  const f = fixture();
  // Both may view before either consumes. The fake executor checks marker only for merge here.
  const exec = f.deps.exec;
  f.deps.exec = (bin, args, options) => args[1] === 'view'
    ? Promise.resolve({ code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: SHA, baseRefName: BASE }), stderr: '' })
    : exec(bin, args, options);
  const results = await Promise.allSettled([runApproved(ID, f.deps), runApproved(ID, f.deps)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'approval-used');
  assert.equal(f.calls.length, 1);
});

test('execution failure stays consumed; output is bounded, redacted, and labelled untrusted', async () => {
  const f = fixture(); const exec = f.deps.exec;
  f.deps.exec = async (bin, args, options) => args[1] === 'view' ? exec(bin, args, options) : { code: 7, stdout: `${TOKEN}\x1b[31m${'x'.repeat(5000)}`, stderr: '' };
  const result = await runApproved(ID, f.deps);
  assert.equal(result.ok, false); assert.equal(result.exitCode, 7); assert.equal(result.consumed, true);
  assert.match(result.note, /new request/); assert.ok(!result.output.includes(TOKEN));
  assert.ok(result.output.length < MAX_OUTPUT + 100); assert.ok(!result.output.includes('\x1b'));
  await assert.rejects(runApproved(ID, f.deps), { code: 'approval-used' });
});

test('template grammar rejects target injection and never uses agent argv, environment or cwd', () => {
  for (const target of ['a/b#42; echo hi', 'a/b#42 --admin', '-R/b#42', 'a/b#42\nls', 'a/b#$(x)', 'a/b#0', 'a/b#42/../../x', 'a/b@main']) assert.throws(() => templateFor('merge', target));
  assert.deepEqual(templateFor('merge', 'https://github.com/A/B/pull/0042').merge(SHA), ['pr', 'merge', '42', '--repo=a/b', '--squash', `--match-head-commit=${SHA}`]);
  const env = brokerEnv({ ghBin: '/stub/gh', token: TOKEN }, '/scratch/broker');
  assert.equal(env.HOME, '/scratch/broker'); assert.equal(env.GH_CONFIG_DIR, '/scratch/broker/gh');
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.GH_HOST, undefined); assert.equal(env.COURIER_HOME, undefined);
  assert.equal(sanitizeOutput(`a ${TOKEN} b`, [TOKEN]), 'a [redacted] b');
});
