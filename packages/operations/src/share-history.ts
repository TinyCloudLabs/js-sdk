import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SenderShareRecord, SenderShareRecordStorage } from "@tinycloud/share-sdk";
import { profilePath, readProfile, withProfileLock, writeJsonAtomic } from "./state.js";

const HISTORY_FILE = "share-history-v2.json";
const LEGACY_HISTORY_FILE = "share-history-v1.bin";
const HISTORY_VERSION = 2;
const PBKDF2_ITERATIONS = 100_000;
const PRIVATE_DIR_MODE = 0o700;
const HISTORY_KEY_DOMAIN = "xyz.tinycloud.share/history-key/v1";

export interface ProfileShareHistoryInput {
  profile: string;
  /** Signs the bytes that seed the history key of a profile without a local private key. */
  signSessionBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
}

/** The history file exists but cannot be decrypted or parsed with the profile's key. It is never overwritten. */
export class ShareHistoryUnreadableError extends Error {
  constructor() {
    super("The sender share history could not be read with this profile's key. It was left unchanged.");
    this.name = "ShareHistoryUnreadableError";
  }
}

interface HistoryKeys {
  readonly secret: Uint8Array;
  readonly material: CryptoKey;
}

const encode = (value: Uint8Array): string => Buffer.from(value).toString("base64url");

function decode(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ShareHistoryUnreadableError();
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  if (encode(bytes) !== value) throw new ShareHistoryUnreadableError();
  return bytes;
}

const isStoredRecord = (value: unknown): value is SenderShareRecord =>
  typeof value === "object" && value !== null && "shareId" in value && typeof value.shareId === "string";

async function readIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("The sender share history could not be read.", { cause: error });
  }
}

async function decryptRecords(key: CryptoKey, iv: Uint8Array, ciphertext: Uint8Array): Promise<SenderShareRecord[]> {
  try {
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const values = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return Array.isArray(values) ? values.filter(isStoredRecord) : [];
  } catch {
    throw new ShareHistoryUnreadableError();
  }
}

const deriveKey = (material: CryptoKey, salt: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );

/**
 * The sender history the CLI keeps for a profile: the same encrypted file
 * under the same profile lock, so a CLI process and an MCP process see one
 * history and serialize their changes.
 */
export function openProfileShareHistory(input: ProfileShareHistoryInput): SenderShareRecordStorage {
  const { profile } = input;

  // Signing may use the network, so it happens before the profile lock is taken.
  const prepareKeys = async (): Promise<HistoryKeys> => {
    const stored = await readProfile<{ privateKey?: unknown }>(profile);
    if (stored === null) throw new Error(`Profile "${profile}" does not exist.`);
    const secret = typeof stored.privateKey === "string" && stored.privateKey.length > 0
      ? new TextEncoder().encode(stored.privateKey)
      : await input.signSessionBytes(new TextEncoder().encode(HISTORY_KEY_DOMAIN));
    return { secret, material: await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveKey"]) };
  };

  const locked = async <T>(action: (read: () => Promise<SenderShareRecord[]>, write: (records: readonly SenderShareRecord[]) => Promise<void>) => Promise<T>): Promise<T> => {
    const keys = await prepareKeys();
    return withProfileLock(profile, async () => {
      const directory = join(profilePath(profile), "cache");
      await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
      await chmod(directory, PRIVATE_DIR_MODE);
      const file = join(directory, HISTORY_FILE);
      let salt: Uint8Array | undefined;
      let key: CryptoKey | undefined;

      const read = async (): Promise<SenderShareRecord[]> => {
        const bytes = await readIfPresent(file);
        if (bytes === undefined) {
          const legacy = await readIfPresent(join(directory, LEGACY_HISTORY_FILE));
          if (legacy === undefined || legacy.length <= 12) return [];
          const legacyKey = await crypto.subtle.importKey("raw", createHash("sha256").update(keys.secret).digest(), { name: "AES-GCM" }, false, ["decrypt"]);
          return decryptRecords(legacyKey, new Uint8Array(legacy.subarray(0, 12)), new Uint8Array(legacy.subarray(12)));
        }
        let envelope: unknown;
        try {
          envelope = JSON.parse(bytes.toString("utf8"));
        } catch {
          throw new ShareHistoryUnreadableError();
        }
        if (typeof envelope !== "object" || envelope === null || (envelope as Record<string, unknown>).version !== HISTORY_VERSION) {
          throw new ShareHistoryUnreadableError();
        }
        const stored = envelope as Record<string, unknown>;
        salt = decode(stored.kdfSalt);
        if (salt.length < 16) throw new ShareHistoryUnreadableError();
        const iv = decode(stored.iv);
        const ciphertext = decode(stored.ciphertext);
        if (iv.length !== 12 || ciphertext.length <= 16) throw new ShareHistoryUnreadableError();
        key = await deriveKey(keys.material, salt);
        return decryptRecords(key, iv, ciphertext);
      };

      const write = async (records: readonly SenderShareRecord[]): Promise<void> => {
        salt ??= crypto.getRandomValues(new Uint8Array(16));
        key ??= await deriveKey(keys.material, salt);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(records))));
        await writeJsonAtomic(file, { version: HISTORY_VERSION, kdfSalt: encode(salt), iv: encode(iv), ciphertext: encode(encrypted) });
      };

      return action(read, write);
    }, { requireProfile: true });
  };

  return {
    put: (record) => locked(async (read, write) => {
      const records = await read();
      const index = records.findIndex((value) => value.shareId === record.shareId);
      if (index >= 0) records[index] = record;
      else records.push(record);
      await write(records);
    }),
    update: (shareId, change) => locked(async (read, write) => {
      const records = await read();
      const index = records.findIndex((record) => record.shareId === shareId);
      if (index < 0) return undefined;
      const updated = await change(records[index]!);
      records[index] = updated;
      await write(records);
      return updated;
    }),
    list: () => locked((read) => read()),
    get: (shareId) => locked(async (read) => (await read()).find((record) => record.shareId === shareId)),
    delete: (shareId) => locked(async (read, write) => {
      await write((await read()).filter((record) => record.shareId !== shareId));
    }),
  };
}
