// Fake OpenCredentials witness as a fetch stub for courier flow tests.
// Serves the acquisition endpoint set, verifies the Ed25519 holder signature and
// kid, and issues an SD-JWT signed by a per-stub issuer key. node:crypto only.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import { canonicalDigest, holderBindingCanonicalBytes, holderBindingSigningBytes } from '@tinycloud/sdk-core';

const fixture = JSON.parse(
  fs.readFileSync(new URL('../../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json', import.meta.url), 'utf8'),
);
const DESCRIPTOR = fixture.vectors[0].descriptor;
const DESCRIPTOR_DIGEST = fixture.vectors[0].digest;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const sha = (text) => createHash('sha256').update(text).digest('base64url');

function b58encode(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let text = '';
  while (n > 0n) { text = B58[Number(n % 58n)] + text; n /= 58n; }
  return text;
}

function b58decode(text) {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(B58.indexOf(c));
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
}

function holderPublicKey(did) {
  const multibase = did.replace('did:key:', '').split('#')[0];
  const raw = b58decode(multibase.slice(1));
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw.subarray(2)) }, format: 'jwk' });
}

/** Fresh Ed25519 holder key as Courier stores it: private JWK plus its bare did:key. */
export function generateHolderKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicRaw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const bare = `did:key:z${b58encode(Buffer.concat([Buffer.from([0xed, 0x01]), publicRaw]))}`;
  return { jwk: privateKey.export({ format: 'jwk' }), bare };
}

