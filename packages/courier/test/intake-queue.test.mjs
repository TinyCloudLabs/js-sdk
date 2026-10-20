import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, emptyState, ensureRealDir, readState, writeNew, writeReplace } from '../dist/intake/queue.js';

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
