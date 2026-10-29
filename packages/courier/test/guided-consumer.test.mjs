import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createGuidedFixture } from './support/guided-fixture.mjs';

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
