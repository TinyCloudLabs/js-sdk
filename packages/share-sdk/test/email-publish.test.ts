import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalize, toBase64Url } from "@tinycloud/share-envelope";
import { addressedCredentialRequirement, normalizeShareTarget, prepareAddressedShare, publishAddressedShare, type AddressedSharePublishOptions } from "../src/index.js";

const digest = (value: unknown) => toBase64Url(sha256(new TextEncoder().encode(canonicalize(value))));

/** Digest of the descriptor the issuer serves for `name`, from sdk-core's golden vectors. */
function goldenDescriptorDigest(name: string): string {
  const fixture: unknown = JSON.parse(readFileSync(new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url), "utf8"));
  const vectors: unknown[] = typeof fixture === "object" && fixture !== null && "vectors" in fixture && Array.isArray(fixture.vectors) ? fixture.vectors : [];
  const vector = vectors.find((candidate) => typeof candidate === "object" && candidate !== null && "name" in candidate && candidate.name === name);
  if (typeof vector !== "object" || vector === null || !("digest" in vector) || typeof vector.digest !== "string") throw new Error(`golden descriptor vector ${name} is missing`);
  return vector.digest;
}

function options(overrides: Partial<AddressedSharePublishOptions>): AddressedSharePublishOptions {
  const refuse = async (): Promise<never> => { throw new Error("authority must not be reached"); };
  return {
    shareId: "emailpublish000000001", shareOrigin: "https://share.tinycloud.xyz", nodeOrigin: "https://node.example",
    nodeAudience: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", enforcerDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    spaceId: "tinycloud:test-space", target: { kind: "email", address: "reader@tinycloud.xyz" },
    resource: { kind: "exact", path: "shares/emailpublish000000001/readme.md" },
    actions: ["read"], policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource: { shareId: "emailpublish000000001", kvResource: "tinycloud:test-space/kv/shares/emailpublish000000001/readme.md", selector: "exact", encryptionNetwork: "urn:tinycloud:encryption:did:key:z:default", encryptedSymmetricKeyDigestHex: "1".repeat(64), keyVersion: 1, mode: "immutable", initialCiphertextDigestHex: "2".repeat(64) },
    credentialRequirement: addressedCredentialRequirement({ kind: "email", address: "reader@tinycloud.xyz" }),
    filename: "readme.md", mediaType: "text/markdown", byteLength: 8, expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    authority: { ownerDid: "did:key:z6MkOwner", createOwnerRoot: refuse, sign: refuse, registerPolicy: refuse },
    ...overrides,
  };
}

describe("mailbox credential commitments", () => {
  it("commit to the requirement the receiver rebuilds from the canonical recipient", () => {
    const commitment = addressedCredentialRequirement({ kind: "email", address: "reader@tinycloud.xyz" });
    const profile = { id: "tinycloud.email-proof/v1", version: 1 };
    const credentialType = { id: "opencredentials.email/v1", version: 1 };
    expect(commitment.requirementDigest).toBe(digest({ type: "TinyCloudCredentialRequirement", version: 1, profile, credentialType, claims: { email: "reader@tinycloud.xyz" }, maxAgeSeconds: 3600 }));
    expect(commitment).toMatchObject({ profile, credentialType, issuerDid: "did:web:issuer.credentials.org", issuerKid: "did:web:issuer.credentials.org#controller" });
    expect(commitment.descriptorDigest).toBe(goldenDescriptorDigest("email"));
    const domain = addressedCredentialRequirement({ kind: "emailDomain", domain: "TinyCloud.xyz" });
    expect(domain.requirementDigest).toBe(digest({ type: "TinyCloudCredentialRequirement", version: 1, profile: { id: "tinycloud.email-domain-proof/v1", version: 1 }, credentialType, claims: { emailDomain: "tinycloud.xyz" }, maxAgeSeconds: 300 }));
    expect(domain.descriptorDigest).toBe(goldenDescriptorDigest("email-domain-proof-v1"));
  });

  it("canonicalize a mixed-case mailbox to the lowercase form the issuer accepts", async () => {
    expect(normalizeShareTarget({ kind: "email", address: "Reader@TinyCloud.XYZ" })).toEqual({ kind: "email", address: "reader@tinycloud.xyz" });
    const lowercase = addressedCredentialRequirement({ kind: "email", address: "reader@tinycloud.xyz" });
    expect(addressedCredentialRequirement({ kind: "email", address: "Reader@TinyCloud.XYZ" })).toEqual(lowercase);
    expect(prepareAddressedShare({ target: { kind: "email", address: "Reader@TinyCloud.XYZ" }, actions: ["read"], policyActions: ["tinycloud.kv/get"], filename: "readme.md" }))
      .toEqual({ target: { kind: "email", address: "reader@tinycloud.xyz" }, credentialRequirement: lowercase });
    // A sender that canonicalizes the mailbox itself passes the guard for mixed-case input.
    await expect(publishAddressedShare(options({ target: { kind: "email", address: "Reader@TinyCloud.XYZ" }, credentialRequirement: lowercase }))).rejects.toThrow("authority must not be reached");
  });

  it("refuse recipients the issuer or receiver would reject", () => {
    for (const address of ["reader@tinycloud.123", "reader@localhost", "a%b@tinycloud.xyz", "reader@tinycloud..xyz", "@tinycloud.xyz"]) {
      expect(() => normalizeShareTarget({ kind: "email", address })).toThrow("recipient email is invalid");
    }
    for (const domain of ["example.123", "localhost", "tinycloud.xyz.", "192.168.0.1", "-tc.xyz"]) {
      expect(() => normalizeShareTarget({ kind: "emailDomain", domain })).toThrow("recipient email domain is invalid");
    }
  });
});

