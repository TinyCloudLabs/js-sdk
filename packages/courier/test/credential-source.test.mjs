import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { StoredCredentialSource } from '../dist/credential-source.js';
import { parseArgs } from '../dist/args.js';
import { cmdCredential } from '../dist/credential.js';
import { profileDir } from '../dist/profile.js';
import { DEFAULT_EMAIL_PROOF_PROFILE, EMAIL_PROOF_CREDENTIAL_TYPE, emailProofRequirement } from '@tinycloud/node-sdk/credentials';
import { credentialRequirementDigest } from '@tinycloud/sdk-core';
import { generateHolderKey, makeWitness } from './support/witness-stub.mjs';

const ADDRESS = 'qa.owner@example.test';
const T0 = new Date('2026-10-20T10:00:00Z');
const requirement = emailProofRequirement(ADDRESS);
const digest = () => credentialRequirementDigest(requirement);

const freshHome = () => mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'courier-store-test-'));
const credentialFilesIn = (home) => {
  const dir = join(home, 'credentials');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('credential-')) : [];
};

/** Stand-in for the offline re-verify, used only where the test is about expiry or freshness rules. */
const acceptStandIn = async () => {};

/** A verified-result shape that `StoredCredentialSource.store` can persist. Lifetimes are set per test. */
function resultFor(holderDid, issuedAt, expiresAt) {
  const issued = issuedAt.toISOString();
  const verified = {
    type: 'OpenCredentialsIssuedCredential',
    version: 1,
    protocol: 'tinycloud.credentials/acquisition/v1',
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
    descriptorDigest: 'd'.repeat(64),
    credentialId: 'cred-1',
    issuedAt: issued,
    notBefore: issued,
    expiresAt: expiresAt.toISOString(),
    status: { method: 'none', freshnessSeconds: 300 },
    credential: 'SECRET-SD-JWT~disclosure~',
    verifiedAt: issued,
    credentialDigest: 'e'.repeat(64),
    statusCheckedAt: issued,
  };
  return { envelope: verified, verified, credentialId: 'cred-1', issuedAt: issued, expiresAt: expiresAt.toISOString() };
}

const ms = (base, delta) => new Date(base.getTime() + delta);

test('find keeps a credential with more than 60 s of its exp left and drops one with less', async () => {
  const home = freshHome();
  const holder = generateHolderKey();
  const expiresAt = ms(T0, 3_600_000);
  const source = new StoredCredentialSource(home, acceptStandIn);
  await source.store({ result: resultFor(holder.bare, ms(T0, -5_000), expiresAt), requirement, requirementDigest: await digest(), holderDid: holder.bare, now: T0 });

  const kept = await source.find({ requirement, requirementDigest: await digest(), holderDid: holder.bare, now: ms(expiresAt, -61_000) });
  assert.ok(kept, 'credential with 61 s left must be returned');

  const dropped = await source.find({ requirement, requirementDigest: await digest(), holderDid: holder.bare, now: ms(expiresAt, -59_000) });
  assert.equal(dropped, undefined, 'credential with 59 s left must not be returned');
  assert.equal(credentialFilesIn(home).length, 0, 'a credential inside the margin is deleted');
});

test('find honours the 3600 s freshness window on issuedAt: a record issued 3599 s ago is kept, 3601 s ago is dropped', async () => {
  const holder = generateHolderKey();
  const expiresAt = ms(T0, 2 * 3_600_000);

  const freshHome_ = freshHome();
  const fresh = new StoredCredentialSource(freshHome_, acceptStandIn);
  await fresh.store({ result: resultFor(holder.bare, ms(T0, -3_599_000), expiresAt), requirement, requirementDigest: await digest(), holderDid: holder.bare, now: T0 });
  assert.ok(await fresh.find({ requirement, requirementDigest: await digest(), holderDid: holder.bare, now: T0 }), 'record issued 3599 s ago must be returned');

  const staleHome = freshHome();
  const stale = new StoredCredentialSource(staleHome, acceptStandIn);
  await stale.store({ result: resultFor(holder.bare, ms(T0, -3_601_000), expiresAt), requirement, requirementDigest: await digest(), holderDid: holder.bare, now: T0 });
  assert.equal(await stale.find({ requirement, requirementDigest: await digest(), holderDid: holder.bare, now: T0 }), undefined, 'record issued 3601 s ago must not be returned');
  assert.equal(credentialFilesIn(staleHome).length, 0, 'a stale record is deleted');
});

