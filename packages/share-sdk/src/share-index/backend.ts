import { SHARE_RECORDS_VAULT_PREFIX } from "./ids.js";
import { OwnerUnwrapUnavailableError, type OwnerNetworkUnwrap, type OwnerNetworkWrap } from "./agent-record.js";

/**
 * Storage port of the share index (design C §1, §4). Every key is relative to
 * `sender-history/v2/records/`. The port is structural so share-sdk does not
 * depend on the TinyCloud SDK packages; {@link createTinyCloudShareIndexBackend}
 * adapts a TinyCloud client (node or web SDK) to it.
 */
export type ShareDocumentRead =
  | { readonly status: "ok"; readonly value: unknown; readonly etag: string }
  | { readonly status: "not_found" }
  /** Deterministic corruption (bad envelope, AAD bound elsewhere, undecodable payload). */
  | { readonly status: "corrupt"; readonly etag?: string }
  /** Outage or transient failure: never a reason to rebuild. */
  | { readonly status: "unavailable" };

export type ShareRawRead =
  | { readonly status: "ok"; readonly bytes: Uint8Array; readonly etag: string }
  | { readonly status: "not_found" }
  | { readonly status: "unavailable" };

export type ShareWriteCondition = { readonly ifMatch: string } | { readonly ifNoneMatch: "*" };

export type ShareWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "conflict" | "outcome_unknown" | "busy" | "unauthorized" | "failed" }
  /** The etag was refused as malformed (for example weakened to `W/"…"` in transit). Never retried; `message` is the SDK's own. */
  | { readonly ok: false; readonly code: "invalid_etag"; readonly message: string };

export type ShareListResult =
  | { readonly status: "ok"; readonly keys: readonly string[]; readonly cursor?: string }
  | { readonly status: "unavailable" };

export interface ShareIndexBackend {
  readonly spaceId: string;
  readonly ownerNetworkId: string;
  /** Owner-network vault read with the slice-1 AAD check, from the network (never a replica). */
  readVault(key: string): Promise<ShareDocumentRead>;
  /** Owner-network vault write: a fresh envelope each time; conditional when `condition` is set. */
  writeVault(key: string, value: unknown, condition?: ShareWriteCondition): Promise<ShareWriteResult>;
  /** Delete a record; an absent key counts as success. */
  deleteRecord(key: string): Promise<ShareWriteResult>;
  /** One page of keys under `prefix` (relative, with its trailing slash, or "" for all records). */
  listKeys(prefix: string, cursor?: string): Promise<ShareListResult>;
  /** Raw stored bytes and etag (agent records), from the network. */
  readRaw(key: string): Promise<ShareRawRead>;
  writeRaw(key: string, value: Readonly<Record<string, unknown>>, condition: ShareWriteCondition): Promise<ShareWriteResult>;
  readonly ownerWrap: OwnerNetworkWrap;
  /** Owner-network decrypt; absent for Tier W agents, which have no decrypt grant. */
  readonly ownerUnwrap?: OwnerNetworkUnwrap;
}

/** The vault's classified network read (`readNetworkEncrypted`), as this adapter consumes it. */
export interface VaultNetworkRead {
  readonly status: string;
  readonly entry?: { readonly value: unknown; readonly etag?: string };
}

type SdkResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string; readonly meta?: Record<string, unknown> } };

/** The subset of a TinyCloud client the adapter uses (node-sdk `TinyCloudNode` or the web SDK). */
export interface TinyCloudShareIndexClient {
  readonly vault: {
    readNetworkEncrypted(key: string, options: { readonly expectAad: true }): Promise<VaultNetworkRead>;
    put(key: string, value: unknown, options?: { readonly ifMatch?: string; readonly ifNoneMatch?: "*" }): Promise<SdkResult<unknown>>;
    delete(key: string): Promise<SdkResult<unknown>>;
  };
  readonly kv: {
    get(key: string, options: { readonly prefix: ""; readonly raw: true; readonly source: "network" }): Promise<SdkResult<{ readonly data: unknown; readonly headers: { readonly etag?: string } }>>;
    put(key: string, value: unknown, options: { readonly prefix: ""; readonly ifMatch?: string; readonly ifNoneMatch?: "*" }): Promise<SdkResult<unknown>>;
    list(options: { readonly prefix: string; readonly removePrefix: true; readonly limit: number; readonly cursor?: string; readonly source: "network" }): Promise<SdkResult<{ readonly keys: readonly string[]; readonly nextCursor?: string; readonly truncated?: boolean }>>;
  };
  readonly encryption: {
    encryptToNetwork(networkId: string, plaintext: Uint8Array, options: { readonly aad: Uint8Array }): Promise<SdkResult<object>>;
    decryptEnvelope?(envelope: never, proof: { readonly proofs: readonly string[] }, options: { readonly aad: Uint8Array }): Promise<SdkResult<Uint8Array>>;
  };
}

