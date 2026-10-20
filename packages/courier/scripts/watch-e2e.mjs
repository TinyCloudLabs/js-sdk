/**
 * TC-712 watcher end to end on tee.node with two throwaway identities.
 *
 * alice runs `courier watch`; bob sends. Measures send → delivered (hook or poll) → woke.
 * Run: node scripts/watch-e2e.mjs [--debounce 30] [--poll 60] [--ticket 25] [--runs 3] [--wake none|exec]
 * Writes throwaway identities to tee.node (COURIER_HOST overrides). Owner keys stay in this process.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwner, grantFromRequest } from './fake-openkey.mjs';
import { decodeTime } from 'ulid';

const run = promisify(execFile);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const watchArgs = ['--debounce', opt('debounce', '30'), '--poll', opt('poll', '60'), '--ticket', opt('ticket', '25')];
const runs = Number(opt('runs', '3'));
const wakeAdapter = opt('wake', 'none');
const execScript = opt('exec-script', '');

async function courier(home, args, { input } = {}) {
  const pending = run(process.execPath, [CLI, ...args], { env: { ...process.env, COURIER_HOME: home }, timeout: 180_000 });
  if (input !== undefined) pending.child.stdin.end(input);
  return JSON.parse((await pending).stdout);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-watch-'));
const write = (name, obj) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
};
console.log(`throwaway profiles: ${tmp}`);

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

const wakeArgs = wakeAdapter === 'exec' ? ['--wake', 'exec', '--exec', execScript] : ['--wake', wakeAdapter];
const watcher = spawn(process.execPath, [CLI, 'watch', ...wakeArgs, ...watchArgs], {
  env: { ...process.env, COURIER_HOME: alice }, stdio: ['ignore', 'pipe', 'inherit'],
});
const events = [];
const waiters = [];
let buffer = '';
watcher.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    event.seenAt = Date.now();
    events.push(event);
    if (!['hook-event'].includes(event.event)) console.log(`   [watch] ${line}`);
    for (const waiter of [...waiters]) if (waiter.match(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
  }
});
const waitFor = (match, ms) => new Promise((resolve, reject) => {
  const hit = events.find(match);
  if (hit) return resolve(hit);
  const timer = setTimeout(() => {
    waiters.splice(waiters.indexOf(waiter), 1);
    reject(new Error('timeout waiting for watcher event'));
  }, ms);
  const waiter = { match, resolve: (event) => { clearTimeout(timer); resolve(event); } };
  waiters.push(waiter);
});

const results = [];
try {
  await waitFor((e) => e.event === 'hook-subscribe', 60_000);
  for (let i = 1; i <= runs; i++) {
    const sentWall = Date.now();
    const sent = await courier(bob, ['send', 'alice', '--new', `watch e2e ${i}`, '--intent', 'request', '--text', `run ${i}`]);
    const sentAt = decodeTime(sent.messageId);
    const delivered = await waitFor((e) => e.event === 'delivered' && e.messageId === sent.messageId, 180_000);
    const woke = await waitFor((e) => e.event === 'woke' && e.messageIds?.includes(sent.messageId), 240_000);
    const row = {
      run: i, via: delivered.via, deliveredMs: delivered.seenAt - sentAt, wokeMs: woke.seenAt - sentAt, sendCallMs: sentAt - sentWall,
    };
    results.push(row);
    console.log(`run ${i}: delivered via ${row.via} after ${row.deliveredMs} ms, woke after ${row.wokeMs} ms`);
  }
  // inform never wakes
  const inform = await courier(bob, ['send', 'alice', '--new', 'inform e2e', '--intent', 'inform', '--text', 'fyi']);
  const informDelivered = await waitFor((e) => e.event === 'delivered' && e.messageId === inform.messageId, 180_000);
  await new Promise((r) => setTimeout(r, (Number(opt('debounce', '30')) + 3) * 1000));
  const informWoke = events.some((e) => e.event === 'woke' && e.messageIds?.includes(inform.messageId));
  console.log(`inform delivered via ${informDelivered.via}, woke=${informWoke}`);
  if (informWoke) throw new Error('inform woke the agent');
  const worst = Math.max(...results.map((r) => r.wokeMs));
  console.log(`\nworst wake latency ${worst} ms over ${runs} runs (target < 120000)`);
  fs.writeFileSync(path.join(tmp, 'latency.json'), JSON.stringify({ args: watchArgs, results }, null, 2));
  process.exitCode = worst < 120_000 ? 0 : 1;
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  watcher.kill('SIGTERM');
}
