// Synthetic loopback-only public CLI proof. --serve leaves one unclaimed link for a browser handoff.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createGuidedFixture } from '../test/support/guided-fixture.mjs';

const root = fs.mkdtempSync('/var/tmp/tc1543-loopback-');
fs.chmodSync(root, 0o700);
process.env.COURIER_TEST = '1';
process.env.COURIER_TEST_HOME = root;
const fixture = await createGuidedFixture(root, process.env.COURIER_CLI);
const sender = await fixture.home('issuer');
const recipient = await fixture.home('recipient');
const started = await fixture.run(sender, ['start']);
const serving = fixture.launch(sender, ['invite', '--session', started.session.sessionId, '--mode', 'anyone', '--consent', '--wait', process.argv.includes('--serve') ? '3600' : '30']);
const invitation = await serving.first();
const ready = {
  status: 'ready', root, cli: fixture.cli, host: fixture.host, link: invitation.link,
  invitationId: invitation.invitationId, sessionId: started.session.sessionId,
  senderHome: sender.home, recipientHome: recipient.home,
  env: { HOME: recipient.home, COURIER_HOME: recipient.home, COURIER_TEST: '1', COURIER_TEST_HOME: root,
    NODE_EXTRA_CA_CERTS: fixture.cert, COURIER_LINKS_API_ORIGIN: fixture.host, COURIER_LINK_ORIGIN: fixture.host },
  joinArgv: [process.execPath, fixture.cli, 'join', invitation.link, '--consent', '--wait', '30'],
};
fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify(ready, null, 2), { mode: 0o600 });
console.log(JSON.stringify(ready));
let recipientJoined;
try {
  if (process.argv.includes('--serve')) {
    const result = await serving.done;
    assert.equal(result.code, 0, result.stderr);
    recipientJoined = JSON.parse(fs.readFileSync(path.join(recipient.home, 'active-session.json'), 'utf8'));
  } else {
    recipientJoined = (await fixture.run(recipient, ['join', invitation.link, '--consent', '--wait', '30'])).session;
    const result = await serving.done;
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(recipientJoined.sessionId, started.session.sessionId);
  const senderActive = JSON.parse(fs.readFileSync(path.join(sender.home, 'active-session.json'), 'utf8'));
  const sent = await fixture.run(sender, ['send', senderActive.peer, '--thread', started.session.sessionId, '--intent', 'inform', '--text', 'Synthetic loopback sender message']);
  const received = await fixture.run(recipient, ['read', started.session.sessionId, '--peer', recipientJoined.peer, '--json']);
  assert.equal(received.entries.some((entry) => entry.kind === 'msg' && entry.body.messageId === sent.messageId), true);
  const discovered = await fixture.run(recipient, ['start']);
  assert.equal(discovered.status, 'choose-session');
  const receipt = { ...ready, status: 'passed', active: recipientJoined, sent, received, discovered,
    requests: fixture.requests.map(({ route, cid, refused }) => ({ route, cid, refused })) };
  fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: 'passed', receipt: path.join(root, 'receipt.json'), sessionId: started.session.sessionId }));
} finally {
  await fixture.close();
}
