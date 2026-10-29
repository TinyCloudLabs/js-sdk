import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { buildShortLink, parseLink, parseApprovalRequest, prepareLinkRecord, openLinkRecord, signerFromSeed, linkIssuerPublicKey } from "../src/links/index.js";

const now = Date.parse("2026-10-28T12:00:00.000Z");
const signer = signerFromSeed(new Uint8Array(32).fill(17));
const request = {
  issuer: signer.did, requestVersion: 1 as const, targetDid: signer.did,
  targetPublicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: Buffer.from(linkIssuerPublicKey(signer.did)!).toString("base64url") },
  nodeOrigin: "https://node.example", permissions: [
    { service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list"] },
  ], grantLifetimeSeconds: 2592000,
  resultEncryptionPublicJwk: (() => {
    const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
    return { kty: "EC" as const, crv: "P-256" as const, x: key.x!, y: key.y! };
  })(),
};
const input = { type: "openkey-approval-request" as const,
  plaintext: new TextEncoder().encode(JSON.stringify(request)), issuerKey: signer,
  apiOrigin: "https://api.tinycloud.xyz", now };

test("an immutable approval request opens repeatedly and expires at its request deadline", async () => {
  const prepared = await prepareLinkRecord({ ...input, expiresAt: new Date(now + 3600_000) });
  const first = await openLinkRecord(prepared.record, prepared.key, { now });
  const second = await openLinkRecord(prepared.record, prepared.key, { now });
  expect(parseApprovalRequest(first.value, { issuer: prepared.record.header.issuer })).toEqual(request);
  expect(second.value).toEqual(first.value);
  await expect(openLinkRecord(prepared.record, prepared.key, { now: now + 3600_000 })).rejects.toMatchObject({ code: "expired" });
});

test("canonical approval links use the strict shared v4 grammar and require their sealed CID pin", async () => {
  const prepared = await prepareLinkRecord({ ...input, expiresAt: new Date(now + 3600_000) });
  const link = buildShortLink({ origin: "https://openkey.example", type: input.type, id: "abcdefghijklmnopqrstuvwxyz", key: prepared.key, bodyCid: prepared.bodyCid });
  const parsed = parseLink(link, { trustedOrigins: ["https://openkey.example"] });
  expect(parsed).toMatchObject({ form: "short", pathType: input.type, c: prepared.bodyCid });
  expect(() => parseLink(link.replace(/&c=.*/, ""), { trustedOrigins: ["https://openkey.example"] })).toThrow();
  expect(() => parseLink(link.replace("#v=4", "?api=https://attacker.example#v=4"), { trustedOrigins: ["https://openkey.example"] })).toThrow();
});

test("request lifetime cannot exceed 24 hours even when the grant lasts 30 days", async () => {
  await prepareLinkRecord({ ...input, expiresAt: new Date(now + 86400_000) });
  await expect(prepareLinkRecord({ ...input, expiresAt: new Date(now + 86401_000) })).rejects.toMatchObject({ code: "life_too_long" });
});

test.each([
  { ...request, targetDid: signerFromSeed(new Uint8Array(32).fill(18)).did },
  { ...request, issuer: signerFromSeed(new Uint8Array(32).fill(18)).did },
  { ...request, targetPublicJwk: { ...request.targetPublicJwk, d: "private" } },
  { ...request, resultEncryptionPublicJwk: { ...request.resultEncryptionPublicJwk, x: "A".repeat(43), y: "A".repeat(43) } },
])("rejects inconsistent or unsafe request keys", (invalid) => {
  expect(() => parseApprovalRequest(invalid, { issuer: signer.did })).toThrow();
});
