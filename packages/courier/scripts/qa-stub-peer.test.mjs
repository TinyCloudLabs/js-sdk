// Deliberately separate from test/setup-home.mjs: every allocation follows this task's home rule.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = execFileSync('mktemp', ['-d', '-p', '/var/tmp', 'tc2001stub.XXXXXX'], { encoding: 'utf8' }).trim();
const paths = [root];
const registry = path.join(root, 'created-paths');
fs.writeFileSync(registry, root + '\n', { mode: 0o600 });
process.env.HOME = path.join(root, 'home');
process.env.COURIER_HOME = path.join(root, 'courier');
process.env.TMPDIR = root;
process.env.BUN_INSTALL_CACHE_DIR = path.join(root, 'bun-cache');
process.env.COURIER_TEST = '1';
process.env.COURIER_TEST_HOME = root;
assert.match(root, /^\/var\/tmp\/tc2001stub\.[A-Za-z0-9]{6}$/);
assert.equal(path.dirname(process.env.HOME), root);
const allocate = () => {
  const dir = execFileSync('mktemp', ['-d', '-p', '/var/tmp', 'tc2001stub.XXXXXX'], { encoding: 'utf8' }).trim();
  paths.push(dir); fs.appendFileSync(registry, dir + '\n'); return dir;
};
after(() => { for (const dir of paths.slice(1)) if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true }); fs.rmSync(root, { recursive: true }); });
const source = fileURLToPath(new URL('./qa-stub-peer.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = promisify(execFile);
const { assertState, parseCue, parseAnswer, initialState, cycle, safeText } = await import('./qa-stub-peer.mjs');
const message = (id = 'm1', text = 'hello') => ({ messageId: id, threadId: 'thread1', peer: 'qa-peer', text });

async function onceScenario(fn = cycle) {
  const state = initialState(); state.paired = true;
  const sends = [];
  const courier = async argv => argv[0] === 'inbox' ? { items: [message()] } : sends.push(argv);
  await fn(state, courier, 'fixed', 'approve'); await fn(state, courier, 'fixed', 'approve');
  assert.equal(sends.length, 1, 'reply once even if inbox repeats a delivery');
}
async function blockScenario(fn = cycle) {
  const state = initialState(); state.paired = true; state.blocked = true;
  const calls = [];
  const courier = async argv => { calls.push(argv); return argv[0] === 'inbox' ? { items: [message()] } : {}; };
  await fn(state, courier, 'fixed', 'approve'); assert.equal(calls.length, 0, 'blocked means no inbox reads or sends');
  state.blocked = false; await fn(state, courier, 'fixed', 'approve'); await fn(state, courier, 'fixed', 'approve');
  assert.equal(calls.filter(a => a[0] === 'send').length, 1, 'unblock drains once');
}
async function answerScenario(fn = cycle, decision = 'deny', wrongId = false) {
  const state = initialState(); state.paired = true;
  const askId = '01AAAAAAAAAAAAAAAAAAAAAAAA';
  state.asks[askId] = { askId, threadId: 'thread1', messageId: 'ask-message' };
  const item = message('answer-message', `${decision} ${wrongId ? '01BBBBBBBBBBBBBBBBBBBBBBBB' : askId}`);
  const sends = [];
  const courier = async argv => argv[0] === 'inbox' ? { items: [item] }
    : argv[0] === 'read' ? { entries: [{ side: 'peer', id: item.messageId, body: { metadata: { 'https://tinycloud.xyz/ext/courier/v0': { inReplyTo: 'ask-message' } } } }] }
    : sends.push(argv);
  await fn(state, courier, 'fixed', 'approve'); await fn(state, courier, 'fixed', 'approve');
  assert.equal(state.answersReceived, wrongId ? 0 : 1);
  assert.equal(state.resumedActions, !wrongId && decision === 'approve' ? 1 : 0, 'only approve resumes');
  assert.equal(sends.length, wrongId ? 0 : 1);
  assert.equal(state.unparseable, wrongId ? 1 : 0);
}

test('reply once; block avoids reading; unblock drains once', async () => { await onceScenario(); await blockScenario(); });
test('approval/denial correlation and one fixed follow-up', async () => {
  await answerScenario(); await answerScenario(cycle, 'approve'); await answerScenario(cycle, 'approve', true);
});
test('pause retains queued messages, resumes once, fixed structured reply for asks', async () => {
  const state = initialState(); state.paired = true; state.pausedThreads = ['thread1'];
  const sends = []; const item = { ...message(), asks: [{ id: 'a1', title: 'task' }] };
  const courier = async a => a[0] === 'inbox' ? { items: [item] } : sends.push(a);
  await cycle(state, courier, 'fixed', 'deny'); assert.equal(sends.length, 0); assert.equal(state.pending.length, 1);
  state.pausedThreads = []; await cycle(state, courier, 'fixed', 'deny');
  assert.match(sends[0].at(-1), /"answer":"deny"/); assert.equal(state.pending.length, 0);
});
test('argument, home, text, cue and answer guards', async () => {
  assert.throws(() => assertState(root, '/foreign'), /escapes/);
  assert.throws(() => parseCue(['pause', 'bad']), /ULID/);
  assert.throws(() => parseCue(['unknown']), /unknown/);
  assert.equal(parseCue(['block']).action, 'block');
  assert.equal(parseAnswer('approve 01AAAAAAAAAAAAAAAAAAAAAAAA extra').answer, 'approve');
  assert.equal(parseAnswer('{"type":"qa-stub-answer","askId":"01AAAAAAAAAAAAAAAAAAAAAAAA","answer":"deny"}').answer, 'deny');
  assert.equal(parseAnswer('yes'), undefined);
  assert.throws(() => safeText('Bearer credential'), /refused/);
  assert.throws(() => safeText('hidden\ntext'), /refused/);
  const result = await run(process.execPath, [source, 'start'], { env: { PATH: process.env.PATH }, timeout: 5000 }).catch(e => e);
  assert.equal(result.code, 1); assert.match(result.stderr, /requires --host/);
  const foreign = allocate();
  const purge = await run(process.execPath, [source, 'purge', '--state', foreign], { env: { PATH: process.env.PATH }, timeout: 5000 }).catch(e => e);
  assert.equal(purge.code, 1); assert.equal(fs.existsSync(foreign), true);
});

test('mutation proof: reply-once, block, ask-id and approve guards', async () => {
  const original = fs.readFileSync(source, 'utf8');
  const mutations = [
    ['reply-once', 'if (state.seen.includes(item.messageId))', 'if (false)', onceScenario],
    ['block', 'if (state.blocked || !state.paired)', 'if (!state.paired)', blockScenario],
    ['ask-id', 'answer.askId !== openAsk.askId', 'false', fn => answerScenario(fn, 'approve', true)],
    ['approve-only', "if (answer.answer === 'approve') state.resumedActions++", 'if (true) state.resumedActions++', answerScenario],
  ];
  for (const [guard, from, to, scenario] of mutations) {
    assert.ok(original.includes(from));
    const file = path.join(root, `mutant-${guard}.mjs`);
    // Absolute safety import: mutations live exclusively in our recorded scratch directory.
    fs.writeFileSync(file, original.replace(from, to).replace("'./qa-stub-safety.mjs'", JSON.stringify(fileURLToPath(new URL('./qa-stub-safety.mjs', import.meta.url)))), { mode: 0o600 });
    const mutant = await import(pathToFileURL(file));
    await assert.rejects(() => scenario(mutant.cycle), assert.AssertionError);
    await scenario(cycle);
    console.log(`MUTATION ${guard}: failed as expected; tracked source untouched; restored green`);
  }
});

test('process/network fences reject forbidden children and non-node destinations', async () => {
  const guard = fileURLToPath(new URL('./qa-stub-safety.mjs', import.meta.url));
  const harness = path.join(root, 'fence-check.mjs');
  fs.writeFileSync(harness, `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import http from 'node:http';
    import net from 'node:net';
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.COURIER_NOTIFY_EXEC, undefined);
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork']) assert.throws(() => cp[name]('claude'), /process fence/);
    assert.throws(() => cp.execFile('curl', ['https://example.com'], {}), /process fence/);
    assert.throws(() => cp.execFile(process.execPath, ['--import', ${JSON.stringify(guard)}, ${JSON.stringify(cli)}, 'watch', '--wake', 'claude'], {}), /process fence/);
    assert.throws(() => fetch('https://example.com'), /network fence/);
    assert.throws(() => http.get('http://127.0.0.1:9'), /network fence/);
    assert.throws(() => new net.Socket().connect({ host: 'example.com', port: 443 }), /socket fence/);
    console.log('SAFETY rejection proof: paid-model/mailer/notify process paths and external hosts refused');
  `, { mode: 0o600 });
  const result = await run(process.execPath, ['--import', guard, harness], { timeout: 5000, env: {
    PATH: process.env.PATH, QA_STUB_HOST: 'http://127.0.0.1:8000', QA_STUB_STATE: root, QA_STUB_CLI: cli,
    ANTHROPIC_API_KEY: 'must-be-scrubbed', COURIER_NOTIFY_EXEC: 'must-not-run',
  } });
  assert.match(result.stdout, /SAFETY rejection proof/);
  console.log(result.stdout.trim());
});

test('kept-state and purge ownership mutation proof', async () => {
  const original = fs.readFileSync(source, 'utf8');
  const scenarios = [
    ['marker', "owner.type !== 'qa-courier-stub-v1' || owner.state !== stateDir", 'false', module => assert.throws(() => module.assertMarker({ type: 'foreign', state: root, pid: null }, root, true), /ownership/)],
    ['kept-running', 'stopped && owner.pid !== null', 'false', module => assert.throws(() => module.assertMarker({ type: 'qa-courier-stub-v1', state: root, pid: 123 }, root, true), /already running/)],
  ];
  const real = await import('./qa-stub-peer.mjs');
  for (const [guard, from, to, scenario] of scenarios) {
    assert.ok(original.includes(from));
    const file = path.join(root, `mutant-${guard}.mjs`);
    fs.writeFileSync(file, original.replace(from, to).replace("'./qa-stub-safety.mjs'", JSON.stringify(fileURLToPath(new URL('./qa-stub-safety.mjs', import.meta.url)))), { mode: 0o600 });
    const mutated = await import(pathToFileURL(file));
    assert.throws(() => scenario(mutated), assert.AssertionError);
    scenario(real);
    console.log(`MUTATION ${guard}: failed as expected; tracked source untouched; restored green`);
  }
});

const binary = process.env.TC_REPLICATION_E2E_NODE_BIN;
test('real local node: all four matrix flows, controls, restart and safety audit', { skip: !binary, timeout: 420_000 }, async () => {
  const server = createServer();
  const port = await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
  const host = `http://127.0.0.1:${port}`;
  const node = spawn(binary, [], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME,
    TINYCLOUD_STORAGE__DATADIR: path.join(root, 'data'), TINYCLOUD_PORT: String(port), TINYCLOUD_ADDRESS: '127.0.0.1',
    ROCKET_PORT: String(port), ROCKET_ADDRESS: '127.0.0.1', TINYCLOUD_KEYS__TYPE: 'Static', TINYCLOUD_KEYS__SECRET: randomBytes(48).toString('base64url') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const children = [node];
  let stubState;
  const wait = async (fn, ms = 60_000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } throw new Error('bounded observation timed out'); };
  const ready = child => new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(new Error('node readiness timeout')), 45_000);
    const data = chunk => { out += chunk; if (out.includes('Rocket has launched')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', data); child.stderr.on('data', data);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`node exited ${code}: ${out.slice(-500)}`)); });
  });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, COURIER_HOME: path.join(root, 'peer'), COURIER_TEST: '1', COURIER_TEST_HOME: root };
  const peer = async argv => JSON.parse((await run(process.execPath, [cli, ...argv], { env, timeout: 45_000 })).stdout);
  const stubEnv = () => ({ PATH: process.env.PATH, COURIER_HOME: path.join(stubState, 'courier'), ANTHROPIC_API_KEY: 'test-credential-must-be-scrubbed', COURIER_NOTIFY_EXEC: 'must-not-run' });
  const control = async (...argv) => JSON.parse((await run(process.execPath, [source, ...argv, '--state', stubState], { env: stubEnv(), timeout: 70_000 })).stdout);
  const read = async thread => (await peer(['read', thread, '--json'])).entries;
  const peerText = entries => entries.filter(e => e.kind === 'msg' && e.side === 'peer').map(e => e.body.parts.map(p => p.text ?? '').join(''));
  const snapshot = () => JSON.parse(fs.readFileSync(path.join(stubState, 'status.json'), 'utf8'));
  const launch = async (dir) => {
    stubState = dir;
    const child = spawn(process.execPath, [source, 'start', '--host', host, ...(dir ? ['--state', dir] : [])], { env: dir ? stubEnv() : { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'must-be-scrubbed' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const value = await wait(() => {
      if (child.exitCode !== null) throw new Error(`stub exited ${child.exitCode}: ${stderr}`);
      for (const line of stdout.split('\n')) { try { const v = JSON.parse(line); if (v.ready) return v; } catch {} }
    });
    if (!dir) { stubState = value.state; paths.push(stubState); fs.appendFileSync(registry, stubState + '\n'); }
    assert.match(stderr, /QA stub: no model, no human, no wake/);
    assert.match(stderr, new RegExp(host));
    return value;
  };
  try {
    await ready(node);
    process.env.COURIER_FAKE_OPENKEY_HOST = host;
    const { createOwner, grantFromRequest } = await import('./fake-openkey.mjs');
    const { requestHash } = await import('../dist/canonical.js');
    const { k } = await import('../dist/keys.js');
    const owner = await createOwner();
    const req = await peer(['init', '--request', '--host', host, '--handle', 'qa-peer']);
    const grant = path.join(root, 'peer-grant.json'); fs.writeFileSync(grant, JSON.stringify(await grantFromRequest(owner, req)), { mode: 0o600 });
    await peer(['init', '--grant-file', grant]); fs.unlinkSync(grant);
    const info = await launch(allocate());
    const af = path.join(root, 'a.json'); fs.writeFileSync(af, JSON.stringify(info.artifact), { mode: 0o600 });
    const artB = await peer(['pair', 'accept', '--file', af]);
    const bf = path.join(root, 'b.json'); fs.writeFileSync(bf, JSON.stringify(artB), { mode: 0o600 });
    const artC = await control('accept', '--file', bf);
    const cf = path.join(root, 'c.json'); fs.writeFileSync(cf, JSON.stringify(artC), { mode: 0o600 });
    await peer(['pair', 'accept', '--file', cf]);
    assert.equal(snapshot().paired, true);
    console.log('E2E paired: A -> B -> C (two throwaway identities)');

    const started = await control('cue', 'send-thread');
    assert.ok(peerText(await read(started.threadId)).some(t => t.includes('please read')));
    const reply = await peer(['send', 'qa-stub', '--thread', started.threadId, '--text', 'QA peer read and replied', '--intent', 'answer', '--reply-to', started.messageId]);
    await wait(() => snapshot().seen.includes(reply.messageId));
    assert.equal(peerText(await read(started.threadId)).filter(t => t.includes(reply.messageId)).length, 1);
    console.log('E2E follow-a-conversation + reply: read stub thread; fixed acknowledgement once');

    for (const decision of ['approve', 'deny']) {
      const ask = await control('cue', 'ask', '--verb', 'other', '--target', 'qa:fixed-follow-up', '--summary', 'Post a fixed QA follow-up');
      const messages = await read(ask.threadId);
      const askMessage = messages.find(e => e.id === ask.messageId).body;
      const ext = askMessage.metadata['https://tinycloud.xyz/ext/courier/v0'];
      assert.equal(ext.intent, 'ask'); assert.equal(ext.asks[0].title, 'Approve: other on qa:fixed-follow-up');
      assert.ok(askMessage.parts[0].text.includes('```json'));
      const task = await peer(['task', 'new', '--peer', 'qa-stub', '--thread', ask.threadId, '--state', 'working', '--ask', 'a1']);
      const request = await peer(['request', ask.threadId, '--peer', 'qa-stub', '--task', task.taskId,
        '--verb', 'other', '--target', 'qa:fixed-follow-up', '--summary', 'Post a fixed QA follow-up', '--why', 'QA owner decision only']);
      const raw = (await owner.node.kv.get(k.request(request.requestId), { prefix: '' })).data;
      const requestBody = typeof raw.data === 'string' ? JSON.parse(raw.data) : raw.data;
      assert.equal(requestBody.id, request.requestId);
      const put = await owner.node.kv.put(k.approval(request.requestId), { requestId: request.requestId, requestHash: requestHash(requestBody), decision: decision === 'approve' ? 'approved' : 'denied', note: 'QA fixture owner decision', decidedAt: new Date().toISOString() }, { prefix: '', ifNoneMatch: '*' });
      assert.equal(put.ok, true);
      // Peer watcher has no model, wake adapter or external notifier; needs-you is local only.
      const watch = await run(process.execPath, [cli, 'watch', '--once', '--wake', 'none', '--notify', 'none', '--cwd', root], { env, timeout: 45_000 });
      assert.ok(watch.stdout.length > 0);
      const checked = await run(process.execPath, [cli, 'approval', request.requestId, '--verb', 'other', '--target', 'qa:fixed-follow-up'], { env, timeout: 45_000 }).catch(e => e);
      if (decision === 'approve') { assert.equal(JSON.parse(checked.stdout).consumed, true); }
      else { assert.equal(checked.code, 1); assert.match(checked.stderr, /approval-denied/); }
      const text = decision === 'approve' ? `approve ${ask.askId}` : JSON.stringify({ type: 'qa-stub-answer', askId: ask.askId, answer: 'deny' });
      await peer(['send', 'qa-stub', '--thread', ask.threadId, '--intent', 'answer', '--reply-to', ask.messageId, '--text', text]);
      assert.deepEqual(await control('cue', 'wait-answer', ask.askId, '--timeout', '60'), { answer: decision });
      assert.ok(peerText(await read(ask.threadId)).some(t => t.includes(decision === 'approve' ? 'resumed action' : 'denied.')));
      console.log(`E2E owner ${decision}: real peer task/request -> owner decision -> approval ${decision === 'approve' ? 'consumed' : 'refused approval-denied'} -> correlated answer -> fixed ${decision === 'approve' ? 'resumed' : 'denied'} message`);
    }
    assert.equal(snapshot().answersReceived, 2); assert.equal(snapshot().resumedActions, 1);

    const fresh = await peer(['send', 'qa-stub', '--new', 'Fresh request', '--text', 'Please acknowledge', '--intent', 'request']);
    await wait(() => snapshot().seen.includes(fresh.messageId));
    assert.equal(peerText(await read(fresh.threadId)).filter(t => t.includes(fresh.messageId)).length, 1);
    await control('cue', 'block');
    const queued = await peer(['send', 'qa-stub', '--thread', fresh.threadId, '--text', 'While blocked', '--intent', 'request']);
    const safetyBefore = fs.readFileSync(path.join(stubState, 'safety.jsonl'), 'utf8');
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(peerText(await read(fresh.threadId)).filter(t => t.includes(queued.messageId)).length, 0);
    assert.equal(fs.readFileSync(path.join(stubState, 'safety.jsonl'), 'utf8'), safetyBefore, 'blocked stub makes no node calls');
    await control('cue', 'unblock'); await wait(() => snapshot().seen.includes(queued.messageId));
    assert.equal(peerText(await read(fresh.threadId)).filter(t => t.includes(queued.messageId)).length, 1);
    await control('cue', 'pause', fresh.threadId);
    assert.ok((await read(fresh.threadId)).some(e => e.body.metadata?.['https://tinycloud.xyz/ext/courier/v0']?.notice === 'thread-paused'));
    await control('cue', 'resume', fresh.threadId);
    console.log('E2E send-a-new-request: fixed reply once; block silence 1200ms; unblock queued reply once; real thread-paused inform');

    const audit = fs.readFileSync(path.join(stubState, 'safety.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const calls = audit.filter(e => e.type === 'child');
    assert.ok(calls.length > 10);
    const allowedCommands = ['init', 'pair', 'inbox', 'read', 'send', 'pause', 'resume', 'revoke'];
    for (const call of calls) {
      assert.equal(call.file, process.execPath); assert.equal(call.argv[0], '--import'); assert.equal(call.argv[2], cli);
      assert.ok(allowedCommands.includes(call.argv[3]));
      assert.ok(!call.envKeys.some(k => /API_KEY|TOKEN|NOTIFY/.test(k)));
    }
    assert.ok(audit.some(e => e.type === 'network' || e.type === 'socket'));
    for (const event of audit.filter(e => e.type === 'network')) assert.equal(event.origin, host);
    for (const event of audit.filter(e => e.type === 'socket')) assert.equal(event.port, port);
    for (const event of audit.filter(e => e.type === 'fence')) { assert.equal(event.wake, 'none'); assert.equal(event.notify, 'none'); assert.ok(!event.envKeys.some(k => /API_KEY|TOKEN|NOTIFY/.test(k))); }
    console.log(`SAFETY: ${calls.length} children; ONLY real courier CLI; network ONLY ${host}; injected API key and notifier scrubbed; peer --wake none --notify none`);

    const before = JSON.parse(fs.readFileSync(path.join(stubState, 'courier', 'profile.json'), 'utf8'));
    await control('stop', '--keep-state');
    assert.equal(fs.existsSync(stubState), true);
    const modes = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); assert.equal(fs.statSync(f).mode & 0o777, e.isDirectory() ? 0o700 : 0o600, f); if (e.isDirectory()) modes(f); } };
    modes(stubState);
    const returned = await launch(stubState); assert.equal(returned.artifact, null);
    const after = JSON.parse(fs.readFileSync(path.join(stubState, 'courier', 'profile.json'), 'utf8'));
    assert.equal(after.courierDid, before.courierDid); assert.deepEqual(after.peers, before.peers);
    const again = await peer(['send', 'qa-stub', '--new', 'Returning request', '--intent', 'request', '--text', 'Returning profile']);
    await wait(() => snapshot().seen.includes(again.messageId));
    assert.equal(peerText(await read(again.threadId)).filter(t => t.includes(again.messageId)).length, 1);
    const returningAudit = fs.readFileSync(path.join(stubState, 'safety.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    for (const call of returningAudit.filter(e => e.type === 'child')) { assert.equal(call.file, process.execPath); assert.equal(call.argv[2], cli); assert.ok(allowedCommands.includes(call.argv[3])); assert.ok(!call.envKeys.some(k => /API_KEY|TOKEN|NOTIFY/.test(k))); }
    for (const event of returningAudit.filter(e => e.type === 'network')) assert.equal(event.origin, host);
    console.log('SAFETY returning: complete trace remains Courier-only, node-only, credential-free');
    await control('stop', '--keep-state'); await control('purge'); assert.equal(fs.existsSync(stubState), false);
    console.log('E2E returning: identity + pairing reused; reply once; keep-state modes 0600/0700; purge exact state');
    await launch();
    const automaticAudit = fs.readFileSync(path.join(stubState, 'safety.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    for (const call of automaticAudit.filter(e => e.type === 'child')) { assert.equal(call.file, process.execPath); assert.equal(call.argv[2], cli); assert.ok(allowedCommands.includes(call.argv[3])); }
    for (const event of automaticAudit.filter(e => e.type === 'network')) assert.equal(event.origin, host);
    console.log('SAFETY automatic allocation: in-process state creation; ONLY Courier CLI children');
    await control('stop'); assert.equal(fs.existsSync(stubState), false);
    console.log('E2E default stop: exact state removed; ALL PASS');
  } finally {
    for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 3000))]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  }
});
