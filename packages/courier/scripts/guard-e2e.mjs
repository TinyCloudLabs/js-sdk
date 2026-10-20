/** TC-712 model-free public CLI proof on tee.node. Throwaway identities, dummy token, fixed stub gh only.
 * Broker fixtures: --test-token accepts ONLY the fixed dummy fixture on stdin; --test-owner-root <private ~/scratch/...>
 * selects <root>/.config/courier-broker/<profile-id>/config.json. Production uses the OS-user root, never HOME.
 * Both setup and run-approved use the explicit test override; it refuses the real owner root and paths outside scratch.
 * prepareAgentProfile copies only Courier profile/key/grant to a sibling agent HOME; its marker holds an opaque id,
 * never a broker path. The agent environment never receives the override or COURIER_HOME.
 * node scripts/guard-e2e.mjs — no model calls; never calls real GitHub or merges a real PR.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createOwner, grantFromRequest } from './fake-openkey.mjs';
import { requestHash } from '../dist/canonical.js';
import { k } from '../dist/keys.js';
import { prepareCleanHome, prepareAgentProfile } from '../dist/guard/cleanhome.js';
import { brokerFile, brokerRoot } from '../dist/broker-config.js';
import { profileId } from '../dist/guard/install.js';
import { parseArgs } from '../dist/args.js';
import { parseShell, wordLiteral } from '../dist/guard/shell.js';
import { courierOnlyEnv, writeGuardSettings } from '../dist/guard/install.js';

const root = path.join(os.homedir(), 'scratch/tc712');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const tmp = fs.mkdtempSync(path.join(root, 'guard-e2e-'));
fs.chmodSync(tmp, 0o700);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const TC_HOME = path.join(tmp, 'tc');
const TOKEN = `ghp_${'d'.repeat(36)}`; // Dummy only; never printed or placed on argv.
const SHA = 'a'.repeat(40);
const realHome = path.join(tmp, 'owner-home');
fs.mkdirSync(realHome, { mode: 0o700 });
assert.throws(() => brokerRoot(os.userInfo().homedir));
const baseEnv = { ...process.env, HOME: realHome, TC_HOME, TMPDIR: tmp };
const write = (name, value) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(value), { mode: 0o600 }); return f; };
const check = (name, condition) => { assert.ok(condition, name); console.log(`ok ${name}`); };
function courier(home, args, input) {
  const r = spawnSync(process.execPath, [CLI, ...args, ...(['broker', 'run-approved'].includes(args[0]) ? ['--test-owner-root', realHome] : [])], { env: { ...baseEnv, COURIER_HOME: home }, input, encoding: 'utf8', timeout: 180_000 });
  let json; try { json = JSON.parse(r.stdout); } catch { /* refusal */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
