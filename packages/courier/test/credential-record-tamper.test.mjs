// Courier-side tamper tests for stored credentials. Stored envelope fields are untrusted hints:
// `StoredCredentialSource.find` re-verifies the on-disk record, a tampered record is refused with
// `credential-record-invalid`, the file is kept byte-identical, and `courier credential show` prints
// no credential bytes. Field-by-field verifier coverage lives in node-sdk `stored-tamper.test.ts`;
// the pinned issuer keys cannot accept a stub-issued record, so here the stand-in verifier accepts
// exactly the original record and the real verifier covers the production refusal path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoredCredentialSource } from '../dist/credential-source.js';
import { DEFAULT_EMAIL_PROOF_PROFILE, EMAIL_PROOF_CREDENTIAL_TYPE, emailProofRequirement } from '@tinycloud/node-sdk/credentials';
import { credentialRequirementDigest } from '@tinycloud/sdk-core';
import { generateHolderKey } from './support/witness-stub.mjs';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const ADDRESS = 'qa.owner@example.test';
const requirement = emailProofRequirement(ADDRESS);
const fixture = JSON.parse(
  readFileSync(new URL('../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json', import.meta.url), 'utf8'),
);
const pinned = fixture.vectors[0];
const otherDescriptor = fixture.vectors[1].descriptor;

const b64u = (text) => Buffer.from(text).toString('base64url');

/** A structurally real SD-JWT: header.payload.signature~disclosure~. The signature bytes are arbitrary; only the real verifier would judge them. */
function sdJwt(holderDid, nowMs) {
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'vc+sd-jwt', kid: 'issuer-key-1' }));
  const payload = b64u(JSON.stringify({ iss: 'did:web:issuer.example', sub: holderDid, iat: Math.floor(nowMs / 1000) - 5, exp: Math.floor(nowMs / 1000) + 3600 }));
  const signature = Buffer.alloc(64, 7).toString('base64url');
  return `${header}.${payload}.${signature}~${b64u(JSON.stringify(['salt', 'email', ADDRESS]))}~`;
}

function resultFor(holderDid, nowMs) {
  const issued = new Date(nowMs - 5_000).toISOString();
  const expires = new Date(nowMs + 3_600_000).toISOString();
  const verified = {
    type: 'OpenCredentialsIssuedCredential',
    version: 1,
    protocol: pinned.descriptor.protocol,
    profile: { id: DEFAULT_EMAIL_PROOF_PROFILE, version: 1 },
    credentialType: EMAIL_PROOF_CREDENTIAL_TYPE,
    schema: 'schema-digest',
    format: 'vc+sd-jwt',
    issuerDid: 'did:web:issuer.example',
    issuerKid: 'issuer-key-1',
    subjectDid: holderDid,
    holderDid,
    claims: { email: ADDRESS },
    claimsDigest: 'c'.repeat(64),
    descriptorDigest: pinned.digest,
    credentialId: 'cred-1',
    issuedAt: issued,
    notBefore: issued,
    expiresAt: expires,
    status: { method: 'none', freshnessSeconds: 300 },
    credential: sdJwt(holderDid, nowMs),
    verifiedAt: issued,
    credentialDigest: 'e'.repeat(64),
    statusCheckedAt: issued,
  };
  return { envelope: verified, verified, descriptor: pinned.descriptor, credentialId: 'cred-1', issuedAt: issued, expiresAt: expires };
}

const swapCharAt = (text, i) => text.slice(0, i) + (text[i] === 'A' ? 'B' : 'A') + text.slice(i + 1);

/** Each edit keeps the record inside its lifecycle window, so only the verifier can refuse it. */
const tampers = [
  { name: 'profile id is changed', field: 'profile', mutate: (r) => ({ ...r, profile: { ...r.profile, id: 'tinycloud.email-domain-proof/v1' } }) },
  { name: 'descriptor.format is replaced as a whole object', field: 'descriptor', mutate: (r) => ({ ...r, descriptor: { ...r.descriptor, format: { type: 'jwt_vc_json', vct: 'opencredentials.other/v1', alg: ['ES256'] } } }) },
  { name: 'descriptor lifecycle is edited', field: 'descriptor', mutate: (r) => ({ ...r, descriptor: { ...r.descriptor, lifecycle: { ...r.descriptor.lifecycle, tampered: true } } }) },
  { name: 'a different profile descriptor is swapped in whole', field: 'descriptor', mutate: (r) => ({ ...r, descriptor: otherDescriptor }) },
  { name: 'one byte of the SD-JWT header is flipped', field: 'credential', mutate: (r) => ({ ...r, credential: swapCharAt(r.credential, 10) }) },
  { name: 'one byte of the SD-JWT signature is flipped', field: 'credential', mutate: (r) => ({ ...r, credential: swapCharAt(r.credential, r.credential.split('~')[0].lastIndexOf('.') + 5) }) },
];

