import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { approvalPhase, readApprovalEntry, stageOf } from '../dist/approval-phase.js';

// TC-2383: `approvalPhase` is the one place that classifies a saved approval request (approval-pending.json): none, open, held (stage
// ref / result / committed), unreadable, corrupt, or orphaned (a live request whose profile or agent key is missing). It follows what the code
// did before: a request is held once any of resultRef, resultEnvelope or committed is set; the request's own expiry gives `lapsed`
// only while nothing is held. No other timing rule is added.

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const FUTURE = '2026-06-02T00:00:00.000Z';
const PAST = '2026-05-31T00:00:00.000Z';

const record = (extra = {}, expiresAt = FUTURE) => ({
  version: 1, request: {}, requestId: 'r', bodyCid: 'b', approvalUrl: 'https://x.test/a', requestExpiresAt: expiresAt,
  record: {}, apiOrigin: 'https://x.test', linkApiOrigin: 'https://x.test', openkeyOrigin: 'https://x.test', relayPrivateKey: 'k', ackId: 'a', ...extra,
});
const ok = (extra, expiresAt) => ({ kind: 'ok', pending: record(extra, expiresAt) });
const BOTH = { profile: true, key: true };

// ---- the phase of every entry kind and every stage ----

const PHASES = [
  ['no file', { kind: 'none' }, { phase: 'none' }],
  ['an open request that has not expired', ok(), { phase: 'open', lapsed: false }],
  ['an open request past its own expiry', ok({}, PAST), { phase: 'open', lapsed: true }],
  ['a request expiring exactly now', ok({}, new Date(NOW).toISOString()), { phase: 'open', lapsed: true }],
  ['a result reference only', ok({ resultRef: 'ref', resultExpiresAt: FUTURE }), { phase: 'held', stage: 'ref' }],
  ['a collected encrypted result', ok({ resultRef: 'ref', resultEnvelope: { relay: 1 } }), { phase: 'held', stage: 'result' }],
  ['an encrypted result without a reference', ok({ resultEnvelope: { relay: 1 } }), { phase: 'held', stage: 'result' }],
  ['a committed grant', ok({ resultRef: 'ref', resultEnvelope: {}, committed: true }), { phase: 'held', stage: 'committed' }],
  ['a commit marker alone', ok({ committed: true }), { phase: 'held', stage: 'committed' }],
  ['a held request past its own expiry (the result is what matters)', ok({ resultRef: 'ref' }, PAST), { phase: 'held', stage: 'ref' }],
  ['an unreadable file', { kind: 'unreadable', reason: 'mode 644', fix: 'chmod 600 f' }, { phase: 'unreadable', reason: 'mode 644', fix: 'chmod 600 f' }],
  ['a readable file that is not a request', { kind: 'corrupt', reason: 'unexpected contents' }, { phase: 'corrupt', reason: 'unexpected contents' }],
];

for (const [name, entry, expected] of PHASES) {
  test(`approvalPhase: ${name}`, () => {
    assert.deepEqual(approvalPhase(entry, BOTH, NOW), expected);
  });
}

test('stageOf: committed outranks a collected result, which outranks a reference; nothing set is no stage', () => {
  assert.equal(stageOf(record()), undefined);
  assert.equal(stageOf(record({ resultRef: 'r' })), 'ref');
  assert.equal(stageOf(record({ resultRef: 'r', resultEnvelope: {} })), 'result');
  assert.equal(stageOf(record({ resultEnvelope: {} })), 'result');
  assert.equal(stageOf(record({ resultRef: 'r', resultEnvelope: {}, committed: true })), 'committed');
  assert.equal(stageOf(record({ committed: true })), 'committed');
  assert.equal(stageOf(record({ resultRef: '' })), 'ref', 'an empty reference is still set, as before');
});

// ---- orphaned: a live request whose profile or agent key is missing ----

