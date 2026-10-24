// The channel guidance printed by `invite` and written in the README must keep saying the same things.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INVITE_GUIDANCE } from '../dist/invite-commands.js';

const README = fs.readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8').replace(/\s+/g, ' ');
const SOURCE = fs.readFileSync(fileURLToPath(new URL('../src/invite-commands.ts', import.meta.url)), 'utf8');

test('invite screen text: bearer link, a different channel than the invited address, --also-ask / --expect-owner for email, what a link holder can read', () => {
  const text = INVITE_GUIDANCE.join('\n');
  assert.match(text, /bearer link: keep it private until revoked or expired/);
  assert.match(text, /different channel than the invited email address/);
  assert.match(text, /If it goes by email, add --also-ask or --expect-owner/);
  assert.match(text, /Anyone who holds the link can read the invitee address and your owner address, space and handles until it expires/);
});

test('invite create prints every guidance line', () => {
  assert.match(SOURCE, /for \(const line of INVITE_GUIDANCE\) console\.log\(line\);/);
});

test('README says the same: different channel, --also-ask / --expect-owner by email, what a link holder can read', () => {
  assert.ok(README.includes('Send the link by a different channel than the invited email address'));
  assert.ok(README.includes('add `--also-ask`'));
  assert.ok(README.includes('`--expect-owner`'));
  assert.ok(README.includes('Anyone who holds the link can read the invitee address and your owner address, space and handles until it expires'));
});
