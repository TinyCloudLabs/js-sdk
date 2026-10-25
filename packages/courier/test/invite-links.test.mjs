// Invitations ride the `courier` link type. The client is the SDK's links module; Courier's part is tested against a stand-in links API on loopback that
// applies the contract's own checks (real `verifyHeader` / `verifyDelete`), under a fixed clock: the life bounds, the size cap before signing, the per-invite
// key, the issuer binding, stable error codes with fixed messages, expiry, and the contract vectors that concern a `courier` link.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  LINK_MIN_LIFE_SECONDS, LINK_SEAL_OVERHEAD_BYTES, LINK_TYPE_SPECS, LinkError, MAX_LINK_BODY_BYTES, createLink, parseLink, shortShareLinkCid, signerFromSeed, verifyHeader,
} from '@tinycloud/share-envelope/links';
import { canonicalize, fromBase64Url, toBase64Url } from '@tinycloud/share-envelope';
import { parseArgs } from '../dist/args.js';
import { newAgentKey } from '../dist/commands.js';
import { buildInviteBlob, newInviteId } from '../dist/invite-blob.js';
import { cmdInvite, inviteRecordsFor, storedRecord } from '../dist/invite-commands.js';
import {
  INVITE_TTL_DEFAULT, INVITE_TTL_MAX_MS, INVITE_TTL_MIN_MS, createInviteLink, deleteInviteLink, inviteTtl, linkFailure, linksConfig, newInviteLinkKey, resolveInviteLink, signerFromStored,
} from '../dist/invite-links.js';
import { readRecord, writeRecord } from '../dist/invite-watch.js';
import { LINK_SEED, storedLink } from './support/invite-link-fixture.mjs';
import { DEFAULT_LINKS_API_ORIGIN, DEFAULT_SHARE_ORIGINS } from '@tinycloud/share-envelope/links';
import { assertBlobIssuer } from '../dist/invite-links.js';
import { API_ORIGIN, VIEWER_ORIGIN, startLinksApi } from './support/links-standin.mjs';

assert.ok(process.env.COURIER_TEST === '1' && process.env.COURIER_TEST_HOME, 'the test home fence is armed');
for (const name of ['HOME', 'COURIER_HOME']) {
  assert.ok(path.resolve(process.env[name]).startsWith(`${path.resolve(process.env.COURIER_TEST_HOME)}${path.sep}`) || path.resolve(process.env[name]) === path.resolve(process.env.COURIER_TEST_HOME), `${name} is inside the test home`);
}

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const EMAIL = 'hunter@example.test';
const SPEC = LINK_TYPE_SPECS.courier;

