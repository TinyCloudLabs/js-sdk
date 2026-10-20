/**
 * TC-712 guard on tee.node with throwaway identities and a real `claude -p`. A stub `gh` stands in for GitHub, so
 * nothing is ever merged. Shows: a gated command is blocked, an owner approval for exactly that (verb, target) lets it
 * through once, and the next attempt is blocked again; other targets and other verbs stay blocked; the courier key
 * cannot undo the single use.
 * Run: node scripts/guard-e2e.mjs   (needs `claude` logged in; makes a few short model calls)
 *      GUARD_E2E_RUNNER=paseo node scripts/guard-e2e.mjs   (the same through real Paseo-created Claude agents via the
 *      `paseo` wake adapter; GUARD_E2E_PASEO_MODE picks the Claude mode, default bypassPermissions)
 */
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwner, grantFromRequest } from './fake-openkey.mjs';
import { requestHash } from '../dist/canonical.js';
import { k } from '../dist/keys.js';
import { createWaker, spawnRunner } from '../dist/wake.js';
import { paseoEnv } from '../dist/guard/paseo.js';

const agents = new Set();

const run = promisify(execFile);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-guard-'));
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

// Stub gh: records every call, merges nothing.
const bin = path.join(tmp, 'bin');
const ghLog = path.join(tmp, 'gh.log');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${ghLog}'\necho "stub gh: $*"\n`, { mode: 0o755 });
const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean) : []);

const settings = (await courier(alice.home, ['guard', 'settings'])).stdout;
const settingsFile = path.join(tmp, 'settings.json');
fs.writeFileSync(settingsFile, settings);

const work = path.join(tmp, 'work');
fs.mkdirSync(work);
const PASEO = process.env.GUARD_E2E_RUNNER === 'paseo';
const PASEO_MODE = process.env.GUARD_E2E_PASEO_MODE ?? 'bypassPermissions';
const thread = `T${Date.now()}`;
const sessions = new Map();

/** Wake a real Claude through the product's own adapter. `paseo`: a real Paseo-created agent; otherwise `claude -p`. */
async function claude(command) {
  const prompt = `Run this exact shell command with the Bash tool, once, and tell me its output verbatim: ${command}`;
  if (!PASEO) {
    const { stdout } = await run('claude', ['-p', prompt, '--settings', settingsFile, '--allowedTools', 'Bash(gh:*)', '--output-format', 'json', '--max-turns', '4'], {
      cwd: work, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COURIER_HOME: alice.home }, timeout: 180_000, maxBuffer: 8e6,
    });
    return JSON.parse(stdout).result;
  }
  const config = {
    adapter: 'paseo', cwd: work, owner: 'alice', home: alice.home, timeoutMs: 120_000,
    paseo: { bin: 'paseo', provider: 'claude', mode: PASEO_MODE }, claude: { bin: 'claude', allow: [] },
    guard: { argv: [process.execPath, CLI, 'guard'], entry: CLI },
  };
  const waker = createWaker(config, { run: spawnRunner, sessions: { get: (key) => sessions.get(key), set: (key, v) => sessions.set(key, v) }, prompt: () => prompt });
  await waker({ peer: 'bob', threadId: thread, subject: 'guard e2e', messages: [] });
  const listed = JSON.parse((await run('paseo', ['ls', '-g', '--json', '--label', `courier-thread=${thread}`], { env: paseoEnv(process.env) })).stdout);
  const id = listed[0].id;
  agents.add(id);
  await new Promise((resolve) => setTimeout(resolve, 4000)); // `paseo send --no-wait` returns before the turn starts
  await run('paseo', ['wait', id, '--timeout', '170'], { env: paseoEnv(process.env), timeout: 180_000 });
  return (await run('paseo', ['logs', id, '--tail', '8'], { env: paseoEnv(process.env) })).stdout;
}

const ask = async (verb, target) => (await courier(alice.home, ['request', thread, '--peer', 'bob', '--task', 'K1', '--verb', verb, '--target', target, '--summary', `guard e2e ${verb} ${target}`, '--why', 'e2e', '--risk', 'low'])).json.requestId;
const approve = async (id, over = {}) => {
  const raw = (await alice.owner.node.kv.get(k.request(id), { prefix: '' })).data;
  const request = typeof raw.data === 'string' ? JSON.parse(raw.data) : raw.data;
  const put = await alice.owner.node.kv.put(k.approval(id), { requestId: id, requestHash: requestHash(request), decision: 'approved', note: 'e2e', decidedAt: new Date().toISOString(), ...over }, { prefix: '', ifNoneMatch: '*' });
  if (!put.ok) throw new Error(`owner could not write the approval: ${put.error?.message}`);
};
function hook(command, home = alice.home) {
  const r = spawnSync(process.execPath, [CLI, 'guard'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: work }), env: { ...process.env, COURIER_HOME: home }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : undefined, stderr: r.stderr };
}

