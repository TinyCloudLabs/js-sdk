import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import {
  canonicalize,
  encodeSealedInlineShareUrl,
  fromBase64Url,
  open,
  parseSealedInlineShareUrl,
  verifyCid,
} from "@tinycloud/share-envelope";
import { historyRecordForPublishedShare, inspectShare, publishAddressedShare, type AddressedPolicyRegistrationInput } from "../src/index.js";

const ownerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ownerDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(ownerSeed)]))}`;
const nodeSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const nodeDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(nodeSeed)]))}`;

async function fixture() {
  let registration: AddressedPolicyRegistrationInput | undefined;
  const published = await publishAddressedShare({
    shareId: "addressedroundtrip0001",
    shareOrigin: "https://share.tinycloud.xyz",
    nodeOrigin: "https://node.example",
    nodeAudience: nodeDid,
    enforcerDid: nodeDid,
    spaceId: "tinycloud:test-space",
    target: { kind: "email", address: "alice@example.com" },
    resource: { kind: "exact", path: "shares/addressedroundtrip0001/readme.md" },
    actions: ["read"],
    policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource: {
      shareId: "addressedroundtrip0001",
      kvResource: "tinycloud:test-space/kv/shares/addressedroundtrip0001/readme.md",
      selector: "exact",
      encryptionNetwork: `urn:tinycloud:encryption:${ownerDid}:default`,
      encryptedSymmetricKeyDigestHex: "1".repeat(64),
      keyVersion: 1,
      mode: "immutable",
      initialCiphertextDigestHex: "2".repeat(64),
    },
    filename: "readme.md",
    mediaType: "text/markdown",
    byteLength: 8,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    authority: {
      ownerDid,
      async createOwnerRoot(input) {
        return { cid: input.role === "policy-authority" ? "bafy-policy-root" : "bafy-enforcement-root", delegationHeader: { Authorization: input.role === "policy-authority" ? "a.b.c" : "d.e.f" } };
      },
      async sign(bytes) {
        return ed25519.sign(bytes, ownerSeed);
      },
      async registerPolicy(input) {
        registration = input;
        return {
          policyCid: input.policyCid,
          policyRootCid: input.policyRoot.cid,
          enforcementRootCid: input.enforcementRoot.cid,
          attestedEnforcerBinding: {
            schema: "xyz.tinycloud.policy/attested-enforcer/v2",
            enforcerDid: nodeDid,
            nodeAudience: nodeDid,
            attestationBindingDigestHex: "3".repeat(64),
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2030-01-01T00:00:00.000Z",
            signature: { suite: "Ed25519", signerDid: nodeDid, value: "AQ" },
          },
        };
      },
    },
  });
  return { published, registration };
}

describe("canonical addressed publication", () => {
  it("builds a signed Policy/v3 envelope from an app-neutral registration callback", async () => {
    const { published, registration } = await fixture();
    expect(registration).toMatchObject({
      policyRoot: { cid: "bafy-policy-root", authorization: "a.b.c" },
      enforcementRoot: { cid: "bafy-enforcement-root", authorization: "d.e.f" },
      enforcerDid: nodeDid,
      expectedNodeAudience: nodeDid,
    });
    expect(published.metadata.policyCid).toBe(registration?.policyCid);
    expect(JSON.stringify(published)).not.toContain(published.url);
    expect(published.deliveryMaterial?.sealedEnvelope).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(published.deliveryMaterial?.envelopeKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(registration)).not.toContain("/share/");
  });

  it("retains the v3 envelope and binding material in encrypted sender history", async () => {
    const { published } = await fixture();
    const record = historyRecordForPublishedShare(published);
    expect(record.deliveryMaterial).toEqual(published.deliveryMaterial);
    expect(record.deliveryMaterial?.shareCid).toBe(published.link.cid);
    expect(record.deliveryMaterial?.envelope).toMatchObject({ version: 3, policyCid: published.metadata.policyCid });
  });

  it("seals the signed policy envelope and keeps the key and recipient out of loggable URL components", async () => {
    const { published } = await fixture();
    const url = new URL(published.url);
    const parsed = await parseSealedInlineShareUrl(published.url, { expectedOrigin: "https://share.tinycloud.xyz" });
    const material = published.deliveryMaterial!;
    expect(url.pathname).toBe("/s/inline");
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#v=2&p=[A-Za-z0-9_-]+$/);
    expect(url.href.split("#", 1)[0]).not.toContain("alice@example.com");
    expect(parsed.ciphertextCid).toBe(material.shareCid);
    expect(parsed.key32).toEqual(fromBase64Url(material.envelopeKey));
    const sealed = fromBase64Url(material.sealedEnvelope);
    expect(await verifyCid(sealed, material.shareCid)).toBe(true);
    expect(new TextDecoder().decode(await open(sealed, parsed.key32))).toBe(canonicalize(material.envelope));
    expect(published.metadata.expiresAt).toBe("2030-01-01T00:00:00Z");
    expect(published.link.kind).toBe("policy");
    await expect(inspectShare("https://share.tinycloud.xyz/viewer?tc2=legacy-plaintext-envelope")).rejects.toMatchObject({ code: "invalid-link" });
  });

  it("does not accept a substituted fragment key or tampered sealed envelope", async () => {
    const { published } = await fixture();
    const material = published.deliveryMaterial!;
    const key = fromBase64Url(material.envelopeKey);
    const sealed = fromBase64Url(material.sealedEnvelope);
    const substituted = await encodeSealedInlineShareUrl({
      origin: "https://share.tinycloud.xyz",
      ciphertext: sealed,
      key32: fromBase64Url("A".repeat(43)),
    });
    await expect(parseSealedInlineShareUrl(substituted)).resolves.toMatchObject({ ciphertextCid: material.shareCid });
    await expect(inspectShare(substituted, { now: () => Date.parse("2029-01-01T00:00:00.000Z") })).rejects.toMatchObject({ code: "envelope-invalid" });
    await expect(open(sealed, fromBase64Url("A".repeat(43)))).rejects.toThrow();
    const tampered = Uint8Array.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(await verifyCid(tampered, material.shareCid)).toBe(false);
    await expect(open(tampered, key)).rejects.toThrow();
    const payload = new URL(published.url).hash.slice("#v=2&p=".length);
    const flipped = `${published.url.slice(0, published.url.indexOf(payload))}${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
    await expect(parseSealedInlineShareUrl(flipped)).rejects.toThrow();
  });
});
