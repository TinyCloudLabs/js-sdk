import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { inviteRecordsFor, storedRecord } from '../dist/invite-commands.js';
import { InviteWatcher, readRecord, recordPath } from '../dist/invite-watch.js';
import { inviteFolder } from '../dist/invite-schema.js';
import { newInviteId } from '../dist/invite-blob.js';
import { writeSecure } from '../dist/profile.js';
import { verifyEmailProofWithPin } from '../dist/verify-email-proof.js';
import { EMAIL_PROOF_PIN } from '../dist/credential-pin.js';
import { signPossession, oneTimeKeyHash } from '../dist/possession.js';
import { ed25519DidKey } from '../dist/did-key.js';
import { memoryKv } from './memory-kv.mjs';

// The REAL verifier (with a test issuer key) behind the REAL watcher. Only the node-side pairing call is a stub, and it records who it was asked to pair.
const NOW = Date.now();
const NOW_S = Math.floor(NOW / 1000);
const ISSUED = new Date(NOW).toISOString();
const SAM_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const ALICE_ADDR = '0xfedcba0987654321fedcba0987654321fedcba09';
const MALLORY_ADDR = `0x${'2'.repeat(40)}`;
const SAM_OWNER = `did:pkh:eip155:1:${SAM_ADDR}`;
const ALICE_OWNER = `did:pkh:eip155:1:${ALICE_ADDR}`;
const MALLORY_OWNER = `did:pkh:eip155:1:${MALLORY_ADDR}`;
const SAM_COURIER = 'did:key:z6MkSamCourier';
const EMAIL = 'alice@example.test';
const OTK_X = 'one-time-key-x-value';
const C_ARTIFACT = { type: 'courier-pair', v: 0, step: 'C', from: { owner: SAM_OWNER, courier: SAM_COURIER }, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, peer: 'alice', callMe: 'sam', delegation: 'DELEGATION-C', delegationExpiresAt: new Date(NOW + 3600e3).toISOString(), issuedAt: ISSUED };

const b64u = (value) => Buffer.from(value).toString('base64url');
function ed25519() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicJwk: publicKey.export({ format: 'jwk' }), privateJwk: privateKey.export({ format: 'jwk' }) };
}
const issuer = ed25519();
const alice = ed25519();
const mallory = ed25519();
const ALICE_COURIER = ed25519DidKey(alice.publicJwk.x);
const MALLORY_COURIER = ed25519DidKey(mallory.publicJwk.x);
const TEST_PIN = { ...EMAIL_PROOF_PIN, jwk: { kty: 'OKP', crv: 'Ed25519', x: issuer.publicJwk.x } };

function mintFor(sub, jti) {
  const disclosure = b64u(JSON.stringify(['salt-1', 'email', EMAIL]));
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'vc+sd-jwt', kid: TEST_PIN.kid }));
  const iat = NOW_S - 60;
  const payload = b64u(JSON.stringify({
    iss: TEST_PIN.issuerDid, sub, jti, iat, nbf: iat, exp: iat + 3600,
    vct: TEST_PIN.descriptor.format.vct, profile: TEST_PIN.descriptor.profile, profileVersion: 1,
    descriptorDigest: TEST_PIN.descriptorDigest,
    _sd_alg: 'sha-256', _sd: [b64u(createHash('sha256').update(disclosure).digest())],
    holderBinding: { did: sub, signingDomain: 'tinycloud.credentials/holder-binding/v1' },
  }));
  const signature = b64u(nodeSign(null, Buffer.from(`${header}.${payload}`), issuer.privateKey));
  return `${header}.${payload}.${signature}~${disclosure}~`;
}

let home;
let sentinel;
let saved;
let kv;
let accepted;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-holder-home-'));
  sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-holder-sentinel-'));
  saved = { COURIER_HOME: process.env.COURIER_HOME, HOME: process.env.HOME };
  process.env.COURIER_HOME = home;
  process.env.HOME = sentinel;
  kv = memoryKv();
  accepted = [];
});

afterEach(() => {
  for (const key of Object.keys(saved)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sentinel, { recursive: true, force: true });
});

function openInvite() {
  const inviteId = newInviteId();
  const { record } = inviteRecordsFor({
    inviteId, handle: 'alice', callMe: 'sam', expectEmail: EMAIL, tier: 'strict', expectOwner: null, alsoAsk: false,
    expiresAt: new Date(NOW + 24 * 3600e3), createdAt: ISSUED,
    store: { id: 'store-1', cid: 'bafkrei' + 'a'.repeat(52), deleteToken: 'DELETE-TOKEN-FIXTURE' },
    publicDir: undefined,
  });
  writeSecure(recordPath(inviteId), storedRecord(record, oneTimeKeyHash(OTK_X)));
  return inviteId;
}

/** A hello whose credential and possession belong to Alice's key, whatever artifact B names. */
async function helloNaming(inviteId, { courier, owner, label }) {
  const credential = mintFor(ALICE_COURIER, `cred-${inviteId}`);
  const possession = signPossession({ inviteId, oneTimeKeyX: OTK_X, credential }, alice.privateJwk, NOW);
  await kv.put(`${inviteFolder(inviteId)}in/hello.json`, {
    v: 1,
    inviteId,
    artifactB: {
      type: 'courier-pair', v: 0, step: 'B',
      from: { owner, courier },
      spaceId: `tinycloud:pkh:eip155:1:${owner.split(':').pop()}:agents`,
      peer: 'sam', callMe: 'alice', delegation: 'DELEGATION-B', delegationExpiresAt: new Date(NOW + 3600e3).toISOString(), issuedAt: ISSUED,
    },
    claimedLabel: label,
    sentAt: ISSUED,
    credential,
    possession,
  });
}

function watcher() {
  return new InviteWatcher({
    node: { kv },
    profile: () => ({ version: 3, host: 'https://openkey.example.test', openkeyHost: 'https://openkey.example.test', label: 'sam', courierDid: SAM_COURIER, ownerDid: SAM_OWNER, spaceId: `tinycloud:pkh:eip155:1:${SAM_ADDR}:agents`, status: 'ready', peers: {} }),
    log: () => undefined,
    notify: async () => undefined,
    now: () => new Date(NOW),
    verify: (input) => verifyEmailProofWithPin(input, TEST_PIN),
    accept: async (_profile, _node, artifact) => { accepted.push(artifact.from.courier); return C_ARTIFACT; },
    deleteSealed: async () => undefined,
  });
}

const welcomeOf = (id) => kv.rows.get(`${inviteFolder(id)}out/welcome.json`)?.value;

test('control: a hello whose artifact B names the credential holder pairs that holder', async () => {
  const id = openInvite();
  await helloNaming(id, { courier: ALICE_COURIER, owner: ALICE_OWNER, label: 'Alice' });
  await watcher().onHello(id);
  assert.equal(readRecord(id).status, 'completed');
  assert.deepEqual(accepted, [ALICE_COURIER]);
});

test("Alice's credential and possession with Mallory's artifact B never pair Mallory", async () => {
  const id = openInvite();
  await helloNaming(id, { courier: MALLORY_COURIER, owner: MALLORY_OWNER, label: 'Alice' });
  await watcher().onHello(id);
  const record = readRecord(id);
  assert.equal(record.status, 'held');
  assert.equal(record.held.reason, 'holder-mismatch');
  assert.equal(record.completedPeer, undefined);
  assert.equal(record.artifactC, undefined);
  assert.deepEqual(accepted, []);
  assert.equal(welcomeOf(id), undefined);
});
