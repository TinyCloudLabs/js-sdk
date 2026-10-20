import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requestFields, storedRequestFields, requestText } from '../dist/request.js';
import { plainLineProblem, MAX_SUMMARY } from '../dist/text.js';
import { requestHash } from '../dist/canonical.js';
import { verifyApproval } from '../dist/approval.js';

const vectors = JSON.parse(fs.readFileSync(new URL('./vectors/request-fields.json', import.meta.url), 'utf8'));

for (const v of vectors.fields) {
  test(`shared vector: ${v.field} ${v.name} -> ${v.valid ? 'accepted' : 'refused'}`, () => {
    if (v.field === 'summary') {
      assert.equal(plainLineProblem(v.value, MAX_SUMMARY) === undefined, v.valid);
      if (typeof v.value === 'string') {
        const written = () => requestFields({ verb: 'other', target: 'workflow:o/r:ci.yml', summary: v.value });
        if (v.valid) assert.equal(written().summary, v.value, 'accepted text is stored exactly as given');
        else assert.throws(written, (e) => e.code === 'usage', 'refused, not repaired');
      }
    } else {
      const written = () => requestFields({ verb: v.verb, target: v.value, summary: 'ok' }).target;
      if (v.valid) assert.equal(written(), v.value, 'a valid target is already the canonical spelling');
      else {
        let out;
        try { out = written(); } catch (e) { assert.equal(e.code, 'usage'); }
        assert.ok(out === undefined || out !== v.value, 'a refused value is never written as given (it is refused or normalised)');
      }
      const stored = storedRequestFields({ verb: v.verb, target: v.value, summary: 'ok' });
      assert.equal(stored !== undefined, v.valid, 'the stored form is judged by the same rules');
    }
  });
}

test('requestText refuses hidden text in action, why and risk; allows a newline, never a tab or CR, up to 2000', () => {
  const ok = requestText({ action: 'two\nlines', reason: 'line one\nline two', risk: 'a b' }, 'Summary');
  assert.deepEqual([ok.action, ok.risk], ['two\nlines', 'a b']);
  assert.throws(() => requestText({ reason: 'a\tb' }, 's'), (e) => /--why is refused/.test(e.message));
  assert.throws(() => requestText({ reason: 'a\r\nb' }, 's'), (e) => /--why is refused/.test(e.message));
  assert.doesNotThrow(() => requestText({ reason: 'x'.repeat(2000) }, 's'));
  assert.throws(() => requestText({ reason: 'r\u202ex' }, 's'), (e) => /--why is refused/.test(e.message));
  assert.throws(() => requestText({ reason: 'r', risk: 'x\u{E0041}' }, 's'), (e) => /--risk is refused/.test(e.message));
  assert.throws(() => requestText({ reason: 'x'.repeat(2001) }, 's'), (e) => /--why is refused/.test(e.message));
});

const NOW = Date.parse('2026-10-20T12:00:00Z');
const base = {
  id: 'R1', peer: 'hunter', threadId: 'T1', taskId: 'K1', verb: 'merge', target: 'tinycloudlabs/docs#42', summary: 'Merge docs PR 42',
  action: 'Merge docs PR 42', reason: 'docs only', risk: 'low',
  requestedBy: { owner: 'did:pkh:o', agent: 'did:key:a' },
  createdAt: '2026-10-20T10:00:00Z', expiresAt: '2026-10-21T10:00:00Z', status: 'pending',
};
const approve = (req) => {
  let hash = 'x';
  try { hash = requestHash(req); } catch { /* unhashable: the approval carries a made-up hash */ }
  return { requestId: 'R1', requestHash: hash, decision: 'approved', note: '', decidedAt: '2026-10-20T11:00:00Z' };
};
const code = (req) => { try { verifyApproval('R1', req, approve(req), { now: NOW }); } catch (e) { return `${e.code}: ${e.message.slice(0, 70)}`; } return 'ok'; };

test('courier approval refuses a request that hides text anywhere, even in a free-text field it does not match on', () => {
  assert.equal(code(base), 'ok');
  assert.match(code({ ...base, reason: 'docs\u{E0041}' }), /^approval-mismatch/);
  assert.match(code({ ...base, risk: 'low\u202e' }), /^approval-mismatch/);
  assert.match(code({ ...base, summary: 'Merge\u200b docs PR 42' }), /^approval-mismatch/);
  assert.match(code({ ...base, action: 'gh pr merge 12\ufe0f' }), /^approval-mismatch/);
  assert.match(code({ ...base, ['k\u200bey']: 1 }), /^approval-mismatch/, 'also in keys');
});

test('courier approval fails closed on a request that cannot be hashed (non-finite number, deep nesting)', () => {
  assert.match(code({ ...base, extra: JSON.parse('1e999') }), /^approval-mismatch.*cannot be verified/);
  assert.match(code({ ...base, extra: JSON.parse('['.repeat(70) + ']'.repeat(70)) }), /^approval-mismatch.*cannot be verified/);
});

test('courier approval requires the stored target to be the canonical, ASCII spelling of its verb', () => {
  assert.match(code({ ...base, target: 'TinyCloudLabs/docs#42' }), /^approval-mismatch/, 'hand-written non-canonical');
  assert.match(code({ ...base, target: 'tinycloudlabs/d\u043ecs#42' }), /^approval-mismatch/, 'cyrillic lookalike');
  assert.match(code({ ...base, verb: 'deploy' }), /^approval-mismatch/, 'a merge target filed as a deploy');
});

