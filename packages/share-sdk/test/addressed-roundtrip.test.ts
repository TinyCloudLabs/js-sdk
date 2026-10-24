import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import {
  canonicalize,
  fromBase64Url,
  open,
  verifyCid,
} from "@tinycloud/share-envelope";
import { MAX_LINK_BODY_BYTES, parseLink, resolveLink } from "@tinycloud/share-envelope/links";
import { SharePublishError, addressedCredentialRequirement, historyRecordForPublishedShare, inspectShare, publishAddressedShare, type AddressedPolicyRegistrationInput, type AddressedSharePublishOptions } from "../src/index.js";

const ownerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ownerDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(ownerSeed)]))}`;
const nodeSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const nodeDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(nodeSeed)]))}`;

async function fixture(onDeliveryMaterial?: AddressedSharePublishOptions["onDeliveryMaterial"], filename = "readme.md", pathPadding = "") {
  let registration: AddressedPolicyRegistrationInput | undefined;
  const published = await publishAddressedShare({
    shareId: "addressedroundtrip0001",
    shareOrigin: "https://share.tinycloud.xyz",
    nodeOrigin: "https://node.example",
    nodeAudience: nodeDid,
    enforcerDid: nodeDid,
    spaceId: "tinycloud:test-space",
    target: { kind: "email", address: "alice@example.com" },
    resource: { kind: "exact", path: `shares/addressedroundtrip0001/${pathPadding}readme.md` },
    actions: ["read"],
    policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource: {
      shareId: "addressedroundtrip0001",
      kvResource: `tinycloud:test-space/kv/shares/addressedroundtrip0001/${pathPadding}readme.md`,
      selector: "exact",
      encryptionNetwork: `urn:tinycloud:encryption:${ownerDid}:default`,
      encryptedSymmetricKeyDigestHex: "1".repeat(64),
      keyVersion: 1,
      mode: "immutable",
      initialCiphertextDigestHex: "2".repeat(64),
    },
    credentialRequirement: addressedCredentialRequirement({ kind: "email", address: "alice@example.com" }),
    filename,
    mediaType: "text/markdown",
    byteLength: 8,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    ...(onDeliveryMaterial === undefined ? {} : { onDeliveryMaterial }),
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

  it("carries the NFC filename in the envelope, result metadata and history", async () => {
    const { published } = await fixture(undefined, "cafe\u0301.md");
    expect(published.metadata.display.filename).toBe("caf\u00e9.md");
    expect(historyRecordForPublishedShare(published).filename).toBe("caf\u00e9.md");
    expect(published.deliveryMaterial?.envelope).toMatchObject({ display: { filename: "caf\u00e9.md" }, metadata: { filename: "caf\u00e9.md" } });
  });

  it("publishes sealed delivery material through the typed callback", async () => {
    let observed: Parameters<NonNullable<AddressedSharePublishOptions["onDeliveryMaterial"]>>[0] | undefined;
    const { published } = await fixture((material) => {
      const sealedEnvelope: string = material.sealedEnvelope;
      const envelopeKey: string = material.envelopeKey;
      expect(sealedEnvelope).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(envelopeKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      observed = material;
    });
    expect(observed).toEqual(published.deliveryMaterial);
  });

  it("seals the signed policy envelope into a signed full link and keeps the key and recipient out of loggable URL components", async () => {
    const { published } = await fixture();
    const url = new URL(published.url);
    const material = published.deliveryMaterial!;
    expect(url.pathname).toBe("/s/full");
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#v=4&k=[A-Za-z0-9_-]{43}&r=[A-Za-z0-9_-]+$/);
    expect(url.href.split("#", 1)[0]).not.toContain("alice@example.com");
    const resolved = await resolveLink(published.url, { trustedOrigins: ["https://share.tinycloud.xyz"], apiOrigin: "https://api.tinycloud.xyz" });
    expect(resolved.form).toBe("full");
    expect(resolved.header).toMatchObject({ type: "share", issuer: ownerDid, audience: "https://api.tinycloud.xyz", bodyCid: material.shareCid });
    expect(resolved.header.expiresAt).toBe("2030-01-01T00:00:00.000Z");
    expect(new URL(published.url).hash).toContain(`k=${material.envelopeKey}`);
    const sealed = fromBase64Url(material.sealedEnvelope);
    expect(await verifyCid(sealed, material.shareCid)).toBe(true);
    expect(new TextDecoder().decode(resolved.plaintext)).toBe(canonicalize(material.envelope));
    expect(published.metadata.expiresAt).toBe("2030-01-01T00:00:00Z");
    expect(published.link.kind).toBe("policy");
    await expect(inspectShare("https://share.tinycloud.xyz/viewer?tc2=legacy-plaintext-envelope")).rejects.toMatchObject({ code: "invalid-link" });
  });

  it("does not accept a substituted fragment key or tampered sealed envelope", async () => {
    const { published } = await fixture();
    const material = published.deliveryMaterial!;
    const key = fromBase64Url(material.envelopeKey);
    const sealed = fromBase64Url(material.sealedEnvelope);
    const substituted = published.url.replace(/&k=[A-Za-z0-9_-]{43}/, `&k=${"A".repeat(43)}`);
    expect(parseLink(substituted, { trustedOrigins: ["https://share.tinycloud.xyz"] }).form).toBe("full");
    await expect(inspectShare(substituted, { now: () => Date.parse("2029-01-01T00:00:00.000Z") })).rejects.toMatchObject({ code: "decrypt-failed" });
    await expect(open(sealed, fromBase64Url("A".repeat(43)))).rejects.toThrow();
    const tampered = Uint8Array.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(await verifyCid(tampered, material.shareCid)).toBe(false);
    await expect(open(tampered, key)).rejects.toThrow();
    const payload = new URL(published.url).hash.split("&r=")[1]!;
    const flipped = `${published.url.slice(0, published.url.indexOf(payload))}${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
    expect(() => parseLink(flipped, { trustedOrigins: ["https://share.tinycloud.xyz"] })).toThrow();
    await expect(inspectShare(flipped)).rejects.toMatchObject({ code: "invalid-link" });
  });

  it("refuses an over-limit envelope before any write, creating no link and no delivery material", async () => {
    let delivered = false;
    const outcome = await fixture(() => {
      delivered = true;
    }, "readme.md", "x".repeat(MAX_LINK_BODY_BYTES)).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(SharePublishError);
    expect(outcome).toMatchObject({ code: "max-bytes-exceeded" });
    expect(delivered).toBe(false);
  });

  it("carries exactly the envelope key and the sealed body's CID, also in a link whose key was substituted", async () => {
    const { published } = await fixture();
    const material = published.deliveryMaterial!;
    const trustedOrigins = ["https://share.tinycloud.xyz"];
    const recordOf = (link: string): { readonly bodyCid: unknown; readonly body: unknown } => {
      const parsed = parseLink(link, { trustedOrigins });
      if (parsed.form !== "full") throw new Error("expected a full link");
      const record = parsed.record;
      if (typeof record !== "object" || record === null || !("header" in record) || !("body" in record)) throw new Error("record shape");
      const header = record.header;
      if (typeof header !== "object" || header === null || !("bodyCid" in header)) throw new Error("header shape");
      return { bodyCid: header.bodyCid, body: record.body };
    };

    const parsed = parseLink(published.url, { trustedOrigins });
    expect(parsed.key).toEqual(fromBase64Url(material.envelopeKey));
    expect(parsed.k).toBe(material.envelopeKey);
    expect(new URL(published.url).hash.split("&")[1]).toBe(`k=${material.envelopeKey}`);
    expect(recordOf(published.url)).toEqual({ bodyCid: material.shareCid, body: material.sealedEnvelope });

    const substituted = published.url.replace(/&k=[A-Za-z0-9_-]{43}/, `&k=${"A".repeat(43)}`);
    const parsedSubstituted = parseLink(substituted, { trustedOrigins });
    expect(parsedSubstituted.key).toEqual(fromBase64Url("A".repeat(43)));
    expect(parsedSubstituted.key).not.toEqual(fromBase64Url(material.envelopeKey));
    expect(recordOf(substituted)).toEqual({ bodyCid: material.shareCid, body: material.sealedEnvelope });
    expect(await verifyCid(fromBase64Url(material.sealedEnvelope), material.shareCid)).toBe(true);
  });
});
