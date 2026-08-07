import {
  createStoredCredentialRecord,
  credentialMatchesRequirement,
  type CredentialRequirement,
  type StoredCredentialRecord,
  type VerifiedCredential,
} from "@tinycloud/sdk-core";
import type { ReceiverCredentialCustody } from "../credentials";
import type { ReceiverSessionStorage } from "./receiver-session";

const STORE_KEY = "tinycloud.share.receiver-credentials.v1";
const MAX_CREDENTIALS = 8;

interface ReceiverCredentialEntry {
  readonly holderDid: string;
  readonly requirementDigest: string;
  readonly expiresAt: string;
  readonly record: StoredCredentialRecord;
}

function entries(storage: ReceiverSessionStorage, now: Date): ReceiverCredentialEntry[] {
  const raw = storage.getItem(STORE_KEY);
  if (raw === null) return [];
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.type !== "TinyCloudShareReceiverCredentials" || value.version !== 1 || !Array.isArray(value.entries) || Object.keys(value).sort().join(",") !== "entries,type,version") throw new Error("invalid");
    return value.entries.filter((entry): entry is ReceiverCredentialEntry => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const item = entry as unknown as Record<string, unknown>;
      const record = item.record as Record<string, unknown> | undefined;
      return Object.keys(item).sort().join(",") === "expiresAt,holderDid,record,requirementDigest" && typeof item.holderDid === "string" && typeof item.requirementDigest === "string" && typeof item.expiresAt === "string" && Date.parse(item.expiresAt) > now.getTime() && record?.type === "TinyCloudStoredCredential" && record.version === 1 && record.holderDid === item.holderDid && record.requirementDigest === item.requirementDigest && record.expiresAt === item.expiresAt;
    }).slice(0, MAX_CREDENTIALS);
  } catch {
    storage.removeItem(STORE_KEY);
    return [];
  }
}

function save(storage: ReceiverSessionStorage, value: readonly ReceiverCredentialEntry[]): void {
  storage.setItem(STORE_KEY, JSON.stringify({ type: "TinyCloudShareReceiverCredentials", version: 1, entries: value.slice(0, MAX_CREDENTIALS) }));
}

export class SessionReceiverCredentialCustody implements ReceiverCredentialCustody {
  constructor(private readonly storage: ReceiverSessionStorage = window.sessionStorage) {}

  async find(input: { readonly requirement: CredentialRequirement; readonly requirementDigest: string; readonly holderDid: string; readonly now?: Date }): Promise<StoredCredentialRecord | undefined> {
    const now = input.now ?? new Date();
    const active = entries(this.storage, now);
    save(this.storage, active);
    const found = active.find((entry) => entry.holderDid === input.holderDid && entry.requirementDigest === input.requirementDigest);
    return found !== undefined && credentialMatchesRequirement(input.requirement, found.record, input.holderDid, now) ? found.record : undefined;
  }

  async store(input: { readonly verified: VerifiedCredential; readonly requirement: CredentialRequirement; readonly requirementDigest: string; readonly holderDid: string; readonly now?: Date }): Promise<StoredCredentialRecord> {
    if (input.verified.holderDid !== input.holderDid || input.verified.subjectDid !== input.holderDid) throw new Error("receiver credential holder mismatch");
    const now = input.now ?? new Date();
    const record = await createStoredCredentialRecord({ verified: input.verified, ownerDid: input.holderDid, requirement: input.requirement, requirementDigest: input.requirementDigest, storedAt: now.toISOString() });
    const next = entries(this.storage, now).filter((entry) => entry.holderDid !== input.holderDid || entry.requirementDigest !== input.requirementDigest);
    next.unshift({ holderDid: input.holderDid, requirementDigest: input.requirementDigest, expiresAt: record.expiresAt, record });
    save(this.storage, next);
    return record;
  }
}
