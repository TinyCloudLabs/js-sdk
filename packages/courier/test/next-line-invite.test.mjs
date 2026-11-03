import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createGuidedFixture } from './support/guided-fixture.mjs';
import { PREFIX } from '../dist/keys.js';

// TC-2360: an agent ran `invite ... --wait 1` then `invite serve --wait 60` for minutes without ever sending the invitation
// link, although it was in its output. A pending `invite` ends its stderr with one `Next: ` line after the existing
// invite-pending error. `invite serve` prints one at the start of every run and, when still pending, a second as the last
// line. The wording may follow the guides, so these tests pin only what must stay true: prefix, count, position, the
// backticked command or the saved link; a paired invite prints none; stdout, the error line and exit codes are as before.

const root = process.env.COURIER_TEST_HOME;
assert.ok(root, 'setup-home.mjs must isolate every Courier profile');
const fixture = await createGuidedFixture(path.join(root, 'guided-next-line'), process.env.COURIER_CLI);
test.after(() => fixture.close());

const lines = (text) => text.split('\n');
// Wording v5: a link site asks ONLY for the relay now ((6) adds "when the owner next writes to you, run <invite serve>"; (7) is
// the relay alone). The one exception is the pending `invite serve` line (8): there is no link to relay, only a run-again.
const inviteLine = (id) => `Next: send the owner the invitation link above in your reply now. When the owner next writes to you, run \`courier invite serve ${id} --wait 60\`.`;
const startLine = (link) => `Next: send the owner this invitation link in your reply now if you have not sent it yet: ${link}`;
const pendingServeLine = (id, wait) => `Next: No one has joined yet; run \`courier invite serve ${id} --wait ${wait}\` again now, in this same turn; do not end your turn or wait for a reply.`;
/** Phrases of the dropped v3/v4 wordings: none may come back on a link site. */
const OLD_PHRASES = ['cannot see', 'before your next tool call', 'same reply', 'do not end your turn', 'wait for a reply'];
const nextLines = (text) => {
  const found = lines(text).filter((line) => line.startsWith('Next: '));
  for (const line of found) {
    if (line.startsWith('Next: No one has joined yet; run ')) continue; // (8): its own wording, kept from v3
    assert.ok(/^Next: send the owner (the invitation link above|this invitation link|the invitation link printed by `invite`) in your reply now/.test(line), line);
    for (const phrase of OLD_PHRASES) assert.ok(!line.includes(phrase), `${phrase}: ${line}`);
  }
  return found;
};
// Node itself can print warning blocks to stderr: on Node 20 a `MaxListenersExceededWarning` (`(node:<pid>) ...Warning: ...`,
// then a `(Use \`node --trace-warnings ...\`)` hint, and indented `at ...` lines under --trace-warnings) from the pre-existing
// listener leak in the services' combineSignals (TC-2418), about 3 s into a poll loop. They are not Courier output and land
// before or after our lines depending on timing, so the last line is picked among the lines Courier itself wrote.
const isNodeWarning = (line) => /^\(node:\d+\) /.test(line) || line.startsWith('(Use `node --trace-warnings') || /^\s+at /.test(line);
const lastLine = (text) => lines(text).filter((line) => line !== '' && !isNodeWarning(line)).at(-1);
const stateKey = (agent, id) => `${agent.profile.spaceId}/${PREFIX}/me/state/invitations/${id}.json`;
/** The existing pending error line, unchanged. */
const pendingLine = (id) => `courier: [invite-pending] No claim received. Resume with courier invite serve ${id}; the same invitation and winner reservation are preserved.`;

/** A pending run ends with exactly one Next line, the last non-empty stderr line, after the `[invite-pending]` line. */
function assertNextLastAfterPending(stderr) {
  const next = nextLines(stderr);
  assert.equal(next.length, 1, stderr);
  assert.equal(lastLine(stderr), next[0], 'the Next line is the last non-empty stderr line');
  const all = lines(stderr);
  const pending = all.findIndex((line) => line.includes('[invite-pending]'));
  assert.ok(pending >= 0 && all.indexOf(next[0]) > pending, 'and it follows the invite-pending error');
  return next[0];
}