describe("addressed publication preflight", () => {
  it("TC-530: leaves domain access and delivery to the owner, and refuses bad input without touching any authority", () => {
    const request = { target: { kind: "emailDomain" as const, domain: "tinycloud.xyz" }, actions: ["read", "edit"] as const, policyActions: ["tinycloud.kv/get", "tinycloud.kv/put"] as const, filename: "readme.md" };
    // Edit access and a pinned mailbox at the domain are the owner's choice.
    expect(prepareAddressedShare(request).target).toEqual({ kind: "emailDomain", domain: "tinycloud.xyz" });
    expect(prepareAddressedShare({ ...request, deliveryEmail: "reader@tinycloud.xyz" }).credentialRequirement?.profile).toEqual({ id: "tinycloud.email-domain-proof/v1", version: 1 });
    // A pinned mailbox elsewhere, or not in the issuer's lowercase form, is refused before any side effect.
    for (const outside of ["reader@other.xyz", "reader@sub.tinycloud.xyz", "Reader@tinycloud.xyz"]) {
      expect(() => prepareAddressedShare({ ...request, deliveryEmail: outside }), outside).toThrow("lowercase mailbox at the domain");
    }
    expect(() => prepareAddressedShare({ ...request, policyActions: ["tinycloud.kv/get", "tinycloud.kv/delete" as never] })).toThrow("not supported");
    expect(() => prepareAddressedShare({ ...request, filename: "../readme.md" })).toThrow("addressed filename is invalid");
  });

  it("refuses a delivery address the envelope schema would reject before any side effect", () => {
    const request = { actions: ["read"] as const, policyActions: ["tinycloud.kv/get"] as const, filename: "readme.md" };
    // Mailboxes the issuer accepts but deployed viewers' envelope schema does not.
    for (const address of ["a/b@tinycloud.xyz", "reader@tinycloud.xn--p1ai"]) {
      expect(() => prepareAddressedShare({ ...request, target: { kind: "email", address }, deliveryEmail: address }), address).toThrow("delivery email is not a valid envelope address");
    }
    expect(prepareAddressedShare({ ...request, target: { kind: "email", address: "reader@tinycloud.xyz" }, deliveryEmail: "reader@tinycloud.xyz" }).target).toEqual({ kind: "email", address: "reader@tinycloud.xyz" });
  });
});

describe("exact-email publication guards", () => {
  it("refuses an email share no receiver could open before any authority is used", async () => {
    // Without a commitment the SDK would sign Policy/v1 (TC-556).
    await expect(publishAddressedShare(options({ credentialRequirement: undefined }))).rejects.toThrow("email shares require a credential requirement");
    await expect(publishAddressedShare(options({ credentialRequirement: addressedCredentialRequirement({ kind: "email", address: "other@tinycloud.xyz" }) }))).rejects.toThrow("not bound to the email address");
    // A domain commitment, an unknown descriptor or another issuer cannot back an exact-email share.
    await expect(publishAddressedShare(options({ credentialRequirement: addressedCredentialRequirement({ kind: "emailDomain", domain: "tinycloud.xyz" }) }))).rejects.toThrow("email credential profile");
    const exact = addressedCredentialRequirement({ kind: "email", address: "reader@tinycloud.xyz" });
    await expect(publishAddressedShare(options({ credentialRequirement: { ...exact, descriptorDigest: "7UoA6-MTjKThr4wbNdsjasZ6Pxk8XT4Kz-9aN-Uhn9I" } }))).rejects.toThrow("email credential profile");
    await expect(publishAddressedShare(options({ credentialRequirement: { ...exact, issuerDid: "did:web:issuer.example" } }))).rejects.toThrow("email credential profile");
    // A well-formed exact-email share proceeds to the owner's authority.
    await expect(publishAddressedShare(options({}))).rejects.toThrow("authority must not be reached");
  });
});
