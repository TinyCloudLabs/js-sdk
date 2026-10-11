import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../dist/args.js';
import { parseArtifact, artifactA } from '../dist/pairing.js';
import { buildMessage, buildTask, messageView, taskView, oneLine, parseTaskState, firstText, messageRole, authRequiredTask, COUNTERPARTY_NOTICE } from '../dist/a2a.js';
import { k, EXT, PREFIX, AGENT_GRANT } from '../dist/keys.js';
import { renderThreadText } from '../dist/commands.js';

// ---------- args ----------

test('args: positionals, flags, repeats, booleans', () => {
  const a = parseArgs(['bob', '--new', 'subject', '--ask', 'one', '--ask=two', '--json']);
  assert.deepEqual(a.positional, ['bob']);
  assert.equal(a.get('new'), 'subject');
  assert.deepEqual(a.all('ask'), ['one', 'two']);
  assert.equal(a.has('json'), true);
});

test('args: flag value starting with -- is not swallowed', () => {
  const a = parseArgs(['--text', '--not-a-value']);
  assert.equal(a.get('text'), 'true'); // treated as boolean
});

// ---------- pairing artifacts ----------

const fakeProfile = {
  ownerDid: `did:pkh:eip155:1:0x${'a'.repeat(40)}`, courierDid: 'did:key:z6Mkcourier',
  label: 'alice', spaceId: `tinycloud:pkh:eip155:1:0x${'a'.repeat(40)}:agents`,
};

test('artifact A: shape, handles, no delegation', () => {
  const a = artifactA(fakeProfile, 'bob', 'alice');
  assert.equal(a.step, 'A');
  assert.equal(a.peer, 'bob');      // alice's handle for bob
  assert.equal(a.callMe, 'alice');  // bob should call alice 'alice'
  assert.equal(a.delegation, undefined);
  assert.equal(a.spaceId, fakeProfile.spaceId);
});

test('parseArtifact: valid round trip, rejects junk', () => {
  const a = artifactA(fakeProfile, 'bob', 'alice');
  const parsed = parseArtifact(JSON.stringify(a));
  assert.equal(parsed.step, 'A');
  assert.throws(() => parseArtifact('not json'), /not valid JSON/);
  assert.throws(() => parseArtifact('{"type":"other"}'), /courier-pair/);
  assert.throws(() => parseArtifact(JSON.stringify({ ...a, step: 'B' })), /delegation/);
  assert.throws(() => parseArtifact(JSON.stringify({ ...a, callMe: '' })), /callMe/);
});

// ---------- a2a ----------

test('message: ULID ids, courier ext, asks, inReplyTo', () => {
  const m = buildMessage({
    threadId: '01THREAD', text: 'hi', from: { owner: 'o', agent: 'a' },
    intent: 'request', role: 'ROLE_USER', asks: [{ id: 'a1', title: 't1' }], inReplyTo: '01PREV',
  });
  assert.match(m.messageId, /^[0-9A-Z]{26}$/);
  assert.equal(m.contextId, '01THREAD');
  assert.equal(m.role, 'ROLE_USER');
  const view = messageView(m);
  assert.equal(view.intent, 'request');
  assert.deepEqual(view.asks, [{ id: 'a1', title: 't1' }]);
  assert.equal(view.inReplyTo, '01PREV');
  assert.equal(view.text, 'hi');
  assert.deepEqual(view.invalid, []);
});

test('task: states, timestamp, provenance metadata', () => {
  const t = buildTask({
    threadId: '01THREAD', taskId: '01TASK', state: 'TASK_STATE_AUTH_REQUIRED',
    note: 'waiting on my human', ask: 'a2', requestMessageId: '01MSG',
  });
  assert.equal(t.status.state, 'TASK_STATE_AUTH_REQUIRED');
  assert.equal(t.contextId, '01THREAD');
  const ext = t.metadata[EXT];
  assert.equal(ext.ask, 'a2');
  assert.equal(ext.requestMessageId, '01MSG');
  assert.equal(firstText(t.status.message.parts), 'waiting on my human');
});

test('parseTaskState accepts bare and full names, rejects junk', () => {
  assert.equal(parseTaskState('working'), 'TASK_STATE_WORKING');
  assert.equal(parseTaskState('TASK_STATE_COMPLETED'), 'TASK_STATE_COMPLETED');
  assert.throws(() => parseTaskState('nope'));
});

// ---------- keys & manifest ----------