for (const [name, entry, was] of [
  ['open', ok(), { phase: 'open', lapsed: false }],
  ['held (reference)', ok({ resultRef: 'ref' }), { phase: 'held', stage: 'ref' }],
  ['held (result)', ok({ resultEnvelope: {} }), { phase: 'held', stage: 'result' }],
  ['held (committed)', ok({ committed: true }), { phase: 'held', stage: 'committed' }],
  ['unreadable', { kind: 'unreadable', reason: 'r', fix: 'f' }, { phase: 'unreadable', reason: 'r', fix: 'f' }],
]) {
  for (const [missing, presence] of [['profile', { profile: false, key: true }], ['agent key', { profile: true, key: false }], ['both', { profile: false, key: false }]]) {
    test(`approvalPhase: a ${name} request with the ${missing} missing is orphaned and says what it was`, () => {
      assert.deepEqual(approvalPhase(entry, presence, NOW), { phase: 'orphaned', was });
    });
  }
}

test('approvalPhase: nothing saved, or a corrupt file, is never orphaned', () => {
  for (const presence of [{ profile: false, key: false }, { profile: false, key: true }, { profile: true, key: false }]) {
    assert.deepEqual(approvalPhase({ kind: 'none' }, presence, NOW), { phase: 'none' });
    assert.equal(approvalPhase({ kind: 'corrupt', reason: 'x' }, presence, NOW).phase, 'corrupt');
  }
});

test('approvalPhase: the presence argument is optional and means both are present', () => {
  assert.deepEqual(approvalPhase(ok(), undefined, NOW), { phase: 'open', lapsed: false });
});

test('approvalPhase: the clock defaults to now', () => {
  assert.deepEqual(approvalPhase(ok({}, new Date(Date.now() + 3_600_000).toISOString())), { phase: 'open', lapsed: false });
  assert.deepEqual(approvalPhase(ok({}, new Date(Date.now() - 3_600_000).toISOString())), { phase: 'open', lapsed: true });
});

// ---- the reader: what is on disk becomes an entry ----

function withHome(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-phase-'));
  const previous = process.env.COURIER_HOME;
  process.env.COURIER_HOME = path.join(root, 'courier');
  fs.mkdirSync(process.env.COURIER_HOME, { recursive: true, mode: 0o700 });
  fs.chmodSync(process.env.COURIER_HOME, 0o700);
  try { run(process.env.COURIER_HOME); } finally {
    if (previous === undefined) delete process.env.COURIER_HOME; else process.env.COURIER_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const put = (home, content, mode = 0o600) => {
  const file = path.join(home, 'approval-pending.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), { mode });
  fs.chmodSync(file, mode);
};

test('readApprovalEntry: none, ok, unreadable (loose mode, loose directory, newer version) and corrupt; it changes nothing', () => {
  withHome((home) => {
    assert.deepEqual(readApprovalEntry(), { kind: 'none' });
    put(home, record({ resultRef: 'ref' }));
    const entry = readApprovalEntry();
    assert.equal(entry.kind, 'ok');
    assert.equal(entry.pending.resultRef, 'ref');
    assert.deepEqual(approvalPhase(entry, BOTH, NOW), { phase: 'held', stage: 'ref' });

    put(home, record(), 0o644);
    const loose = readApprovalEntry();
    assert.equal(loose.kind, 'unreadable');
    assert.match(loose.fix, /chmod 600/);
    put(home, record());

    fs.chmodSync(home, 0o755);
    const dir = readApprovalEntry();
    assert.equal(dir.kind, 'unreadable');
    assert.match(dir.fix, /chmod 700/);
    fs.chmodSync(home, 0o700);

    put(home, { ...record(), version: 2 });
    assert.equal(readApprovalEntry().kind, 'unreadable', 'written by a newer Courier: not ours to set aside');

    const before = fs.readFileSync(path.join(home, 'approval-pending.json'));
    put(home, '{ not json');
    assert.equal(readApprovalEntry().kind, 'corrupt');
    put(home, { version: 1 });
    assert.equal(readApprovalEntry().kind, 'corrupt');
    assert.notDeepEqual(before, Buffer.alloc(0));
    assert.equal(fs.readFileSync(path.join(home, 'approval-pending.json'), 'utf8'), JSON.stringify({ version: 1 }), 'the reader never rewrites the file');
  });
});
