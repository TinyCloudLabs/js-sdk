import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import { canonicalizeSignedObjectUnsigned as canonicalize } from "../policy/signed-object.js";
import { readFileSync } from "node:fs";
import { assertDidKeySignature } from "@tinycloud/share-envelope/links";
import { DELIVERY_ADMISSION_DOMAIN, shortDeliveryLinkBodyCid, validateShareDeliveryAuthorizationV3Bytes, verifyShareDeliveryAuthorizationV3Bytes } from "./share-delivery-v3.js";

const seed = new Uint8Array(32).fill(7);
const nodeDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(seed)]))}`;
const senderKeyDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(new Uint8Array(32).fill(8))]))}`;
const ownerDid = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(new Uint8Array(32).fill(9))]))}`;
const shareCid = `bafkrei${"a".repeat(52)}`;
const jti = "A".repeat(22);

const envelope = {
  version: 3,
  policyCid: shareCid,
  shareId: "share-v3",
  recipientMatcher: { kind: "exactEmail", value: "alice@example.com" },
  actions: ["read"],
  resource: { kind: "exact", path: "shares/share-v3/report.pdf" },
  policy: { policyId: "pol_example", credentialRequirement: { credentialType: { id: "opencredentials.email/v1", version: 1 } } },
  target: { origin: "https://node.tinycloud.xyz", nodeAudience: nodeDid },
  attestedEnforcerBinding: { enforcerDid: nodeDid, nodeAudience: nodeDid },
  contentSource: { shareId: "share-v3", kvResource: `${ownerDid}/kv/shares/share-v3/report.pdf` },
  expiry: "2026-08-13T12:00:00Z",
  signature: { algorithm: "Ed25519", signerDid: ownerDid, value: "signature" },
};

const request = {
  recipientEmail: "alice@example.com",
  shareUrl: `https://share.tinycloud.xyz/s/lqdw5iopqq2tkkvjj6gbbi5vbv#v=4&k=${"A".repeat(43)}&c=${shareCid}`,
  documentName: "report.pdf",
  jti,
  expiresAt: "2026-08-06T12:05:00Z",
  requestBodyDigest: "B".repeat(43),
};

function response(overrides: Record<string, unknown> = {}): Uint8Array {
  const invitation = {
    schema: "xyz.tinycloud.credentials/invitation-request/v1",
    policyId: envelope.policyCid,
    recipient: request.recipientEmail,
    resource: envelope.contentSource.kvResource,
    credentialType: envelope.policy.credentialRequirement.credentialType.id,
    returnLink: request.shareUrl,
    envelopeRef: shareCid,
    label: request.documentName,
    shareExpiresAt: "2026-08-13T12:00:00Z",
    audience: "https://api.share.tinycloud.xyz",
    issuedAt: "2026-08-06T12:00:00Z",
    expiresAt: request.expiresAt,
    nonce: request.jti,
  };
  const admission = {
    ...invitation,
    schema: "xyz.tinycloud.policy/delivery-admission/v1",
    ownerDid,
    actions: ["tinycloud.kv/get"],
    senderKeyDid,
    ...overrides,
  };
  const digest = sha256(new TextEncoder().encode(`${DELIVERY_ADMISSION_DOMAIN}${canonicalize(admission)}`));
  return new TextEncoder().encode(JSON.stringify({
    request: invitation,
    admission: {
      ...admission,
      signature: { suite: "eddsa-ed25519-sha256-jcs-v1", signerDid: nodeDid, value: Buffer.from(ed25519.sign(digest, seed)).toString("base64url") },
    },
  }));
}

