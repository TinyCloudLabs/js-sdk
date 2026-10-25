// The channel guidance `invite` prints with the link. Output is checked through the function `invite` prints with, not through source or README text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INVITE_GUIDANCE, printInviteCreated } from '../dist/invite-commands.js';

const INVITE = `https://share.example.test/c/aaaaaaaaaaaaaaaaaaaaaaaaaa#v=4&k=${'B'.repeat(43)}&c=bafkrei${'a'.repeat(52)}`;
const input = () => ({ expectEmail: 'hunter@example.test', handle: 'hunter', tier: 'strict', expiresAt: new Date('2099-01-01T00:00:00.000Z'), invite: INVITE });

/** Captures what the default sink (console.log, i.e. stdout) receives. */
function stdoutOf(fn) {
  const out = [];
  const log = console.log;
  console.log = (...parts) => out.push(parts.join(' '));
  try {
    fn();
  } finally {
    console.log = log;
  }
  return out;
}

test('invite screen text: bearer link, a different channel than the invited address, --also-ask / --expect-owner for email, what a link holder can read', () => {
  const text = INVITE_GUIDANCE.join('\n');
  assert.match(text, /bearer link: keep it private until revoked or expired/);
  assert.match(text, /different channel than the invited email address/);
  assert.match(text, /If it goes by email, add --also-ask or --expect-owner/);
  assert.match(text, /Anyone who holds the link can read your owner address, space and handles until it expires, and can check a guessed invitee address against it/);
});

test('invite prints every guidance line on stdout, after the summary and above the invite string, which comes last', () => {
  const lines = stdoutOf(() => printInviteCreated(input()));
  assert.equal(lines.length, INVITE_GUIDANCE.length + 2);
  assert.match(lines[0], /^Invite for hunter@example\.test as "hunter"/);
  assert.deepEqual(lines.slice(1, 1 + INVITE_GUIDANCE.length), [...INVITE_GUIDANCE]);
  assert.equal(lines.at(-1), INVITE);
  assert.equal(lines.filter((line) => line === INVITE).length, 1, 'the string is printed once');
});