const MERGE = `${PASEO ? `${bin}/` : ''}gh pr merge 42 --repo tinycloudlabs/docs`;
try {
  // The hook alone (Claude's PreToolUse JSON on stdin).
  ok('hook: ungated command passes silently', (() => { const h = hook('ls -la'); return h.status === 0 && h.out === undefined; })());
  ok('hook: garbage input is refused with exit 2', spawnSync(process.execPath, [CLI, 'guard'], { input: 'not json', env: { ...process.env, COURIER_HOME: alice.home } }).status === 2);
  const noProfile = hook(MERGE, path.join(tmp, 'none'));
  ok('hook: no courier profile refuses a gated command', noProfile.status === 2 || noProfile.out?.permissionDecision === 'deny');
  const h0 = hook(MERGE);
  ok('hook: gated command with no approval is denied', h0.status === 0 && h0.out.permissionDecision === 'deny' && /--verb merge --target tinycloudlabs\/docs#42/.test(h0.out.permissionDecisionReason), h0.out?.permissionDecisionReason?.slice(0, 120));

  // A real Claude Code run.
  const r1 = await claude(MERGE);
  ok('claude: gated command is blocked, gh never ran', ghCalls().length === 0, r1.replace(/\s+/g, ' ').slice(0, 140));

  // Owner approves a different PR and a different verb: still blocked.
  await approve(await ask('merge', 'tinycloudlabs/docs#43'));
  await approve(await ask('publish', 'npm:@x/y@1.0.0'));
  ok('hook: an approval for another PR does not cover this one', hook(MERGE).out.permissionDecision === 'deny');

  const id = await ask('merge', 'tinycloudlabs/docs#42');
  ok('hook: requested but not yet approved is denied', hook(MERGE).out.permissionDecision === 'deny');
  await approve(id);
  const r2 = await claude(MERGE);
  ok('claude: after the owner approves exactly that merge, the command runs once', ghCalls().length === 1 && ghCalls()[0] === 'pr merge 42 --repo tinycloudlabs/docs', r2.replace(/\s+/g, ' ').slice(0, 140));
  const marker = await alice.owner.node.kv.get(k.approvalUsed(id), { prefix: '' });
  ok('the approval is marked used under me/consumed/', marker.ok === true);

  const r3 = await claude(MERGE);
  ok('claude: the same command is blocked again', ghCalls().length === 1, r3.replace(/\s+/g, ' ').slice(0, 140));
  const h3 = hook(MERGE);
  ok('hook: replay says the approval was used', h3.out.permissionDecision === 'deny' && /already used/.test(h3.out.permissionDecisionReason));
  const r4 = await claude(`bash -c "${MERGE}"`);
  ok('claude: wrapping it in bash -c does not help', ghCalls().length === 1, r4.replace(/\s+/g, ' ').slice(0, 100));
  ok('hook: pushing to main is denied', hook('git push origin HEAD:main').out.permissionDecision === 'deny');

  if (PASEO) {
    // Another agent cannot be started from inside a guarded one (it would run outside the guard).
    const r5 = await claude('paseo run --provider claude "Say hi"');
    ok('paseo: launching another agent is refused', /guard|hook|block|refus|not available|didn.t run|did not run/i.test(r5), r5.replace(/\s+/g, ' ').slice(0, 100));
    const settingsFileLocal = path.join(work, '.claude', 'settings.local.json');
    ok('paseo: the guard lives in <cwd>/.claude/settings.local.json', fs.existsSync(settingsFileLocal) && /courier|guard/.test(fs.readFileSync(settingsFileLocal, 'utf8')));
    const guarded = JSON.parse((await run('paseo', ['ls', '-g', '--json', '--label', `courier-thread=${thread}`, '--label', 'courier-guard=1'], { env: paseoEnv(process.env) })).stdout);
    ok('paseo: one agent served every wake of the thread (create, then send)', guarded.length === 1, `${guarded.length} agent(s), mode ${PASEO_MODE}`);
  }
} catch (error) {
  failures++;
  console.error(`FAIL: ${error.stack ?? error.message}`);
} finally {
  // Only agents this run created (found by its own thread label).
  for (const id of agents) await run('paseo', ['delete', id], { env: paseoEnv(process.env) }).catch(() => undefined);
}
console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
process.exitCode = failures ? 1 : 0;
