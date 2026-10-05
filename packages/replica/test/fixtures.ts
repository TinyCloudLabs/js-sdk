import { ed25519 } from "@noble/curves/ed25519";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentHash } from "../src/engine.js";
import { ReplicaError, ReplicaErrorCode } from "../src/errors.js";
import { parseUcanGrant, type ParsedUcanGrant } from "../src/grant.js";
import { SqliteReplicaStore } from "../src/sqlite/store.js";
import type { AuthorityWindow, Change, FetchedContent, ReplicaConfig, ReplicaTransport, SyncPage } from "../src/types.js";

export const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
export const NODE_DID = "did:key:z6MkfhoxdzVTa6fLWMgEJNiRJomE5grMqkWyHiRbU9Tt7mAq";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export function keyPair(): { secret: Uint8Array; did: string } {
  const secret = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(secret);
  return { secret, did: `did:key:z${base58(Uint8Array.from([0xed, 0x01, ...pub]))}` };
}

/** A compact UCAN signed exactly like the SDK's WASM `createDelegation`. */
export function signUcan(
  issuer: { secret: Uint8Array; did: string },
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "EdDSA", typ: "JWT" },
): string {
  const head = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ iss: issuer.did, ...payload })));
  const signature = ed25519.sign(new TextEncoder().encode(`${head}.${body}`), issuer.secret);
  return `${head}.${body}.${b64url(signature)}`;
}

export const owner = keyPair();
export const device = keyPair();

export function deviceGrant(
  options: { prefix?: string; actions?: string[]; exp?: number; nbf?: number; aud?: string } = {},
): ParsedUcanGrant {
  const abilities = Object.fromEntries((options.actions ?? ["get", "list", "metadata", "sync"]).map((a) => [`tinycloud.kv/${a}`, [{}]]));
  return parseUcanGrant(
    signUcan(owner, {
      aud: options.aud ?? device.did,
      exp: options.exp ?? Math.floor(Date.now() / 1000) + 3600,
      ...(options.nbf === undefined ? {} : { nbf: options.nbf }),
      att: { [`${SPACE}/kv/${options.prefix ?? "notes/"}`]: abilities },
      prf: ["bafyparent"],
    }),
  );
}

export const etagOf = (bytes: Uint8Array) => `"blake3-${contentHash(bytes)}"`;

/**
 * An in-memory node serving `tinycloud.kv/sync` for one prefix. Each write
 * gets the next position; the feed reports each key's latest state in order.
 */
export class FakeNode implements ReplicaTransport {
  values = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  log: Array<{ key: string; pos: number }> = [];
  pos = 0;
  nodeDid = NODE_DID;
  space = SPACE;
  authority: AuthorityWindow = { notBefore: null, expiresAt: new Date(Date.now() + 3600_000).toISOString(), retainUntil: null };
  online = true;
  syncCalls = 0;
  fetchCalls = 0;
  /** Override what the next fetch returns for a key. */
  tamper = new Map<string, FetchedContent>();
  failNextSync: ReplicaError | undefined;
  extraChanges: Change[] = [];

  constructor(readonly prefix = "notes/") {}

  put(key: string, value: string | Uint8Array, metadata: Record<string, string> = {}): void {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    this.values.set(key, { bytes, metadata });
    this.log.push({ key, pos: ++this.pos });
  }

  delete(key: string): void {
    this.values.delete(key);
    this.log.push({ key, pos: ++this.pos });
  }

  #changesAfter(pos: number): Array<{ key: string; pos: number }> {
    const latest = new Map<string, number>();
    for (const entry of this.log) if (entry.key.startsWith(this.prefix)) latest.set(entry.key, entry.pos);
    return [...latest].filter(([, at]) => at > pos).sort((a, b) => a[1] - b[1]).map(([key, at]) => ({ key, pos: at }));
  }

  async syncPage(a: { prefix: string; cursor?: string; limit: number }): Promise<SyncPage> {
    this.syncCalls += 1;
    if (!this.online) throw new ReplicaError(ReplicaErrorCode.NETWORK_ERROR, "offline");
    if (this.failNextSync) {
      const error = this.failNextSync;
      this.failNextSync = undefined;
      throw error;
    }
    // Cursor = "<position>:<floor>". Like the node, a bootstrap skips
    // tombstones from before its first request (the floor).
    const [from, floor] = a.cursor === undefined ? [0, this.pos] : a.cursor.split(":").map(Number) as [number, number];
    const pending = this.#changesAfter(from).filter(({ key, pos }) => this.values.has(key) || pos > floor);
    const page = pending.slice(0, a.limit);
    const changes: Change[] = page.map(({ key }) => {
      const value = this.values.get(key);
      return value === undefined
        ? { key, deleted: true }
        : { key, deleted: false, etag: etagOf(value.bytes), metadata: value.metadata };
    });
    changes.push(...this.extraChanges);
    this.extraChanges = [];
    const last = page.at(-1)?.pos ?? from;
    return {
      changes,
      more: pending.length > page.length,
      cursor: `${last}:${floor}`,
      source: { nodeDid: this.nodeDid, space: this.space, prefix: this.prefix },
      authority: this.authority,
    };
  }

  async fetchContent(keys: string[]): Promise<Map<string, FetchedContent>> {
    this.fetchCalls += 1;
    if (!this.online) throw new ReplicaError(ReplicaErrorCode.NETWORK_ERROR, "offline");
    const out = new Map<string, FetchedContent>();
    for (const key of keys) {
      const tampered = this.tamper.get(key);
      if (tampered !== undefined) {
        out.set(key, tampered);
        continue;
      }
      const value = this.values.get(key);
      out.set(key, value === undefined ? { missing: true } : { bytes: value.bytes, etag: etagOf(value.bytes) });
    }
    return out;
  }
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tc-replica-"));
}

export function config(overrides: Partial<ReplicaConfig> = {}): ReplicaConfig {
  return {
    name: "notes",
    replicaId: "r-test",
    host: "http://127.0.0.1:1",
    space: SPACE,
    prefix: "notes/",
    deviceDid: device.did,
    allowSecrets: false,
    localReadPolicy: "whileGrantValid",
    retentionGrantCid: null,
    ...overrides,
  };
}

/** A created store with a pending device grant installed. */
export async function newStore(dir?: string, overrides: Partial<ReplicaConfig> = {}): Promise<SqliteReplicaStore> {
  const store = await SqliteReplicaStore.open(dir ?? (await tempDir()), { create: true });
  await store.init(config(overrides));
  await store.installGrant(deviceGrant({ prefix: overrides.prefix ?? "notes/" }));
  return store;
}
