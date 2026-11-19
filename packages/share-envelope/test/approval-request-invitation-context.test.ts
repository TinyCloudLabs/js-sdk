import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { buildShareInvitationApprovalSpec, linkIssuerPublicKey, parseApprovalRequest, signerFromSeed } from "../src/links/index.js";

const now = Date.parse("2026-11-11T12:00:00.000Z");
const signer = signerFromSeed(new Uint8Array(32).fill(21));
const targetPublicJwk = { kty: "OKP" as const, crv: "Ed25519" as const, x: Buffer.from(linkIssuerPublicKey(signer.did)!).toString("base64url") };
const result = (() => {
  const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  return { kty: "EC" as const, crv: "P-256" as const, x: key.x!, y: key.y! };
})();
const context = {
  kind: "share-invitation" as const, version: 1 as const, invitationId: "01HZX3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3",
  recipientEmail: "reader@example.com", subjectKind: "session" as const, subjectName: "plan",
  acceptanceExpiresAt: new Date(now + 3_600_000).toISOString(), accessExpiresAt: new Date(now + 3_600_000).toISOString(),
};
const spec = () => buildShareInvitationApprovalSpec({ targetDid: signer.did, targetPublicJwk, nodeOrigin: "https://node.example", context, now });

test("an invitation request carries its context and no permissions, so it can name no key", () => {
  const request = { ...spec(), resultEncryptionPublicJwk: result };
  expect(request.permissions).toEqual([]);
  expect(request.grantLifetimeSeconds).toBe(3600);
  expect(request.suggestedLifetimeSeconds).toBe(3600);
  expect(parseApprovalRequest(request, { issuer: signer.did })).toEqual(request);
});

test("a context request with any permission, or a request with neither, is refused", () => {
  const request = { ...spec(), resultEncryptionPublicJwk: result };
  const entry = { service: "tinycloud.encryption", space: "encryption", path: "urn:tinycloud:encryption:did:pkh:eip155:1:0xabc:default/share/" + "a".repeat(32), actions: ["tinycloud.encryption/key.create"] };
  expect(() => parseApprovalRequest({ ...request, permissions: [entry] })).toThrow();
  const { context: _context, ...withoutContext } = request;
  expect(() => parseApprovalRequest(withoutContext)).toThrow();
});

test("the context is strict: a requester-chosen key id or any extra field is refused", () => {
  const request = { ...spec(), resultEncryptionPublicJwk: result };
  expect(() => parseApprovalRequest({ ...request, context: { ...context, shareId: "a".repeat(32) } })).toThrow();
  expect(() => parseApprovalRequest({ ...request, context: { ...context, invitationId: "not-a-ulid" } })).toThrow();
  expect(() => parseApprovalRequest({ ...request, context: { ...context, acceptanceExpiresAt: "tomorrow" } })).toThrow();
});

test("the approval window is at most 24 hours and must be in the future", () => {
  const at = (ms: number) => buildShareInvitationApprovalSpec({ targetDid: signer.did, targetPublicJwk, nodeOrigin: "https://node.example", now,
    context: { ...context, acceptanceExpiresAt: new Date(now + ms).toISOString() } });
  expect(at(86_400_000).grantLifetimeSeconds).toBe(86_400);
  expect(() => at(86_401_000)).toThrow();
  expect(() => at(0)).toThrow();
});