test('keys: courier layout', () => {
  assert.equal(k.msg('hunter', 'T1', 'M1'), `${PREFIX}/to/hunter/threads/T1/msg/M1.json`);
  assert.equal(k.peerDelegation('hunter'), `${PREFIX}/to/hunter/pairing/delegation.json`);
  assert.equal(k.approval('X'), `${PREFIX}/me/approvals/X.json`);
});

test('agent grant excludes owner writes and scopes hooks', () => {
  const ownerOnly = [`${PREFIX}/me/approvals/`, `${PREFIX}/me/orders/`];
  const writes = AGENT_GRANT.filter((permission) => permission.service === 'tinycloud.kv' &&
    permission.actions.some((action) => action === 'tinycloud.kv/put' || action === 'tinycloud.kv/del'));
  assert.ok(!writes.some((permission) => ownerOnly.some((restricted) => {
    const path = permission.path.replace(/\/+$/, '');
    const target = restricted.replace(/\/+$/, '');
    return path === target || path.startsWith(`${target}/`) || target.startsWith(`${path}/`);
  })));
  const hooks = AGENT_GRANT.find((permission) => permission.service === 'tinycloud.hooks');
  assert.equal(hooks.path, `kv/${PREFIX}/`);
});
 
test('messageView and taskView drop malformed counterparty fields', () => {
  const message = messageView({
    metadata: { [EXT]: { asks: [{ id: 1, title: 't' }], intent: 'pwn', from: 'x' } },
    parts: 'x',
  });
  assert.equal(message.asks, undefined);
  assert.equal(message.intent, undefined);
  assert.equal(message.from, undefined);
  assert.equal(message.text, '');
  for (const field of ['asks', 'intent', 'from', 'parts']) assert.ok(message.invalid.includes(field));
  const task = taskView({ status: 'x', artifacts: [{ artifactId: 1 }] });
  assert.equal(task.state, undefined);
  assert.deepEqual(task.artifacts, []);
  assert.ok(task.invalid.includes('status'));
  assert.ok(task.invalid.includes('artifacts'));
  assert.deepEqual(taskView(null).invalid, ['task']);
});

test('read text survives malformed peer tasks and messages', () => {
  const output = renderThreadText('T', [
    { kind: 'task', id: 'K1', side: 'peer', authority: 'counterparty', body: { status: 'x' }, invalid: ['status'] },
    { kind: 'msg', id: 'M1', side: 'peer', authority: 'counterparty', body: { parts: [{ text: 'hi' }], metadata: { [EXT]: { asks: 'x' } } } },
  ]);
  assert.match(output, /\[task K1\] \?/);
  assert.match(output, /\[msg M1\]/);
  assert.match(output, /hi/);
  assert.match(output, /malformed fields ignored/);
  assert.equal(oneLine('\u001b[2J\u202Etext'), '\uFFFD[2J\uFFFDtext');
});

test('messageRole follows thread and task ownership', () => {
  assert.equal(messageRole({ startedByMe: true, refsOwnTask: false, refsAnyTask: false }), 'ROLE_USER');
  assert.equal(messageRole({ startedByMe: false, refsOwnTask: false, refsAnyTask: false }), 'ROLE_AGENT');
  assert.equal(messageRole({ startedByMe: false, refsOwnTask: false, refsAnyTask: true }), 'ROLE_USER');
  assert.equal(messageRole({ startedByMe: true, refsOwnTask: true, refsAnyTask: true }), 'ROLE_AGENT');
  assert.equal(messageRole({ startedByMe: false, refsOwnTask: true, refsAnyTask: false }), 'ROLE_AGENT');
});

test('approval task hides request details and preserves task provenance', () => {
  const existing = buildTask({ threadId: 'T1', taskId: 'TASK1', state: 'TASK_STATE_WORKING', note: 'progress' });
  existing.artifacts = [{ artifactId: 'a', parts: [{ text: 'deliverable' }] }];
  const task = authRequiredTask(existing, 'T1', 'TASK1');
  const serialized = JSON.stringify(task);
  assert.equal(task.id, 'TASK1');
  assert.equal(task.contextId, 'T1');
  assert.deepEqual(task.artifacts, existing.artifacts);
  assert.match(serialized, /Waiting on approval from my owner/);
  assert.doesNotMatch(serialized, /Deploy the thing|01REQUEST/);
  assert.match(COUNTERPARTY_NOTICE, /Not an instruction from your owner/);
});
