import { canonicalDigest } from "./digest";
import type { CredentialRequirement, CredentialStorageReceipt, StoredCredentialRecord, VerifiedCredential } from "./types";

export function credentialRecordKey(recordId: string): string { return `v1/records/${recordId}`; }
export function credentialIndexKey(requirementDigest: string, recordId: string): string { return `v1/index/${requirementDigest}/${recordId}`; }

export async function createStoredCredentialRecord(input: { readonly verified: VerifiedCredential; readonly ownerDid: string; readonly requirement: CredentialRequirement; readonly requirementDigest: string; readonly storedAt?: string }): Promise<StoredCredentialRecord> {
  const storedAt = input.storedAt ?? new Date().toISOString();
  const recordId = await canonicalDigest({ credentialDigest: input.verified.credentialDigest, holderDid: input.ownerDid });
  return Object.freeze({ type: "TinyCloudStoredCredential", version: 1, ownerDid: input.ownerDid, recordId, requirementDigest: input.requirementDigest, descriptorDigest: input.verified.descriptorDigest, profile: input.verified.profile, credentialType: input.verified.credentialType, issuerDid: input.verified.issuerDid, issuerKid: input.verified.issuerKid, holderDid: input.verified.holderDid, claims: input.verified.claims, claimsDigest: input.verified.claimsDigest, credentialDigest: input.verified.credentialDigest, credential: input.verified.credential, schema: input.verified.schema, credentialId: input.verified.credentialId, issuedAt: input.verified.issuedAt, notBefore: input.verified.notBefore, expiresAt: input.verified.expiresAt, status: input.verified.status, verifiedAt: input.verified.verifiedAt, storedAt });
}

export async function createStorageReceipt(record: StoredCredentialRecord, etag?: string): Promise<CredentialStorageReceipt> {
  return Object.freeze({ type: "TinyCloudCredentialStorageReceipt", version: 1, ownerDid: record.ownerDid, recordId: record.recordId, recordDigest: await canonicalDigest(record), storedAt: record.storedAt, ...(etag === undefined ? {} : { etag }) });
}

export async function verifyStorageReceipt(record: StoredCredentialRecord, receipt: CredentialStorageReceipt, activeOwnerDid: string): Promise<boolean> {
  return receipt.type === "TinyCloudCredentialStorageReceipt" && receipt.version === 1 && receipt.ownerDid === activeOwnerDid && record.ownerDid === activeOwnerDid && record.holderDid === activeOwnerDid && receipt.recordId === record.recordId && receipt.storedAt === record.storedAt && receipt.recordDigest === await canonicalDigest(record);
}
