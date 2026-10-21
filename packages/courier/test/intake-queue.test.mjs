import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, emptyState, ensureRealDir, readState, writeNew, writeReplace } from '../dist/intake/queue.js';

const DEAD_PID = 2147483646;
const alive = (pid) => pid !== DEAD_PID; // fake contender pids count as alive

function tryAcquire(file, opts) {
  try {
    return { ok: true, release: acquireLock(file, opts) };
  } catch (error) {
    return { ok: false, code: error.code };
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tc712-queue-'));
}

test('writeNew creates a 0640 file and never replaces an existing one', () => {
  const dir = tempDir();
  assert.equal(writeNew(dir, 'a.json', 'first', 0o640), true);
  assert.equal(fs.statSync(path.join(dir, 'a.json')).mode & 0o777, 0o640);
  assert.equal(writeNew(dir, 'a.json', 'second', 0o640), false);
  assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'first');
  assert.deepEqual(fs.readdirSync(dir), ['a.json'], 'no temp files left behind');
});

test('writeNew does not follow a symlink planted at the target name', () => {
  const dir = tempDir();
  const outside = path.join(tempDir(), 'victim.txt');
  fs.writeFileSync(outside, 'untouched');
  fs.symlinkSync(outside, path.join(dir, 'a.json'));
  assert.equal(writeNew(dir, 'a.json', 'payload', 0o640), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});

test('writeReplace refuses to replace a symlink', () => {
  const dir = tempDir();
  const outside = path.join(tempDir(), 'victim.txt');
  fs.writeFileSync(outside, 'untouched');
  fs.symlinkSync(outside, path.join(dir, 'state.json'));
  assert.throws(() => writeReplace(dir, 'state.json', 'x', 0o600), (e) => e.code === 'unsafe-target');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});

test('writeReplace swaps in the new body at the requested mode', () => {
  const dir = tempDir();
  writeReplace(dir, 'state.json', 'one', 0o600);
  writeReplace(dir, 'state.json', 'two', 0o600);
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), 'two');
  assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
});

test('ensureRealDir refuses a symlink in place of the directory', () => {
  const real = tempDir();
  const link = path.join(tempDir(), 'queue');
  fs.symlinkSync(real, link);
  assert.throws(() => ensureRealDir(link, 0o750), (e) => e.code === 'unsafe-dir');
});

test('ensureRealDir sets the requested mode even under a restrictive umask', () => {
  const previous = process.umask(0o077);
  try {
    const dir = path.join(tempDir(), 'queue');
    ensureRealDir(dir, 0o750);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o750);
  } finally {
    process.umask(previous);
  }
});

test('the intake lock refuses a live holder and takes over a dead one', () => {
  const dir = tempDir();
  const file = path.join(dir, 'intake.lock');
  const release = acquireLock(file);
  assert.throws(() => acquireLock(file), (e) => e.code === 'locked');
  release();
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, '2147483646\n');
  const takeover = acquireLock(file);
  takeover();
});

test('readState: missing is empty, corrupt refuses to start', () => {
  const dir = tempDir();
  const file = path.join(dir, 'intake-state.json');
  assert.deepEqual(readState(file), emptyState());
  fs.writeFileSync(file, '{not json');
  assert.throws(() => readState(file), (e) => e.code === 'bad-state');
  fs.writeFileSync(file, JSON.stringify({ v: 1, peers: { alice: { highWater: 5, receipts: [] } } }));
  assert.deepEqual(readState(file).peers.alice.receipts, [], 'a stale highWater key from an older build is ignored');
  fs.writeFileSync(file, JSON.stringify({ v: 1, peers: { alice: { receipts: 'x' } } }));
  assert.throws(() => readState(file), (e) => e.code === 'bad-state');
});

test('the lock records its pid and a nonce', () => {
  const file = path.join(tempDir(), 'intake.lock');
  const release = acquireLock(file);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.pid, process.pid);
  assert.match(record.nonce, /^[0-9a-f]{12}$/);
  release();
});

test('a live holder is never pre-empted, however old its files are', () => {
  const file = path.join(tempDir(), 'intake.lock');
  const body = `${JSON.stringify({ pid: process.pid, nonce: 'live00000001' })}\n`;
  fs.writeFileSync(file, body);
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(file, old, old);
  assert.throws(() => acquireLock(file), (e) => e.code === 'locked');
  assert.equal(fs.readFileSync(file, 'utf8'), body);
});

test('a dead holder is recovered without any age check', () => {
  const file = path.join(tempDir(), 'intake.lock');
  fs.writeFileSync(file, `${JSON.stringify({ pid: DEAD_PID, nonce: 'dead00000001' })}\n`);
  const release = acquireLock(file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  release();
  assert.equal(fs.existsSync(file), false);
});

test('a slow contender cannot remove a fresh lock; of three contenders exactly one wins', () => {
  const dir = tempDir();
  const file = path.join(dir, 'intake.lock');
  fs.writeFileSync(file, `${JSON.stringify({ pid: DEAD_PID, nonce: 'dead00000002' })}\n`);
  const nested = [];
  const slow = tryAcquire(file, {
    pid: 1001,
    alive,
    afterObserve: () => {
      nested.push(tryAcquire(file, { pid: 2001, alive }));
      nested.push(tryAcquire(file, { pid: 3001, alive }));
    },
  });
  const results = [slow, ...nested];
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(slow.ok, false);
  assert.equal(slow.code, 'locked');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 2001, 'the first breaker keeps its lock');
  assert.deepEqual(fs.readdirSync(dir), ['intake.lock'], 'no break guard left behind');
});

test('a break guard left by a dead contender is passed over', () => {
  const dir = tempDir();
  const file = path.join(dir, 'intake.lock');
  fs.writeFileSync(file, `${JSON.stringify({ pid: DEAD_PID, nonce: 'dead00000003' })}\n`);
  fs.writeFileSync(path.join(dir, 'intake.lock.break.dead00000003.1'), `${JSON.stringify({ pid: DEAD_PID, nonce: 'guard00000001' })}\n`);
  const release = acquireLock(file, { alive });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  release();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a break guard held by a live contender refuses the takeover', () => {
  const dir = tempDir();
  const file = path.join(dir, 'intake.lock');
  fs.writeFileSync(file, `${JSON.stringify({ pid: DEAD_PID, nonce: 'dead00000004' })}\n`);
  const hourAgo = new Date(Date.now() - 3_600_000);
  fs.utimesSync(file, hourAgo, hourAgo);
  fs.writeFileSync(path.join(dir, 'intake.lock.break.dead00000004.1'), `${JSON.stringify({ pid: 1001, nonce: 'guard00000002' })}\n`);
  assert.throws(() => acquireLock(file, { alive }), (e) => e.code === 'locked');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, 'dead00000004');
});

test('release leaves a lock with the same pid but another nonce', () => {
  const dir = tempDir();
  const file = path.join(dir, 'intake.lock');
  const release = acquireLock(file);
  writeReplace(dir, 'intake.lock', `${process.pid}\n`, 0o600);
  release();
  assert.equal(fs.readFileSync(file, 'utf8'), `${process.pid}\n`);
});