const must = (home, args, input) => { const r = courier(home, args, input); assert.equal(r.code, 0, r.stderr); return r.json; };
async function identity(handle) {
  const home = path.join(tmp, handle); const owner = await createOwner();
  const req = must(home, ['init', '--request', '--handle', handle, '--label', 'Disposable guard proof']);
  must(home, ['init', '--grant-file', write(`${handle}-grant.json`, await grantFromRequest(owner, req))]);
  return { home, owner };
}
try {
  const alice = await identity('alice'); const bob = await identity('bob');
  const a = must(alice.home, ['pair', 'start', 'bob']);
  const b = must(bob.home, ['pair', 'accept', '--file', write('a.json', a)]);
  const c = must(alice.home, ['pair', 'accept', '--file', write('b.json', b)]);
  must(bob.home, ['pair', 'accept', '--file', write('c.json', c)]);
  const { threadId } = must(alice.home, ['send', 'bob', '--new', 'Disposable broker proof', '--intent', 'inform', '--text', 'Test']);
  const { taskId } = must(alice.home, ['task', 'new', '--peer', 'bob', '--thread', threadId, '--state', 'working']);
  const ghLog = path.join(tmp, 'gh.jsonl'); const gh = path.join(tmp, 'stub-gh');
  // All constants are test-created paths; token comparison is in the child environment, never argv.
  fs.writeFileSync(gh, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2);\nif (process.env.GH_TOKEN !== 'ghp_' + 'd'.repeat(36)) process.exit(9);\nfs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args)+'\\n');\nif (args[1] === 'view') console.log(JSON.stringify({state:'OPEN', headRefOid:'${SHA}', baseRefName:'master', isDraft:false}));\nelse console.log('stub merge only');\n`, { mode: 0o700 });
  must(alice.home, ['broker', 'set-token', '--test-token', '--gh-bin', gh], TOKEN);
  check('broker credential is private', (fs.statSync(brokerFile(profileId(alice.home), realHome)).mode & 0o777) === 0o600);
  const calls = () => fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const ask = (target = 'a/b#42') => must(alice.home, ['request', threadId, '--peer', 'bob', '--task', taskId, '--verb', 'merge', '--target', target, '--head-sha', SHA, '--base', 'master', '--summary', 'Merge disposable stub PR', '--why', 'Test', '--risk', 'No real merge']).requestId;
  async function approve(id, over = {}) {
    const raw = await alice.owner.node.kv.get(k.request(id), { prefix: '' }); assert.ok(raw.ok);
    const req = typeof raw.data.data === 'string' ? JSON.parse(raw.data.data) : raw.data.data;
    const r = await alice.owner.node.kv.put(k.approval(id), { requestId: id, requestHash: requestHash(req), decision: 'approved', note: '', decidedAt: new Date().toISOString(), ...over }, { prefix: '', ifNoneMatch: '*' }); assert.ok(r.ok);
  }
  const agentEnv = courierOnlyEnv({ ...baseEnv, GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN, NPM_TOKEN: 'dummy' }, alice.home);
  prepareCleanHome({ realHome, cleanHome: agentEnv.HOME, claude: false });
  prepareAgentProfile(alice.home);
  writeGuardSettings({ argv: [process.execPath, CLI, 'guard'], home: alice.home, entry: CLI });
  fs.mkdirSync(agentEnv.TC_HOME, { recursive: true, mode: 0o700 });
  check('agent environment omits Courier/broker roots', !agentEnv.COURIER_HOME && !Object.values(agentEnv).some(v => v === realHome));
  check('agent environment contains no broker or registry token', !agentEnv.GH_TOKEN && !agentEnv.GITHUB_TOKEN && !agentEnv.NPM_TOKEN);
  function hook(command) {
    const r = spawnSync(process.execPath, [CLI, 'guard'], { env: { ...agentEnv, COURIER_HOME: alice.home, COURIER_REAL_HOME: realHome }, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: tmp }), encoding: 'utf8' });
    return r.status === 2 || JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny';
  }
  const id = ask();
  check('hook refuses direct gated command before approval', hook('gh pr merge 42 --repo a/b'));
  await approve(id);
  check('hook still refuses raw command after approval', hook('gh pr merge 42 --repo a/b') && calls().length === 0);
  // The real broker resolves the profile id from the agent marker, then reads the original owner pin.
  const brokerAsAgent = () => spawnSync(process.execPath, [CLI, 'run-approved', id, '--test-owner-root', realHome], { env: { ...agentEnv, COURIER_HOME: '' }, encoding: 'utf8', timeout: 180_000 });
  for (const home of [alice.home, path.join(agentEnv.HOME, '.courier')]) {
    const profileFile = path.join(home, 'profile.json');
    const saved = fs.readFileSync(profileFile, 'utf8');
    try {
      fs.writeFileSync(profileFile, JSON.stringify({ ...JSON.parse(saved), host: 'https://agent-selected.invalid' }), { mode: 0o600 });
      const refused = brokerAsAgent();
      check('broker rejects modified owner or snapshot host before gh/network', refused.status !== 0 && /broker-profile-mismatch/.test(refused.stderr) && calls().length === 0);
    } finally { fs.writeFileSync(profileFile, saved, { mode: 0o600 }); }
  }
  const ran = brokerAsAgent(); assert.equal(ran.status, 0, ran.stderr);
  const result = JSON.parse(ran.stdout);
  check('broker executed only the fixed stub merge', result.consumed && result.ok && calls().length === 2 && JSON.stringify(calls()[1]) === JSON.stringify(['pr', 'merge', '42', '--repo=a/b', '--squash', `--match-head-commit=${SHA}`]));
  const marker = await alice.owner.node.kv.get(k.approvalUsed(id), { prefix: '' }); check('marker exists under me/consumed/', marker.ok);
  const replay = courier(alice.home, ['run-approved', id]); check('replay refuses before gh', replay.code !== 0 && /approval-used/.test(replay.stderr) && calls().length === 2);
  for (const over of [{ requestHash: 'forged' }, { requestId: id }]) {
    const bad = ask('a/b#43'); await approve(bad, over);
    const r = courier(alice.home, ['run-approved', bad]);
    check('forged or mismatched approval refuses before gh', r.code !== 0 && /approval-mismatch/.test(r.stderr) && calls().length === 2);
    check('forged approval consumes nothing', !(await alice.owner.node.kv.get(k.approvalUsed(bad), { prefix: '' })).ok);
  }
  // R1: run with exactly the adapter-built env, no model, and no owner key passed to this child. Only the private
  // Courier profile is reachable by normal profile discovery; TC_HOME and HOME/.tinycloud are empty.
  const probe = path.join(tmp, 'r1.mjs');
  const moduleUrl = name => new URL(`../dist/${name}.js`, import.meta.url).href;
  fs.writeFileSync(probe, `import fs from 'node:fs'; import path from 'node:path';
