import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalize, toBase64Url } from "@tinycloud/share-envelope";
import { addressedCredentialRequirement, publishAddressedShare, type AddressedSharePublishOptions } from "../src/index.js";

const digest = (value: unknown) => toBase64Url(sha256(new TextEncoder().encode(canonicalize(value))));
const golden: unknown = JSON.parse(readFileSync(new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url), "utf8"));

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
  it("commit to the requirement the receiver rebuilds from the normalized recipient", () => {
    const commitment = addressedCredentialRequirement({ kind: "email", address: "Reader@TinyCloud.XYZ" });
    const profile = { id: "tinycloud.email-proof/v1", version: 1 };
    const credentialType = { id: "opencredentials.email/v1", version: 1 };
    // The envelope's matcher keeps the local part and lowercases the domain.
    expect(commitment.requirementDigest).toBe(digest({ type: "TinyCloudCredentialRequirement", version: 1, profile, credentialType, claims: { email: "Reader@tinycloud.xyz" }, maxAgeSeconds: 3600 }));
    expect(commitment).toMatchObject({ profile, credentialType, issuerDid: "did:web:issuer.credentials.org", issuerKid: "did:web:issuer.credentials.org#controller" });
    const domain = addressedCredentialRequirement({ kind: "emailDomain", domain: "TinyCloud.xyz" });
    expect(domain.requirementDigest).toBe(digest({ type: "TinyCloudCredentialRequirement", version: 1, profile: { id: "tinycloud.email-domain-proof/v1", version: 1 }, credentialType, claims: { emailDomain: "tinycloud.xyz" }, maxAgeSeconds: 300 }));
    // The descriptors the issuer serves for each profile.
    expect(golden).toMatchObject({ vectors: [{ name: "email", digest: commitment.descriptorDigest }, { name: "synthetic-handle" }, { name: "email-domain-proof-v1", digest: domain.descriptorDigest }] });
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
