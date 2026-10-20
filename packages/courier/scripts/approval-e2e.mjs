/**
 * TC-712 approval loop on tee.node with two throwaway identities: `courier request` -> owner approves
 * (the throwaway owner wallet writes me/approvals/, as the view will) -> watcher wakes the agent at once ->
 * `courier approval` verifies and consumes (single use). Also: hash mismatch, wrong decision literal, denial.
 * Run: node scripts/approval-e2e.mjs
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwner, grantFromRequest } from './fake-openkey.mjs';
import { requestHash } from '../dist/canonical.js';
import { k } from '../dist/keys.js';

const run = promisify(execFile);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-approval-'));
console.log(`throwaway profiles: ${tmp}`);
const write = (name, obj) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
let failures = 0;
const ok = (name, cond, extra = '') => { if (!cond) failures++; console.log(`${cond ? 'ok' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`); };

async function courier(home, args, { allowFail } = {}) {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env: { ...process.env, COURIER_HOME: home }, timeout: 180_000 });
    return { code: 0, json: stdout.trim().startsWith('{') ? JSON.parse(stdout) : undefined, stdout, stderr: '' };
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
  return { home, owner };
}

const alice = await identity('alice');
const bob = await identity('bob');
const artA = (await courier(alice.home, ['pair', 'start', 'bob'])).json;
const artB = (await courier(bob.home, ['pair', 'accept', '--file', write('a.json', artA)])).json;
const artC = (await courier(alice.home, ['pair', 'accept', '--file', write('b.json', artB)])).json;
await courier(bob.home, ['pair', 'accept', '--file', write('c.json', artC)]);

const wakeOut = path.join(tmp, 'wake.out');
const watcher = spawn(process.execPath, [CLI, 'watch', '--exec', `printf '%s\\n' "$COURIER_PROMPT" >> '${wakeOut}'`, '--unguarded', '--cwd', tmp], {
  env: { ...process.env, COURIER_HOME: alice.home }, stdio: ['ignore', 'pipe', 'inherit'],
});
const events = [];
const waiters = [];
let buffer = '';
watcher.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (let nl; (nl = buffer.indexOf('\n')) !== -1;) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    try {
      const event = { ...JSON.parse(line), seenAt: Date.now() };
      events.push(event);
      if (event.event !== 'hook-event' && event.event !== 'hook-subscribe') console.log(`   [watch] ${line}`);
      for (const w of [...waiters]) if (w.match(event)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(event); }
    } catch { /* not JSON */ }
  }
});
const waitFor = (match, ms) => new Promise((resolve, reject) => {
  const hit = events.find(match);
  if (hit) return resolve(hit);
  const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timeout waiting for watcher event')); }, ms);
  const w = { match, resolve: (e) => { clearTimeout(timer); resolve(e); } };
  waiters.push(w);
});

const thread = 'T' + Date.now();
const ask = async (verb, target) => (await courier(alice.home, ['request', thread, '--peer', 'bob', '--task', 'K1', '--verb', verb, '--target', target, '--summary', `e2e ${verb} ${target}`, '--why', 'e2e', '--risk', 'low'])).json.requestId;
const forWhat = (verb, target) => ['--verb', verb, '--target', target];
const MERGE = ['merge', 'tinycloudlabs/docs#42'];
const readRequest = async (id) => (await alice.owner.node.kv.get(k.request(id), { prefix: '' })).data;
const decide = async (id, over = {}) => {
  const raw = await readRequest(id);
  const request = typeof raw.data === 'string' ? JSON.parse(raw.data) : raw.data;
  const body = { requestId: id, requestHash: requestHash(request), decision: 'approved', note: 'e2e', decidedAt: new Date().toISOString(), ...over };
  const put = await alice.owner.node.kv.put(k.approval(id), body, { prefix: '', ifNoneMatch: '*' });
  if (!put.ok) throw new Error(`owner could not write the approval: ${put.error?.message}`);
  return Date.now();
};

