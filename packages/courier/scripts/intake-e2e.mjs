/**
 * TC-712 intake end to end on tee.node with two throwaway identities.
 *
 * bob sends to alice; alice runs `courier watch` until the message is mirrored and reported delivered, stops that
 * watcher, then runs `courier intake --once`. Checks the queue record, its file mode, and that a second run queues
 * nothing. Logs are printed without message text.
 * Run: node scripts/intake-e2e.mjs
 * Profiles, queue and state live under ~/scratch/tc712/ and are removed on exit.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwner, grantFromRequest } from './fake-openkey.mjs';

const run = promisify(execFile);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;

const base = path.join(os.homedir(), 'scratch', 'tc712');
fs.mkdirSync(base, { recursive: true });
const tmp = fs.mkdtempSync(path.join(base, 'intake-e2e-'));
fs.chmodSync(tmp, 0o700);
console.log(`throwaway profiles: ${tmp}`);

async function courierRaw(home, args, { input } = {}) {
  const pending = run(process.execPath, [CLI, ...args], { env: { ...process.env, COURIER_HOME: home }, timeout: 180_000 });
  if (input !== undefined) pending.child.stdin.end(input);
  return (await pending).stdout;
}
const courier = async (home, args, options) => JSON.parse(await courierRaw(home, args, options));

const write = (name, obj, mode = 0o600) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(obj), { mode });
  return file;
};

async function identity(handle) {
  const home = path.join(tmp, handle);
  const owner = await createOwner();
  const request = await courier(home, ['init', '--request', '--handle', handle, '--label', `${handle}'s courier`]);
  const grant = await grantFromRequest(owner, request);
  await courier(home, ['init', '--grant-file', write(`${handle}-grant.json`, grant)]);
  return home;
}

const alice = await identity('alice');
const bob = await identity('bob');
const artA = await courier(alice, ['pair', 'start', 'bob']);
const artB = await courier(bob, ['pair', 'accept', '--file', write('a.json', artA)]);
const artC = await courier(alice, ['pair', 'accept', '--file', write('b.json', artB)]);
await courier(bob, ['pair', 'accept', '--file', write('c.json', artC)]);
console.log('paired alice <-> bob');

const queue = path.join(tmp, 'queue');
const state = path.join(tmp, 'state');
const peers = write('peers.json', { bob: { tier: 'trusted', ratePerHour: 100, outPerHour: 100 } });
fs.mkdirSync(queue, { mode: 0o750 });
fs.mkdirSync(state, { mode: 0o700 });

const events = [];
const watcher = spawn(process.execPath, [CLI, 'watch', '--debounce', '30', '--poll', '60', '--ticket', '25', '--cwd', tmp], {
  env: { ...process.env, COURIER_HOME: alice },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let buffer = '';
watcher.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    try {
      events.push(JSON.parse(line));
    } catch {
      // non-JSON watcher output is ignored
    }
  }
});

async function waitFor(match, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find(match);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error('timeout waiting for watcher event');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

try {
  await waitFor((e) => e.event === 'hook-subscribe', 60_000);
  const sent = await courier(bob, ['send', 'alice', '--new', 'intake e2e', '--intent', 'request', '--text', 'run 1']);
  const delivered = await waitFor((e) => e.event === 'delivered' && e.messageId === sent.messageId, 180_000);
  console.log(`watcher delivered ${delivered.messageId}`);
  watcher.kill('SIGTERM');

  const first = await courierRaw(alice, ['intake', '--once', '--queue-dir', queue, '--state-dir', state, '--peers-file', peers]);
  console.log(first.trim());
  const file = path.join(queue, 'bob', `${sent.messageId}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const mode = fs.statSync(file).mode & 0o777;
  const checks = {
    msgId: record.msgId === sent.messageId,
    threadId: record.threadId === sent.threadId,
    text: record.text === 'run 1',
    sender: record.sender.id === 'bob',
    peerId: record.peerId === 'bob' && path.basename(path.dirname(file)) === record.peerId,
    tier: record.cheapChecks.tier === 'trusted',
    remaining: record.cheapChecks.peerRatePerHourRemaining === 99,
    mode: mode === 0o640,
  };
  console.log(`queue record ${file.replace(tmp, '<tmp>')} mode ${mode.toString(8)}`);
  console.log(JSON.stringify({ ...checks, flags: record.cheapChecks.flags }));

  const second = await courierRaw(alice, ['intake', '--once', '--queue-dir', queue, '--state-dir', state, '--peers-file', peers]);
  const queuedAgain = second.split('\n').filter((line) => line.includes('"intake-queued"')).length;
  console.log(`second intake cycle queued ${queuedAgain} new records`);
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length || queuedAgain !== 0) {
    console.error(`FAILED: ${[...failed, ...(queuedAgain ? ['repeat-queued'] : [])].join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('intake e2e passed');
  }
} finally {
  watcher.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`removed ${tmp}`);
}
