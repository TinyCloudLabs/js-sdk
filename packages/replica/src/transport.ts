import { ReplicaError, ReplicaErrorCode } from "./errors.js";
import type { AuthorityWindow, Change, FetchedContent, ReplicaTransport, SyncPage } from "./types.js";

/** The sdk-services `ServiceError` fields the transport reads. */
type ServiceError = { code: string; message: string; meta?: Record<string, unknown> };
type Result<T> = { ok: true; data: T } | { ok: false; error: ServiceError };

type KVChangesResponse = {
  changes: Change[];
  more: boolean;
  cursor: string;
  source: { nodeDid: string; space: string; prefix: string };
  authority: AuthorityWindow;
};

type KVValue = { data: unknown; headers: { etag?: string } };

/**
 * The slice of sdk-services `KVService` a replica needs: the `tinycloud.kv/sync`
 * feed (`changes`, TC-736) and binary reads. Typed structurally so this
 * package never imports an SDK entry point (web-sdk defines custom elements
 * on load; node-sdk pulls in Node-only code).
 */
export interface KVSyncClient {
  changes(options: {
    prefix: string;
    cursor?: string;
    limit?: number;
    retentionGrant?: string;
    signal?: AbortSignal;
  }): Promise<Result<KVChangesResponse>>;
  get(key: string, options: { binary: true; signal?: AbortSignal }): Promise<Result<KVValue>>;
  batchGet(
    keys: string[],
    options: { binary: true; signal?: AbortSignal },
  ): Promise<Result<{ results: Array<{ key: string; result: Result<KVValue> }> }>>;
}

/** TC-736 maps a revoked chain to these codes; older builds only carry the node's text. */
const REVOKED_CODES = new Set(["AUTH_DELEGATION_REVOKED", "AUTH_DELEGATION_ANCESTOR_REVOKED"]);
const REVOKED = /delegation-(?:ancestor-)?revoked/;

/** Map an SDK failure to the replica's typed errors. */
export function replicaErrorFromService(error: ServiceError, context: string): ReplicaError {
  const meta = error.meta ?? {};
  const status = typeof meta.status === "number" ? meta.status : undefined;
  const text = `${error.code} ${error.message}`;
  const detail = { serviceCode: error.code, ...(status === undefined ? {} : { status }) };
  if (error.code === "KV_SYNC_RESET_REQUIRED" || status === 410) {
    const reason = typeof meta.reason === "string" ? meta.reason : /position-unknown/.test(text) ? "position-unknown" : "cursor-invalid";
    return new ReplicaError(ReplicaErrorCode.RESET_REQUIRED, `${context}: the node requires a fresh bootstrap (${reason}).`, {
      ...detail,
      reason,
    });
  }
  if (REVOKED_CODES.has(error.code) || REVOKED.test(text)) {
    return new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, `${context}: ${error.message}`, detail);
  }
  if (/RETENTION_GRANT_REFUSED/.test(text)) {
    return new ReplicaError(ReplicaErrorCode.RETENTION_GRANT_REFUSED, `${context}: ${error.message}`, detail);
  }
  if (status === 401 || status === 403 || /^AUTH_/.test(error.code)) {
    if (/expired/i.test(error.message)) {
      return new ReplicaError(ReplicaErrorCode.GRANT_EXPIRED, `${context}: ${error.message}`, detail);
    }
    return new ReplicaError(ReplicaErrorCode.GRANT_UNAUTHORIZED, `${context}: ${error.message}`, detail);
  }
  if (status !== undefined) {
    return new ReplicaError(ReplicaErrorCode.NODE_ERROR, `${context}: ${error.message}`, detail);
  }
  if (error.code === "NETWORK_ERROR" || /TIMEOUT|ABORT/.test(error.code)) {
    return new ReplicaError(ReplicaErrorCode.NETWORK_ERROR, `${context}: ${error.message}`, detail);
  }
  return new ReplicaError(ReplicaErrorCode.NODE_ERROR, `${context}: ${error.message}`, detail);
}

function isNotFound(error: ServiceError): boolean {
  return error.code === "KV_NOT_FOUND" || error.code === "NOT_FOUND";
}

function checkPage(data: KVChangesResponse): SyncPage {
  const ok =
    data !== null &&
    typeof data === "object" &&
    Array.isArray(data.changes) &&
    typeof data.more === "boolean" &&
    typeof data.cursor === "string" &&
    typeof data.source?.nodeDid === "string" &&
    typeof data.source?.space === "string" &&
    typeof data.source?.prefix === "string" &&
    data.authority !== null &&
    typeof data.authority === "object" &&
    data.changes.every(
      (change) =>
        typeof change?.key === "string" &&
        (change.deleted === true ||
          (change.deleted === false &&
            typeof change.etag === "string" &&
            change.metadata !== null &&
            typeof change.metadata === "object" &&
            Object.values(change.metadata).every((value) => typeof value === "string"))),
    );
  if (!ok) throw new ReplicaError(ReplicaErrorCode.PROTOCOL_ERROR, "The kv/sync response does not match the wire contract.");
  const iso = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    changes: data.changes.map((change) =>
      change.deleted ? { key: change.key, deleted: true } : { key: change.key, deleted: false, etag: change.etag, metadata: { ...change.metadata } },
    ),
    more: data.more,
    cursor: data.cursor,
    source: { nodeDid: data.source.nodeDid, space: data.source.space, prefix: data.source.prefix },
    authority: {
      notBefore: iso(data.authority.notBefore),
      expiresAt: iso(data.authority.expiresAt),
      retainUntil: iso(data.authority.retainUntil),
    },
  };
}

function fetched(key: string, result: Result<KVValue>): FetchedContent {
  if (!result.ok) {
    if (isNotFound(result.error)) return { missing: true };
    throw replicaErrorFromService(result.error, `Fetching ${JSON.stringify(key)}`);
  }
  if (!(result.data.data instanceof Uint8Array)) {
    throw new ReplicaError(ReplicaErrorCode.PROTOCOL_ERROR, `The value of ${JSON.stringify(key)} did not arrive as bytes.`);
  }
  return { bytes: result.data.data, etag: result.data.headers.etag ?? "" };
}

/** A `ReplicaTransport` over a KV service bound to the replica's space and grant. */
export function kvSyncTransport(kv: KVSyncClient): ReplicaTransport {
  return {
    async syncPage({ prefix, cursor, limit, retentionGrant, signal }) {
      const result = await kv.changes({
        prefix,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(retentionGrant === undefined ? {} : { retentionGrant }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!result.ok) throw replicaErrorFromService(result.error, "Syncing");
      return checkPage(result.data);
    },

    async fetchContent(keys, options) {
      const contents = new Map<string, FetchedContent>();
      if (keys.length === 0) return contents;
      const signal = options?.signal;
      const batch = await kv.batchGet(keys, { binary: true, ...(signal === undefined ? {} : { signal }) });
      if (batch.ok) {
        for (const item of batch.data.results) {
          const result = item.result;
          // One oversize value is fetched alone below.
          if (!result.ok && result.error.code === "KV_RESPONSE_TOO_LARGE") continue;
          contents.set(item.key, fetched(item.key, result));
        }
      } else if (batch.error.code !== "KV_RESPONSE_TOO_LARGE") {
        throw replicaErrorFromService(batch.error, `Fetching ${keys.length} value(s)`);
      }
      for (const key of keys) {
        if (contents.has(key)) continue;
        contents.set(key, fetched(key, await kv.get(key, { binary: true, ...(signal === undefined ? {} : { signal }) })));
      }
      return contents;
    },
  };
}
