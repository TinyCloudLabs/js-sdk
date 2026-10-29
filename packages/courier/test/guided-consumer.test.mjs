import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createGuidedFixture } from './support/guided-fixture.mjs';
import { openLinkRecord, prepareLinkRecord, buildShortLink, signerFromJwk } from '@tinycloud/share-envelope/links';
import { PREFIX } from '../dist/keys.js';

const root = process.env.COURIER_TEST_HOME;
assert.ok(root, 'setup-home.mjs must isolate every Courier profile');
const fixture = await createGuidedFixture(path.join(root, 'guided'), process.env.COURIER_CLI);
test.after(() => fixture.close());
const profileAt = (agent) => JSON.parse(fs.readFileSync(path.join(agent.home, 'profile.json'), 'utf8'));

async function pair(sender, recipient, session, mode, flags = []) {
  const issuer = fixture.launch(sender, ['invite', '--session', session.sessionId, '--mode', mode, '--consent', '--wait', '15', ...flags]);
  const invitation = await issuer.first();
  assert.equal(invitation.status, 'invitation');
  const joined = await fixture.run(recipient, ['join', invitation.link, '--consent', '--wait', '15']);
  const sent = await issuer.done;
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(joined.status, 'active');
  assert.equal(joined.session.sessionId, session.sessionId);
  return { invitation, joined, paired: sent.lines.at(-1) };
}

test('public CLI starts, pairs same-owner agents, and exchanges messages in the intended session', async () => {
  const owner = randomBytes(32).toString('hex');
  const a = await fixture.home('same-owner-a', owner);
  const b = await fixture.home('same-owner-b', owner);
  const start = await fixture.run(a, ['start']);
  assert.equal(start.status, 'active', 'no existing chats means create without asking new/existing');
  assert.deepEqual(start.invitationModes, ['same-owner', 'anyone', 'named']);
  const { invitation, joined, paired } = await pair(a, b, start.session, 'same-owner');
  assert.notEqual(paired.peer, joined.session.peer, 'same-owner mailboxes remain distinct');
  assert.equal(profileAt(a).peers[paired.peer].courierDid, b.profile.courierDid);
  assert.equal(profileAt(b).peers[joined.session.peer].courierDid, a.profile.courierDid);
  const sent = await fixture.run(a, ['send', paired.peer, '--thread', start.session.sessionId, '--intent', 'inform', '--text', 'Synthetic sender message']);
  const reply = await fixture.run(b, ['send', joined.session.peer, '--thread', start.session.sessionId, '--intent', 'answer', '--text', 'Synthetic recipient reply']);
  const thread = await fixture.run(b, ['read', start.session.sessionId, '--peer', joined.session.peer, '--json']);
  assert.deepEqual(thread.entries.filter((entry) => entry.kind === 'msg').map((entry) => entry.body.messageId).sort(), [sent.messageId, reply.messageId].sort());
  const inbox = await fixture.run(b, ['inbox', '--json', '--peek']);
  assert.equal(inbox.errors.length, 0);
  assert.equal(inbox.items.some((item) => item.messageId === sent.messageId && item.threadId === start.session.sessionId), true);
  const discovered = await fixture.run(b, ['start']);
  assert.equal(discovered.status, 'choose-session');
  assert.equal(discovered.sessions.some((session) => session.sessionId === start.session.sessionId), true);
  const selected = await fixture.run(b, ['start', '--session', start.session.sessionId, '--peer', joined.session.peer]);
  assert.equal(selected.session.sessionId, start.session.sessionId);
  const replay = await fixture.launch(b, ['join', invitation.link, '--consent']).done;
  assert.equal(replay.code, 1);
  assert.match(replay.stderr, /\[invite-used\]/);
});