export function makeWitness(opts = {}) {
  const issuer = generateKeyPairSync('ed25519');
  const code = opts.code ?? '12345678';
  const maxAttempts = opts.maxAttempts ?? 5;
  const reqs = new Map();
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const failure = (status, name, recoverable, state) =>
    json({ code: name, recoverable, state, correlationId: 'corr-1', type: 'tinycloud.credentials/error/v1' }, status);

  async function fetchStub(input, init = {}) {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    const method = init.method ?? 'GET';
    const auth = init.headers?.authorization;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const path = url.pathname;

    if (path === '/.well-known/opencredentials') {
      return json({
        type: 'tinycloud.credentials/catalog/v1',
        protocol: 'tinycloud.credentials/acquisition/v1',
        catalogVersion: 1,
        profiles: [{ supported: true, enabled: true, readiness: 'ready', descriptor: DESCRIPTOR, descriptorDigest: DESCRIPTOR_DIGEST }],
      });
    }
    if (path === '/v1/acquisitions' && method === 'POST') {
      const id = b64u(randomBytes(24));
      reqs.set(id, { id, state: 'challenge_required', attempts: 0, create: body });
      return json({
        type: 'tinycloud.credentials/acquisition-request/v1',
        protocol: DESCRIPTOR.protocol,
        requestId: id,
        next: 'challenge',
        endpoint: 'challenge',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    }

    const match = /^\/v1\/acquisitions\/([^/]+)\/(state|challenge|proof|holder-binding|holder-signature|issue|result)$/.exec(path);
    if (!match) return new Response('not found', { status: 404 });
    const r = reqs.get(decodeURIComponent(match[1]));
    const endpoint = match[2];
    if (!r) return new Response('{}', { status: 404 });
    if (auth !== undefined && sha(auth.replace(/^Bearer /, '')) !== r.create.completionVerifierChallenge) {
      return new Response('{}', { status: 403 });
    }

    if (endpoint === 'state') {
      return json({
        type: 'tinycloud.credentials/acquisition-state/v1',
        requestId: r.id,
        profile: DESCRIPTOR.profile,
        profileVersion: 1,
        state: r.state,
        ...(r.state === 'proof_required' ? { challengeNonce: r.nonce } : {}),
      });
    }
    if (endpoint === 'challenge') {
      r.nonce = b64u(randomBytes(24));
      r.state = 'proof_required';
      return json({ type: 'tinycloud.credentials/challenge/v1', step: 'mailbox_otp', stepVersion: 1, challengeNonce: r.nonce });
    }
    if (endpoint === 'proof') {
      if (['issued', 'holder_binding_required', 'ready_to_issue'].includes(r.state)) return failure(409, 'REQUEST_SUBSTITUTED', false, r.state);
      if (body.proof?.otp === code) {
        r.state = 'holder_binding_required';
        return new Response(null, { status: 204 });
      }
      r.attempts += 1;
      return r.attempts >= maxAttempts
        ? failure(400, 'PROOF_REJECTED', false, 'proof_attempts_exhausted')
        : failure(400, 'PROOF_REJECTED', true, 'proof_required');
    }
    if (endpoint === 'holder-binding') {
      const now = new Date();
      r.binding = {
        type: 'tinycloud.credentials/holder-binding/v1',
        protocol: DESCRIPTOR.protocol,
        requestId: r.id,
        profile: DESCRIPTOR.profile,
        profileVersion: 1,
        descriptorDigest: DESCRIPTOR_DIGEST,
        requirementDigest: r.create.requirementDigest,
        issuer: DESCRIPTOR.issuer.did,
        issuerKid: DESCRIPTOR.issuer.kid,
        holderDid: r.create.holderDid,
        normalizedClaimsDigest: await canonicalDigest(r.create.inputs),
        challengeNonce: r.nonce,
        audience: 'tinycloud://credentials',
        openerOrigin: r.create.openerOrigin,
        completionOrigin: r.create.openerOrigin,
        completionContext: 'sdk-acquisition',
        jti: b64u(randomBytes(18)),
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      };
      return json({
        type: 'tinycloud.credentials/holder-binding-request/v1',
        signingDomain: 'tinycloud.credentials/holder-binding/v1',
        alg: 'EdDSA',
        canonical: b64u(holderBindingCanonicalBytes(r.binding)),
        binding: r.binding,
      });
    }
    if (endpoint === 'holder-signature') {
      const holder = r.create.holderDid;
      const kidOk = body.kid === `${holder}#${holder.replace('did:key:', '')}`;
      const sigOk = verify(null, holderBindingSigningBytes(r.binding), holderPublicKey(holder), Buffer.from(body.signature, 'base64url'));
      if (!sigOk || !kidOk) return failure(400, 'SIGNATURE_REJECTED', false, 'holder_signature_required');
      r.state = 'ready_to_issue';
      return new Response(null, { status: 204 });
    }
    if (endpoint === 'issue') {
      r.state = 'issued';
      return new Response(null, { status: 204 });
    }
    if (endpoint === 'result') {
      const email = r.create.inputs.email;
      const holder = r.create.holderDid;
      const nowS = Math.floor(Date.now() / 1000);
      const disclosure = b64u(JSON.stringify(['salt', 'email', email]));
      const payload = {
        iss: DESCRIPTOR.issuer.did,
        sub: holder,
        iat: nowS - 5,
        nbf: nowS - 5,
        exp: nowS + 3600,
        jti: r.binding.jti,
        vct: DESCRIPTOR.format.vct,
        profile: DESCRIPTOR.profile,
        profileVersion: 1,
        descriptorDigest: DESCRIPTOR_DIGEST,
        holderBinding: { did: holder, signingDomain: 'tinycloud.credentials/holder-binding/v1' },
        _sd_alg: 'sha-256',
        _sd: [sha(disclosure)],
      };
      const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'vc+sd-jwt', kid: DESCRIPTOR.issuer.kid }));
      const signingInput = `${header}.${b64u(JSON.stringify(payload))}`;
      const signature = sign(null, Buffer.from(signingInput), issuer.privateKey);
      const credential = `${signingInput}.${b64u(signature)}~${disclosure}~`;
      return json({
        type: 'tinycloud.credentials/result/v1',
        protocol: DESCRIPTOR.protocol,
        profile: DESCRIPTOR.profile,
        profileVersion: 1,
        format: 'vc+sd-jwt',
        descriptorDigest: DESCRIPTOR_DIGEST,
        issuer: DESCRIPTOR.issuer.did,
        issuerKid: DESCRIPTOR.issuer.kid,
        credential,
        credentialDigest: sha(credential),
        subject: holder,
        holderBinding: { did: holder, signingDomain: 'tinycloud.credentials/holder-binding/v1' },
        claims: { email },
        validity: { issuedAt: new Date((nowS - 5) * 1000).toISOString(), expiresAt: new Date((nowS + 3600) * 1000).toISOString() },
        status: { type: 'none', freshnessSeconds: 300 },
      });
    }
    return new Response('not found', { status: 404 });
  }

  return { fetch: fetchStub, reqs, code };
}
