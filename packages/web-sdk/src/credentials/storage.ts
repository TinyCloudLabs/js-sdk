import {
  CredentialError,
  canonicalDigest,
  createStorageReceipt,
  createStoredCredentialRecord,
  credentialIndexKey,
  credentialMatchesRequirement,
  credentialRecordKey,
  verifyStorageReceipt,
  type CredentialRequirement,
  type CredentialStorageReceipt,
  type IKVService,
  type StoredCredentialRecord,
  type VerifiedCredential,
} from "@tinycloud/sdk-core";

function stored(value: unknown): value is StoredCredentialRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.type === "TinyCloudStoredCredential" && item.version === 1 && typeof item.ownerDid === "string" && typeof item.recordId === "string" && typeof item.credential === "string" && typeof item.credentialDigest === "string" && typeof item.expiresAt === "string";
}

export async function findStoredCredential(input: { readonly kv: IKVService; readonly requirement: CredentialRequirement; readonly holderDid: string; readonly now?: Date }): Promise<StoredCredentialRecord | undefined> {
  const listing = await input.kv.list({ prefix: "v1/records/" });
  if (!listing.ok) return undefined;
  for (const key of listing.data.keys.sort()) {
    const result = await input.kv.get<StoredCredentialRecord>(key);
    if (result.ok && stored(result.data.data) && credentialMatchesRequirement(input.requirement, result.data.data, input.holderDid, input.now)) return result.data.data;
  }
  return undefined;
}

export async function storeCredential(input: { readonly kv: IKVService; readonly verified: VerifiedCredential; readonly requirement: CredentialRequirement; readonly requirementDigest: string; readonly activeOwnerDid: string; readonly now?: Date }): Promise<{ readonly record: StoredCredentialRecord; readonly receipt: CredentialStorageReceipt }> {
  if (input.verified.holderDid !== input.activeOwnerDid) throw new CredentialError("HOLDER_MISMATCH", "Credential holder does not match storage owner");
  const record = await createStoredCredentialRecord({ verified: input.verified, ownerDid: input.activeOwnerDid, requirement: input.requirement, requirementDigest: input.requirementDigest, storedAt: (input.now ?? new Date()).toISOString() });
  const index = { type: "TinyCloudCredentialIndex", version: 1, ownerDid: input.activeOwnerDid, recordId: record.recordId, requirementDigest: input.requirementDigest, claimsDigest: record.claimsDigest, expiresAt: record.expiresAt };
  const written = await input.kv.batchPut([{ key: credentialRecordKey(record.recordId), value: record }, { key: credentialIndexKey(input.requirementDigest, record.recordId), value: index }]);
  if (!written.ok) throw new CredentialError("VERIFIED_NOT_SAVED", "Verified credential could not be saved");
  const readback = await input.kv.get<StoredCredentialRecord>(credentialRecordKey(record.recordId));
  if (!readback.ok || !stored(readback.data.data) || await canonicalDigest(readback.data.data) !== await canonicalDigest(record)) throw new CredentialError("VERIFIED_NOT_SAVED", "Credential durable storage could not be confirmed");
  const receipt = await createStorageReceipt(readback.data.data, readback.data.headers.etag);
  if (!(await verifyStorageReceipt(readback.data.data, receipt, input.activeOwnerDid))) throw new CredentialError("VERIFIED_NOT_SAVED", "Credential storage receipt is invalid");
  return { record: readback.data.data, receipt };
}