test('store refuses a record the real offline verifier rejects, and writes nothing', async () => {
  const home = freshHome();
  const holder = generateHolderKey();
  const source = new StoredCredentialSource(home);
  await assert.rejects(
    source.store({ result: resultFor(holder.bare, ms(T0, -5_000), ms(T0, 3_600_000)), requirement, requirementDigest: await digest(), holderDid: holder.bare, now: T0 }),
    { code: 'credential-record-invalid' },
  );
  assert.equal(credentialFilesIn(home).length, 0);
});

test('find refuses a planted record the real offline verifier rejects, and does not delete it', async () => {
  const home = freshHome();
  const holder = generateHolderKey();
  await new StoredCredentialSource(home, acceptStandIn).store({
    result: resultFor(holder.bare, ms(T0, -5_000), ms(T0, 3_600_000)),
    requirement,
    requirementDigest: await digest(),
    holderDid: holder.bare,
    now: T0,
  });
  await assert.rejects(
    new StoredCredentialSource(home).find({ requirement, requirementDigest: await digest(), holderDid: holder.bare, now: T0 }),
    { code: 'credential-record-invalid' },
  );
  assert.equal(credentialFilesIn(home).length, 1, 'a refused record is kept for inspection, not deleted');
});

test('a symlinked credentials directory is refused and its target is never chmodded', async () => {
  const home = freshHome();
  const target = mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'courier-store-target-'));
  chmodSync(target, 0o755);
  symlinkSync(target, join(home, 'credentials'));
  const holder = generateHolderKey();
  await assert.rejects(
    new StoredCredentialSource(home, acceptStandIn).find({ requirement, requirementDigest: await digest(), holderDid: holder.bare, now: T0 }),
    { code: 'credential-permissions' },
  );
  assert.equal(statSync(target).mode & 0o777, 0o755, 'the symlink target keeps its mode');
  rmSync(target, { recursive: true, force: true });
});

test('profileDir refuses to guess a home when HOME and COURIER_HOME are both unset', () => {
  const saved = { HOME: process.env.HOME, COURIER_HOME: process.env.COURIER_HOME };
  try {
    delete process.env.HOME;
    delete process.env.COURIER_HOME;
    assert.throws(() => profileDir(), { code: 'home-unset' });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('acquire step 2 deletes the pending request when the store refuses the record', async () => {
  const home = freshHome();
  const holder = generateHolderKey();
  const loadKey = () => ({ v: 1, jwk: holder.jwk, did: holder.bare, createdAt: '2026-10-20T10:00:00Z' });
  const witness = makeWitness();
  const base = { home, loadKey, fetch: witness.fetch, out: () => {}, err: () => {} };
  await cmdCredential(parseArgs(['acquire', '--email', ADDRESS]), base);
  await assert.rejects(
    cmdCredential(parseArgs(['acquire', '--email', ADDRESS, '--code-stdin']), {
      ...base,
      readStdinLine: async () => '12345678',
      completeProof: async () => resultFor(holder.bare, ms(T0, -5_000), ms(T0, 3_600_000)),
    }),
    { code: 'credential-record-invalid' },
  );
  const pending = readdirSync(join(home, 'credentials')).filter((f) => f.startsWith('pending-'));
  assert.equal(pending.length, 0, 'the spent pending request is deleted even though the record was refused');
});
