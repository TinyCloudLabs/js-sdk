// Helpers for tests that plant a structurally real stored credential record under a throwaway COURIER_HOME.
// The record is stub-issued: only a stand-in verifier (or the node-sdk witness seam) can accept it.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { StoredCredentialSource } from '../../dist/credential-source.js';
import { DEFAULT_EMAIL_PROOF_PROFILE, EMAIL_PROOF_CREDENTIAL_TYPE, emailProofRequirement } from '@tinycloud/node-sdk/credentials';
import { credentialRequirementDigest } from '@tinycloud/sdk-core';

export const ADDRESS = 'qa.owner@example.test';
export const requirement = emailProofRequirement(ADDRESS);
export const requirementDigest = () => credentialRequirementDigest(requirement);

const fixture = JSON.parse(
  readFileSync(new URL('../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json', import.meta.url), 'utf8'),
);
export const pinned = fixture.vectors[0];

const b64u = (text) => Buffer.from(text).toString('base64url');

/** A structurally real SD-JWT: header.payload.signature~disclosure~. The signature bytes are arbitrary. */
export function sdJwt(holderDid, nowMs) {
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'vc+sd-jwt', kid: 'issuer-key-1' }));
  const payload = b64u(JSON.stringify({ iss: 'did:web:issuer.example', sub: holderDid, iat: Math.floor(nowMs / 1000) - 5, exp: Math.floor(nowMs / 1000) + 3600 }));
  const signature = Buffer.alloc(64, 7).toString('base64url');
  return `${header}.${payload}.${signature}~${b64u(JSON.stringify(['salt', 'email', ADDRESS]))}~`;
}

/** An issued result as `StoredCredentialSource.store` persists it: issued 5 s before `nowMs`, valid for 3600 s after it. */
export function resultFor(holderDid, nowMs) {
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

const homes = [];
/** A fresh throwaway home under /var/tmp, removed by `removeHomes`. */
export function freshHome() {
  const home = mkdtempSync(join('/var/tmp', 'courier-stored-'));
  homes.push(home);
  return home;
}
export function removeHomes() {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
}

export const credentialFilesIn = (home) => {
  const dir = join(home, 'credentials');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('credential-')) : [];
};

/** Stores a stub-issued record (store-time verify stood in) and returns its file path and parsed content. */
export async function storedRecord(home, holder, nowMs) {
  await new StoredCredentialSource(home, async () => {}).store({
    result: resultFor(holder.bare, nowMs),
    requirement,
    requirementDigest: await requirementDigest(),
    holderDid: holder.bare,
    now: new Date(nowMs),
  });
  const [name] = credentialFilesIn(home);
  const file = join(home, 'credentials', name);
  return { file, original: JSON.parse(readFileSync(file, 'utf8')) };
}
