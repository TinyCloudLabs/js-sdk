// TC-2384 review: the profile.json lock. A holder is never robbed while it is alive, a break of a stale lock is serialized so that a fresh
// lock is never broken by a process that judged the OLD one stale, and a lock is only removed by the process that owns it.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireLock } from '../dist/file-lock.js';
import { loadProfile, saveProfile, writeSecure } from '../dist/profile.js';

const HOME = process.env.COURIER_HOME;
const PROFILE = path.join(HOME, 'profile.json');
const LOCK = `${PROFILE}.lock`;
const OWNER = 'did:pkh:eip155:1:0x0000000000000000000000000000000000000001';
const onDisk = () => JSON.parse(fs.readFileSync(PROFILE, 'utf8'));
const peer = (handle) => ({ handle, ownerDid: OWNER, courierDid: `did:key:z${handle}`, spaceId: 's', outbound: [], status: 'paired', pairedAt: new Date().toISOString() });

function seed(peers = {}) {
  fs.rmSync(LOCK, { force: true });
  writeSecure(PROFILE, { version: 3, host: 'http://127.0.0.1:1', openkeyHost: 'https://openkey.so', label: 'courier · test', courierDid: 'did:key:zself', status: 'awaiting-grant', peers });
}

const deadPid = async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
};
const age = (file, ms) => { const when = new Date(Date.now() - ms); fs.utimesSync(file, when, when); };

test('a lock held by a LIVE process is never taken, however old it is', async (t) => {
  seed({ old: peer('old') });
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  const foreign = JSON.stringify({ pid: holder.pid, nonce: 'old-live-holder' });
  fs.writeFileSync(LOCK, foreign, { mode: 0o600 });
  age(LOCK, 120_000);
  const profile = loadProfile();
  profile.label = 'intruder';
  assert.throws(() => saveProfile(profile), (e) => e.code === 'profile-locked');
  assert.equal(fs.readFileSync(LOCK, 'utf8'), foreign, 'the holder keeps its lock');
  assert.notEqual(onDisk().label, 'intruder');
});

test('a save removes only a lock it owns: a lock that another process holds by the time it finishes is left alone', async (t) => {
  seed();
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  const foreign = JSON.stringify({ pid: holder.pid, nonce: 'someone-else', at: Date.now() });
  const profile = loadProfile();
  profile.label = 'mine';
  const read = fs.readFileSync;
  let swapped = false;
  t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (!swapped && String(file) === PROFILE) { swapped = true; fs.writeFileSync(LOCK, foreign, { mode: 0o600 }); } // the lock changed hands while this save ran
    return read(file, ...rest);
  });
  try { saveProfile(profile); } catch { /* a save that notices it lost the lock may refuse */ }
  t.mock.restoreAll();
  assert.equal(swapped, true);
  assert.equal(fs.existsSync(LOCK) && fs.readFileSync(LOCK, 'utf8'), foreign, 'the other holder\'s lock must survive this save');
});

test('processes that all find the same dead holder break its lock one at a time: they block on each other, no two saves overlap, no update is lost', async () => {
  seed();
  fs.writeFileSync(LOCK, JSON.stringify({ pid: await deadPid(), nonce: 'dead-holder' }), { mode: 0o600 });
  const start = path.join(HOME, 'lock-start');
  fs.rmSync(start, { force: true });
  const script = fileURLToPath(new URL('./profile-lock-child.mjs', import.meta.url));
  const handles = Array.from({ length: 8 }, (_, i) => `racer${i}`);
  const children = handles.map((handle) => fork(script, [start, handle], { execArgv: [] }));
  const sections = [];
  for (const child of children) child.on('message', (m) => { if (m && m.enter) sections.push(m); });
  await Promise.all(children.map((child) => new Promise((resolve) => child.once('message', resolve))));
  const exited = children.map((child) => new Promise((resolve, reject) => child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))))));
  fs.writeFileSync(start, '1');
  await Promise.all(exited);
  assert.equal(sections.length, 8);
  sections.sort((a, b) => a.enter - b.enter);
  for (let i = 1; i < sections.length; i += 1) assert.ok(sections[i].enter >= sections[i - 1].exit, `saves ${i - 1} and ${i} overlapped inside the lock`);
  assert.deepEqual(Object.keys(onDisk().peers).sort(), handles);
  assert.equal(fs.existsSync(LOCK), false, 'every lock was released');
  assert.deepEqual(fs.readdirSync(HOME).filter((name) => name.includes('.lock')), [], 'no guard or lock files are left');
});

test('a holder killed while writing profile.json leaves a valid profile, and the next save recovers the lock and keeps its own update', async () => {
  seed({ old: peer('old') });
  const before = fs.readFileSync(PROFILE, 'utf8');
  const script = fileURLToPath(new URL('./profile-lock-crash-child.mjs', import.meta.url));
  const child = fork(script, [], { execArgv: [] });
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(child.signalCode, 'SIGKILL', 'the child died inside the save');
  assert.ok(fs.existsSync(LOCK), 'the killed holder left its lock');
  assert.equal(fs.readFileSync(PROFILE, 'utf8'), before, 'profile.json is whole: the half-done save never replaced it');
  JSON.parse(before);
  const profile = loadProfile();
  profile.peers.survivor = peer('survivor');
  saveProfile(profile);
  assert.deepEqual(Object.keys(onDisk().peers).sort(), ['old', 'survivor']);
  assert.equal(fs.existsSync(LOCK), false);
});