test('refuses a forged inviter owner before delegating recipient session access', async () => {
  const attacker = await fixture.home('forged-inviter');
  const recipient = await fixture.home('forged-victim');
  const start = await fixture.run(attacker, ['start']);
  const serving = fixture.launch(attacker, ['invite', '--session', start.session.sessionId, '--mode', 'anyone', '--consent']);
  const invitation = await serving.first();
  serving.child.kill();
  await serving.done;
  const originalUrl = new URL(invitation.link);
  const opened = await openLinkRecord(fixture.links.get(originalUrl.pathname.split('/').at(-1)), Buffer.from(new URLSearchParams(originalUrl.hash.slice(1)).get('k'), 'base64url'));
  const body = structuredClone(opened.value);
  body.mode = 'same-owner';
  body.artifact.from.owner = recipient.profile.ownerDid;
  body.artifact.spaceId = recipient.profile.spaceId;
  const prepared = await prepareLinkRecord({ type: 'courier', issuerKey: signerFromJwk(attacker.agent.jwk), apiOrigin: fixture.host,
    expiresAt: new Date(body.expiresAt), plaintext: new TextEncoder().encode(JSON.stringify(body)) });
  const id = 'b'.repeat(26);
  fixture.links.set(id, prepared.record);
  const link = buildShortLink({ origin: fixture.host, type: 'courier', id, key: prepared.key, bodyCid: prepared.bodyCid });
  const before = [...fixture.delegations.values()].filter((delegation) => delegation.aud === attacker.profile.courierDid).length;
  const refused = await fixture.launch(recipient, ['join', link, '--consent']).done;
  assert.equal(refused.code, 1);
  const after = [...fixture.delegations.values()].filter((delegation) => delegation.aud === attacker.profile.courierDid).length;
  assert.equal(after, before, 'unverified inviter gained no read delegation from recipient');
  assert.deepEqual(profileAt(recipient).peers, {});
});

test('named key and verified handle invitations enforce their recipient and thread scope', async () => {
  const a = await fixture.home('named-a');
  const b = await fixture.home('named-b');
  const wrong = await fixture.home('named-wrong');
  const start = await fixture.run(a, ['start']);
  const issuer = fixture.launch(a, ['invite', '--session', start.session.sessionId, '--mode', 'named', '--recipient', b.profile.courierDid, '--consent']);
  const invitation = await issuer.first();
  const refused = await fixture.launch(wrong, ['join', invitation.link, '--consent']).done;
  assert.equal(refused.code, 1);
  assert.deepEqual(profileAt(wrong).peers, {});
  const joined = await fixture.run(b, ['join', invitation.link, '--consent']);
  const completed = await issuer.done;
  assert.equal(completed.code, 0, completed.stderr);
  const peer = completed.lines.at(-1).peer;
  assert.equal(profileAt(a).peers[peer].courierDid, b.profile.courierDid);
  for (const args of [
    ['send', peer, '--new', 'Uninvited thread', '--text', 'refuse'],
    ['send', peer, '--thread', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '--text', 'refuse'],
  ]) assert.equal((await fixture.launch(a, args).done).code, 1);
  const session2 = await fixture.run(a, ['start', '--new', 'Named handle session']);
  const next = await pair(a, b, session2.session, 'named', ['--recipient', peer]);
  assert.equal(next.joined.session.sessionId, session2.session.sessionId);
  assert.notEqual(next.joined.session.sessionId, joined.session.sessionId);
  const email = await fixture.launch(a, ['invite', '--session', start.session.sessionId, '--mode', 'named', '--recipient', 'synthetic@example.invalid', '--consent']).done;
  assert.equal(email.code, 1);
  assert.match(email.stderr, /\[unsupported-recipient\]/);
});

test('incoming invitation takes precedence and invalid links never create a substitute session', async () => {
  const a = await fixture.home('precedence-a');
  const b = await fixture.home('precedence-b');
  const intended = await fixture.run(a, ['start']);
  const unrelated = await fixture.run(b, ['start', '--new', 'Unrelated existing chat']);
  const serving = fixture.launch(a, ['invite', '--session', intended.session.sessionId, '--mode', 'anyone', '--consent']);
  const invitation = await serving.first();
  const changed = invitation.link.replace(/c=bafkrei./, 'c=bafkreiz');
  const refused = await fixture.launch(b, ['start', '--link', changed, '--new', 'Must not exist', '--consent']).done;
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.home, 'active-session.json'), 'utf8')).sessionId, unrelated.session.sessionId);
  const active = await fixture.run(b, ['start', '--link', invitation.link, '--new', 'Must not exist', '--consent']);
  assert.equal(active.session.sessionId, intended.session.sessionId);
  assert.notEqual(active.session.sessionId, unrelated.session.sessionId);
  assert.equal((await serving.done).code, 0);
  const discovered = await fixture.run(b, ['start']);
  assert.equal(discovered.sessions.some((session) => session.subject === 'Must not exist'), false);
});

