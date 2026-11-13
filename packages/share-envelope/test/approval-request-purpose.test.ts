import { expect, test } from 'bun:test';
import { approvalRequestPurpose, generateRelayKey, linkIssuerPublicKey, parseApprovalRequest, signerFromSeed } from '../src/links/index.js';
const signer = signerFromSeed(new Uint8Array(32).fill(37));
const request = { issuer: signer.did, requestVersion: 1 as const, targetDid: signer.did,
  targetPublicJwk: { kty: 'OKP' as const, crv: 'Ed25519' as const, x: Buffer.from(linkIssuerPublicKey(signer.did)!).toString('base64url') },
  nodeOrigin: 'https://node.example', permissions: [{ service: 'tinycloud.kv', space: 'agents', path: '', actions: ['tinycloud.kv/get'] }],
  grantLifetimeSeconds: 2592000, resultEncryptionPublicJwk: generateRelayKey().publicJwk };
test('missing purpose means task without rewriting a legacy signed request', () => {
  const parsed = parseApprovalRequest(request);
  expect(approvalRequestPurpose(parsed)).toBe('task');
  expect(parsed).toEqual(request);
  expect(approvalRequestPurpose(parseApprovalRequest({ ...request, renewal: { version: 1, leaseLifetimeSeconds: 7776000 } }))).toBe('task');
});
test('accepts only explicit task or standing purpose', () => {
  for (const purpose of ['task', 'standing'] as const) expect(approvalRequestPurpose(parseApprovalRequest({ ...request, purpose }))).toBe(purpose);
  for (const purpose of ['Standing', '', null, true, { kind: 'standing' }]) expect(() => parseApprovalRequest({ ...request, purpose })).toThrow();
});