test('the target must match exactly and the verb must match the kind of command', () => {
  const req = base;
  const run = (opts) => { try { verifyApproval('R1', req, approve(req), { now: NOW, ...opts }); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(run({ verb: 'merge', target: 'tinycloudlabs/docs#42' }), 'ok');
  assert.equal(run({ verb: 'merge', target: 'tinycloudlabs/docs#4' }), 'approval-mismatch', 'prefix of the number is not a match');
  assert.equal(run({ verb: 'merge', target: 'tinycloudlabs/docs#42 ' }), 'approval-mismatch');
  assert.equal(run({ verb: 'publish', target: 'tinycloudlabs/docs#42' }), 'approval-mismatch');
  assert.equal(run({ verb: 'other', target: 'tinycloudlabs/docs#42' }), 'approval-mismatch');
});

test('the approval note and decidedAt are swept like the request, since they are echoed to the agent', () => {
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  const req = { ...base };
  const hash = requestHash(req);
  const run = (over) => { try { verifyApproval('R1', req, { requestId: 'R1', requestHash: hash, decision: 'approved', note: '', decidedAt: '2026-10-20T11:00:00Z', ...over }, { now: NOW }); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(run({}), 'ok');
  assert.equal(run({ note: 'fine, go ahead' }), 'ok');
  assert.equal(run({ note: 'ok\u{E0041}' }), 'approval-mismatch', 'tag characters in the note');
  assert.equal(run({ note: 'ok\u202e' }), 'approval-mismatch');
  assert.equal(run({ note: 5 }), 'approval-mismatch');
  assert.equal(run({ note: 'x'.repeat(2001) }), 'approval-mismatch');
  assert.equal(run({ decidedAt: '2026-10-20T11:00:00Z\u200b' }), 'approval-mismatch', 'zero-width space after the timestamp');
  assert.equal(run({ decidedAt: ' 2026-10-20T11:00:00Z' }), 'approval-mismatch');
});

test('courier approval --action is an explicit error that points at --verb and --target', async () => {
  const { main } = await import('../dist/main.js');
  const original = console.error;
  let message = '';
  console.error = (m) => { message += String(m); };
  try {
    assert.equal(await main(['approval', 'R1', '--action', 'gh pr merge 1']), 2);
  } finally {
    console.error = original;
  }
  assert.match(message, /--action no longer exists/);
  assert.match(message, /--verb/);
});

test('requestIds: thread and task ids that are not ULID-like are refused before anything is written', async () => {
  const { requestIds } = await import('../dist/request.js');
  assert.doesNotThrow(() => requestIds({ threadId: '01M5C9EDF03QMRZS2DJXGN5A4C', taskId: 'K1_a-b' }));
  for (const bad of ['', 'a b', 'a\nb', 'a/b', 'x'.repeat(65), 'caf\u00e9', 'a\u200bb']) {
    assert.throws(() => requestIds({ threadId: bad, taskId: 'K1' }), (e) => e.code === 'usage', JSON.stringify(bad));
    assert.throws(() => requestIds({ threadId: 'T1', taskId: bad }), (e) => e.code === 'usage', JSON.stringify(bad));
  }
});

test('verifyApproval returns the request hash (the view\'s fingerprint is its first 8 hex digits)', async () => {
  const { createHash } = await import('node:crypto');
  const { canonicalJson } = await import('../dist/canonical.js');
  const req = { ...base };
  const v = verifyApproval('R1', req, approve(req), { now: NOW });
  assert.equal(v.requestHash, createHash('sha256').update(canonicalJson(req), 'utf8').digest('hex'));
  assert.match(v.requestHash, /^[0-9a-f]{64}$/);
});

test('the read side refuses an empty or malformed action, reason or risk, like the writer', () => {
  const run = (over) => { const req = { ...base, ...over }; try { verifyApproval('R1', req, approve(req), { now: NOW }); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(run({}), 'ok');
  assert.equal(run({ action: '' }), 'approval-mismatch');
  assert.equal(run({ reason: '' }), 'approval-mismatch');
  assert.equal(run({ risk: 7 }), 'approval-mismatch');
  assert.equal(run({ action: 'x'.repeat(2001) }), 'approval-mismatch');
});

test('PR numbers are exact digits: nothing is rounded through a float, over 9 digits is refused', async () => {
  const { canonicalTarget } = await import('../dist/guard/target.js');
  assert.equal(canonicalTarget('merge', 'O/R#0042'), 'o/r#42');
  assert.equal(canonicalTarget('merge', 'https://github.com/O/R/pull/000123/files'), 'o/r#123');
  assert.equal(canonicalTarget('merge', 'o/r#999999999'), 'o/r#999999999');
  for (const bad of ['o/r#1000000000', 'o/r#99999999999999999999', 'o/r#0', 'o/r#000']) {
    assert.throws(() => canonicalTarget('merge', bad), (e) => e.code === 'usage', bad);
  }
});

test('courier request --help prints the target forms, not the global help', async () => {
  const { main } = await import('../dist/main.js');
  const original = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (chunk) => { out += String(chunk); return true; };
  try {
    assert.equal(await main(['request', '--help']), 0);
  } finally {
    process.stdout.write = original;
  }
  assert.match(out, /--verb merge\|deploy\|publish\|spend\|other/);
  assert.match(out, /owner\/repo#<PR number>/);
  assert.match(out, /npm:<name>@<version>/);
  assert.ok(!/Setup & pairing/.test(out));
});