/** Shown when the SDK reports `INVALID_ETAG` without a message of its own. */
export const INVALID_ETAG_MESSAGE = "etag was weakened in transit; compare-and-swap unavailable through this path";

/** Map an SDK write error. `invalid_etag` only applies to an `ifMatch` write: another 400 is a plain failure. */
function writeFailure(error: { readonly code: string; readonly message?: string; readonly meta?: Record<string, unknown> }, condition: ShareWriteCondition | undefined): ShareWriteResult {
  const status = typeof error.meta?.status === "number" ? error.meta.status : undefined;
  if (error.code === "KV_PRECONDITION_FAILED" || error.code === "ETAG_MISMATCH" || error.code === "ALREADY_EXISTS") return { ok: false, code: "conflict" };
  if (condition !== undefined && "ifMatch" in condition && (error.code === "INVALID_ETAG" || (error.code === "KV_WRITE_FAILED" && status === 400))) return { ok: false, code: "invalid_etag", message: error.message ?? INVALID_ETAG_MESSAGE };
  if (error.code === "OUTCOME_UNKNOWN" || ((error.code === "NETWORK_ERROR" || error.code === "TIMEOUT") && status === undefined)) return { ok: false, code: "outcome_unknown" };
  if (error.code === "NODE_BUSY" || error.code === "REQUEST_TIMEOUT") return { ok: false, code: "busy" };
  if (error.code === "AUTH_UNAUTHORIZED" || error.code === "PERMISSION_DENIED") return { ok: false, code: "unauthorized" };
  return { ok: false, code: "failed" };
}

/** Keys per list page: the node's maximum. */
const LIST_PAGE_SIZE = 1000;

function bytesOf(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data !== null && typeof data === "object") return new TextEncoder().encode(JSON.stringify(data));
  return undefined;
}

export interface TinyCloudShareIndexBackendOptions {
  readonly client: TinyCloudShareIndexClient;
  readonly spaceId: string;
  readonly ownerNetworkId: string;
  /** The decrypt capability proof of the owner session (`{ proofs: [session.delegationCid] }`). Omit for Tier W agents. */
  readonly decryptProof?: () => { readonly proofs: readonly string[] };
  /**
   * The KV prefix every key here sits under: `vault/sender-history/v2/records/`
   * for a client whose KV service has no prefix of its own.
   */
  readonly kvRecordsPrefix?: string;
}

