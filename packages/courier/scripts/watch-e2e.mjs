/**
 * TC-712 watcher end to end on tee.node with two throwaway identities.
 *
 * alice runs `courier watch`; bob sends. Measures send → delivered (hook or poll) → woke.
 * Run: node scripts/watch-e2e.mjs [--debounce 30] [--poll 60] [--ticket 25] [--runs 3] [--wake none|exec|claude|paseo]
 * claude: runs a real `claude -p` (small cost) with a `courier` shim on PATH; paseo: creates and then deletes real
 * Paseo agents. exec/claude/paseo send runs 2.. into the first thread so reuse (session resume / agent reuse) is exercised.
 * Writes throwaway identities to tee.node (COURIER_HOST overrides). Owner keys stay in this process.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwner, grantFromRequest } from './fake-openkey.mjs';
import { decodeTime } from 'ulid';
import { execFileSync } from 'node:child_process';

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

const workdir = path.join(tmp, 'work');
fs.mkdirSync(workdir);
const wakeOut = path.join(tmp, 'wake.out');
const shimDir = path.join(tmp, 'bin');
fs.mkdirSync(shimDir);
fs.writeFileSync(path.join(shimDir, 'courier'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
const adapterArgs = {
  none: [],
  exec: ['--exec', `printf '%s %s\\n' "$COURIER_PEER" "$COURIER_THREAD" >> '${wakeOut}'`],
  claude: ['--wake', 'claude', '--wake-timeout', '420'],
  paseo: ['--wake', 'paseo', '--paseo-provider', opt('paseo-provider', 'claude')],
}[wakeAdapter];
const watcher = spawn(process.execPath, [CLI, 'watch', ...adapterArgs, '--cwd', workdir, ...watchArgs], {
  env: { ...process.env, COURIER_HOME: alice, PATH: `${shimDir}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'inherit'],
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
  const reuse = wakeAdapter === 'claude' || wakeAdapter === 'paseo';
  let thread;
  for (let i = 1; i <= runs; i++) {
    const sentWall = Date.now();
    const text = reuse
      ? `Courier e2e ${i}. Run \`courier read\` on this thread, then reply in one line with \`courier send\` using intent inform. Do nothing else.`
      : `run ${i}`;
    const sendArgs = thread
      ? ['send', 'alice', '--thread', thread, '--intent', 'update', '--text', text]
      : ['send', 'alice', '--new', `watch e2e ${wakeAdapter}`, '--intent', 'request', '--text', text];
    const sent = await courier(bob, sendArgs);
    thread ??= reuse ? sent.threadId : undefined;
    const sentAt = decodeTime(sent.messageId);
    const delivered = await waitFor((e) => e.event === 'delivered' && e.messageId === sent.messageId, 180_000);
    const waking = await waitFor((e) => e.event === 'waking' && e.messageIds?.includes(sent.messageId), 240_000);
    const woke = await waitFor((e) => e.event === 'woke' && e.messageIds?.includes(sent.messageId), 600_000);
    const row = {
      run: i, via: delivered.via, deliveredMs: delivered.seenAt - sentAt, wakeStartMs: waking.seenAt - sentAt,
      wakeRunMs: woke.runMs, sendCallMs: sentAt - sentWall,
    };
    results.push(row);
    console.log(`run ${i}: delivered via ${row.via} after ${row.deliveredMs} ms, wake started after ${row.wakeStartMs} ms, wake run ${row.wakeRunMs} ms`);
  }
  if (wakeAdapter === 'exec') {
    const lines = fs.readFileSync(wakeOut, 'utf8').trim().split('\n');
    console.log(`exec adapter ran ${lines.length}x: ${lines[0]}`);
    if (lines.length !== runs || !lines.every((l) => l.startsWith('bob '))) throw new Error('exec adapter did not run once per wake');
  }
  if (wakeAdapter === 'claude') {
    const sessions = JSON.parse(fs.readFileSync(path.join(alice, 'sessions.json'), 'utf8')).threads;
    console.log(`claude session saved for ${Object.keys(sessions).join(', ')}`);
    if (!sessions[`bob/${thread}`]) throw new Error('claude session id was not saved');
    const read = await courier(bob, ['read', thread, '--json']);
    console.log(`bob sees ${read.entries.filter((e) => e.side === 'peer' && e.kind === 'msg').length} message(s) from alice's woken agent`);
  }
  if (wakeAdapter === 'paseo') {
    const agents = JSON.parse(execFileSync('paseo', ['ls', '-g', '--json', '--label', `courier-thread=${thread}`], { encoding: 'utf8' }));
    console.log(`paseo agents for the thread: ${agents.map((a) => `${a.shortId} "${a.name}"`).join('; ')}`);
    for (const a of agents) execFileSync('paseo', ['delete', a.id, '--json'], { encoding: 'utf8' });
    if (agents.length !== 1) throw new Error(`expected exactly one Paseo agent for the thread, found ${agents.length}`);
  }
  // inform never wakes
  const inform = await courier(bob, ['send', 'alice', '--new', 'inform e2e', '--intent', 'inform', '--text', 'fyi']);
  const informDelivered = await waitFor((e) => e.event === 'delivered' && e.messageId === inform.messageId, 180_000);
  await new Promise((r) => setTimeout(r, (Number(opt('debounce', '30')) + 3) * 1000));
  const informWoke = events.some((e) => e.event === 'waking' && e.messageIds?.includes(inform.messageId));
  console.log(`inform delivered via ${informDelivered.via}, woke=${informWoke}`);
  if (informWoke) throw new Error('inform woke the agent');
  const worst = Math.max(...results.map((r) => r.wakeStartMs));
  console.log(`\nworst send-to-wake-start latency ${worst} ms over ${runs} runs (target < 120000)`);
  fs.writeFileSync(path.join(tmp, 'latency.json'), JSON.stringify({ args: watchArgs, results }, null, 2));
  process.exitCode = worst < 120_000 ? 0 : 1;
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  watcher.kill('SIGTERM');
}
