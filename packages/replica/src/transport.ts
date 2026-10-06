import { ReplicaError, ReplicaErrorCode } from "./errors.js";
import { isInstant } from "./scope.js";
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

/** TC-736 maps a revoked chain on `kv/sync` to these codes. */
const REVOKED_CODES = new Set(["AUTH_DELEGATION_REVOKED", "AUTH_DELEGATION_ANCESTOR_REVOKED"]);
/**
 * The node's whole 401 body for a revoked chain (`InvocationError` in
 * tinycloud-core): only CIDs follow the denial code, never a key or prefix.
 */
const REVOKED_BODY =
  /^(?:Invalid invocation: )?(?:delegation-revoked: [A-Za-z0-9]+|delegation-ancestor-revoked: ancestor=[A-Za-z0-9]+ (?:invoked|parent)=[A-Za-z0-9]+)$/;

/**
 * Revocation only from typed evidence: the SDK's revocation codes, or (for
 * reads, which the SDK reports as `AUTH_UNAUTHORIZED`) a 401 whose message is
 * exactly the SDK's `<request>: 401 - <body>` with the body the node's
 * revocation denial. Free text is never searched: messages carry keys and
 * prefixes, which anyone with write access chooses.
 */
function isRevocation(error: ServiceError, status: number | undefined, request: string | undefined): boolean {
  if (REVOKED_CODES.has(error.code)) return true;
  if (status !== 401 || request === undefined) return false;
  const lead = `${request}: 401 - `;
  return error.message.startsWith(lead) && REVOKED_BODY.test(error.message.slice(lead.length));
}

/**
 * Map an SDK failure to the replica's typed errors. `request` is the SDK's
 * own description of the call (`Failed to get key "k"`), which lets a read's
 * 401 body be told apart from the key it names.
 */
export function replicaErrorFromService(error: ServiceError, context: string, request?: string): ReplicaError {
  const meta = error.meta ?? {};
  const status = typeof meta.status === "number" ? meta.status : undefined;
  const detail = { serviceCode: error.code, ...(status === undefined ? {} : { status }) };
  const reason = typeof meta.reason === "string" ? meta.reason : undefined;
  if (error.code === "KV_SYNC_RESET_REQUIRED" || status === 410) {
    return new ReplicaError(
      ReplicaErrorCode.RESET_REQUIRED,
      `${context}: the node requires a fresh bootstrap (${reason ?? "reason not given"}).`,
      { ...detail, reason: reason ?? "reset-required" },
    );
  }
  if (isRevocation(error, status, request)) {
    return new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, `${context}: ${error.message}`, detail);
  }
  if (error.code === "KV_RETENTION_GRANT_REFUSED") {
    return new ReplicaError(ReplicaErrorCode.RETENTION_GRANT_REFUSED, `${context}: ${error.message}`, {
      ...detail,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  if (status === 401 || status === 403 || /^AUTH_/.test(error.code)) {
    // Not destructive either way (both refuse with exit 5 and keep the replica).
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

const encoder = new TextEncoder();

/** Byte order of UTF-8 keys: how the node orders batch results. */
function compareKeyBytes(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let index = 0; index < Math.min(x.length, y.length); index += 1) {
    if (x[index] !== y[index]) return x[index]! - y[index]!;
  }
  return x.length - y.length;
}

function isNotFound(error: ServiceError): boolean {
  return error.code === "KV_NOT_FOUND" || error.code === "NOT_FOUND";
}

/** An authority bound: null, or an RFC 3339 instant. Anything else fails closed. */
function instant(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && isInstant(value)) return value;
  throw new ReplicaError(ReplicaErrorCode.PROTOCOL_ERROR, `The kv/sync authority holds a bound that is not a timestamp: ${JSON.stringify(value)}.`);
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
  return {
    changes: data.changes.map((change) =>
      change.deleted ? { key: change.key, deleted: true } : { key: change.key, deleted: false, etag: change.etag, metadata: { ...change.metadata } },
    ),
    more: data.more,
    cursor: data.cursor,
    source: { nodeDid: data.source.nodeDid, space: data.source.space, prefix: data.source.prefix },
    authority: {
      notBefore: instant(data.authority.notBefore),
      expiresAt: instant(data.authority.expiresAt),
      retainUntil: instant(data.authority.retainUntil),
    },
  };
}

function fetched(key: string, result: Result<KVValue>, request: string): FetchedContent {
  if (!result.ok) {
    if (isNotFound(result.error)) return { missing: true };
    throw replicaErrorFromService(result.error, `Fetching ${JSON.stringify(key)}`, request);
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
      // The node answers a batch in key byte order and the SDK matches results
      // to requests by position, so ask in that order.
      const ordered = [...keys].sort(compareKeyBytes);
      const batch = await kv.batchGet(ordered, { binary: true, ...(signal === undefined ? {} : { signal }) });
      if (batch.ok) {
        for (const item of batch.data.results) {
          const result = item.result;
          // One oversize value is fetched alone below.
          if (!result.ok && result.error.code === "KV_RESPONSE_TOO_LARGE") continue;
          contents.set(item.key, fetched(item.key, result, `Failed to get key ${JSON.stringify(item.key)}`));
        }
      } else if (batch.error.code !== "KV_RESPONSE_TOO_LARGE") {
        throw replicaErrorFromService(batch.error, `Fetching ${keys.length} value(s)`, `Failed to batch read ${ordered.length} key(s)`);
      }
      for (const key of keys) {
        if (contents.has(key)) continue;
        const request = `Failed to get key ${JSON.stringify(key)}`;
        contents.set(key, fetched(key, await kv.get(key, { binary: true, ...(signal === undefined ? {} : { signal }) }), request));
      }
      return contents;
    },
  };
}