/** Adapt a TinyCloud client (owner web, owner-key CLI, Tier 2 or Tier W agent) to {@link ShareIndexBackend}. */
export function createTinyCloudShareIndexBackend(options: TinyCloudShareIndexBackendOptions): ShareIndexBackend {
  const { client } = options;
  const kvPrefix = options.kvRecordsPrefix ?? `vault/${SHARE_RECORDS_VAULT_PREFIX}`;
  const rawEtag = async (key: string): Promise<string | undefined> => {
    try {
      const raw = await client.kv.get(`${kvPrefix}${key}`, { prefix: "", raw: true, source: "network" });
      return raw.ok ? raw.data.headers.etag : undefined;
    } catch {
      return undefined;
    }
  };
  const decryptProof = options.decryptProof;
  const decryptEnvelope = client.encryption.decryptEnvelope;
  return {
    spaceId: options.spaceId,
    ownerNetworkId: options.ownerNetworkId,
    async readVault(key) {
      let result: VaultNetworkRead;
      try { result = await client.vault.readNetworkEncrypted(`${SHARE_RECORDS_VAULT_PREFIX}${key}`, { expectAad: true }); } catch { return { status: "unavailable" }; }
      if (result.status === "ok" && result.entry !== undefined && typeof result.entry.etag === "string") return { status: "ok", value: result.entry.value, etag: result.entry.etag };
      if (result.status === "not_found") return { status: "not_found" };
      if (result.status === "corrupt_envelope" || result.status === "invalid_payload" || result.status === "aad_mismatch") {
        const etag = await rawEtag(key);
        return etag === undefined ? { status: "corrupt" } : { status: "corrupt", etag };
      }
      return { status: "unavailable" };
    },
    async writeVault(key, value, condition) {
      try {
        const result = await client.vault.put(`${SHARE_RECORDS_VAULT_PREFIX}${key}`, value, condition ?? {});
        return result.ok ? { ok: true } : writeFailure(result.error, condition);
      } catch {
        return { ok: false, code: "outcome_unknown" };
      }
    },
    async deleteRecord(key) {
      try {
        const result = await client.vault.delete(`${SHARE_RECORDS_VAULT_PREFIX}${key}`);
        if (result.ok || result.error.code === "KEY_NOT_FOUND" || result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") return { ok: true };
        return writeFailure(result.error, undefined);
      } catch {
        return { ok: false, code: "outcome_unknown" };
      }
    },
    async listKeys(prefix, cursor) {
      try {
        // The node pages only when a limit is sent, and refuses a cursor without one.
        const result = await client.kv.list({ prefix: `${kvPrefix}${prefix}`, removePrefix: true, limit: LIST_PAGE_SIZE, source: "network", ...(cursor === undefined ? {} : { cursor }) });
        if (!result.ok) return { status: "unavailable" };
        // Keys come back relative to the listed prefix; re-anchor them on `records/`.
        const keys = result.data.keys.map((key) => `${prefix}${key}`);
        return result.data.nextCursor === undefined ? { status: "ok", keys } : { status: "ok", keys, cursor: result.data.nextCursor };
      } catch {
        return { status: "unavailable" };
      }
    },
    async readRaw(key) {
      try {
        const result = await client.kv.get(`${kvPrefix}${key}`, { prefix: "", raw: true, source: "network" });
        if (!result.ok) return result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND" ? { status: "not_found" } : { status: "unavailable" };
        const bytes = bytesOf(result.data.data);
        const etag = result.data.headers.etag;
        return bytes === undefined || etag === undefined ? { status: "unavailable" } : { status: "ok", bytes, etag };
      } catch {
        return { status: "unavailable" };
      }
    },
    async writeRaw(key, value, condition) {
      try {
        const result = await client.kv.put(`${kvPrefix}${key}`, value, { prefix: "", ...condition });
        return result.ok ? { ok: true } : writeFailure(result.error, condition);
      } catch {
        return { ok: false, code: "outcome_unknown" };
      }
    },
    ownerWrap: {
      async wrap(dek, aad) {
        const result = await client.encryption.encryptToNetwork(options.ownerNetworkId, dek, { aad });
        if (!result.ok) throw new Error("owner-network wrap failed");
        return Object.fromEntries(Object.entries(result.data));
      },
    },
    ...(decryptProof === undefined || decryptEnvelope === undefined ? {} : {
      ownerUnwrap: {
        async unwrap(envelope, aad) {
          // `aad` makes the SDK compare the envelope's declared AAD before any decrypt request.
          let result: SdkResult<Uint8Array>;
          try {
            result = await decryptEnvelope.call(client.encryption, envelope as never, decryptProof(), { aad });
          } catch {
            throw new OwnerUnwrapUnavailableError();
          }
          // TRANSPORT_ERROR is an outage; DECRYPT_DENIED, INVALID_INPUT and INVALID_RESPONSE are refusals.
          if (!result.ok) throw result.error.code === "TRANSPORT_ERROR" ? new OwnerUnwrapUnavailableError() : new Error("owner-network unwrap was refused");
          return result.data;
        },
      },
    }),
  };
}
