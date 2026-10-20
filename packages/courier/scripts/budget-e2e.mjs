/**
 * TC-712 wake-budget rehearsal (PLAN §6.5) on tee.node with two throwaway identities.
 *
 * Two scripted agents answer every wake with a message to the other side: the reply loop the budget exists to
 * stop. The budget is lowered to 3 per thread per UTC day. Expected: bob (who receives the first message) is woken
 * 3 times, his 4th wake becomes a pause (marker, `inform` "thread paused" to alice, notification to bob's human);
 * alice's watcher delivers that inform without waking, notifies her human (peer-paused), and the thread goes quiet.
 * Then `courier resume` on bob's side starts a fresh budget and the next message wakes him again.
 *
 * Run: node scripts/budget-e2e.mjs [--budget 3] [--debounce 2]   (writes throwaway identities to tee.node)
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwner, grantFromRequest } from './fake-openkey.mjs';

const run = promisify(execFile);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const BUDGET = Number(opt('budget', '3'));
const DEBOUNCE = opt('debounce', '2');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-budget-'));
console.log(`throwaway profiles: ${tmp}  (budget ${BUDGET}, debounce ${DEBOUNCE} s)`);
const write = (name, obj) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
let failures = 0;
const ok = (name, cond, extra = '') => { if (!cond) failures++; console.log(`${cond ? 'ok' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`); };

async function courier(home, args, { allowFail } = {}) {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env: { ...process.env, COURIER_HOME: home }, timeout: 180_000 });
    return { code: 0, stdout, json: stdout.trim().startsWith('{') ? JSON.parse(stdout) : undefined };
  } catch (e) {
    if (!allowFail) throw e;
    return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function identity(handle) {
  const home = path.join(tmp, handle);
  const owner = await createOwner();
  const request = await courier(home, ['init', '--request', '--handle', handle, '--label', handle]);
  await courier(home, ['init', '--grant-file', write(`${handle}-grant.json`, await grantFromRequest(owner, request.json))]);
  return home;
}

const homes = { alice: await identity('alice'), bob: await identity('bob') };
const artA = (await courier(homes.alice, ['pair', 'start', 'bob'])).json;
const artB = (await courier(homes.bob, ['pair', 'accept', '--file', write('a.json', artA)])).json;
const artC = (await courier(homes.alice, ['pair', 'accept', '--file', write('b.json', artB)])).json;
await courier(homes.bob, ['pair', 'accept', '--file', write('c.json', artC)]);
console.log('paired alice <-> bob');

// The scripted agent: reply to whoever woke it. `courier` on PATH is a shim for this build.
const shim = path.join(tmp, 'bin');
fs.mkdirSync(shim);
fs.writeFileSync(path.join(shim, 'courier'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
const reply = 'courier send "$COURIER_PEER" --thread "$COURIER_THREAD" --intent answer --text "ack" >/dev/null';

const events = { alice: [], bob: [] };
const notes = { alice: path.join(tmp, 'alice-notices'), bob: path.join(tmp, 'bob-notices') };
function watch(side) {
  const p = spawn(process.execPath, [
    CLI, 'watch', '--exec', reply, '--debounce', DEBOUNCE, '--wake-budget', String(BUDGET),
    '--notify-exec', `printf '%s %s\\n' "$COURIER_NOTICE" "$COURIER_PEER" >> '${notes[side]}'`, '--cwd', tmp,
  ], { env: { ...process.env, COURIER_HOME: homes[side], PATH: `${shim}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'inherit'] });
  let buffer = '';
  p.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let nl; (nl = buffer.indexOf('\n')) !== -1;) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const event = { ...JSON.parse(line), at: Date.now() };
        events[side].push(event);
        if (['waking', 'paused', 'resumed', 'notify', 'inform-error', 'notify-error', 'wake-error'].includes(event.event)) console.log(`   [${side}] ${line.slice(0, 200)}`);
      } catch { /* not JSON */ }
    }
  });
  return p;
}
const count = (side, event) => events[side].filter((e) => e.event === event).length;
const until = async (cond, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const readNotes = (side) => (fs.existsSync(notes[side]) ? fs.readFileSync(notes[side], 'utf8').trim().split('\n').filter(Boolean) : []);

const watchers = [watch('alice'), watch('bob')];
try {
  await until(() => count('alice', 'hook-subscribe') >= 2 && count('bob', 'hook-subscribe') >= 2, 90_000, 'both watchers subscribed');
  await new Promise((r) => setTimeout(r, 4000));

  // alice's agent opens the thread; from here the two scripted agents only answer each other.
  const opened = (await courier(homes.alice, ['send', 'bob', '--new', 'budget rehearsal', '--intent', 'request', '--text', 'start'])).json;
  const thread = opened.threadId;
  console.log(`thread ${thread}: the loop starts`);

  await until(() => count('bob', 'paused') >= 1, BUDGET * 150_000, "bob's pause");
  await until(() => readNotes('alice').some((l) => l.startsWith('peer-paused')) && readNotes('bob').some((l) => l.startsWith('paused')), 120_000, 'both humans notified');
  const quietFrom = Date.now();
  const before = { alice: count('alice', 'waking'), bob: count('bob', 'waking') };
  await new Promise((r) => setTimeout(r, 75_000)); // longer than a poll interval and a hook ticket: any late wake would show
  const after = { alice: count('alice', 'waking'), bob: count('bob', 'waking') };

  ok(`bob was woken exactly ${BUDGET} times, then the budget paused the thread`, before.bob === BUDGET && count('bob', 'paused') === 1, `wakes ${before.bob}`);
  ok(`alice was woken ${BUDGET} times (one per bob reply) and never for the pause inform`, before.alice === BUDGET, `wakes ${before.alice}`);
  ok('the loop stopped: no wake on either side for 75 s afterwards', after.alice === before.alice && after.bob === before.bob, `since ${Math.round((Date.now() - quietFrom) / 1000)} s`);
  ok("bob's human was notified of his own pause", readNotes('bob').some((l) => l === 'paused alice'), readNotes('bob').join(' | '));
  ok("alice's human was notified by the inform (peer-paused)", readNotes('alice').some((l) => l === 'peer-paused bob'), readNotes('alice').join(' | '));
  const read = (await courier(homes.alice, ['read', thread, '--json'])).json;
  const informs = read.entries.filter((e) => e.kind === 'msg' && e.side === 'peer' && e.body.metadata?.['https://tinycloud.xyz/ext/courier/v0']?.notice === 'thread-paused');
  ok('alice can read the thread-paused inform (intent inform)', informs.length === 1 && informs[0].body.metadata['https://tinycloud.xyz/ext/courier/v0'].intent === 'inform');

  // Pause survives a restart: bob's watcher restarts and still does not wake for the thread.
  watchers[1].kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 2000));
  watchers[1] = watch('bob');
  await until(() => count('bob', 'hook-subscribe') >= 4, 60_000, 'bob restarted');
  const wakesBeforeRestartMessage = count('bob', 'waking');
  await courier(homes.alice, ['send', 'bob', '--thread', thread, '--intent', 'update', '--text', 'are you there?']);
  await until(() => events.bob.some((e) => e.event === 'delivered' && e.threadId === thread && e.paused), 120_000, 'bob to deliver the message');
  await new Promise((r) => setTimeout(r, Number(DEBOUNCE) * 1000 + 15_000));
  ok('after a restart the pause still holds: the message is delivered and mirrored but does not wake', count('bob', 'waking') === wakesBeforeRestartMessage);

  // courier resume: a fresh budget, and the very next message wakes him.
  const resumed = await courier(homes.bob, ['resume', 'alice', thread]);
  ok('courier resume removes the pause', /Resumed/.test(resumed.stdout), resumed.stdout.trim());
  await courier(homes.alice, ['send', 'bob', '--thread', thread, '--intent', 'update', '--text', 'back?']);
  await until(() => count('bob', 'waking') > wakesBeforeRestartMessage, 150_000, 'bob to wake after the resume');
  ok('after resume the next message wakes bob again', true);
} catch (error) {
  failures++;
  console.error(`FAIL: ${error.stack ?? error.message}`);
} finally {
  for (const p of watchers) p.kill('SIGTERM');
}
console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
process.exitCode = failures ? 1 : 0;