test('same-owner, self-key and explicit consent boundaries refuse before granting access', async () => {
  const a = await fixture.home('owner-boundary-a');
  const foreign = await fixture.home('owner-boundary-foreign');
  const start = await fixture.run(a, ['start']);
  const denied = await fixture.launch(a, ['invite', '--session', start.session.sessionId, '--mode', 'same-owner', '--consent=false']).done;
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /\[consent-required\]/);
  const serving = fixture.launch(a, ['invite', '--session', start.session.sessionId, '--mode', 'same-owner', '--consent']);
  const invitation = await serving.first();
  for (const [agent, flags] of [[foreign, ['--consent']], [a, ['--consent']], [foreign, ['--consent=false']]]) {
    const result = await fixture.launch(agent, ['join', invitation.link, ...flags]).done;
    assert.equal(result.code, 1);
  }
  const forged = { ...profileAt(foreign), ownerDid: a.profile.ownerDid, spaceId: a.profile.spaceId };
  fs.writeFileSync(path.join(foreign.home, 'profile.json'), JSON.stringify(forged), { mode: 0o600 });
  const forgedProfile = await fixture.launch(foreign, ['join', invitation.link, '--consent']).done;
  assert.equal(forgedProfile.code, 1);
  assert.match(forgedProfile.stderr, /\[bad-grant\]/);
  assert.deepEqual(profileAt(foreign).peers, {});
  serving.child.kill();
  await serving.done;
});

test('durable winning claim survives a lost response and issuer restart without issuing C to another key', async () => {
  const a = await fixture.home('restart-a');
  const winner = await fixture.home('restart-winner');
  const loser = await fixture.home('restart-loser');
  const start = await fixture.run(a, ['start']);
  const issuer = fixture.launch(a, ['invite', '--session', start.session.sessionId, '--mode', 'anyone', '--consent']);
  const invitation = await issuer.first();
  fixture.controls.pausePutKey = `${PREFIX}/me/consumed/invitations/${invitation.invitationId}.json`;
  const reserved = new Promise((resolve) => { fixture.controls.onPaused = resolve; });
  const joining = fixture.launch(winner, ['join', invitation.link, '--consent']);
  await reserved;
  issuer.child.kill();
  joining.child.kill();
  await Promise.all([issuer.done, joining.done]);
  const loserResult = await fixture.launch(loser, ['join', invitation.link, '--consent']).done;
  assert.equal(loserResult.code, 1);
  assert.match(loserResult.stderr, /\[invite-used\]/);
  const claimKey = `${a.profile.spaceId}/${PREFIX}/to/invite-${invitation.invitationId}/pairing/claim.json`;
  const originalClaim = fixture.values.get(claimKey);
  const losingState = JSON.parse(fs.readFileSync(path.join(loser.home, 'invitation-joins', `${invitation.invitationId}.json`), 'utf8'));
  fixture.values.set(claimKey, { bytes: Buffer.from(JSON.stringify(losingState.claim)), etag: '"malicious-overwrite"' });
  const resumed = await fixture.run(a, ['invite', 'serve', invitation.invitationId, '--wait', '15']);
  assert.equal(resumed.status, 'paired');
  assert.equal(profileAt(a).peers[resumed.peer].courierDid, winner.profile.courierDid);
  const answer = JSON.parse(fixture.values.get(`${a.profile.spaceId}/${PREFIX}/me/state/invitation-answers/${invitation.invitationId}.json`).bytes.toString());
  const delegation = JSON.parse(answer.payload.artifact.delegation);
  assert.equal(delegation.delegateDID.split('#')[0], winner.profile.courierDid);
  assert.notEqual(delegation.delegateDID.split('#')[0], loser.profile.courierDid);
  fixture.values.set(claimKey, originalClaim);
  const activated = await fixture.run(winner, ['join', invitation.link, '--consent', '--wait', '15']);
  assert.equal(activated.session.sessionId, start.session.sessionId);
  assert.deepEqual(profileAt(loser).peers, {});
});