/** An invitation that nobody has claimed yet: `invite` ran with the shortest wait and ended pending. */
async function pendingInvitation(agent) {
  const started = await fixture.run(agent, ['start']);
  const run = await fixture.launch(agent, ['invite', '--session', started.session.sessionId, '--mode', 'anyone', '--consent', '--wait', '1']).done;
  const invitation = JSON.parse(run.stdout.split('\n')[0]);
  return { started, run, invitation };
}

test('invite (5): the pending run ends with one Next line naming invite serve for this invitation, after the pending error; stdout and exit code as before', async () => {
  const a = await fixture.home('next-invite');
  const { run, invitation } = await pendingInvitation(a);
  assert.equal(run.code, 1);
  assert.equal(invitation.status, 'invitation');
  assert.match(invitation.link, /^https?:\/\//);
  assert.ok(!run.stdout.includes('Next:'));
  const next = assertNextLastAfterPending(run.stderr);
  assert.equal(lines(run.stderr).find((line) => line.includes('[invite-pending]')), pendingLine(invitation.invitationId));
  assert.equal(next, inviteLine(invitation.invitationId));
  assert.ok(next.includes(`\`courier invite serve ${invitation.invitationId} --wait 60\``), next);
});

test('invite (5): when the invitation is claimed in time (exit 0) no Next line is printed', async () => {
  const a = await fixture.home('next-invite-paired-a');
  const b = await fixture.home('next-invite-paired-b');
  const started = await fixture.run(a, ['start']);
  const issuer = fixture.launch(a, ['invite', '--session', started.session.sessionId, '--mode', 'anyone', '--consent', '--wait', '15']);
  const invitation = await issuer.first();
  await fixture.run(b, ['join', invitation.link, '--consent', '--wait', '15']);
  const done = await issuer.done;
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.lines.at(-1).status, 'paired');
  assert.deepEqual(nextLines(done.stderr), []);
});

/**
 * A pending `invite serve` run prints two Next lines: the start-of-run line (7) before the wait, then the pending-exit
 * line (8), which is the last non-empty stderr line and follows `[invite-pending]`. Returns both.
 */
function assertServePending(stderr, id) {
  const next = nextLines(stderr);
  assert.equal(next.length, 2, stderr);
  const all = lines(stderr);
  const pending = all.findIndex((line) => line.includes('[invite-pending]'));
  assert.ok(pending >= 0, stderr);
  assert.ok(all.indexOf(next[0]) < pending, 'the first Next line is printed before the wait, ahead of the pending error');
  assert.ok(all.indexOf(next[1]) > pending, 'the second follows the invite-pending error');
  assert.equal(lastLine(stderr), next[1], 'and is the last non-empty stderr line');
  assert.equal(next[1], pendingServeLine(id, 1), 'the pending line is exactly the run-again text: it names the command that was run and has no owner-cannot-see sentence');
  return next;
}

test('invite serve (7)+(8): a pending run prints the saved link at the start and ends with the run-again line; no key material; stdout and exit code as before', async () => {
  const a = await fixture.home('next-serve');
  const { invitation } = await pendingInvitation(a);
  const run = await fixture.launch(a, ['invite', 'serve', invitation.invitationId, '--wait', '1']).done;
  assert.equal(run.code, 1);
  assert.equal(run.stdout, '');
  const [start] = assertServePending(run.stderr, invitation.invitationId);
  assert.equal(lines(run.stderr).find((line) => line.includes('[invite-pending]')), pendingLine(invitation.invitationId));
  assert.ok(start.includes(invitation.link), 'the saved link, the same one invite printed');
  assert.equal(start, startLine(invitation.link));
  assert.equal(run.stderr.split(invitation.link).length - 1, 1, 'the link appears once');
  const body = JSON.parse(fixture.values.get(stateKey(a, invitation.invitationId)).bytes.toString()).body;
  for (const secret of [body.relay.key.jwk.d, body.relay.delegation]) assert.ok(!run.stderr.includes(secret), 'no key material or delegation on stderr');
});