// ---- the lock itself: deterministic cases, no waiting ----

const lockFile = (name) => path.join(HOME, `${name}.lock`);
const quoted = (file) => `'${file.replace(/'/g, `'\\''`)}'`;
const START = (pid) => { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; };

test('two breakers that both saw the same dead lock: the one that runs second cannot steal the winner\'s fresh lock', async () => {
  const file = lockFile('race');
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify({ pid: await deadPid(), nonce: 'stale' }), { mode: 0o600 });
  let winner;
  assert.throws(
    () => acquireLock(file, { afterObserve: () => { winner = acquireLock(file); } }), // the second breaker observed the stale lock, then the first ran to completion
    (e) => e.code === 'locked',
  );
  assert.ok(winner, 'the first breaker took the lock');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).nonce !== 'stale');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid, 'the winner\'s lock is still in place');
  winner();
  assert.equal(fs.existsSync(file), false);
});

test('release removes only the lock with its own nonce', () => {
  const file = lockFile('release');
  fs.rmSync(file, { force: true });
  const release = acquireLock(file);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, nonce: 'someone-else' }));
  release();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nonce, 'someone-else');
});

test('a guard left by a breaker that died does not block the next breaker', async () => {
  const file = lockFile('guard');
  fs.rmSync(file, { force: true });
  const dead = await deadPid();
  fs.writeFileSync(file, JSON.stringify({ pid: dead, nonce: 'stale' }), { mode: 0o600 });
  fs.writeFileSync(`${file}.break.stale.1`, JSON.stringify({ pid: dead, nonce: 'dead-breaker' }), { mode: 0o600 });
  const release = acquireLock(file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  release();
  assert.deepEqual(fs.readdirSync(HOME).filter((name) => name.startsWith('guard.lock.break')), []);
});

test('a pid reused by a different process is not the holder; the same process still is', (t) => {
  const file = lockFile('reuse');
  fs.rmSync(file, { force: true });
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => bystander.kill('SIGKILL'));
  const start = Number(START(bystander.pid));
  fs.writeFileSync(file, JSON.stringify({ pid: bystander.pid, nonce: 'reused', start: String(start - 100) }), { mode: 0o600 });
  acquireLock(file)(); // the recorded start time is not this process's: the holder is gone

  fs.writeFileSync(file, JSON.stringify({ pid: bystander.pid, nonce: 'genuine', start: String(start) }), { mode: 0o600 });
  assert.throws(() => acquireLock(file), (e) => e.code === 'locked');
});

// A lock whose holder cannot be shown to be gone is never removed. The refusal is one line: the file, the holder, and the safe manual way out.
for (const [label, content] of [
  ['an empty record', ''],
  ['a corrupt record', '{"pid": 12'],
  ['a record without a nonce', JSON.stringify({ pid: 4242 })],
  ['a record from another host', JSON.stringify({ pid: 2147483000, nonce: 'n', host: 'other-host.example' })],
  ['a record from another pid namespace', JSON.stringify({ pid: 2147483000, nonce: 'n', host: os.hostname(), pidns: 'pid:[4026539999]' })],
]) {
  test(`${label} is not broken: the lock stays, and the refusal names it with the safe command`, () => {
    const file = lockFile('uncertain');
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, content, { mode: 0o600 });
    const refusal = (info) => `${info.file} ${info.reason} ${info.pid ?? ''} ${info.host ?? ''}`;
    assert.throws(() => acquireLock(file, { refusal }), (e) => e.code === 'locked' && e.message.includes(file));
    assert.equal(fs.readFileSync(file, 'utf8'), content, 'the lock is untouched');
    fs.rmSync(file);
  });
}

test('a profile save refused by a lock it cannot judge prints one recovery line and leaves the lock', () => {
  seed({ old: peer('old') });
  const content = JSON.stringify({ pid: 2147483000, nonce: 'foreign', host: 'other-host.example' });
  fs.writeFileSync(LOCK, content, { mode: 0o600 });
  const profile = loadProfile();
  profile.label = 'refused';
  assert.throws(() => saveProfile(profile), (e) => {
    assert.equal(e.code, 'profile-locked');
    assert.equal(e.message.split('\n').length, 1, 'one line');
    assert.ok(e.message.includes(`rm -f -- ${quoted(LOCK)}`), e.message);
    assert.match(e.message, /only after confirming no Courier command is running[^:]*: rm -f -- /, 'the removal command is conditioned on confirming no Courier process runs');
    assert.ok(e.message.includes(LOCK) && e.message.includes('2147483000') && e.message.includes('other-host.example'), e.message);
    return true;
  });
  assert.equal(fs.readFileSync(LOCK, 'utf8'), content, 'the lock stays');
  assert.notEqual(onDisk().label, 'refused');
});
