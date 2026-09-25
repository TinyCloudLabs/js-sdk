import { describe, expect, it } from "bun:test";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalize, toBase64Url } from "@tinycloud/share-envelope";
import { publishAddressedShare, type AddressedSharePublishOptions } from "../src/index.js";

const profile = { id: "tinycloud.email-domain-proof/v1", version: 1 } as const;
const credentialType = { id: "opencredentials.email/v1", version: 1 } as const;
const digest = (value: unknown) => toBase64Url(sha256(new TextEncoder().encode(canonicalize(value))));
const commitmentFor = (domain: string) => ({
  type: "TinyCloudPolicyCredentialRequirement" as const, version: 1 as const,
  requirementDigest: digest({ type: "TinyCloudCredentialRequirement", version: 1, profile, credentialType, claims: { emailDomain: domain }, maxAgeSeconds: 300 }),
  descriptorDigest: "33X5mAkZZgApdD3xh_T-3KS5moop0J2Nloi2nqWsdWY",
  issuerDid: "did:web:issuer.credentials.org", issuerKid: "did:web:issuer.credentials.org#controller",
  profile, credentialType,
});

function options(overrides: Partial<AddressedSharePublishOptions>): AddressedSharePublishOptions {
  const refuse = async (): Promise<never> => { throw new Error("authority must not be reached"); };
  return {
    shareId: "emaildomainpublish0001", shareOrigin: "https://share.tinycloud.xyz", nodeOrigin: "https://node.example",
    nodeAudience: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", enforcerDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    spaceId: "tinycloud:test-space", target: { kind: "emailDomain", domain: "tinycloud.xyz" },
    resource: { kind: "exact", path: "shares/emaildomainpublish0001/readme.md" },
    actions: ["read"], policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource: { shareId: "emaildomainpublish0001", kvResource: "tinycloud:test-space/kv/shares/emaildomainpublish0001/readme.md", selector: "exact", encryptionNetwork: "urn:tinycloud:encryption:did:key:z:default", encryptedSymmetricKeyDigestHex: "1".repeat(64), keyVersion: 1, mode: "immutable", initialCiphertextDigestHex: "2".repeat(64) },
    credentialRequirement: commitmentFor("tinycloud.xyz"),
    filename: "readme.md", mediaType: "text/markdown", byteLength: 8, expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    authority: { ownerDid: "did:key:z6MkOwner", createOwnerRoot: refuse, sign: refuse, registerPolicy: refuse },
    ...overrides,
  };
}

describe("email-domain publication guards", () => {
  it("refuses write access, delivery, and requirements not bound to the domain before any authority is used", async () => {
    await expect(publishAddressedShare(options({ actions: ["read", "edit"] }))).rejects.toThrow("view-only");
    await expect(publishAddressedShare(options({ policyActions: ["tinycloud.kv/get", "tinycloud.kv/put"] }))).rejects.toThrow("view-only");
    await expect(publishAddressedShare(options({ deliveryEmail: "reader@tinycloud.xyz" }))).rejects.toThrow("not emailed");
    await expect(publishAddressedShare(options({ credentialRequirement: undefined }))).rejects.toThrow("require a credential requirement");
    for (const other of ["sub.tinycloud.xyz", "tinycloud.xyz.evil", "evil.example"]) {
      await expect(publishAddressedShare(options({ credentialRequirement: commitmentFor(other) }))).rejects.toThrow("not bound to the email domain");
    }
    // The exact-email profile (looser mailbox rules, no domain limits) or an
    // unknown descriptor cannot back a domain share, nor can unknown actions.
    const exactProfile = { ...commitmentFor("tinycloud.xyz"), profile: { id: "tinycloud.email-proof/v1", version: 1 } } as never;
    await expect(publishAddressedShare(options({ credentialRequirement: exactProfile }))).rejects.toThrow("email-domain credential profile");
    await expect(publishAddressedShare(options({ credentialRequirement: { ...commitmentFor("tinycloud.xyz"), descriptorDigest: "1tg-qphmKBVtNwzVg9xyz-xxqt_xtMXAsQyXw46m8S0" } }))).rejects.toThrow("email-domain credential profile");
    await expect(publishAddressedShare(options({ policyActions: ["tinycloud.kv/get", "tinycloud.kv/delete" as never] }))).rejects.toThrow("view-only");
    // A well-formed domain share proceeds to the owner's authority.
    await expect(publishAddressedShare(options({}))).rejects.toThrow("authority must not be reached");
  });
});
