import { describe, expect, test } from "bun:test";
import {
  canonicalize, computeCid, encodeShareUrl, seal, signEnvelopeV2, toBase64Url,
  type ShareEnvelopeV2,
} from "@tinycloud/share-envelope";
import { inspectShare, receiveShare, type SharePolicyEvidence } from "@tinycloud/share-sdk";

const origin = "https://share.tinycloud.xyz";
const key = new Uint8Array(32).fill(5);
const signerSeed = new Uint8Array(32).fill(7);
const content = new TextEncoder().encode("read");

async function fixture() {
  const policyBytes = new TextEncoder().encode('{"policy":"legacy"}');
  const policyCid = await computeCid(policyBytes);
  const envelope: ShareEnvelopeV2 = signEnvelopeV2({
    version: 2, shareId: "legacy-share-1",
    recipientMatcher: { kind: "exactEmail", value: "person@example.com" },
    actions: ["read"], resource: { kind: "exact", path: "documents/readme.md" },
    target: { origin: "https://node.tinycloud.xyz", nodeAudience: "did:web:node.tinycloud.xyz", spaceId: "space" },
    delegationCid: "delegation-cid", authorityMaterialHandle: "amh_kv_001",
    authorityMaterialDigest: "A".repeat(43),
    contentSource: { kind: "kv", space: "space", path: "documents/readme.md", action: "tinycloud.kv/get" },
    contentSourceDigest: "B".repeat(43),
    authorizationTarget: { kind: "policy", policyCid, policyBytes: toBase64Url(policyBytes) },
    display: { filename: "readme.md", mode: "document" },
    expiry: "2026-12-01T00:00:00.000Z", encrypted: true,
    metadata: { mediaType: "text/plain", byteLength: content.length, filename: "readme.md", encoding: "utf-8" },
  }, signerSeed);
  const sealed = await seal(new TextEncoder().encode(canonicalize(envelope)), key);
  const link = encodeShareUrl({ origin, ciphertextCid: sealed.cid, key32: key });
  const evidence: SharePolicyEvidence = {
    policyCid, signerDid: envelope.signature.signerDid, registrationCid: "registration-cid",
    shareId: envelope.shareId, recipientMatcher: envelope.recipientMatcher, target: envelope.target,
    resource: envelope.resource, actions: ["tinycloud.kv/get"], contentSource: envelope.contentSource,
    contentSourceDigest: envelope.contentSourceDigest, delegationCid: envelope.delegationCid,
    authorityMaterialHandle: envelope.authorityMaterialHandle, authorityMaterialDigest: envelope.authorityMaterialDigest,
    expiresAt: envelope.expiry,
  };
  const options = {
    expectedOrigin: origin, now: () => Date.parse("2026-11-01T00:00:00.000Z"),
    fetchBlob: async () => sealed.blob,
    trustedPolicyAuthority: { resolve: async () => evidence },
  };
  return { envelope, evidence, link, options };
}

describe("existing V2 compact links", () => {
  test("verify the signed envelope and external policy before returning metadata or authorized content", async () => {
    const { envelope, evidence, link, options } = await fixture();
    expect(await inspectShare(link, options)).toMatchObject({
      metadata: { shareId: envelope.shareId }, link: { kind: "compact" },
    });
    expect(await receiveShare(link, options)).toMatchObject({ state: "authorization-required", method: "email-claim" });
    const bodyDigest = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", content)));
    const received = await receiveShare(link, {
      ...options,
      authorization: {
        async begin() { return { state: "ready" as const, value: {
          bytes: content, bodyDigest, contentSourceDigest: envelope.contentSourceDigest,
          binding: { shareId: envelope.shareId, delegationCid: envelope.delegationCid,
            authorityMaterialHandle: envelope.authorityMaterialHandle, authorityMaterialDigest: envelope.authorityMaterialDigest,
            resource: envelope.resource, action: "read" }, proof: { signed: true },
        } }; },
        async resume() { throw new Error("unexpected resume"); },
        async verifyResult() { return true; },
      },
    });
    expect(received).toMatchObject({ metadata: { shareId: envelope.shareId }, text: "read" });
    await expect(inspectShare(link, { ...options, trustedPolicyAuthority: {
      resolve: async () => ({ ...evidence, shareId: "another-share" }),
    } })).rejects.toMatchObject({ code: "capability-invalid" });
    const wrongKey = encodeShareUrl({ origin, ciphertextCid: new URL(link).pathname.slice(3), key32: new Uint8Array(32).fill(6) });
    await expect(inspectShare(wrongKey, options)).rejects.toMatchObject({ code: "decrypt-failed" });
  });
});