describe("v3 share delivery authorization", () => {
  it("accepts the exact generic invitation admission", () => {
    expect(validateShareDeliveryAuthorizationV3Bytes(response(), {
      request,
      envelope,
      envelopeRef: shareCid,
      senderKeyDid,
      deliveryAudience: "https://api.share.tinycloud.xyz",
    }).request.envelopeRef).toBe(shareCid);
  });

  it("rejects a recipient substitution", () => {
    expect(() => validateShareDeliveryAuthorizationV3Bytes(response({ recipient: "other@example.com" }), {
      request,
      envelope,
      envelopeRef: shareCid,
      senderKeyDid,
      deliveryAudience: "https://api.share.tinycloud.xyz",
    })).toThrow("not bound");
  });

  it("rejects a different sender key", () => {
    expect(() => validateShareDeliveryAuthorizationV3Bytes(response({ senderKeyDid: ownerDid }), {
      request,
      envelope,
      envelopeRef: shareCid,
      senderKeyDid,
      deliveryAudience: "https://api.share.tinycloud.xyz",
    })).toThrow("not bound");
  });

  it("rejects a tampered admission signature", () => {
    const parsed = JSON.parse(new TextDecoder().decode(response()));
    parsed.admission.signature.value = `${parsed.admission.signature.value.startsWith("A") ? "B" : "A"}${parsed.admission.signature.value.slice(1)}`;
    expect(() => validateShareDeliveryAuthorizationV3Bytes(new TextEncoder().encode(JSON.stringify(parsed)), {
      request,
      envelope,
      envelopeRef: shareCid,
      senderKeyDid,
      deliveryAudience: "https://api.share.tinycloud.xyz",
    })).toThrow("signature");
  });
});

describe("v3 share delivery authorization: admission v1", () => {
  const accept = (bytes: Uint8Array, envelopeRef = shareCid) => validateShareDeliveryAuthorizationV3Bytes(bytes, {
    request,
    envelope,
    envelopeRef,
    senderKeyDid,
    deliveryAudience: "https://api.share.tinycloud.xyz",
  });

  it("refuses an admission under the v0 schema, even when it is signed under the v0 domain", () => {
    const v0 = "xyz.tinycloud.policy/delivery-admission/v0";
    const signed = JSON.parse(new TextDecoder().decode(response({ schema: v0 })));
    const { signature: _signature, ...unsigned } = signed.admission;
    const digest = sha256(new TextEncoder().encode(`${v0}\0${canonicalize(unsigned)}`));
    signed.admission.signature.value = Buffer.from(ed25519.sign(digest, seed)).toString("base64url");
    expect(() => accept(new TextEncoder().encode(JSON.stringify(signed)))).toThrow("not bound");
  });

  it("refuses a v1 admission signed under the v0 domain", () => {
    const signed = JSON.parse(new TextDecoder().decode(response()));
    const { signature: _signature, ...unsigned } = signed.admission;
    const digest = sha256(new TextEncoder().encode(`xyz.tinycloud.policy/delivery-admission/v0\0${canonicalize(unsigned)}`));
    signed.admission.signature.value = Buffer.from(ed25519.sign(digest, seed)).toString("base64url");
    expect(() => accept(new TextEncoder().encode(JSON.stringify(signed)))).toThrow("signature");
  });

  it("refuses an admission whose envelopeRef is not the c of the submitted link", () => {
    expect(() => accept(response(), `bafkrei${"b".repeat(52)}`)).toThrow("not bound");
    expect(() => accept(response({ returnLink: request.shareUrl.replace("lqdw5iopqq2tkkvjj6gbbi5vbv", "aaaaaaaaaaaaaaaaaaaaaaaaaa") }))).toThrow("not bound");
  });

  it("verifies the contract's v1 admission vector and refuses its v0-domain twin", () => {
    const { deliveryAdmission } = JSON.parse(readFileSync(new URL("../../../share-envelope/test/links-api-vectors.json", import.meta.url), "utf8")) as {
      deliveryAdmission: { vectors: readonly { admission: Record<string, unknown>; digestHex: string; signature: { signerDid: string; value: string }; expect: { valid: boolean } }[] };
    };
    expect(deliveryAdmission.vectors).toHaveLength(3);
    for (const vector of deliveryAdmission.vectors) {
      const digest = sha256(new TextEncoder().encode(`${DELIVERY_ADMISSION_DOMAIN}${canonicalize(vector.admission)}`));
      const verifies = ed25519.verify(Buffer.from(vector.signature.value, "base64url"), digest, base58btc.decode(vector.signature.signerDid.slice("did:key:".length)).slice(2));
      expect(verifies).toBe(vector.expect.valid);
      if (vector.expect.valid) expect(Buffer.from(digest).toString("hex")).toBe(vector.digestHex);
    }
  });
});

