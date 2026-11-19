/**
 * TC-709 proof of owner/agent separation, grants, pairing, inbox and renewals.
 *
 * Uses fresh in-memory secp256k1 owners and did:key agents on tee.node; owner
 * private keys never leave this process or enter COURIER_HOME.
 * Run: bun run --cwd packages/courier test:live (writes throwaway identities to tee.node).
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwner, createOwnerWithoutAgents, grantFromRequest } from './fake-openkey.mjs';
import { ulid } from 'ulid';
import { NodeWasmBindings, serializeDelegation } from '@tinycloud/node-sdk';
import { COURIER_SPACE, PREFIX, EXT, k, peerReadPermissions } from '../dist/keys.js';


const run = promisify(execFile);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const results = [];
let failures = 0;

function ok(name, cond, extra) {
  results.push({ name, ok: !!cond });
  if (!cond) failures++;
  console.log(`${cond ? 'ok' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
}

async function courier(home, args, { input, allowFail, env: extraEnv } = {}) {
  const env = { ...process.env, COURIER_HOME: home, ...extraEnv };
  try {
    const pending = run(process.execPath, [CLI, ...args], { env, timeout: 180_000 });
    if (input !== undefined) pending.child.stdin.end(input);
    const { stdout, stderr } = await pending;
    if (stderr.trim()) console.error(`   [stderr] ${stderr.trim().split('\n').slice(0, 3).join(' | ')}`);
    return { code: 0, stdout };
  } catch (e) {
    if (!allowFail) throw e;
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const courierJson = async (home, args, opts) => JSON.parse((await courier(home, args, opts)).stdout);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-e2e-'));
const A = path.join(tmp, 'a');   // "alice" side
const B = path.join(tmp, 'b');   // "bob" side
console.log(`throwaway profiles: ${tmp}`);
const af = (n, obj) => { const p = path.join(tmp, n); fs.writeFileSync(p, JSON.stringify(obj)); return p; };

/** Serve one grant as an OpenKey short code (TC-823); returns the code and API host. */
async function serveShortCode(grant) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const code = [...randomBytes(8)].map((b) => alphabet[b % 32]).join('').replace(/^(.{4})/, '$1-');
  const server = createServer((req, res) => {
    const found = req.url === `/api/delegation-codes/${code}`;
    res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(found ? { delegation: grant } : { error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { code: code.toUpperCase(), apiHost: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function setupIdentity(home, handle, label, { shortCode = false } = {}) {
  const owner = await createOwner();
  const request = await courierJson(home, ['init', '--request', '--handle', handle, '--label', label]);
  const grant = await grantFromRequest(owner, request);
  if (!shortCode) {
    const installed = await courierJson(home, ['init', '--grant-file', af(`${handle}-grant.json`, grant)]);
    return { owner, request, grant, installed };
  }
  const api = await serveShortCode(grant);
  try {
    const installed = await courierJson(home, ['init', '--grant-file', '-'], {
      input: `${api.code}\n`, env: { COURIER_OPENKEY_API_HOST: api.apiHost },
    });
    return { owner, request, grant, installed };
  } finally {
    api.close();
  }
}

// ---------- owner/agent separation ----------
const alice = await setupIdentity(A, 'alice', "Alice's courier");
const bob = await setupIdentity(B, 'bob', "Bob's courier", { shortCode: true });
const initA = alice.installed;
const initB = bob.installed;
ok('owner DID is wallet identity', initA.ownerDid.startsWith('did:pkh:'));
ok('courier DID is separate did:key', initA.courierDid.startsWith('did:key:') && initA.ownerDid !== initA.courierDid);
ok('short-code grant installs (TC-823)', initB.ok === true && initB.ownerDid.startsWith('did:pkh:'));
ok('second identity is distinct', initA.ownerDid !== initB.ownerDid && initA.courierDid !== initB.courierDid);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(file) : [file];
});
for (const [home, owner] of [[A, alice.owner], [B, bob.owner]]) {
  const files = walk(home);
  ok('agent key mode 0600', (fs.statSync(path.join(home, 'key.json')).mode & 0o777) === 0o600);
  ok('owner secret absent from profile', files.every((file) => {
    const content = fs.readFileSync(file, 'utf8');
    return !content.includes(owner.privateKey) && !/"privateKey"\s*:/.test(content);
  }));
}

const manifest = await courierJson(A, ['manifest']);
ok('Courier grant targets canonical agents space', manifest.space === COURIER_SPACE &&
  initA.spaceId.endsWith(`:${COURIER_SPACE}`) && initB.spaceId.endsWith(`:${COURIER_SPACE}`));

// An approved grant is retained until the owner hosts agents, then resumed without consent.
const noSpaceOwner = await createOwnerWithoutAgents();
const noSpaceHome = path.join(tmp, 'awaiting-space');
const noSpaceRequest = await courierJson(noSpaceHome, ['init', '--request', '--handle', 'solo']);
const noSpaceGrant = await grantFromRequest(noSpaceOwner, noSpaceRequest);
const noSpaceGrantFile = af('awaiting-space-grant.json', noSpaceGrant);
const noSpaceInstall = await courier(noSpaceHome, ['init', '--grant-file', noSpaceGrantFile], { allowFail: true });
const awaitingProfile = JSON.parse(fs.readFileSync(path.join(noSpaceHome, 'profile.json'), 'utf8'));
const savedGrantPath = path.join(noSpaceHome, 'grant.json');
const savedGrantBefore = JSON.parse(fs.readFileSync(savedGrantPath, 'utf8'));
ok('unhosted grant persists awaiting-space', /\[no-space\]/.test(noSpaceInstall.stderr) &&
  awaitingProfile.status === 'awaiting-space' && (fs.statSync(savedGrantPath).mode & 0o777) === 0o600);
const blockedInbox = await courier(noSpaceHome, ['inbox'], { allowFail: true });
ok('awaiting-space blocks Courier operations', /\[no-space\]/.test(blockedInbox.stderr));
await noSpaceOwner.node.hostOwnedSpace('agents');
const resumed = await courierJson(noSpaceHome, ['init', '--resume']);
const savedGrantAfter = JSON.parse(fs.readFileSync(savedGrantPath, 'utf8'));
ok('resume uses saved grant without reapproval', resumed.ok && resumed.spaceId.endsWith(':agents') &&
  savedGrantAfter.delegationCid === savedGrantBefore.delegationCid);
await courierJson(noSpaceHome, ['pair', 'start', 'owner']);
const resumedOrders = await courierJson(noSpaceHome, ['orders', 'owner', '--json']);
const resumedInbox = await courierJson(noSpaceHome, ['inbox', '--json']);
ok('orders and inbox work after resume', resumedOrders.source === 'default' && resumedInbox.items.length === 0);
// The signed grant itself must reject a trimmed-but-broadened owner prefix.
const badHome = path.join(tmp, 'bad');
const badRequest = await courierJson(badHome, ['init', '--request']);
const broadGrant = await grantFromRequest(alice.owner, badRequest, [{
  service: 'tinycloud.kv', space: 'agents', path: 'xyz.tinycloud.courier/me/',
  actions: ['tinycloud.kv/put'],
}]);
const broadFile = af('broad-grant.json', broadGrant);
const broadResult = await courier(badHome, ['init', '--grant-file', broadFile], { allowFail: true });
ok('broad signed grant rejected', /grant-too-broad/.test(broadResult.stderr));
ok('rejected grant not persisted', !fs.existsSync(path.join(badHome, 'grant.json')));

// ---------- pairing: A -> B -> C ----------
const artA = await courierJson(A, ['pair', 'start', 'bob']);
ok('artifact A shape', artA.type === 'courier-pair' && artA.step === 'A' && artA.peer === 'bob' && artA.callMe === 'alice' && !artA.delegation);
const oldSpaceArtifact = { ...artA, spaceId: artA.spaceId.replace(/:agents$/, ':applications') };
const oldSpacePair = await courier(B, ['pair', 'accept', '--file', af('old-space-a.json', oldSpaceArtifact)], { allowFail: true });
ok('pairing rejects applications-space peer', /\[bad-artifact\]/.test(oldSpacePair.stderr) && /not an agents space/.test(oldSpacePair.stderr));

// Artifacts travel as files — mirrors the humans' paste-out/paste-in flow.
const artB = await courierJson(B, ['pair', 'accept', '--file', af('a.json', artA)]);
ok('artifact B shape', artB.step === 'B' && !!artB.delegation && artB.peer === 'alice' && artB.callMe === 'bob');

const artC = await courierJson(A, ['pair', 'accept', '--file', af('b.json', artB)]);
ok('artifact C shape', artC.step === 'C' && typeof artC.delegation === 'string' && artC.peer === 'bob' && artC.callMe === 'alice');

const doneB = await courierJson(B, ['pair', 'accept', '--file', af('c.json', artC)]);
ok('pairing complete on B', doneB.ok === true && doneB.paired === 'alice');
ok('pairing delegation expires within grant', Date.parse(artB.delegationExpiresAt) <= Date.parse(initB.grantExpiresAt) &&
  Date.parse(artC.delegationExpiresAt) <= Date.parse(initA.grantExpiresAt));

// ---------- send a message with two asks ----------
const handoff = `# Handoff to bob's agent

## Ask
Please handle the two asks below.

## Summary
Test handoff for TC-709.

## Verification
Nothing verified; this is a fixture.
`;
const sent = await courierJson(A, [
  'send', 'bob', '--new', 'TC-709 smoke', '--text', handoff,
  '--intent', 'request',
  '--ask', 'Confirm the round trip works',
  '--ask', 'Report the artifact you received',
  '--constraint', 'Throwaway identities only',
]);
ok('send ok', sent.ok && /^[0-9A-Z]{26}$/.test(sent.threadId) && /^[0-9A-Z]{26}$/.test(sent.messageId));

// ---------- inbox on B: framing as counterparty data ----------
const inbox = await courierJson(B, ['inbox', '--json']);
const item = inbox.items?.find((i) => i.messageId === sent.messageId);
ok('inbox framing and authority', Object.keys(inbox)[0] === 'notice' &&
  /COUNTERPARTY DATA/.test(inbox.notice) && item?.authority === 'counterparty' &&
  !!item && item.peer === 'alice' && item.threadId === sent.threadId);
ok('inbox carries asks', item?.asks?.length === 2 && item.asks[0].title === 'Confirm the round trip works');
ok('inbox framing (peer intent)', item?.intent === 'request' && item?.from?.owner === initA.ownerDid);

const inboxAgain = (await courier(B, ['inbox'])).stdout; // receipts advanced → empty
ok('inbox marks delivered', /Inbox empty/.test(inboxAgain));

// ---------- read: merged thread ----------
const thread = await courierJson(B, ['read', sent.threadId, '--json']);
const peerMsg = thread.entries?.find((e) => e.kind === 'msg' && e.side === 'peer');
ok('read shows peer message', peerMsg?.body?.messageId === sent.messageId);
const ext = peerMsg?.body?.metadata?.['https://tinycloud.xyz/ext/courier/v0'];
ok('courier extension present', ext?.intent === 'request' && ext?.asks?.length === 2 && ext?.constraints?.[0] === 'Throwaway identities only');

// ---------- task round-trip ----------
const t1 = await courierJson(B, ['task', 'new', '--peer', 'alice', '--thread', sent.threadId,
  '--state', 'working', '--ask', 'a1', '--request-message', sent.messageId, '--note', 'On it']);
ok('task create', t1.ok && /^[0-9A-Z]{26}$/.test(t1.taskId));

const verdict = path.join(tmp, 'verdict.md');
fs.writeFileSync(verdict, '| Check | Verdict |\n|---|---|\n| round trip | works |');
const t2 = await courierJson(B, ['task', t1.taskId, '--peer', 'alice', '--thread', sent.threadId,
  '--state', 'completed', '--artifact', verdict, '--note', 'Done']);
ok('task update (if-match)', t2.ok && t2.updated === true);

// A reads the task through B's space… wait: tasks live in the WRITER's space.
// B's task is at B: to/alice/… A reads it via the delegation to B's to/alice/.
const threadA = await courierJson(A, ['read', sent.threadId, '--json']);
const taskEntry = threadA.entries?.find((e) => e.kind === 'task' && e.side === 'peer');
ok('A sees B task COMPLETED', taskEntry?.body?.status?.state === 'TASK_STATE_COMPLETED');
ok('A sees B artifact', /round trip/.test(taskEntry?.body?.artifacts?.[0]?.parts?.[0]?.text ?? ''));

// Bob did not start this thread, so an unreferenced reply is agent-authored.
const reply = await courierJson(B, ['send', 'alice', '--thread', sent.threadId, '--intent', 'answer',
  '--reply-to', sent.messageId, '--text', '# Answer\n\nRound trip verified; artifact attached to task.']);
ok('answer has agent role', reply.ok && reply.role === 'ROLE_AGENT');
const followup = await courierJson(A, ['send', 'bob', '--thread', sent.threadId, '--task-ref', t1.taskId,
  '--intent', 'update', '--text', 'Following up on your task.']);
ok('peer task reference has user role', followup.role === 'ROLE_USER');
const ownTaskReply = await courierJson(B, ['send', 'alice', '--thread', sent.threadId, '--task-ref', t1.taskId,
  '--intent', 'update', '--text', 'Updating my task.']);
ok('own task reference has agent role', ownTaskReply.role === 'ROLE_AGENT');
const inboxA = await courierJson(A, ['inbox', '--json']);
ok('A inbox gets answer with notice', Object.keys(inboxA)[0] === 'notice' &&
  inboxA.items?.some((i) => i.messageId === reply.messageId && i.authority === 'counterparty'));
// ---------- request privacy and owner-only authority ----------
const req = await courierJson(B, ['request', sent.threadId, '--peer', 'alice', '--task', t1.taskId,
  '--action', 'Deploy the thing', '--why', 'Handoff implies a deploy', '--risk', 'production']);
ok('request written + AUTH_REQUIRED', req.ok && req.state === 'TASK_STATE_AUTH_REQUIRED');
const threadB2 = await courierJson(B, ['read', sent.threadId, '--json']);
const taskAfter = threadB2.entries?.find((e) => e.kind === 'task' && e.side === 'me');
ok('read notice and authority framing', Object.keys(threadB2)[0] === 'notice' &&
  threadB2.entries?.every((e) => e.authority === (e.side === 'peer' ? 'counterparty' : 'self')));
ok('task flipped to AUTH_REQUIRED', taskAfter?.body?.status?.state === 'TASK_STATE_AUTH_REQUIRED');
const threadAAfterRequest = await courierJson(A, ['read', sent.threadId, '--json']);
ok('peer task hides action and request id', !JSON.stringify(threadAAfterRequest).includes('Deploy the thing') &&
  !JSON.stringify(threadAAfterRequest).includes(req.requestId));

// A corrupt peer must not prevent delivery from the valid peer.
const bobProfilePath = path.join(B, 'profile.json');
const bobProfile = JSON.parse(fs.readFileSync(bobProfilePath, 'utf8'));
bobProfile.peers.ghost = {
  handle: 'ghost', ownerDid: initA.ownerDid, courierDid: initA.courierDid,
  spaceId: initA.spaceId, theirHandleForMe: 'bob', status: 'paired', pairedAt: new Date().toISOString(),
  outbound: [], inbound: { delegation: 'not-json', cid: 'bad', expiresAt: new Date(Date.now() + 60_000).toISOString() },
};
fs.writeFileSync(bobProfilePath, JSON.stringify(bobProfile, null, 2), { mode: 0o600 });
const resilient = await courierJson(B, ['inbox', '--json']);
ok('peer failure is isolated', resilient.items?.some((i) => i.messageId === followup.messageId) &&
  resilient.errors?.some((e) => e.peer === 'ghost'));
const secondInbox = await courierJson(B, ['inbox', '--json']);
ok('successful peer receipts advance despite other error', !secondInbox.items?.some((i) => i.messageId === followup.messageId));

const lateMessage = await courierJson(A, ['send', 'bob', '--thread', sent.threadId, '--text', 'Late-arriving older ULID.']);
const peek = await courierJson(B, ['inbox', '--json', '--peek']);
ok('peek displays without committing receipts', peek.items?.some((i) => i.messageId === lateMessage.messageId));
const afterPeek = await courierJson(B, ['inbox', '--json']);
ok('peeked message remains deliverable', afterPeek.items?.some((i) => i.messageId === lateMessage.messageId));
await courierJson(B, ['inbox', '--json']);

const savedBob = JSON.parse(fs.readFileSync(bobProfilePath, 'utf8'));
delete savedBob.peers.ghost;
fs.writeFileSync(bobProfilePath, JSON.stringify(savedBob, null, 2), { mode: 0o600 });

// The owner view, not the Courier agent, can author standing orders.
await bob.owner.node.kv.put(k.orders('alice'), '# Always ask before production deploys', { prefix: '' });
const orders = await courierJson(B, ['orders', 'alice', '--json']);
ok('orders are owner-written and readable', orders.source === 'space' && /production deploys/.test(orders.orders));

// ---------- negative: restricted Courier session ----------
const { loadProfile } = await import('../dist/profile.js');
const { courierNode } = await import('../dist/node.js');
const previousHome = process.env.COURIER_HOME;
process.env.COURIER_HOME = B;
const nodeB = await courierNode(loadProfile());
process.env.COURIER_HOME = previousHome;
async function deniedPut(key) {
  return nodeB.kv.put(key, { evil: true }, { prefix: '' })
    .then((r) => ({ ok: r.ok === true, status: r.error?.status ?? r.error?.meta?.status ?? r.error?.code, msg: r.error?.message }))
    .catch((e) => ({ ok: false, status: e.status ?? e.code, msg: String(e.message).slice(0, 120) }));
}
for (const key of [k.approval('e2e'), k.orders('alice')]) {
  const denied = await deniedPut(key);
  ok(`Courier cannot write ${key.includes('approvals') ? 'approvals' : 'orders'}`,
    denied.ok === false && /401|403/.test(String(denied.status ?? denied.msg)));
}
const deniedDelegation = await nodeB.delegateTo(initA.courierDid, [{
  space: initB.spaceId, service: 'tinycloud.kv', path: `${PREFIX}/me/approvals/`,
  actions: ['tinycloud.kv/put'],
}], { expiry: '1h' }).then(() => false).catch((e) => /PermissionNotInManifestError|permission/i.test(String(e)));
ok('agent cannot delegate approvals write', deniedDelegation);

// Single use survives the courier key itself (spec §7): create the marker, then try to un-consume it.
const { approvalIsUsed, consumeApproval } = await import('../dist/approval.js');
const consumedId = 'e2econsumed';
ok('approval starts unused (clean key-level 404)', (await approvalIsUsed(nodeB.kv, consumedId)) === false);
await consumeApproval(nodeB.kv, consumedId);
ok('approval is used after consume', (await approvalIsUsed(nodeB.kv, consumedId)) === true);
ok('second consume is refused', await consumeApproval(nodeB.kv, consumedId).then(() => false).catch((e) => e.code === 'approval-used'));
const deniedDel = await nodeB.kv.delete(k.approvalUsed(consumedId), { prefix: '' })
  .then((r) => ({ ok: r.ok === true, status: r.error?.status ?? r.error?.meta?.status ?? r.error?.code, msg: r.error?.message }))
  .catch((e) => ({ ok: false, status: e.status ?? e.code, msg: String(e.message).slice(0, 120) }));
ok('Courier cannot delete a used-marker', deniedDel.ok === false && /401|403/.test(String(deniedDel.status ?? deniedDel.msg)), JSON.stringify(deniedDel));
await nodeB.kv.put(k.approvalUsed(consumedId), 'overwritten', { prefix: '' }).catch(() => undefined);
ok('overwriting the marker does not un-consume it', (await approvalIsUsed(nodeB.kv, consumedId)) === true);
ok('replay after the delete attempt is still refused', await consumeApproval(nodeB.kv, consumedId).then(() => false).catch((e) => e.code === 'approval-used'));
const ownerRequest = await nodeB.kv.get(k.request(req.requestId), { prefix: '' });
ok('owner request record retains action detail', JSON.stringify(ownerRequest).includes('Deploy the thing'));

// Older ULIDs must still be delivered after newer IDs were acknowledged.
const { buildMessage } = await import('../dist/a2a.js');
const { ulid: makeUlid } = await import('ulid');
const previousAliceHome = process.env.COURIER_HOME;
process.env.COURIER_HOME = A;
const nodeA = await courierNode(loadProfile());
process.env.COURIER_HOME = previousAliceHome;
const old = buildMessage({
  threadId: sent.threadId,
  text: 'Late-arriving older ULID.',
  from: { owner: initA.ownerDid, agent: initA.courierDid, label: "Alice's courier" },
  intent: 'inform',
  role: 'ROLE_USER',
});
old.messageId = makeUlid(Date.now() - 60_000);
await nodeA.kv.put(k.msg('bob', sent.threadId, old.messageId), old, { prefix: '', ifNoneMatch: '*' });
const lateInbox = await courierJson(B, ['inbox', '--json']);
ok('late older ULID is delivered', lateInbox.items?.some((i) => i.messageId === old.messageId));

const malformed = buildMessage({
  threadId: sent.threadId,
  text: 'Malformed asks fixture.',
  from: { owner: initA.ownerDid, agent: initA.courierDid, label: "Alice's courier" },
  intent: 'request',
  role: 'ROLE_USER',
});
malformed.metadata[EXT].asks = 'x';
await nodeA.kv.put(k.msg('bob', sent.threadId, malformed.messageId), malformed, { prefix: '', ifNoneMatch: '*' });
const textInbox = await courier(B, ['inbox'], { allowFail: true });
ok('malformed peer metadata does not block text inbox', textInbox.code === 0 && textInbox.stdout.includes(malformed.messageId));
const afterMalformed = await courierJson(B, ['inbox', '--json']);
ok('malformed message receipt advances', !afterMalformed.items?.some((item) => item.messageId === malformed.messageId));

// Pair grants are renew-able and survive a fresh CLI process.
const renewA = await courierJson(A, ['pair', 'renew', 'bob', '--force']);
const oldInboundCid = JSON.parse(fs.readFileSync(bobProfilePath, 'utf8')).peers.alice.inbound.cid;
const renewB = await courierJson(B, ['pair', 'renew', 'alice']);
const newInboundCid = JSON.parse(fs.readFileSync(bobProfilePath, 'utf8')).peers.alice.inbound.cid;
ok('pair renewal updates both directions', renewA.ok && renewB.ok && oldInboundCid !== newInboundCid);
const restartedRead = await courierJson(B, ['read', sent.threadId, '--json']);
ok('restarted process reads after renewal', restartedRead.entries?.some((e) => e.kind === 'msg' && e.side === 'peer'));

// ---------- negative: pairing binds issuer, mailbox authority and lifetime ----------
const C = path.join(tmp, 'c');
const initC = (await setupIdentity(C, 'carol', "Carol's courier")).installed;
const artA3 = await courierJson(A, ['pair', 'start', 'carol']);
const artB3 = await courierJson(C, ['pair', 'accept', '--file', af('a3.json', artA3)]);
process.env.COURIER_HOME = C;
const nodeC = await courierNode(loadProfile());
process.env.COURIER_HOME = previousHome;
const aliceProfilePath = path.join(A, 'profile.json');
const aliceCarol = () => JSON.parse(fs.readFileSync(aliceProfilePath, 'utf8')).peers.carol;
const carolPending = () => {
  const current = aliceCarol();
  return current?.status === 'pending-A' && !current.inbound && current.outbound.length === 0;
};
const stranger = new NodeWasmBindings().createSessionManager();
const strangerDid = stranger.getDID(stranger.createSessionKey('stranger')).split('#', 1)[0];
const swapped = await courier(A, ['pair', 'accept', '--file',
  af('b3-swapped.json', { ...artB3, from: { ...artB3.from, courier: strangerDid } })], { allowFail: true });
ok('pairing rejects an advertised courier that did not sign the delegation',
  swapped.code !== 0 && /\[bad-delegation\]/.test(swapped.stderr) && !swapped.stdout.includes(strangerDid) && carolPending());

const meRead = { space: initC.spaceId, service: 'tinycloud.kv', path: `${PREFIX}/me/`, actions: ['tinycloud.kv/get', 'tinycloud.kv/list'] };
const asB = (delegation) => ({
  ...artB3,
  delegation: serializeDelegation(delegation.delegation),
  delegationExpiresAt: new Date(delegation.delegation.expiry).toISOString(),
});
const broadB = await nodeC.delegateTo(initA.courierDid, [...peerReadPermissions(artB3.peer, initC.spaceId), meRead], { expiry: '7d' });
const broadPair = await courier(A, ['pair', 'accept', '--file', af('b3-broad.json', asB(broadB))], { allowFail: true });
ok('pairing rejects a delegation beyond the mailbox',
  broadPair.code !== 0 && /\[grant-too-broad\]/.test(broadPair.stderr) && carolPending());
const longB = await nodeC.delegateTo(initA.courierDid, peerReadPermissions(artB3.peer, initC.spaceId), { expiry: '30d' });
const longPair = await courier(A, ['pair', 'accept', '--file', af('b3-long.json', asB(longB))], { allowFail: true });
ok('pairing rejects a peer delegation longer than 7 days',
  longPair.code !== 0 && /\[grant-too-long\]/.test(longPair.stderr) && carolPending());
const artC3 = await courierJson(A, ['pair', 'accept', '--file', af('b3.json', artB3)]);
await courierJson(C, ['pair', 'accept', '--file', af('c3.json', artC3)]);
ok('genuine artifact B still pairs after rejected tampering', artC3.step === 'C' && aliceCarol().status === 'paired');

const pairedCid = aliceCarol().inbound.cid;
const broadRenewal = await nodeC.delegateTo(initA.courierDid, [...peerReadPermissions(artB3.peer, initC.spaceId), meRead], { expiry: '7d' });
await nodeC.kv.put(k.peerDelegation(artB3.peer),
  { v: 0, delegation: serializeDelegation(broadRenewal.delegation), issuedAt: new Date().toISOString() }, { prefix: '' });
const badRenew = await courier(A, ['pair', 'renew', 'carol'], { allowFail: true });
ok('renewal rejects a delegation beyond the mailbox',
  badRenew.code !== 0 && /\[grant-too-broad\]/.test(badRenew.stderr) && aliceCarol().inbound.cid === pairedCid);
await courierJson(C, ['pair', 'renew', 'alice', '--force']);
const goodRenew = await courierJson(A, ['pair', 'renew', 'carol']);
ok('renewal installs the exact replacement', goodRenew.ok && aliceCarol().inbound.cid !== pairedCid);
// ---------- summary ----------
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`} — ${results.length} checks`);
fs.writeFileSync(path.join(tmp, 'results.json'), JSON.stringify({ tmp, results, initA, initB }, null, 2));
process.exit(failures ? 1 : 0);
