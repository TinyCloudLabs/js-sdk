import { describe, expect, it } from "vitest";
import { signEnvelopeV2, verifyEnvelopeV2SignatureOnly } from "../src/sign.js";
import { toBase64Url } from "../src/bytes.js";

const key = new Uint8Array(32).fill(7);
const target = { origin: "https://node.tinycloud.xyz", nodeAudience: "did:web:node.tinycloud.xyz", spaceId: "space" };
const resource = { kind: "exact" as const, path: "documents/readme.md" };
const source = { kind: "kv" as const, space: "space", path: "documents/readme.md", action: "tinycloud.kv/get" as const };

describe("canonical v2 envelopes", () => {
  it("requires unique actions in canonical order and signs the complete policy binding", () => {
    const envelope = signEnvelopeV2({
      version: 2,
      shareId: "share-v2",
      recipientMatcher: { kind: "emailDomain", value: "example.com" },
      actions: ["read", "list", "edit"],
      resource,
      target: { origin: target.origin, nodeAudience: target.nodeAudience, spaceId: target.spaceId },
      delegationCid: "delegation-cid",
      authorityMaterialHandle: "amh_kv_001",
      authorityMaterialDigest: "A".repeat(43),
      contentSource: source,
      contentSourceDigest: "B".repeat(43),
      authorizationTarget: { kind: "policy", policyCid: "policy", policyBytes: toBase64Url(new TextEncoder().encode("{}")) },
      display: { filename: "readme.md", mode: "document" },
      expiry: "2026-07-25T00:00:00.000Z",
      encrypted: true,
      metadata: { mediaType: "text/markdown", byteLength: 12, filename: "readme.md", encoding: "utf-8" },
    }, key);
    expect(verifyEnvelopeV2SignatureOnly(envelope)).toBe(true);
    expect(() => signEnvelopeV2({ ...envelope, actions: ["edit", "read"] }, key)).toThrow();
    expect(() => signEnvelopeV2({ ...envelope, actions: ["read", "read"] }, key)).toThrow();
  });

  it("accepts exactly 100 MiB of content metadata and rejects one byte over", () => {
    expect(() => signEnvelopeV2({ ...baseEnvelope(), metadata: { mediaType: "application/octet-stream", byteLength: 100 * 1024 * 1024, filename: "large.bin" } }, key)).not.toThrow();
    expect(() => signEnvelopeV2({ ...baseEnvelope(), metadata: { mediaType: "application/octet-stream", byteLength: 100 * 1024 * 1024 + 1, filename: "too-large.bin" } }, key)).toThrow();
  });

  it("rejects every content-bearing safe-plaintext envelope", () => {
    const base = {
      version: 2 as const,
      shareId: "policy-only",
      recipientMatcher: { kind: "policyDigest" as const, value: "A".repeat(43) },
      actions: ["list" as const],
      resource,
      target: { origin: target.origin, nodeAudience: target.nodeAudience, spaceId: target.spaceId },
      delegationCid: "delegation-cid",
      authorityMaterialHandle: "amh_kv_001",
      authorityMaterialDigest: "A".repeat(43),
      contentSource: source,
      contentSourceDigest: "B".repeat(43),
      authorizationTarget: { kind: "policy" as const, policyCid: "policy", policyBytes: toBase64Url(new TextEncoder().encode("{}")) },
      display: { mode: "folder" as const },
      expiry: "2026-07-25T00:00:00.000Z",
      encrypted: false,
      metadata: { mediaType: "application/octet-stream", byteLength: 0, filename: "policy", },
    };
    expect(() => signEnvelopeV2({ ...base, content: { cid: "bafkreiekhtgxpb5xhykd6pytalpkmg52trryror2gritt7r56jv2t75fl4", key: "A".repeat(43) } }, key)).toThrow();
    expect(() => signEnvelopeV2({ ...base, metadata: { ...base.metadata, byteLength: 1 } }, key)).toThrow();
  });

  it("rejects a public domain matcher in plaintext even when it carries no content", () => {
    const value = {
      version: 2 as const,
      shareId: "policy-only",
      recipientMatcher: { kind: "emailDomain" as const, value: "example.com" },
      actions: ["list" as const],
      resource,
      target: { origin: target.origin, nodeAudience: target.nodeAudience, spaceId: target.spaceId },
      delegationCid: "delegation-cid",
      authorityMaterialHandle: "amh_kv_001",
      authorityMaterialDigest: "A".repeat(43),
      contentSource: source,
      contentSourceDigest: "B".repeat(43),
      authorizationTarget: { kind: "policy" as const, policyCid: "policy", policyBytes: toBase64Url(new TextEncoder().encode("{}")) },
      display: {},
      expiry: "2026-07-25T00:00:00.000Z",
      encrypted: false,
      metadata: { mediaType: "application/octet-stream", byteLength: 0, filename: "policy" },
    };
    expect(() => signEnvelopeV2(value, key)).toThrow(/matcher digest/i);
  });
});

function baseEnvelope() {
  return {
    version: 2 as const,
    shareId: "share-boundary",
    recipientMatcher: { kind: "bearer" as const },
    // `["read" as const]`, not `["read"] as const`: the latter is a *readonly*
    // tuple, which `UnsignedShareEnvelopeV2.actions` (a mutable `ShareAction[]`)
    // does not accept. This form keeps the literal element type without the
    // readonly modifier.
    actions: ["read" as const],
    resource,
    target,
    delegationCid: "delegation-cid",
    authorityMaterialHandle: "amh_kv_001",
    authorityMaterialDigest: "A".repeat(43),
    contentSource: source,
    contentSourceDigest: "B".repeat(43),
    authorizationTarget: { kind: "policy" as const, policyCid: "policy", policyBytes: toBase64Url(new TextEncoder().encode("{}")) },
    display: { filename: "large.bin" },
    expiry: "2026-07-25T00:00:00.000Z",
    encrypted: true,
  };
}