describe("the short link of a delivery", () => {
  const origin = "https://share.tinycloud.xyz";
  const id = "lqdw5iopqq2tkkvjj6gbbi5vbv";
  const key = "A".repeat(43);
  const short = `${origin}/s/${id}#v=4&k=${key}&c=${shareCid}`;
  const refused = [
    ["a full link", `${origin}/s/full#v=4&k=${key}&r=eyJ4IjoxfQ`],
    ["fragment version 3", `${origin}/s/${id}#v=3&k=${key}&c=${shareCid}`],
    ["the compact cid link", `${origin}/s/${shareCid}#k=${key}`],
    ["a query", `${origin}/s/${id}?x=1#v=4&k=${key}&c=${shareCid}`],
    ["an upper-case host", `https://SHARE.tinycloud.xyz/s/${id}#v=4&k=${key}&c=${shareCid}`],
    ["plain http", `http://share.tinycloud.xyz/s/${id}#v=4&k=${key}&c=${shareCid}`],
    ["another link type", `${origin}/c/${id}#v=4&k=${key}&c=${shareCid}`],
    ["no fragment", `${origin}/s/${id}`],
    ["text that is not a link", "not a link"],
  ] as const;

  it("gives the c of a short share link", async () => {
    expect(await shortDeliveryLinkBodyCid(short)).toBe(shareCid);
  });

  for (const [label, link] of refused) {
    it(`refuses ${label} with a message that holds no part of the link`, async () => {
      let failure: unknown;
      try {
        await shortDeliveryLinkBodyCid(link);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ message: "share delivery requires a short share link" });
    });
  }
});