const tempRoot = '/var/tmp';
const homes = [];
function freshHome() {
  const home = mkdtempSync(join(tempRoot, 'courier-tamper-'));
  homes.push(home);
  return home;
}
test.after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

const credentialFilesIn = (home) => {
  const dir = join(home, 'credentials');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('credential-')) : [];
};

/** Stores a stub-issued record (store-time verify stood in), returns the file path and the original parsed record. */
async function storedRecord(home, holder, nowMs) {
  const accept = async () => {};
  await new StoredCredentialSource(home, accept).store({
    result: resultFor(holder.bare, nowMs),
    requirement,
    requirementDigest: await credentialRequirementDigest(requirement),
    holderDid: holder.bare,
    now: new Date(nowMs),
  });
  const [name] = credentialFilesIn(home);
  const file = join(home, 'credentials', name);
  return { file, original: JSON.parse(readFileSync(file, 'utf8')) };
}

/** Accepts only the untouched original record, so any edit to any field is a refusal caused by that edit. */
const acceptOnly = (original) => async (input) => {
  assert.deepEqual(input.record, original, 'record differs from the original');
};

for (const tamper of tampers) {
  test(`find refuses and keeps a stored record whose ${tamper.name}`, async () => {
    const home = freshHome();
    const holder = generateHolderKey();
    const nowMs = Date.now();
    const now = new Date(nowMs);
    const { file, original } = await storedRecord(home, holder, nowMs);
    const digest = await credentialRequirementDigest(requirement);
    const findWith = (source) => source.find({ requirement, requirementDigest: digest, holderDid: holder.bare, now });

    // Control: the stand-in accepts the untouched record, so the refusals below come from the edit.
    assert.deepEqual(await findWith(new StoredCredentialSource(home, acceptOnly(original))), original);

    writeFileSync(file, JSON.stringify(tamper.mutate(original), null, 2) + '\n');
    const before = readFileSync(file);
    const tampered = JSON.parse(before.toString('utf8'));
    assert.notDeepEqual(tampered[tamper.field], original[tamper.field], 'the edit must change the field');

    // The record handed to the verifier is the on-disk record, edit included.
    const seen = [];
    const spy = async (input) => { seen.push(input.record); await acceptOnly(original)(input); };
    await assert.rejects(findWith(new StoredCredentialSource(home, spy)), { code: 'credential-record-invalid' });
    assert.deepEqual(seen, [tampered]);

    // The production verifier (pinned issuer keys) refuses it too.
    await assert.rejects(findWith(new StoredCredentialSource(home)), { code: 'credential-record-invalid' });

    assert.ok(existsSync(file), 'a refused record is kept');
    assert.equal(credentialFilesIn(home).length, 1);
    assert.ok(readFileSync(file).equals(before), 'a refused record is byte-identical');
  });

  test(`courier credential show refuses a stored record whose ${tamper.name}, keeps it, and prints no credential bytes`, async () => {
    const home = freshHome();
    chmodSync(home, 0o700);
    const holder = generateHolderKey();
    const nowMs = Date.now();
    const { file, original } = await storedRecord(home, holder, nowMs);
    writeFileSync(join(home, 'key.json'), JSON.stringify({ v: 1, jwk: holder.jwk, did: holder.bare, createdAt: new Date(nowMs).toISOString() }), { mode: 0o600 });
    writeFileSync(file, JSON.stringify(tamper.mutate(original), null, 2) + '\n');
    const before = readFileSync(file);
    const tampered = JSON.parse(before.toString('utf8'));

    const run = spawnSync(process.execPath, [CLI, 'credential', 'show', '--email', ADDRESS], {
      env: { PATH: process.env.PATH, HOME: home, COURIER_HOME: home },
      encoding: 'utf8',
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.notEqual(run.status, 0, output);
    assert.match(run.stderr, /\[credential-record-invalid\]/);
    assert.ok(existsSync(file), 'a refused record is kept');
    assert.ok(readFileSync(file).equals(before), 'a refused record is byte-identical');
    for (const secret of [original.credential.slice(0, 40), tampered.credential.slice(0, 40), original.credential, tampered.credential, original.subjectDid, tampered.subjectDid]) {
      assert.ok(!output.includes(secret), 'output must not contain any part of the credential');
    }
    assert.equal(run.stdout, '', 'a refused show writes nothing to stdout');
  });
}