test('invite serve (7): without a saved link the start line says to use the link invite printed and carries none', async () => {
  const a = await fixture.home('next-serve-nolink');
  const { invitation } = await pendingInvitation(a);
  const key = stateKey(a, invitation.invitationId);
  const saved = fixture.values.get(key);
  const state = JSON.parse(saved.bytes.toString());
  delete state.link;
  fixture.values.set(key, { bytes: Buffer.from(JSON.stringify(state)), etag: saved.etag });
  const run = await fixture.launch(a, ['invite', 'serve', invitation.invitationId, '--wait', '1']).done;
  assert.equal(run.code, 1);
  const [start] = assertServePending(run.stderr, invitation.invitationId);
  assert.ok(!start.includes('http'), start);
  assert.equal(start, 'Next: send the owner the invitation link printed by `invite` in your reply now if you have not sent it yet.');
});

test('invite serve (7): a run that ends paired (exit 0) prints exactly one start line with the link, before the wait, and stdout is the paired JSON', async () => {
  const a = await fixture.home('next-serve-paired-a');
  const b = await fixture.home('next-serve-paired-b');
  const { invitation } = await pendingInvitation(a);
  const serving = fixture.launch(a, ['invite', 'serve', invitation.invitationId, '--wait', '15']);
  // The start line must already be out before anybody has claimed the invitation: only then is it printed before the wait.
  let early = '';
  serving.child.stderr.on('data', (chunk) => { early += chunk; });
  for (const deadline = Date.now() + 10000; !early.includes('Next: ') && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(early.includes('Next: '), 'the start line was printed before the join began');
  await fixture.run(b, ['join', invitation.link, '--consent', '--wait', '15']);
  const done = await serving.done;
  assert.equal(done.code, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout.trim()).status, 'paired');
  // Not required to be the LAST line: on Node 20 a Node warning (see lastLine) can follow it.
  const next = nextLines(done.stderr);
  assert.equal(next.length, 1, done.stderr);
  assert.ok(next[0].includes(invitation.link));
  assert.ok(early.includes(invitation.link), 'and it carried the link already then');
  assert.ok(!lines(done.stderr).some((line) => line.includes('run `courier invite serve')), 'no run-again line: the invitation was claimed');
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

test('a join that ends pending (invite-pending, a different producer) prints no Next line', async () => {
  const a = await fixture.home('next-join-pending-a');
  const b = await fixture.home('next-join-pending-b');
  const { invitation } = await pendingInvitation(a);
  const joined = await fixture.launch(b, ['join', invitation.link, '--consent', '--wait', '1']).done;
  assert.equal(joined.code, 1);
  assert.match(joined.stderr, /\[invite-pending\]/);
  assert.deepEqual(nextLines(joined.stderr), []);
});

test('invite serve (7): an expired invitation prints no start line, only the expiry error', async () => {
  const a = await fixture.home('next-serve-expired');
  const { invitation } = await pendingInvitation(a);
  const key = stateKey(a, invitation.invitationId);
  const saved = fixture.values.get(key);
  const state = JSON.parse(saved.bytes.toString());
  state.body.expiresAt = new Date(Date.now() - 1000).toISOString();
  fixture.values.set(key, { bytes: Buffer.from(JSON.stringify(state)), etag: saved.etag });
  const run = await fixture.launch(a, ['invite', 'serve', invitation.invitationId, '--wait', '1']).done;
  assert.equal(run.code, 1);
  assert.match(run.stderr, /\[invite-expired\]/);
  assert.deepEqual(nextLines(run.stderr), []);
});

test('invite serve (7): an invitation that was already claimed and paired prints no start line when served again', async () => {
  const a = await fixture.home('next-serve-claimed-a');
  const b = await fixture.home('next-serve-claimed-b');
  const { invitation } = await pendingInvitation(a);
  const serving = fixture.launch(a, ['invite', 'serve', invitation.invitationId, '--wait', '15']);
  await fixture.run(b, ['join', invitation.link, '--consent', '--wait', '15']);
  assert.equal((await serving.done).code, 0);
  const again = await fixture.launch(a, ['invite', 'serve', invitation.invitationId, '--wait', '15']).done;
  assert.deepEqual(nextLines(again.stderr), [], again.stderr);
});
