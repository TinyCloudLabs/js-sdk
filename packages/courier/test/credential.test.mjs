import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../dist/args.js';
import { cmdCredential } from '../dist/credential.js';
import { DEFAULT_EMAIL_PROOF_PROFILE, EMAIL_PROOF_CREDENTIAL_TYPE } from '@tinycloud/node-sdk/credentials';
import { generateHolderKey, makeWitness } from './support/witness-stub.mjs';

const ADDRESS = 'qa.owner@example.test';
const SECRET_CREDENTIAL = 'SECRET-SD-JWT~disclosure~';

const freshHome = () => mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'courier-cred-test-'));
const credDir = (home) => join(home, 'credentials');
const modeOf = (p) => statSync(p).mode & 0o777;
const pendingFiles = (home) => readdirSync(credDir(home)).filter((f) => f.startsWith('pending-'));
const credentialFiles = (home) => readdirSync(credDir(home)).filter((f) => f.startsWith('credential-'));

/** A fresh Courier agent key: private JWK plus the bare did:key the store and witness use. */
function identity() {
  const holder = generateHolderKey();
  return {
    holder,
    loadKey: () => ({ v: 1, jwk: holder.jwk, did: holder.bare, createdAt: '2026-10-20T10:00:00Z' }),
  };
}

function runner(home, deps = {}) {
  const out = [];
  return {
    out: () => out.join(''),
    run: (argv) => cmdCredential(parseArgs(argv), { home, out: (text) => out.push(text), ...deps }),
  };
}

/**
 * Stand-in for a witness-verified result. The stub witness cannot pass the production
 * descriptor pins, so the success path substitutes the verification step only.
 */
function issuedResult(holderDid, now = new Date()) {
  const issuedAt = new Date(now.getTime() - 5_000).toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
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
    issuedAt,
    notBefore: issuedAt,
    expiresAt,
    status: { method: 'none', freshnessSeconds: 300 },
    credential: SECRET_CREDENTIAL,
    verifiedAt: now.toISOString(),
    credentialDigest: 'e'.repeat(64),
    statusCheckedAt: now.toISOString(),
  };
  return { envelope: verified, verified, credentialId: 'cred-1', issuedAt, expiresAt };
}

test('step 1 stores one owner-only pending request and prints no code, verifier, or request id', async () => {
  const home = freshHome();
  const { loadKey } = identity();
  const witness = makeWitness();
  const r = runner(home, { loadKey, fetch: witness.fetch });
  await r.run(['acquire', '--email', ADDRESS]);
  const [requestId] = witness.reqs.keys();

  assert.equal(modeOf(credDir(home)), 0o700);
  const files = pendingFiles(home);
  assert.equal(files.length, 1);
  assert.equal(modeOf(join(credDir(home), files[0])), 0o600);
  assert.match(r.out(), /Verification code sent to qa\.owner@example\.test/);
  assert.ok(!r.out().includes(requestId), 'request id must not be printed');
});

test('step 2 stores the credential, deletes the pending request, and show never prints the SD-JWT', async () => {
  const home = freshHome();
  const { holder, loadKey } = identity();
  const witness = makeWitness();
  await runner(home, { loadKey, fetch: witness.fetch }).run(['acquire', '--email', ADDRESS]);

  const seen = {};
  const acquire = runner(home, {
    loadKey,
    fetch: witness.fetch,
    readStdinLine: async () => witness.code,
    completeProof: async (input) => {
      seen.requestId = input.pending.requestId;
      seen.code = input.code;
      seen.holderDid = input.holder.did;
      return issuedResult(holder.bare);
    },
  });
  await acquire.run(['acquire', '--email', ADDRESS, '--code-stdin']);

  assert.deepEqual([...witness.reqs.keys()], [seen.requestId]);
  assert.equal(seen.code, witness.code);
  assert.equal(seen.holderDid, holder.bare);
  assert.match(acquire.out(), /Email credential stored for qa\.owner@example\.test/);
  assert.equal(pendingFiles(home).length, 0);
  assert.equal(credentialFiles(home).length, 1);
  assert.ok(!acquire.out().includes(SECRET_CREDENTIAL));

  const show = runner(home, { loadKey });
  await show.run(['show', '--email', ADDRESS]);
  assert.match(show.out(), /email: qa\.owner@example\.test/);
  assert.match(show.out(), /credentialId: cred-1/);
  assert.match(show.out(), /status: none/);
  assert.ok(!show.out().includes(SECRET_CREDENTIAL), 'show must not print the SD-JWT');
});

