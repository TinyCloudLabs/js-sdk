// The invitee's address is carried as a domain-separated, invite-salted SHA-256, never as the address: in the blob, the public record and the owner-visible texts a link holder can reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildInviteBlob } from '../dist/invite-blob.js';
import { EMAIL_HASH_DOMAIN, inviteEmailHash } from '../dist/invite-email-hash.js';
import { inviteRecordsFor } from '../dist/invite-commands.js';
import { parseInviteBlob } from '../dist/invite-schema.js';
import { LINK_ISSUER, storedLink } from './support/invite-link-fixture.mjs';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const ID_A = 'a'.repeat(25) + 'b';
const ID_B = 'a'.repeat(25) + 'c';
const EMAIL = 'hunter@example.test';
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';

test('the documented hash: base64url(SHA-256(domain 0x00 inviteId 0x00 address)), 43 characters', () => {
  const expected = createHash('sha256').update(Buffer.concat([Buffer.from('tinycloud.courier.invite-email/v1'), Buffer.from([0]), Buffer.from(ID_A), Buffer.from([0]), Buffer.from(EMAIL)])).digest('base64url');
  assert.equal(EMAIL_HASH_DOMAIN, 'tinycloud.courier.invite-email/v1');
  assert.equal(inviteEmailHash(ID_A, EMAIL), expected);
  assert.match(inviteEmailHash(ID_A, EMAIL), /^[A-Za-z0-9_-]{43}$/);
});

test('the invite id is the salt, and the compare is exact: another invite, another address, another case all hash differently', () => {
  const base = inviteEmailHash(ID_A, EMAIL);
  assert.notEqual(inviteEmailHash(ID_B, EMAIL), base);
  assert.notEqual(inviteEmailHash(ID_A, 'hunter@example.tes'), base);
  assert.notEqual(inviteEmailHash(ID_A, 'Hunter@example.test'), base);
  assert.notEqual(inviteEmailHash(ID_A, 'hunter+x@example.test'), base);
  // The separators matter: moving a character across the id/address boundary changes the hash.
  assert.notEqual(inviteEmailHash(`${ID_A}x`, 'unter@example.test'), inviteEmailHash(ID_A, 'xunter@example.test'));
});

const input = () => ({
  inviteId: ID_A, host: 'https://node.example.test', spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`,
  oneTimeKey: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'B'.repeat(43) }, permissions: { put: 'P', read: 'R', hooks: 'H' },
  artifactA: { type: 'courier-pair', v: 0, step: 'A', from: { owner: `did:pkh:eip155:1:${SAM_ADDR}`, courier: 'did:key:z6MkSamCourier' }, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, peer: 'hunter', callMe: 'sam', issuedAt: new Date(NOW).toISOString() },
  expiresAt: new Date(NOW + 3600e3), issuer: LINK_ISSUER, expectEmail: EMAIL, expectOwner: null, tier: 'strict', now: NOW,
});

test('the blob carries the hash and not the address, under the invite id it was built for', () => {
  const text = buildInviteBlob(input());
  assert.equal(text.includes(EMAIL), false);
  assert.equal(text.includes('hunter@'), false);
  const blob = parseInviteBlob(text, NOW);
  assert.equal(blob.expectEmailHash, inviteEmailHash(ID_A, EMAIL));
  assert.equal('expectEmail' in blob, false);
});

test('the public record carries the hash and not the address; the owner\'s private record keeps the address for the watcher', () => {
  const { record, publicRecord } = inviteRecordsFor({
    inviteId: ID_A, handle: 'hunter', callMe: 'sam', expectEmail: EMAIL, tier: 'strict', expectOwner: null, alsoAsk: false,
    expiresAt: new Date(NOW + 3600e3), createdAt: new Date(NOW).toISOString(), link: storedLink('l'), publicDir: undefined,
  });
  assert.equal(JSON.stringify(publicRecord).includes('hunter@'), false);
  assert.equal(publicRecord.expectEmailHash, inviteEmailHash(ID_A, EMAIL));
  assert.equal('expectEmail' in publicRecord, false);
  assert.equal(record.email, EMAIL);
});

test('the exact bytes hashed, pinned with a fixed vector: domain, 0x00, invite id, 0x00, address, and nothing after the address', () => {
  const bytes = Buffer.from('74696e79636c6f75642e636f75726965722e696e766974652d656d61696c2f76310061616161616161616161616161616161616161616161616161620068756e746572406578616d706c652e74657374', 'hex');
  assert.equal(bytes.toString('latin1'), `tinycloud.courier.invite-email/v1\0${ID_A}\0${EMAIL}`);
  assert.equal(bytes.at(-1), EMAIL.charCodeAt(EMAIL.length - 1), 'no 0x00 after the address');
  assert.equal(createHash('sha256').update(bytes).digest('base64url'), 'XWcep_LaPpNA_aYItwZfnJe2954Y02pvF7SL61yhYCI');
  assert.equal(inviteEmailHash(ID_A, EMAIL), 'XWcep_LaPpNA_aYItwZfnJe2954Y02pvF7SL61yhYCI');
});
