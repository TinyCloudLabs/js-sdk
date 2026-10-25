// `invite` end to end against the stand-in links API under a fixed clock: the delegations are minted by a fake node, the link is created with the per-invite key,
// the record keeps the seed 0600, the public copy holds only the address hash, a failed create leaves nothing behind, and revoke deletes the link with the recorded key.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../dist/args.js';
import { cmdInvite } from '../dist/invite-commands.js';
import { inviteEmailHash } from '../dist/invite-email-hash.js';
import { DEFAULT_SHARE_ORIGINS } from '@tinycloud/share-envelope/links';
import { linksConfig } from '../dist/invite-links.js';
import { deleteInviteLink, resolveInviteLink } from '../dist/invite-links.js';
import { InviteWatcher, listRecords, readRecord } from '../dist/invite-watch.js';
import { memoryKv } from './memory-kv.mjs';
import { startLinksApi } from './support/links-standin.mjs';

assert.ok(process.env.COURIER_TEST === '1' && process.env.COURIER_TEST_HOME, 'the test home fence is armed');

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const SAM_OWNER = `did:pkh:eip155:1:${SAM_ADDR}`;
const EMAIL = 'hunter@example.test';

let standin;
let home;
let saved;
let delegations;

before(async () => { standin = await startLinksApi({ now: () => NOW }); });
after(() => standin.stop());
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc712.create-links.'));
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME, COURIER_PEERS_FILE: process.env.COURIER_PEERS_FILE, COURIER_INVITES_PUBLIC_DIR: process.env.COURIER_INVITES_PUBLIC_DIR };
  process.env.COURIER_HOME = home;
  process.env.HOME = home;
  delete process.env.COURIER_PEERS_FILE;
  delete process.env.COURIER_INVITES_PUBLIC_DIR;
  assert.ok([process.env.COURIER_HOME, process.env.HOME].every((p) => path.resolve(p).startsWith(path.resolve(process.env.COURIER_TEST_HOME) + path.sep)));
  standin.requests.length = 0;
  standin.records.clear();
  delegations = [];
});
afterEach(() => {
  for (const name of Object.keys(saved)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const profile = () => ({
  version: 3, host: 'https://node.example.test', openkeyHost: 'https://o.example.test', label: 'sam', selfHandle: 'sam',
  courierDid: 'did:key:z6MkSamCourier', ownerDid: SAM_OWNER, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, status: 'ready', peers: {},
});
const fakeNode = () => ({
  delegateTo: async (_did, entries, options) => {
    delegations.push({ entries, expiry: options.expiry });
    return { delegation: { cid: `cid-${delegations.length}`, expiry: new Date(NOW + 3600e3), delegationHeader: { Authorization: 'x' } } };
  },
});
const deps = (p, extra = {}) => ({ ctx: async () => ({ profile: p, node: fakeNode() }), links: standin.config, now: () => NOW, ...extra });

async function stdoutOf(promise) {
  const chunks = [];
  const log = console.log;
  console.log = (...parts) => chunks.push(parts.join(' '));
  try {
    await promise;
  } finally {
    console.log = log;
  }
  return chunks;
}

test('invite: the printed link is a courier link; the record keeps the per-invite key 0600; the service holds a record signed by that key and no address', async () => {
  const p = profile();
  const lines = await stdoutOf(cmdInvite(parseArgs(['hunter', '--email', EMAIL, '--ttl', '2h', '--tier', 'strict']), deps(p)));
  const link = lines.at(-1);
  assert.match(link, /^https:\/\/share\.links\.test\/c\/[a-z2-7]{26}#v=4&k=[A-Za-z0-9_-]{43}&c=bafkrei[a-z2-7]{52}$/);
  assert.equal(lines.filter((line) => line.includes('#v=4')).length, 1, 'printed once');

  const [record] = listRecords();
  assert.equal(fs.statSync(path.join(home, 'invites', `${record.inviteId}.json`)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(record.link).sort(), ['apiOrigin', 'cid', 'id', 'issuer', 'seed']);
  assert.match(record.link.seed, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(record.email, EMAIL, 'the owner\'s own record keeps the address');
  assert.equal(Object.hasOwn(record, 'store'), false);

  const [stored] = [...standin.records.values()];
  assert.equal(stored.header.type, 'courier');
  assert.equal(stored.header.issuer, record.link.issuer);
  assert.equal(Date.parse(stored.header.expiresAt) - NOW, 2 * 3600e3, 'the link lives exactly as long as --ttl');
  assert.equal(Buffer.from(stored.body).toString('latin1').includes(EMAIL), false);

  const opened = await resolveInviteLink(standin.config, link, NOW);
  assert.equal(opened.blob.inviteId, record.inviteId);
  assert.equal(opened.blob.issuer, record.link.issuer);
  assert.equal(opened.blob.expectEmailHash, inviteEmailHash(record.inviteId, EMAIL));
  assert.equal(opened.blobText.includes(record.link.seed), false);
  assert.ok(delegations.length === 3 && delegations.every((d) => d.expiry === '2h'), 'the node grants live as long as the link');
  for (const text of [...lines, JSON.stringify(p)]) assert.equal(text.includes(record.link.seed), false);
});

test('invite with no --ttl lives 24 h (from the courier link type), and each invite gets its own key', async () => {
  const p = profile();
  await stdoutOf(cmdInvite(parseArgs(['hunter', '--email', EMAIL]), deps(p)));
  await stdoutOf(cmdInvite(parseArgs(['other', '--email', EMAIL]), deps(p)));
  const records = [...standin.records.values()];
  assert.equal(records.length, 2);
  for (const stored of records) assert.equal(Date.parse(stored.header.expiresAt) - NOW, 24 * 3600e3);
  assert.notEqual(records[0].header.issuer, records[1].header.issuer);
  assert.ok(delegations.every((d) => d.expiry === '86400s'));
});

test('invite with a public dir writes the address hash and nothing of the key', async () => {
  const dir = path.join(home, 'public');
  const p = profile();
  await stdoutOf(cmdInvite(parseArgs(['hunter', '--email', EMAIL, '--invites-public-dir', dir]), deps(p)));
  const [record] = listRecords();
  const publicText = fs.readFileSync(path.join(dir, `${record.inviteId}.json`), 'utf8');
  const publicRecord = JSON.parse(publicText);
  assert.equal(publicRecord.expectEmailHash, inviteEmailHash(record.inviteId, EMAIL));
  for (const secret of [EMAIL, record.link.seed, record.link.issuer, record.link.id]) assert.equal(publicText.includes(secret), false);
  assert.equal(Object.hasOwn(publicRecord, 'expectEmail'), false);
});

test('invite whose link cannot be created leaves nothing behind: no peer, no record, no link', async () => {
  const p = profile();
  standin.fail(503);
  await assert.rejects(stdoutOf(cmdInvite(parseArgs(['hunter', '--email', EMAIL]), deps(p))), (e) => e.code === 'invite-unavailable');
  assert.deepEqual(p.peers, {});
  assert.deepEqual(listRecords(), []);
  assert.equal(standin.records.size, 0);
});

test('invite without COURIER_LINK_ORIGIN prints a link on the SDK\'s production viewer and records the API origin it was created on', async () => {
  const p = profile();
  const before = process.env.COURIER_LINK_ORIGIN;
  delete process.env.COURIER_LINK_ORIGIN;
  let lines;
  try {
    // The viewer comes from the environment-derived default; only the API (a loopback stand-in) is the test's.
    const links = { ...linksConfig({}), apiOrigin: standin.config.apiOrigin, fetch: standin.config.fetch };
    lines = await stdoutOf(cmdInvite(parseArgs(['hunter', '--email', EMAIL]), deps(p, { links })));
  } finally {
    if (before !== undefined) process.env.COURIER_LINK_ORIGIN = before;
  }
  assert.ok(lines.at(-1).startsWith(`${DEFAULT_SHARE_ORIGINS[0]}/c/`), lines.at(-1));
  const [record] = listRecords();
  assert.equal(record.link.apiOrigin, standin.config.apiOrigin);
});

test('revoke deletes the link with the key the record holds: gone at the service, revoked locally; a failed delete is logged without the key and the invite still closes', async () => {
  const p = profile();
  await stdoutOf(cmdInvite(parseArgs(['hunter', '--email', EMAIL]), deps(p)));
  const [record] = listRecords();
  assert.equal(standin.records.size, 1);
  const logs = [];
  const watcher = (deleteLink) => new InviteWatcher({ node: { kv: memoryKv() }, profile: () => p, log: (entry) => logs.push(entry), deleteLink, now: () => new Date(NOW) });

  standin.fail(503);
  await watcher((link) => deleteInviteLink(standin.config, link)).revoke(record);
  assert.equal(standin.records.size, 1, 'the delete failed: the link lives to its expiry');
  assert.equal(readRecord(record.inviteId).status, 'revoked', 'local state still closes');
  assert.ok(logs.some((entry) => entry.step === 'delete-link' && entry.reason === 'invite-unavailable'));
  for (const text of logs.map((entry) => JSON.stringify(entry))) assert.equal(text.includes(record.link.seed), false);

  // Deleted with the recorded seed: the stand-in's real verifyDelete accepted it.
  await deleteInviteLink(standin.config, record.link);
  assert.equal(standin.records.size, 0);
  assert.ok(standin.requests.some((r) => r.path.endsWith('/delete') && r.status === 204));
});