test('a code that is not 8 digits is rejected before any network or store access', async () => {
  const home = freshHome();
  const { loadKey } = identity();
  let networkUsed = false;
  const r = runner(home, {
    loadKey,
    fetch: async () => {
      networkUsed = true;
      throw new Error('network must not be used');
    },
    readStdinLine: async () => '1234',
  });
  await assert.rejects(r.run(['acquire', '--email', ADDRESS, '--code-stdin']), { code: 'credential.code.CODE_INVALID' });
  assert.equal(networkUsed, false);
  assert.equal(existsSync(credDir(home)), false);
});

test('--code and --code-stdin together are a usage error', async () => {
  const home = freshHome();
  const { loadKey } = identity();
  const r = runner(home, { loadKey });
  await assert.rejects(r.run(['acquire', '--email', ADDRESS, '--code', '12345678', '--code-stdin']), { code: 'usage' });
});

test('a wrong code keeps the pending request for retry and says so', async () => {
  const home = freshHome();
  const { loadKey } = identity();
  const witness = makeWitness();
  await runner(home, { loadKey, fetch: witness.fetch }).run(['acquire', '--email', ADDRESS]);

  const retry = runner(home, { loadKey, fetch: witness.fetch, readStdinLine: async () => '00000000' });
  await assert.rejects(retry.run(['acquire', '--email', ADDRESS, '--code-stdin']), (error) => {
    assert.match(error.message, /Retry with --code-stdin before/);
    return true;
  });
  assert.equal(pendingFiles(home).length, 1);
});

test('the last allowed wrong code deletes the pending request', async () => {
  const home = freshHome();
  const { loadKey } = identity();
  const witness = makeWitness({ maxAttempts: 1 });
  await runner(home, { loadKey, fetch: witness.fetch }).run(['acquire', '--email', ADDRESS]);

  const last = runner(home, { loadKey, fetch: witness.fetch, readStdinLine: async () => '00000000' });
  await assert.rejects(last.run(['acquire', '--email', ADDRESS, '--code-stdin']));
  assert.equal(pendingFiles(home).length, 0);

  const after = runner(home, { loadKey, fetch: witness.fetch, readStdinLine: async () => witness.code });
  await assert.rejects(after.run(['acquire', '--email', ADDRESS, '--code-stdin']), { code: 'credential-request-missing' });
});

test('a code entered under a different agent key is refused and the pending request is deleted', async () => {
  const home = freshHome();
  const first = identity();
  const second = identity();
  const witness = makeWitness();
  await runner(home, { loadKey: first.loadKey, fetch: witness.fetch }).run(['acquire', '--email', ADDRESS]);

  const other = runner(home, {
    loadKey: second.loadKey,
    readStdinLine: async () => witness.code,
    completeProof: async () => {
      throw new Error('the witness must not be reached for another holder');
    },
  });
  await assert.rejects(other.run(['acquire', '--email', ADDRESS, '--code-stdin']), { code: 'credential.session.SESSION_INVALID' });
  assert.equal(pendingFiles(home).length, 0);
});

test('a new step 1 replaces the live pending request for the same address', async () => {
  const home = freshHome();
  const { loadKey } = identity();
  const witness = makeWitness();
  const r = runner(home, { loadKey, fetch: witness.fetch });
  await r.run(['acquire', '--email', ADDRESS]);
  await r.run(['acquire', '--email', ADDRESS]);
  assert.equal(witness.reqs.size, 2);
  assert.equal(pendingFiles(home).length, 1);
});

test('show reports NOT_FOUND with the acquire hint when nothing is stored', async () => {
  const home = freshHome();
  const { loadKey } = identity();
  await assert.rejects(runner(home, { loadKey }).run(['show', '--email', ADDRESS]), { code: 'credential.show.NOT_FOUND' });
});

test('show refuses a credentials directory that is not owner-only', async () => {
  const home = freshHome();
  const { loadKey } = identity();
  mkdirSync(credDir(home));
  chmodSync(credDir(home), 0o755);
  await assert.rejects(runner(home, { loadKey }).run(['show', '--email', ADDRESS]), { code: 'credential-permissions' });
});

test('missing --email and unknown subcommands are usage errors', async () => {
  const home = freshHome();
  const { loadKey } = identity();
  const r = runner(home, { loadKey });
  await assert.rejects(r.run(['acquire']), { code: 'usage' });
  await assert.rejects(r.run(['show']), { code: 'usage' });
  await assert.rejects(r.run(['rotate']), { code: 'usage' });
});