describe("v3 share delivery authorization: the strict Ed25519 rule", () => {
  const { ed25519Strict } = JSON.parse(readFileSync(new URL("../../../share-envelope/test/links-api-vectors.json", import.meta.url), "utf8")) as {
    ed25519Strict: readonly { name: string; publicKeyHex: string; signatureHex: string; expect: { valid: boolean } }[];
  };
  const didOf = (publicKey: Uint8Array) => `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
  const expectedFor = (nodeAudience: string) => ({
    request,
    envelope: { ...envelope, target: { ...envelope.target, nodeAudience }, attestedEnforcerBinding: { ...envelope.attestedEnforcerBinding, nodeAudience } },
    envelopeRef: shareCid,
    senderKeyDid,
    deliveryAudience: "https://api.share.tinycloud.xyz",
  });
  /** The node's response with the admission signed by `signerDid` and carrying exactly `value` as its signature. */
  const responseWith = (signerDid: string, value: string) => {
    const parsed = JSON.parse(new TextDecoder().decode(response()));
    parsed.admission.signature = { suite: "eddsa-ed25519-sha256-jcs-v1", signerDid, value };
    return new TextEncoder().encode(JSON.stringify(parsed));
  };
  const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  const vectorsNamed = (prefix: string) => ed25519Strict.filter((vector) => vector.name.startsWith(prefix));

  it("verifies an admission signed by the node's key", async () => {
    const verified = await verifyShareDeliveryAuthorizationV3Bytes(response(), expectedFor(nodeDid));
    expect(verified.admission.signature.signerDid).toBe(nodeDid);
  });

  it("refuses a small-order node key with the identity signature, for all eight keys of the contract vectors", async () => {
    const vectors = vectorsNamed("small-order public key");
    expect(vectors).toHaveLength(8);
    let permissive = 0;
    for (const vector of vectors) {
      const signerDid = didOf(fromHex(vector.publicKeyHex));
      const bytes = responseWith(signerDid, Buffer.from(fromHex(vector.signatureHex)).toString("base64url"));
      try {
        validateShareDeliveryAuthorizationV3Bytes(bytes, expectedFor(signerDid));
        permissive += 1;
      } catch {
        // The default rule of the library may refuse some of them as well.
      }
      await expect(verifyShareDeliveryAuthorizationV3Bytes(bytes, expectedFor(signerDid))).rejects.toThrow("signature is invalid");
    }
    expect(permissive).toBeGreaterThan(0);
  });

  it("refuses a non-canonical encoding of the identity as the node key and as R", async () => {
    for (const vector of [...vectorsNamed("non-canonical encoding of the identity as the public key"), ...vectorsNamed("non-canonical encoding of the identity as R")]) {
      const signerDid = didOf(fromHex(vector.publicKeyHex));
      const bytes = responseWith(signerDid, Buffer.from(fromHex(vector.signatureHex)).toString("base64url"));
      await expect(verifyShareDeliveryAuthorizationV3Bytes(bytes, expectedFor(signerDid))).rejects.toThrow();
    }
  });

  it("refuses a signature whose base64url spelling is not canonical, though it decodes to the same bytes", async () => {
    const value: string = JSON.parse(new TextDecoder().decode(response())).admission.signature.value;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const spelled = `${value.slice(0, -1)}${alphabet[alphabet.indexOf(value.slice(-1)) | 1]}`;
    expect(spelled).not.toBe(value);
    expect(Buffer.from(spelled, "base64url").equals(Buffer.from(value, "base64url"))).toBe(true);
    const bytes = responseWith(nodeDid, spelled);
    await expect(verifyShareDeliveryAuthorizationV3Bytes(bytes, expectedFor(nodeDid))).rejects.toThrow("canonical base64url");
  });
});

describe("the short link of a delivery: the share origin", () => {
  const id = "lqdw5iopqq2tkkvjj6gbbi5vbv";
  const link = (origin: string, linkId = id) => `${origin}/s/${linkId}#v=4&k=${"A".repeat(43)}&c=${shareCid}`;

  it("accepts the production share origin by default and refuses another one", async () => {
    expect(await shortDeliveryLinkBodyCid(link("https://share.tinycloud.xyz"))).toBe(shareCid);
    await expect(shortDeliveryLinkBodyCid(link("https://share.example"))).rejects.toThrow("share delivery requires a short share link");
  });

  it("accepts the origins it is given, and only those", async () => {
    expect(await shortDeliveryLinkBodyCid(link("https://share.example"), ["https://share.example"])).toBe(shareCid);
    await expect(shortDeliveryLinkBodyCid(link("https://share.tinycloud.xyz"), ["https://share.example"])).rejects.toThrow("short share link");
  });

  it("refuses an upper-case id", async () => {
    await expect(shortDeliveryLinkBodyCid(link("https://share.tinycloud.xyz", id.toUpperCase()))).rejects.toThrow("short share link");
  });
});

describe("the delivery admission vector with a non-ASCII label", () => {
  const { deliveryAdmission } = JSON.parse(readFileSync(new URL("../../../share-envelope/test/links-api-vectors.json", import.meta.url), "utf8")) as {
    deliveryAdmission: { vectors: readonly { admission: Record<string, unknown>; digestHex: string; signature: { signerDid: string; value: string }; expect: { valid: boolean } }[] };
  };
  const vector = deliveryAdmission.vectors.find((entry) => String(entry.admission.label).includes("\u{1F4C4}"));
  if (vector === undefined) throw new Error("the vector file has no admission with a non-ASCII label");
  const digestOf = (admission: Record<string, unknown>) => sha256(new TextEncoder().encode(`${DELIVERY_ADMISSION_DOMAIN}${canonicalize(admission)}`));

  it("has the digest the SDK computes, and the strict verifier accepts its signature", () => {
    expect(vector.expect.valid).toBe(true);
    expect(String(vector.admission.label)).toContain("\u2028");
    expect(Buffer.from(digestOf(vector.admission)).toString("hex")).toBe(vector.digestHex);
    expect(() => assertDidKeySignature(vector.signature.signerDid, digestOf(vector.admission), vector.signature.value)).not.toThrow();
  });

  it("is refused when one character of the label differs", () => {
    const altered = { ...vector.admission, label: String(vector.admission.label).replace("<v2>", "<v3>") };
    expect(() => assertDidKeySignature(vector.signature.signerDid, digestOf(altered), vector.signature.value)).toThrow("signature is invalid");
  });
});