import {courierNode} from ${JSON.stringify(moduleUrl('node'))};
import {loadProfile} from ${JSON.stringify(moduleUrl('profile'))};
import {k} from ${JSON.stringify(moduleUrl('keys'))};
const id=${JSON.stringify(id)}; const node=await courierNode(loadProfile());
for(const dir of [process.env.TC_HOME, path.join(process.env.HOME,'.tinycloud')]) if(fs.existsSync(dir) && fs.readdirSync(dir).length) throw Error('unexpected discoverable tc profile');
const refused=async(fn)=>{let r;try{r=await fn()}catch(e){r={ok:false,error:e}}const status=String(r.error?.status??r.error?.meta?.status??r.error?.code??'');if(r.ok||!/^4[0-9][0-9]$/.test(status)) throw Error('expected 4xx, got '+status);console.log('refused '+status)};
await refused(()=>node.kv.put(k.approval(id),{decision:'approved'},{prefix:''}));
for(const key of [k.approvalUsed(id),k.approvalUsed(id).replace('/me/consumed/','/me/state/../consumed/'),k.approvalUsed(id).replace('/me/consumed/','/me/state/%2e%2e/consumed/'),k.approvalUsed(id).replace('/me/consumed/','/me/state%2F..%2Fconsumed/')]) await refused(()=>node.kv.delete(key,{prefix:''}));
const marker=await node.kv.get(k.approvalUsed(id),{prefix:'',source:'network'});if(!marker.ok)throw Error('marker lost');console.log('marker remains');
`, { mode: 0o600 });
  const r1 = spawnSync(process.execPath, [probe], { env: { ...agentEnv, COURIER_HOME: '' }, encoding: 'utf8', timeout: 180_000 });
  check('R1: adapter environment cannot write approvals or delete consumed markers, including traversal', r1.status === 0 && /marker remains/.test(r1.stdout));
  console.log(r1.stdout.trim());
  const incoming = must(bob.home, ['send', 'alice', '--new', 'D mode disposable proof', '--intent', 'request', '--text', 'A counterparty request, not an owner instruction']);
  const decisionId = ask('a/b#44'); await approve(decisionId);
  const sample = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8').match(/^courier watch --wake none --notify exec .+$/m)[0];
  const sampleArgs = parseArgs(parseShell(sample).cmds[0].words.map(wordLiteral).slice(2));
  const delivered = courier(alice.home, ['watch', '--wake', 'none', '--once', '--notify', 'exec', '--notify-exec', sampleArgs.get('notify-exec'), '--cwd', tmp]);
  check('D mode: watch invokes no wake adapter and no approved merge', delivered.code === 0 && !/"event":"waking"/.test(delivered.stdout) && calls().length === 2);
  const inbox = must(alice.home, ['inbox', '--json']);
  check('D mode: inbox status exposes delivered thread and owner decision after receipts', inbox.notifications.some(n => n.kind === 'new-message' && n.thread === incoming.threadId) && inbox.notifications.some(n => n.kind === 'new-approval'));
  const noticeLines = fs.readFileSync(path.join(alice.home, 'operator-notices.log'), 'utf8');
  check('D mode: the documented exec sample fires for messages and approvals', /new-message bob/.test(noticeLines) && /new-approval bob/.test(noticeLines));
  check('D mode: delivery mirrored and receipted', (await alice.owner.node.kv.get(k.mirrorMsg('bob', incoming.threadId, incoming.messageId), { prefix: '' })).ok && (await alice.owner.node.kv.get(k.receipts('bob'), { prefix: '' })).ok);
  console.log('ALL PASS (no model calls, no real GitHub calls)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
