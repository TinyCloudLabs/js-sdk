import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createGuidedFixture } from './support/guided-fixture.mjs';
import { PREFIX } from '../dist/keys.js';

// TC-2360: an agent ran `invite ... --wait 1` then `invite serve --wait 60` for minutes without ever sending the invitation
// link, although it was in its output. `invite` and `invite serve` now print one `Next: ` line on stderr. The wording may
// follow the guides, so these tests pin only what must stay true: the line is there, once, in the right place, it names
// the follow-up command (invite) or carries the saved invitation link (invite serve), and stdout and exit codes are as before.

const root = process.env.COURIER_TEST_HOME;
assert.ok(root, 'setup-home.mjs must isolate every Courier profile');
const fixture = await createGuidedFixture(path.join(root, 'guided-next-line'), process.env.COURIER_CLI);
test.after(() => fixture.close());

const lines = (text) => text.split('\n');
const nextLines = (text) => lines(text).filter((line) => line.startsWith('Next: '));
const lastLine = (text) => lines(text).filter((line) => line !== '').at(-1);
const stateKey = (agent, id) => `${agent.profile.spaceId}/${PREFIX}/me/state/invitations/${id}.json`;

/** An invitation that nobody has claimed yet: `invite` ran with the shortest wait and ended pending. */
async function pendingInvitation(agent) {
  const started = await fixture.run(agent, ['start']);
  const run = await fixture.launch(agent, ['invite', '--session', started.session.sessionId, '--mode', 'anyone', '--consent', '--wait', '1']).done;
  const invitation = JSON.parse(run.stdout.split('\n')[0]);
  return { started, run, invitation };
}

test('invite (5): one Next line on stderr naming invite serve for this invitation, before the pending error; stdout and exit code as before', async () => {
  const a = await fixture.home('next-invite');
  const { run, invitation } = await pendingInvitation(a);
  assert.equal(run.code, 1);
  assert.equal(invitation.status, 'invitation');
  assert.match(invitation.link, /^https?:\/\//);
  assert.ok(!run.stdout.includes('Next:'));
  const next = nextLines(run.stderr);
  assert.equal(next.length, 1, run.stderr);
  assert.ok(next[0].includes(`invite serve ${invitation.invitationId}`), next[0]);
  assert.ok(next[0].includes('`'), 'the follow-up command is in backticks');
  assert.ok(lines(run.stderr).indexOf(next[0]) < lines(run.stderr).findIndex((line) => line.includes('[invite-pending]')), 'the Next line is printed with the link, before the wait');
});

test('invite (5): when the invitation is claimed in time, the Next line is the last stderr line', async () => {
  const a = await fixture.home('next-invite-paired-a');
  const b = await fixture.home('next-invite-paired-b');
  const started = await fixture.run(a, ['start']);
  const issuer = fixture.launch(a, ['invite', '--session', started.session.sessionId, '--mode', 'anyone', '--consent', '--wait', '15']);
  const invitation = await issuer.first();
  await fixture.run(b, ['join', invitation.link, '--consent', '--wait', '15']);
  const done = await issuer.done;
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.lines.at(-1).status, 'paired');
  assert.equal(nextLines(done.stderr).length, 1);
  assert.equal(lastLine(done.stderr), nextLines(done.stderr)[0]);
});

test('invite serve (6): one Next line carrying the saved invitation link, before the wait; no key material; stdout and exit code as before', async () => {
  const a = await fixture.home('next-serve');
  const { invitation } = await pendingInvitation(a);
  const run = await fixture.launch(a, ['invite', 'serve', invitation.invitationId, '--wait', '1']).done;
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[invite-pending\]/);
  assert.equal(run.stdout, '');
  const next = nextLines(run.stderr);
  assert.equal(next.length, 1, run.stderr);
  assert.ok(next[0].includes(invitation.link), 'the saved link, the same one invite printed');
  assert.equal(run.stderr.split(invitation.link).length - 1, 1, 'the link appears once');
  assert.ok(lines(run.stderr).indexOf(next[0]) < lines(run.stderr).findIndex((line) => line.includes('[invite-pending]')));
  const body = JSON.parse(fixture.values.get(stateKey(a, invitation.invitationId)).bytes.toString()).body;
  for (const secret of [body.relay.key.jwk.d, body.relay.delegation]) assert.ok(!run.stderr.includes(secret), 'no key material or delegation on stderr');
});

test('invite serve (6): without a saved link the line says to use the link invite printed, and carries none', async () => {
  const a = await fixture.home('next-serve-nolink');
  const { invitation } = await pendingInvitation(a);
  const key = stateKey(a, invitation.invitationId);
  const saved = fixture.values.get(key);
  const state = JSON.parse(saved.bytes.toString());
  delete state.link;
  fixture.values.set(key, { bytes: Buffer.from(JSON.stringify(state)), etag: saved.etag });
  const run = await fixture.launch(a, ['invite', 'serve', invitation.invitationId, '--wait', '1']).done;
  assert.equal(run.code, 1);
  const next = nextLines(run.stderr);
  assert.equal(next.length, 1, run.stderr);
  assert.ok(!next[0].includes('http'), next[0]);
  assert.ok(next[0].includes('invite'), next[0]);
});

test('invite serve (6): when the invitation is claimed in time the Next line is the last stderr line and stdout is the paired JSON', async () => {
  const a = await fixture.home('next-serve-paired-a');
  const b = await fixture.home('next-serve-paired-b');
  const { invitation } = await pendingInvitation(a);
  const serving = fixture.launch(a, ['invite', 'serve', invitation.invitationId, '--wait', '15']);
  await fixture.run(b, ['join', invitation.link, '--consent', '--wait', '15']);
  const done = await serving.done;
  assert.equal(done.code, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout.trim()).status, 'paired');
  assert.equal(nextLines(done.stderr).length, 1);
  assert.equal(lastLine(done.stderr), nextLines(done.stderr)[0]);
  assert.ok(nextLines(done.stderr)[0].includes(invitation.link));
});

test('no Next line on join, on a refused invite (no consent), or on an invite serve for an unknown invitation', async () => {
  const a = await fixture.home('next-absent-a');
  const b = await fixture.home('next-absent-b');
  const started = await fixture.run(a, ['start']);
  const refused = await fixture.launch(a, ['invite', '--session', started.session.sessionId, '--mode', 'anyone']).done;
  assert.equal(refused.code, 1);
  assert.deepEqual(nextLines(refused.stderr), []);
  const unknown = await fixture.launch(a, ['invite', 'serve', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '--wait', '1']).done;
  assert.equal(unknown.code, 1);
  assert.deepEqual(nextLines(unknown.stderr), []);
  const issuer = fixture.launch(a, ['invite', '--session', started.session.sessionId, '--mode', 'anyone', '--consent', '--wait', '15']);
  const invitation = await issuer.first();
  const joined = await fixture.launch(b, ['join', invitation.link, '--consent', '--wait', '15']).done;
  await issuer.done;
  assert.equal(joined.code, 0, joined.stderr);
  assert.deepEqual(nextLines(joined.stderr), []);
});
