import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { canonicalize, parseInlineShareUrl } from "@tinycloud/share-envelope";
import { historyRecordForPublishedShare, publishAddressedShare, type AddressedPolicyRegistrationInput } from "../src/index.js";

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
    expect(JSON.stringify(published.deliveryMaterial)).not.toContain("envelopeKey");
    expect(JSON.stringify(published.deliveryMaterial)).not.toContain("sealedEnvelope");
    expect(JSON.stringify(registration)).not.toContain("/share/");
  });

  it("retains the v3 envelope and binding material in encrypted sender history", async () => {
    const { published } = await fixture();
    const record = historyRecordForPublishedShare(published);
    expect(record.deliveryMaterial).toEqual(published.deliveryMaterial);
    expect(record.deliveryMaterial?.shareCid).toBe(published.link.cid);
    expect(record.deliveryMaterial?.envelope).toMatchObject({ version: 3, policyCid: published.metadata.policyCid });
  });

  it("publishes the signed policy envelope as a public fragment-free invitation", async () => {
    const { published } = await fixture();
    const url = new URL(published.url);
    const parsed = parseInlineShareUrl(published.url, { expectedOrigin: "https://share.tinycloud.xyz" });
    expect(url.pathname).toBe("/viewer");
    expect(url.hash).toBe("");
    expect([...url.searchParams.keys()]).toEqual(["tc2"]);
    expect(parsed.key32).toBeUndefined();
    expect(new TextDecoder().decode(parsed.ciphertext)).toBe(canonicalize(published.deliveryMaterial!.envelope));
    expect(parsed.ciphertextCid).toBe(published.link.cid);
    expect(published.metadata.expiresAt).toBe("2030-01-01T00:00:00Z");
    expect(published.link.kind).toBe("policy");
  });
});