test('expired invitations refuse without an outbound delegation or replacement session', async () => {
  const a = await fixture.home('expiry-a');
  const b = await fixture.home('expiry-b');
  const started = await fixture.run(a, ['start']);
  const serving = fixture.launch(a, ['invite', '--session', started.session.sessionId, '--mode', 'anyone', '--consent']);
  const invitation = await serving.first();
  serving.child.kill();
  await serving.done;
  const url = new URL(invitation.link);
  const opened = await openLinkRecord(fixture.links.get(url.pathname.split('/').at(-1)), Buffer.from(new URLSearchParams(url.hash.slice(1)).get('k'), 'base64url'));
  const body = structuredClone(opened.value);
  body.expiresAt = new Date(Date.now() - 1000).toISOString();
  const prepared = await prepareLinkRecord({ type: 'courier', issuerKey: signerFromJwk(a.agent.jwk), apiOrigin: fixture.host,
    now: Date.now() - 300000, expiresAt: new Date(body.expiresAt), plaintext: new TextEncoder().encode(JSON.stringify(body)) });
  fixture.links.set('c'.repeat(26), prepared.record);
  const link = buildShortLink({ origin: fixture.host, type: 'courier', id: 'c'.repeat(26), key: prepared.key, bodyCid: prepared.bodyCid });
  const before = fixture.delegations.size;
  const refused = await fixture.launch(b, ['start', '--link', link, '--new', 'No expired fallback', '--consent']).done;
  assert.equal(refused.code, 1);
  assert.equal(fixture.delegations.size, before);
  assert.equal(fs.existsSync(path.join(b.home, 'active-session.json')), false);
  assert.deepEqual(profileAt(b).peers, {});
});

test('changed pairing claims cannot consume the invitation or obtain C', async () => {
  const a = await fixture.home('changed-claim-a');
  const b = await fixture.home('changed-claim-b');
  const started = await fixture.run(a, ['start']);
  const serving = fixture.launch(a, ['invite', '--session', started.session.sessionId, '--mode', 'anyone', '--consent']);
  const invitation = await serving.first();
  serving.child.kill();
  await serving.done;
  const pending = await fixture.launch(b, ['join', invitation.link, '--consent', '--wait', '1']).done;
  assert.equal(pending.code, 1);
  assert.match(pending.stderr, /\[invite-pending\]/);
  const claimKey = `${a.profile.spaceId}/${PREFIX}/to/invite-${invitation.invitationId}/pairing/claim.json`;
  const original = fixture.values.get(claimKey);
  const changed = JSON.parse(original.bytes.toString());
  changed.payload.sessionId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  fixture.values.set(claimKey, { bytes: Buffer.from(JSON.stringify(changed)), etag: '"changed"' });
  const refused = await fixture.launch(a, ['invite', 'serve', invitation.invitationId, '--wait', '1']).done;
  assert.equal(refused.code, 1);
  assert.equal(fixture.values.has(`${a.profile.spaceId}/${PREFIX}/me/consumed/invitations/${invitation.invitationId}.json`), false);
  assert.equal(fixture.values.has(`${a.profile.spaceId}/${PREFIX}/me/state/invitation-answers/${invitation.invitationId}.json`), false);
  assert.deepEqual(profileAt(a).peers, {});
  fixture.values.set(claimKey, original);
  assert.equal((await fixture.run(a, ['invite', 'serve', invitation.invitationId, '--wait', '15'])).status, 'paired');
  const joined = await fixture.run(b, ['join', invitation.link, '--consent', '--wait', '15']);
  assert.equal(joined.session.sessionId, started.session.sessionId);
});