const artifactA = () => ({
  type: 'courier-pair', v: 0, step: 'A',
  from: { owner: `did:pkh:eip155:1:${SAM_ADDR}`, courier: 'did:key:z6MkSamCourier', label: 'Sam' },
  spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, peer: 'hunter', callMe: 'sam', issuedAt: new Date(NOW).toISOString(),
});
const blobFor = (key, over = {}) => buildInviteBlob({
  inviteId: newInviteId(), host: 'https://node.example.test', spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`,
  oneTimeKey: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'B'.repeat(43) },
  permissions: { put: 'PUT-DELEGATION', read: 'READ-DELEGATION', hooks: 'HOOKS-DELEGATION' },
  artifactA: artifactA(), expiresAt: new Date(NOW + 3600e3), issuer: key.signer.did, expectEmail: EMAIL, expectOwner: null, tier: 'strict', now: NOW, ...over,
});
const rejectsWith = (promise, code) => assert.rejects(promise, (e) => e.name === 'CourierError' && e.code === code, `expected ${code}`);
const LINK_SHAPE = new RegExp(`^${VIEWER_ORIGIN}/c/[a-z2-7]{26}#v=4&k=[A-Za-z0-9_-]{43}&c=bafkrei[a-z2-7]{52}$`);

let standin;
before(async () => { standin = await startLinksApi({ now: () => NOW }); });
after(() => standin.stop());
beforeEach(() => { standin.requests.length = 0; standin.records.clear(); });

const create = (key = newInviteLinkKey(), over = {}) => createInviteLink(standin.config, { blobText: blobFor(key), expiresAt: new Date(NOW + 3600e3), key, now: NOW, ...over });

test('create and resolve: the link has the contract shape and opens to the same invitation, over one POST and one GET', async () => {
  const key = newInviteLinkKey();
  const blobText = blobFor(key);
  const { link, stored } = await createInviteLink(standin.config, { blobText, expiresAt: new Date(NOW + 3600e3), key, now: NOW });
  assert.match(link, LINK_SHAPE);
  assert.deepEqual(standin.requests.map((r) => [r.method, r.status]), [['POST', 201]]);
  const opened = await resolveInviteLink(standin.config, link, NOW);
  assert.equal(opened.blobText, blobText);
  assert.equal(opened.issuer, key.signer.did);
  assert.equal(opened.blob.issuer, key.signer.did);
  assert.deepEqual(standin.requests.map((r) => [r.method, r.status]), [['POST', 201], ['GET', 200]]);
  assert.equal(parseLink(link, { trustedOrigins: [VIEWER_ORIGIN] }).id, stored.id);
});

test('what the service stored: a courier record signed by the per-invite key (the real verifyHeader accepts it), audience the API, life exactly the ttl', async () => {
  const key = newInviteLinkKey();
  const { stored } = await create(key, { expiresAt: new Date(NOW + 90 * 60_000) });
  const record = standin.records.get(stored.id);
  assert.equal(record.header.type, 'courier');
  assert.equal(record.header.issuer, key.signer.did);
  assert.equal(record.header.audience, API_ORIGIN);
  assert.equal(Date.parse(record.header.expiresAt) - Date.parse(record.header.issuedAt), 90 * 60_000);
  assert.equal(verifyHeader(record.header, record.signature), true);
  assert.deepEqual(stored, { id: stored.id, cid: record.header.bodyCid, issuer: key.signer.did, seed: key.seed, apiOrigin: API_ORIGIN });
});

// --- ttl ------------------------------------------------------------------------------------------------------------------------------------------

test('ttl bounds come from the courier link type: min 120 s, default 24 h, max 7 d', () => {
  assert.equal(INVITE_TTL_MIN_MS, LINK_MIN_LIFE_SECONDS * 1000);
  assert.equal(INVITE_TTL_MAX_MS, SPEC.maxLifeSeconds * 1000);
  assert.equal(INVITE_TTL_MAX_MS, 7 * 86_400_000);
  assert.equal(inviteTtl(undefined).ms, SPEC.defaultLifeSeconds * 1000);
  assert.equal(inviteTtl(undefined).ms, 24 * 3_600_000);
  assert.equal(INVITE_TTL_DEFAULT, '86400s');
  assert.equal(inviteTtl(undefined).text, INVITE_TTL_DEFAULT);
});

for (const [ttl, ok] of [
  ['119s', false], ['120s', true], ['2m', true], ['1s', false], ['0s', false], ['1m', false],
  ['7d', true], ['168h', true], ['604800s', true], ['604801s', false], ['8d', false], ['10080m', true], ['10081m', false],
  ['soon', false], ['-5m', false], ['1.5h', false], ['', false], ['24', false],
]) {
  test(`ttl ${JSON.stringify(ttl)} is ${ok ? 'accepted' : 'refused as a usage error'}`, () => {
    if (ok) assert.equal(inviteTtl(ttl).text, ttl);
    else assert.throws(() => inviteTtl(ttl), (e) => e.name === 'CourierError' && e.code === 'usage' && /--ttl must be a duration/.test(e.message));
  });
}

test('an out-of-bounds --ttl is refused by `invite` before the node is reached, a key is made or any request is sent', async () => {
  const boom = async () => { throw new Error('ctx must not be reached'); };
  for (const ttl of ['119s', '8d', 'soon']) {
    await assert.rejects(cmdInvite(parseArgs(['hunter', '--email', EMAIL, '--ttl', ttl]), { ctx: boom, links: standin.config }), (e) => e.code === 'usage' && /--ttl/.test(e.message));
  }
  assert.deepEqual(standin.requests, []);
});

test('a life outside the bounds is refused by the client itself before any request (the SDK checks it; the stand-in sees nothing)', async () => {
  const key = newInviteLinkKey();
  await rejectsWith(createInviteLink(standin.config, { blobText: blobFor(key), expiresAt: new Date(NOW + 119_000), key, now: NOW }), 'usage');
  await rejectsWith(createInviteLink(standin.config, { blobText: blobFor(key), expiresAt: new Date(NOW + 7 * 86_400_000 + 1000), key, now: NOW }), 'usage');
  assert.deepEqual(standin.requests, []);
});

// --- size cap -----------------------------------------------------------------------------------------------------------------------------------

function withSignSpy(key) {
  const spy = { calls: 0 };
  return { spy, key: { seed: key.seed, signer: { did: key.signer.did, sign: (digest) => { spy.calls += 1; return key.signer.sign(digest); } } } };
}
const textOfSize = (key, bytes) => {
  const head = JSON.stringify({ issuer: key.signer.did, pad: '' });
  return JSON.stringify({ issuer: key.signer.did, pad: 'x'.repeat(bytes - Buffer.byteLength(head)) });
};

test('body cap: the sealed size is checked against MAX_LINK_BODY_BYTES before anything is signed or sent; one byte under goes through, one over is invite-too-large', async () => {
  const largest = MAX_LINK_BODY_BYTES - LINK_SEAL_OVERHEAD_BYTES;
  const under = withSignSpy(newInviteLinkKey());
  const created = await createInviteLink(standin.config, { blobText: textOfSize(under.key, largest), expiresAt: new Date(NOW + 3600e3), key: under.key, now: NOW });
  assert.match(created.link, LINK_SHAPE);
  assert.equal(standin.records.get(created.stored.id).body.length, MAX_LINK_BODY_BYTES);
  assert.equal(under.spy.calls, 1);

  standin.requests.length = 0;
  const over = withSignSpy(newInviteLinkKey());
  await rejectsWith(createInviteLink(standin.config, { blobText: textOfSize(over.key, largest + 1), expiresAt: new Date(NOW + 3600e3), key: over.key, now: NOW }), 'invite-too-large');
  assert.equal(over.spy.calls, 0, 'nothing was signed');
  assert.deepEqual(standin.requests, [], 'nothing was sent');
});

// --- per-invite key -----------------------------------------------------------------------------------------------------------------------

test('every invite gets its own throwaway key: distinct from other invites and from the agent key, and its seed is in no link, body, service record or public record', async () => {
  const a = newInviteLinkKey();
  const b = newInviteLinkKey();
  assert.notEqual(a.signer.did, b.signer.did);
  assert.notEqual(a.seed, b.seed);
  assert.equal(signerFromStored({ id: 'x', cid: 'c', issuer: a.signer.did, seed: a.seed }).did, a.signer.did);
  const agent = newAgentKey();
  assert.ok(![a.signer.did, b.signer.did].includes(agent.did.split('#')[0]));
  assert.equal(Object.keys(a.signer).sort().join(), 'did,sign', 'the signer carries no seed');
  assert.equal(JSON.stringify(a.signer), JSON.stringify({ did: a.signer.did }));

  const { link, stored } = await create(a);
  const record = standin.records.get(stored.id);
  const seen = [link, JSON.stringify(record.header), JSON.stringify(record.signature), Buffer.from(record.body).toString('latin1'), Buffer.from(record.body).toString('base64url')];
  for (const text of seen) assert.equal(text.includes(a.seed), false);

  const { record: privateRecord, publicRecord } = inviteRecordsFor({
    inviteId: newInviteId(), handle: 'hunter', callMe: 'sam', expectEmail: EMAIL, tier: 'strict', expectOwner: null, alsoAsk: false,
    expiresAt: new Date(NOW + 3600e3), createdAt: new Date(NOW).toISOString(), link: stored, publicDir: undefined,
  });
  assert.equal(privateRecord.link.seed, a.seed, 'the private record keeps the seed');
  const publicText = JSON.stringify(publicRecord);
  assert.equal(publicText.includes(a.seed), false);
  assert.equal(publicText.includes(a.signer.did), false, 'not even the key\'s did');
  assert.equal(publicText.includes(stored.id), false, 'nor the link id');
});

test('the private record is written 0600 with the seed; `invite list` never prints the seed, the key or the link id', async () => {
  const key = newInviteLinkKey();
  const { stored } = await create(key);
  const inviteId = newInviteId();
  const { record } = inviteRecordsFor({
    inviteId, handle: 'hunter', callMe: 'sam', expectEmail: EMAIL, tier: 'strict', expectOwner: null, alsoAsk: false,
    expiresAt: new Date(NOW + 3600e3), createdAt: new Date(NOW).toISOString(), link: stored, publicDir: undefined,
  });
  writeRecord(storedRecord(record, 'hash-of-one-time-key'));
  const file = path.join(process.env.COURIER_HOME, 'invites', `${inviteId}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(readRecord(inviteId).link.seed, key.seed);
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    await cmdInvite(parseArgs(['list']));
  } finally {
    process.stdout.write = write;
  }
  const printed = chunks.join('');
  assert.ok(printed.includes(inviteId));
  for (const secret of [key.seed, key.signer.did, stored.id]) assert.equal(printed.includes(secret), false);
});

// --- issuer binding -----------------------------------------------------------------------------------------------------------------------------

test('issuer binding, accepted: an invitation whose top-level issuer is the link\'s signing key opens', async () => {
  const key = newInviteLinkKey();
  const { link } = await create(key);
  assert.equal((await resolveInviteLink(standin.config, link, NOW)).blob.issuer, key.signer.did);
});

async function linkWithBody(plaintext, signer) {
  return createLink({
    type: 'courier', plaintext: new TextEncoder().encode(plaintext), issuerKey: signer, apiOrigin: API_ORIGIN, linkOrigin: VIEWER_ORIGIN,
    expiresAt: new Date(NOW + 3600e3), now: NOW, fetch: standin.fetch,
  });
}

test('issuer binding, refused: a body that names another issuer, none, or a non-string is refused as invite-issuer-mismatch BEFORE its other fields are used', async () => {
  const signer = newInviteLinkKey().signer;
  const other = newInviteLinkKey().signer.did;
  // Each body is also invalid as an invitation: if any other field were looked at first, the error would be bad-invite-file.
  for (const body of [{ issuer: other, junk: 1 }, { junk: 1 }, { issuer: 7 }, { issuer: `${signer.did}x` }, { issuer: signer.did.toUpperCase() }]) {
    const { link } = await linkWithBody(JSON.stringify(body), signer);
    await rejectsWith(resolveInviteLink(standin.config, link, NOW), 'invite-issuer-mismatch');
  }
  // The same junk body bound to the right issuer gets as far as the schema, which refuses it for its fields.
  const { link } = await linkWithBody(JSON.stringify({ issuer: signer.did, junk: 1 }), signer);
  await rejectsWith(resolveInviteLink(standin.config, link, NOW), 'bad-invite-file');
});

test('a real invitation text that names another issuer is refused; so is creating one (the client will not publish a body that is not bound to its key)', async () => {
  const signer = newInviteLinkKey().signer;
  const other = newInviteLinkKey();
  const { link } = await linkWithBody(blobFor(other), signer);
  await rejectsWith(resolveInviteLink(standin.config, link, NOW), 'invite-issuer-mismatch');
  await rejectsWith(createInviteLink(standin.config, { blobText: blobFor(other), expiresAt: new Date(NOW + 3600e3), key: newInviteLinkKey(), now: NOW }), 'internal');
});

// --- errors, expiry, delete -----------------------------------------------------------------------------------------------------------------------

test('service refusals map to stable Courier codes with fixed messages: none of the service\'s words reaches the message', async () => {
  const cases = [[429, 'invite-rate-limited'], [503, 'invite-unavailable'], [500, 'invite-store-error'], [403, 'invite-store-error']];
  for (const [status, code] of cases) {
    standin.fail(status);
    const key = newInviteLinkKey();
    await assert.rejects(create(key), (e) => e.name === 'CourierError' && e.code === code && !/forced/.test(e.message) && !e.message.includes(key.seed));
  }
  const { link } = await create();
  standin.fail(503);
  await rejectsWith(resolveInviteLink(standin.config, link, NOW), 'invite-unavailable');
  const key = newInviteLinkKey();
  const made = await create(key);
  standin.fail(500);
  await assert.rejects(deleteInviteLink(standin.config, made.stored), (e) => e.code === 'invite-store-error' && !e.message.includes(key.seed) && !/forced/.test(e.message));
});

test('an unreachable service is invite-unreachable; a link on another viewer origin is invite-origin; a link that is not an invitation link is bad-invite', async () => {
  const dead = { ...standin.config, fetch: async () => { throw new Error('connection refused to 10.0.0.1'); } };
  const key = newInviteLinkKey();
  await assert.rejects(createInviteLink(dead, { blobText: blobFor(key), expiresAt: new Date(NOW + 3600e3), key, now: NOW }), (e) => e.code === 'invite-unreachable' && !/10\.0\.0\.1/.test(e.message));
  const { link } = await create();
  await rejectsWith(resolveInviteLink({ ...standin.config, viewerOrigin: 'https://elsewhere.test' }, link, NOW), 'invite-origin');
  for (const bad of ['not a link', 'tcinvite1:aaaaaaaaaaaaaaaaaaaaaaaaaa:' + 'B'.repeat(43) + ':bafkrei' + 'a'.repeat(52), link.replace('#v=4', '#v=3'), link.replace('/c/', '/s/'), `${link}&x=1`]) {
    await assert.rejects(resolveInviteLink(standin.config, bad, NOW), (e) => e.name === 'CourierError' && ['bad-invite', 'invite-gone'].includes(e.code));
  }
});

test('expiry under an injected clock: open before it, gone after it, whether the service or the reader notices first', async () => {
  const { link } = await create(newInviteLinkKey(), { expiresAt: new Date(NOW + 600_000) });
  assert.ok((await resolveInviteLink(standin.config, link, NOW + 599_999)).blob);
  // The service clock is fixed at NOW: it still serves the record, and the reader's own expiry check refuses it.
  await rejectsWith(resolveInviteLink(standin.config, link, NOW + 600_000), 'invite-gone');
  // A service that already dropped it says 404.
  const later = await startLinksApi({ now: () => NOW + 700_000 });
  try {
    const key = newInviteLinkKey();
    const made = await createInviteLink({ ...later.config }, { blobText: blobFor(key), expiresAt: new Date(NOW + 700_000 + 600_000), key, now: NOW + 700_000 });
    assert.ok((await resolveInviteLink(later.config, made.link, NOW + 700_000)).blob);
    await rejectsWith(resolveInviteLink(later.config, made.link, NOW + 700_000 + 600_000), 'invite-gone');
  } finally {
    await later.stop();
  }
});

test('delete is signed by the invite\'s own key: the real verifyDelete accepts it, another key leaves the link alone, a repeat counts as already deleted', async () => {
  const key = newInviteLinkKey();
  const { link, stored } = await create(key);
  const foreign = { ...stored, issuer: signerFromSeed(Uint8Array.from({ length: 32 }, (_, i) => 200 - i)).did, seed: Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => 200 - i)).toString('base64url') };
  await deleteInviteLink(standin.config, foreign);
  assert.equal(standin.records.has(stored.id), true, 'another key does not delete it (404, which counts as absent)');
  await assert.rejects(deleteInviteLink(standin.config, { ...stored, issuer: foreign.issuer }), (e) => e.code === 'internal', 'a seed that is not the recorded issuer\'s is refused locally');
  await deleteInviteLink(standin.config, stored);
  assert.equal(standin.records.has(stored.id), false);
  await deleteInviteLink(standin.config, stored);
  await rejectsWith(resolveInviteLink(standin.config, link, NOW), 'invite-gone');
  const statuses = standin.requests.filter((r) => r.path.endsWith('/delete')).map((r) => r.status);
  assert.deepEqual(statuses, [404, 204, 404]);
});

test('a stored link whose seed is not the recorded issuer\'s, or not canonical, is refused before any signing', () => {
  for (const bad of [{ seed: 'short' }, { seed: `${LINK_SEED.slice(0, 42)}B` }, { issuer: 'did:key:z6MkOther' }]) {
    assert.throws(() => signerFromStored({ ...storedLink('x'), ...bad }), (e) => e.code === 'internal');
  }
  assert.equal(signerFromStored(storedLink('x')).did, storedLink('x').issuer);
});

test('linkFailure: each refusal of the contract maps to a stable Courier code, and no message carries text from the store', () => {
  const table = {
    body_over_cap: 'invite-too-large', gone: 'invite-gone', expired: 'invite-gone', origin_not_trusted: 'invite-origin', issuer_binding_mismatch: 'invite-issuer-mismatch',
    service_unavailable: 'invite-unreachable', response_too_large: 'invite-unreachable', invalid_response: 'invite-unreachable', life_too_short: 'usage', life_too_long: 'usage',
    already_expired: 'usage', issued_at_window: 'invite-clock', invalid_argument: 'internal', signer_failed: 'internal',
    bad_signature: 'bad-invite', body_hash_mismatch: 'bad-invite', body_open_failed: 'bad-invite', removed_version: 'bad-invite', type_path_mismatch: 'bad-invite',
    link_cid_mismatch: 'bad-invite', full_non_share: 'bad-invite', not_https: 'bad-invite', plaintext_schema: 'bad-invite',
  };
  for (const [reason, code] of Object.entries(table)) {
    const failure = linkFailure(new LinkError(reason, 'SECRET store text'), 'open');
    assert.equal(failure.code, code, reason);
    assert.equal(failure.message.includes('SECRET'), false, reason);
  }
  const refused = (status) => linkFailure(new LinkError('service_refused', 'SECRET store text', { status, serviceError: 'secret_code' }), 'create');
  assert.deepEqual([429, 503, 500, 404].map((status) => refused(status).code), ['invite-rate-limited', 'invite-unavailable', 'invite-store-error', 'invite-store-error']);
  for (const status of [429, 503, 500]) assert.equal(/SECRET|secret_code/.test(refused(status).message), false);
  assert.equal(linkFailure(new Error('SECRET store text'), 'open').message.includes('SECRET'), false);
});

test('COURIER_LINKS_API_ORIGIN defaults to the SDK\'s; an invalid COURIER_LINK_ORIGIN is refused', () => {
  for (const bad of ['http://share.example', 'https://share.example/path', 'share.example', 'https://user@share.example', 'https://share.example?x=1']) {
    assert.throws(() => linksConfig({ COURIER_LINK_ORIGIN: bad }), (e) => e.code === 'link-origin-invalid', bad);
  }
  assert.deepEqual(linksConfig({ COURIER_LINK_ORIGIN: 'https://share.example/' }), { apiOrigin: 'https://api.tinycloud.xyz', viewerOrigin: 'https://share.example' });
  assert.equal(linksConfig({ COURIER_LINK_ORIGIN: 'https://share.example', COURIER_LINKS_API_ORIGIN: 'https://api.example:8443' }).apiOrigin, 'https://api.example:8443');
  assert.throws(() => linksConfig({ COURIER_LINK_ORIGIN: 'https://share.example', COURIER_LINKS_API_ORIGIN: 'http://api.example' }), (e) => e.code === 'link-origin-invalid');
});

test('COURIER_LINK_ORIGIN unset or blank: the viewer is the SDK\'s production viewer, the API the SDK\'s default; an override wins; an invalid override is still refused', () => {
  for (const env of [{}, { COURIER_LINK_ORIGIN: '' }, { COURIER_LINK_ORIGIN: '   ' }]) {
    assert.deepEqual(linksConfig(env), { apiOrigin: DEFAULT_LINKS_API_ORIGIN, viewerOrigin: DEFAULT_SHARE_ORIGINS[0] });
  }
  assert.equal(linksConfig({ COURIER_LINK_ORIGIN: 'https://share.example' }).viewerOrigin, 'https://share.example', 'an override beats the default');
  assert.notEqual(linksConfig({ COURIER_LINK_ORIGIN: 'https://share.example' }).viewerOrigin, DEFAULT_SHARE_ORIGINS[0]);
  for (const bad of ['http://share.tinycloud.xyz', 'https://share.tinycloud.xyz/x', 'share.tinycloud.xyz']) {
    assert.throws(() => linksConfig({ COURIER_LINK_ORIGIN: bad }), (e) => e.code === 'link-origin-invalid', bad);
  }
});

test('the default viewer origin is one the SDK reader trusts: a link made on it parses under DEFAULT_SHARE_ORIGINS, and one made on an override does not', async () => {
  const viewerOrigin = linksConfig({}).viewerOrigin;
  assert.ok(DEFAULT_SHARE_ORIGINS.includes(viewerOrigin));
  const key = newInviteLinkKey();
  const { link } = await createInviteLink({ ...standin.config, viewerOrigin }, { blobText: blobFor(key), expiresAt: new Date(NOW + 3600e3), key, now: NOW });
  assert.equal(new URL(link).origin, viewerOrigin);
  assert.equal(parseLink(link, { trustedOrigins: DEFAULT_SHARE_ORIGINS }).pathType, 'courier');
  const { link: overridden } = await create();
  assert.throws(() => parseLink(overridden, { trustedOrigins: DEFAULT_SHARE_ORIGINS }), (e) => e.code === 'origin_not_trusted');
});

test('Courier\'s own issuer check: the invitation must name the did:key that signed the link', () => {
  const key = newInviteLinkKey();
  const blob = { issuer: key.signer.did };
  assert.doesNotThrow(() => assertBlobIssuer(blob, key.signer.did));
  assert.throws(() => assertBlobIssuer(blob, newInviteLinkKey().signer.did), (e) => e.name === 'CourierError' && e.code === 'invite-issuer-mismatch');
  assert.throws(() => assertBlobIssuer({ issuer: `${key.signer.did}x` }, key.signer.did), (e) => e.code === 'invite-issuer-mismatch');
});

test('a stored link keeps the API origin it was created on, and the delete goes there, not to the origin the environment names now', async () => {
  const key = newInviteLinkKey();
  const { stored } = await create(key);
  assert.equal(stored.apiOrigin, API_ORIGIN);
  const urls = [];
  const recording = async (url) => { urls.push(String(url)); return new Response('{}', { status: 404 }); };
  const before = process.env.COURIER_LINKS_API_ORIGIN;
  process.env.COURIER_LINKS_API_ORIGIN = 'https://api.elsewhere.example';
  try {
    await deleteInviteLink({ fetch: recording }, stored);
    await deleteInviteLink({ fetch: recording }, { ...stored, apiOrigin: 'https://api.recorded.example' });
    await deleteInviteLink({ fetch: recording }, { id: stored.id, cid: stored.cid, issuer: stored.issuer, seed: stored.seed });
  } finally {
    if (before === undefined) delete process.env.COURIER_LINKS_API_ORIGIN;
    else process.env.COURIER_LINKS_API_ORIGIN = before;
  }
  assert.equal(urls.length, 3);
  assert.ok(urls[0].startsWith(`${API_ORIGIN}/`), 'the recorded origin');
  assert.ok(urls[1].startsWith('https://api.recorded.example/'), 'another recorded origin');
  assert.ok(urls[2].startsWith(`${DEFAULT_LINKS_API_ORIGIN}/`), 'a record from before the origin was kept: the SDK default, not the environment');
  assert.equal(urls.some((u) => u.includes('elsewhere.example')), false);
});

test('a recorded API origin that is not a canonical https origin is refused before anything is sent', async () => {
  let sent = 0;
  for (const apiOrigin of ['http://api.example', 'https://api.example/x', 'api.example']) {
    await assert.rejects(deleteInviteLink({ fetch: () => { sent += 1; throw new Error('sent'); } }, { ...storedLink('x'), apiOrigin }), (e) => e.code === 'link-origin-invalid');
  }
  assert.equal(sent, 0);
});

// --- contract vectors -----------------------------------------------------------------------------------------------------------------------

const VECTOR_PATH = new URL('../../share-envelope/test/links-api-vectors.json', import.meta.url);
const VECTOR_SHA256 = '59641c44536e5f53d7230205ff7d277bd5441cc8ddac10b7bee63f1d2358f3e6';
const vectors = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'));

test('vectors: the file is the byte-identical copy of the contract\'s (read in place, never edited)', () => {
  assert.equal(createHash('sha256').update(fs.readFileSync(VECTOR_PATH)).digest('hex'), VECTOR_SHA256);
});

const vectorFetch = (record) => async () => {
  if (record === null) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  const { body, ...stored } = record;
  return new Response(fromBase64Url(body), { status: 200, headers: { 'content-type': 'application/octet-stream', 'x-link-record': toBase64Url(new TextEncoder().encode(canonicalize(stored))) } });
};
// What Courier answers for each contract refusal that a courier link can meet. The valid row passes the contract and then meets Courier's own schema.
const VECTOR_COURIER_CODE = { type_path_mismatch: 'bad-invite', issuer_binding_mismatch: 'invite-issuer-mismatch' };

for (const vector of vectors.resolve.filter((row) => /\/c\//.test(row.link) || row.serverRecord?.header.type === 'courier')) {
  test(`vectors resolve: ${vector.name}`, async () => {
    const config = { viewerOrigin: vectors.meta.trustedOrigins[0], apiOrigin: vectors.meta.audience, fetch: vectorFetch(vector.serverRecord) };
    const code = vector.expect.status === 200 ? 'bad-invite-file' : VECTOR_COURIER_CODE[vector.expect.reason];
    assert.ok(code, `the vector's refusal ${vector.expect.reason} has a Courier code in this test`);
    await rejectsWith(resolveInviteLink(config, vector.link, Date.parse(vector.now)), code);
  });
}

for (const vector of vectors.linkChoice) {
  test(`vectors linkChoice: a ${vector.shareLifetimeSeconds} s life is ${vector.expect.form === 'short' && vector.shareLifetimeSeconds <= SPEC.maxLifeSeconds ? 'a short link Courier creates' : 'refused by Courier (it never falls back to a full link)'}`, async () => {
    const seconds = vector.shareLifetimeSeconds;
    if (vector.expect.form === 'short' && seconds <= SPEC.maxLifeSeconds) {
      assert.equal(inviteTtl(`${seconds}s`).ms, seconds * 1000);
      const key = newInviteLinkKey();
      const { link } = await createInviteLink(standin.config, { blobText: blobFor(key), expiresAt: new Date(NOW + seconds * 1000), key, now: NOW });
      assert.equal(parseLink(link, { trustedOrigins: [VIEWER_ORIGIN] }).form, 'short');
      assert.equal(parseLink(link, { trustedOrigins: [VIEWER_ORIGIN] }).pathType, 'courier');
    } else {
      assert.throws(() => inviteTtl(`${seconds}s`), (e) => e.code === 'usage');
    }
  });
}

for (const vector of vectors.deliveryAdmission.ocReturnLinks) {
  test(`vectors ocReturnLinks: ${vector.name}`, () => {
    const permitted = shortShareLinkCid(vector.returnLink, { trustedOrigins: vector.allowedOrigins }) !== undefined && Buffer.byteLength(vector.returnLink) <= vectors.constants.ocReturnLinkMaxBytes;
    assert.equal(permitted, vector.expect.permits);
    if (/\/c\//.test(vector.returnLink)) assert.equal(permitted, false, 'a courier link never rides the share delivery seam');
  });
}

test('vectors ocReturnLinks: a link Courier creates is not a share delivery link', async () => {
  const { link } = await create();
  assert.equal(shortShareLinkCid(link, { trustedOrigins: [VIEWER_ORIGIN] }), undefined);
});