try {
  await waitFor((e) => e.event === 'hook-subscribe', 60_000);

  const noFields = await courier(alice.home, ['request', thread, '--peer', 'bob', '--task', 'K1', '--action', 'gh pr merge 42', '--why', 'e2e'], { allowFail: true });
  ok('a request without verb/target/summary is refused', noFields.code === 2 && /--verb/.test(noFields.stderr));
  const id = await ask(...MERGE);
  const before = await courier(alice.home, ['approval', id, ...forWhat(...MERGE)], { allowFail: true });
  ok('no approval yet: refused', before.code !== 0 && /approval-missing/.test(before.stderr));

  const wrote = await decide(id);
  const woke = await waitFor((e) => e.event === 'waking' && e.approvalIds?.includes(id), 120_000);
  ok('approval wakes the agent without the 30 s debounce', woke.seenAt - wrote < 60_000, `${woke.seenAt - wrote} ms after the owner wrote it`);
  await waitFor((e) => e.event === 'woke' && e.approvalIds?.includes(id), 60_000);
  const prompt = fs.readFileSync(wakeOut, 'utf8');
  ok('wake prompt tells the agent to verify', /courier approval <requestId>/.test(prompt) && prompt.includes(id));

  const peek = await courier(alice.home, ['approval', id, ...forWhat(...MERGE), '--peek']);
  ok('peek verifies without consuming', peek.json.ok && peek.json.consumed === false);
  const wrongAction = await courier(alice.home, ['approval', id, ...forWhat('merge', 'tinycloudlabs/docs#43')], { allowFail: true });
  ok('a different target is refused', wrongAction.code !== 0 && /approval-mismatch/.test(wrongAction.stderr));
  const used = await courier(alice.home, ['approval', id, ...forWhat(...MERGE)]);
  ok('approved request verifies and is consumed', used.json.ok && used.json.consumed && used.json.decision === 'approved');
  const again = await courier(alice.home, ['approval', id, ...forWhat(...MERGE)], { allowFail: true });
  ok('second use is refused', again.code !== 0 && /approval-used/.test(again.stderr));
  const peekUsed = await courier(alice.home, ['approval', id, ...forWhat(...MERGE), '--peek'], { allowFail: true });
  ok('peek on a used approval is refused too', peekUsed.code !== 0 && /approval-used/.test(peekUsed.stderr));
  const bare = await courier(alice.home, ['approval', id], { allowFail: true });
  ok('consuming without --verb and --target is a usage error', bare.code === 2 && /Say what you are about to do/.test(bare.stderr));

  const tampered = await ask('deploy', 'wrangler:eliza');
  await decide(tampered, { requestHash: '0'.repeat(64) });
  const t = await courier(alice.home, ['approval', tampered, ...forWhat('deploy', 'wrangler:eliza')], { allowFail: true });
  ok('hash that does not match the request is refused', t.code !== 0 && /approval-mismatch/.test(t.stderr));

  const literal = await ask('publish', 'npm:@tinycloud/courier@9.9.9');
  await decide(literal, { decision: 'approve' });
  const l = await courier(alice.home, ['approval', literal, ...forWhat('publish', 'npm:@tinycloud/courier@9.9.9')], { allowFail: true });
  ok('"approve" is not "approved"', l.code !== 0 && /approval-mismatch/.test(l.stderr));

  const denied = await ask('other', 'secrets:set DATABASE_URL');
  await decide(denied, { decision: 'denied', note: 'no' });
  const d = await courier(alice.home, ['approval', denied, ...forWhat('other', 'secrets:set DATABASE_URL')], { allowFail: true });
  ok('a denial exits non-zero as approval-denied', d.code !== 0 && /approval-denied/.test(d.stderr));
} catch (error) {
  failures++;
  console.error(`FAIL: ${error.stack ?? error.message}`);
} finally {
  watcher.kill('SIGTERM');
}
console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
process.exitCode = failures ? 1 : 0;
