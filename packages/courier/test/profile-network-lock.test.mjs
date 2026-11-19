import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { withProfileTransaction, saveProfile, loadProfile } from '../dist/profile.js';
import { loadPendingForWrite, savePending } from '../dist/approval-phase.js';

const home = process.env.COURIER_HOME;
const lock = path.join(home, 'profile.json.lock');
const pendingFile = path.join(home, 'approval-pending.json');
const seed = () => saveProfile({ version: 3, host: 'http://127.0.0.1:1', openkeyHost: 'http://127.0.0.1:1', courierDid: 'did:key:self', label: 'before', status: 'ready', peers: {} });
const pending = (id) => ({ version: 1, request: {}, requestId: id, bodyCid: `body-${id}`, approvalUrl: 'http://127.0.0.1:1/a', requestExpiresAt: '2099-01-01', record: {}, apiOrigin: 'http://127.0.0.1:1', linkApiOrigin: 'http://127.0.0.1:1', openkeyOrigin: 'http://127.0.0.1:1', relayPrivateKey: 'fixture', ackId: id });

async function localNetwork(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, init) => {
    assert.equal(new URL(typeof input === 'string' ? input : input.url ?? input.href).origin, origin, 'all requests stay on the local listener');
    assert.equal(fs.existsSync(lock), false, 'no network call starts while profile.json.lock is held');
    return fetch(input, init);
  });
  return origin;
}

test('profile network work releases the lock and keeps a concurrent writer when it commits', async t => {
  seed();
  let release;
  let arrived;
  const started = new Promise(resolve => { arrived = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const origin = await localNetwork(t, async (_req, res) => { arrived(); await response; res.end('ok'); });
  const first = withProfileTransaction(async (profile, save) => {
    await (await fetch(origin)).text();
    profile.label = 'network result';
    save();
  });
  // Catch a synchronous assertion in the network guard without leaving an unhandled rejection.
  const outcome = first.then(() => undefined, error => error);
  await Promise.race([started, outcome.then(error => { if (error) throw error; })]);
  try {
    await withProfileTransaction(async (profile, save) => { profile.selfHandle = 'concurrent'; save(); });
  } finally { release(); }
  const error = await outcome;
  if (error) throw error;
  assert.equal(loadProfile().label, 'network result');
  assert.equal(loadProfile().selfHandle, 'concurrent');
  assert.equal(fs.existsSync(lock), false);
});

test('two approval sidecar updates preserve the result reference and encrypted result progress', () => {
  seed();
  fs.rmSync(pendingFile, { force: true });
  savePending(pending('same'));
  const discovered = loadPendingForWrite();
  const collected = loadPendingForWrite();
  discovered.resultRef = 'result-reference';
  discovered.resultExpiresAt = '2099-01-01';
  savePending(discovered);
  collected.resultEnvelope = { encrypted: 'fixture-ciphertext' };
  collected.committed = true;
  savePending(collected);
  const disk = loadPendingForWrite();
  assert.equal(disk.resultRef, 'result-reference');
  assert.equal(disk.resultExpiresAt, '2099-01-01');
  assert.deepEqual(disk.resultEnvelope, { encrypted: 'fixture-ciphertext' });
  assert.equal(disk.committed, true);
});

test('a stale new approval request cannot overwrite the first saved request', () => {
  seed();
  fs.rmSync(pendingFile, { force: true });
  savePending(pending('winner'), null);
  assert.throws(() => savePending(pending('stale'), null), error => {
    assert.equal(error.code, 'approval-changed');
    assert.match(error.message, /winner/);
    assert.match(error.message, /again|retry|Retry/);
    return true;
  });
  assert.equal(loadPendingForWrite().requestId, 'winner');
});
