import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { didKeyFromEd25519PublicKey, fromBase64Url, toBase64Url } from "@tinycloud/share-envelope";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { OwnerUnwrapUnavailableError, type OwnerNetworkUnwrap, type OwnerNetworkWrap } from "../../src/share-index/agent-record.js";
import type { ShareDocumentRead, ShareIndexBackend, ShareListResult, ShareRawRead, ShareWriteCondition, ShareWriteResult } from "../../src/share-index/backend.js";
import type { ParsedSiweCacao, SiweCacaoParser } from "../../src/share-index/verify/session.js";
import type { SenderShareRecord } from "../../src/history.js";

/** Test fixtures for the share index: the package's own primitives with throwaway keys. */

export const OWNER_DID = "did:pkh:eip155:1:0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
export const SPACE_ID = "tinycloud:pkh:eip155:1:0xabcdef0123456789abcdef0123456789abcdef01:applications";
export const NETWORK_ID = "urn:tinycloud:encryption:did:pkh:eip155:1:0xAbCdEf0123456789aBcDeF0123456789AbCdEf01:default";
export const SHARE_ORIGIN = "https://share.test";
const encoder = new TextEncoder();

export function standardBase64(bytes: Uint8Array): string {
  const url = toBase64Url(bytes).replace(/-/g, "+").replace(/_/g, "/");
  return url + "=".repeat((4 - (url.length % 4)) % 4);
}

/**
 * A stand-in owner encryption network. Like the real one, the wrapped key is
 * encrypted with no AAD binding (only a declared `aad` field), and the
 * unwrap compares the declared AAD before its "decrypt POST", which it counts.
 */
export class FakeOwnerNetwork implements OwnerNetworkWrap, OwnerNetworkUnwrap {
  readonly key = crypto.getRandomValues(new Uint8Array(32));
  unwrapCalls = 0;
  readonly returned: Uint8Array[] = [];
  override?: (bytes: Uint8Array) => Uint8Array;
  unavailable = false;
  /** Set false to model an SDK that does not compare the declared AAD itself, isolating share-sdk's own pre-check. */
  checksAad = true;

  async wrap(dek: Uint8Array, aad: Uint8Array): Promise<Record<string, unknown>> {
    const key = await crypto.subtle.importKey("raw", this.key, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, dek));
    const body = new Uint8Array(12 + sealed.length);
    body.set(iv);
    body.set(sealed, 12);
    return { networkId: NETWORK_ID, alg: "test", keyVersion: 1, aad: standardBase64(aad), encryptedSymmetricKey: toBase64Url(body) };
  }

  async unwrap(envelope: Readonly<Record<string, unknown>>, aad: Uint8Array): Promise<Uint8Array> {
    if (this.checksAad && envelope.aad !== standardBase64(aad)) throw new Error("INVALID_INPUT: aad does not match");
    this.unwrapCalls++;
    if (this.unavailable) {
      throw new OwnerUnwrapUnavailableError();
    }
    const body = fromBase64Url(String(envelope.encryptedSymmetricKey));
    const key = await crypto.subtle.importKey("raw", this.key, "AES-GCM", false, ["decrypt"]);
    let out = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: body.subarray(0, 12) }, key, body.subarray(12)));
    if (this.override !== undefined) out = this.override(out);
    this.returned.push(out);
    return out;
  }
}

interface Stored { value: unknown; etag: string; raw: boolean }

/**
 * In-memory {@link ShareIndexBackend}: sorted keys, 1,000-key pages with a
 * cursor, strong etags, conditional writes, and hooks for fault injection.
 */
export class MemoryBackend implements ShareIndexBackend {
  readonly spaceId = SPACE_ID;
  readonly ownerNetworkId = NETWORK_ID;
  readonly store = new Map<string, Stored>();
  readonly network = new FakeOwnerNetwork();
  readonly ownerWrap: OwnerNetworkWrap = this.network;
  ownerUnwrap: OwnerNetworkUnwrap | undefined = this.network;
  pageSize = 1000;
  counters = { vaultReads: 0, rawReads: 0, writes: 0, lists: 0 };
  readonly vaultReadKeys: string[] = [];
  /** Return a result to replace the real write outcome (the write is skipped unless `apply` is true). */
  writeHook?: (key: string, attempt: number) => { result: ShareWriteResult; apply?: boolean } | undefined;
  private etagCounter = 0;

  private nextEtag(): string {
    this.etagCounter++;
    return `"blake3-${this.etagCounter.toString(16).padStart(64, "0")}"`;
  }

  private conditional(key: string, condition: ShareWriteCondition | undefined): ShareWriteResult | undefined {
    const existing = this.store.get(key);
    if (condition === undefined) return undefined;
    if ("ifNoneMatch" in condition) return existing === undefined ? undefined : { ok: false, code: "conflict" };
    if (!/^"[^"]+"$/.test(condition.ifMatch)) return { ok: false, code: "invalid_etag", message: "etag was weakened in transit" };
    return existing?.etag === condition.ifMatch ? undefined : { ok: false, code: "conflict" };
  }

  private write(key: string, value: unknown, raw: boolean, condition: ShareWriteCondition | undefined): ShareWriteResult {
    this.counters.writes++;
    const hooked = this.writeHook?.(key, this.counters.writes);
    if (hooked !== undefined) {
      if (hooked.apply === true) this.store.set(key, { value: structuredClone(value), etag: this.nextEtag(), raw });
      return hooked.result;
    }
    const refused = this.conditional(key, condition);
    if (refused !== undefined) return refused;
    this.store.set(key, { value: structuredClone(value), etag: this.nextEtag(), raw });
    return { ok: true };
  }

  async readVault(key: string): Promise<ShareDocumentRead> {
    this.counters.vaultReads++;
    this.vaultReadKeys.push(key);
    const entry = this.store.get(key);
    if (entry === undefined) return { status: "not_found" };
    if (entry.raw) return { status: "corrupt", etag: entry.etag };
    return { status: "ok", value: structuredClone(entry.value), etag: entry.etag };
  }

  async writeVault(key: string, value: unknown, condition?: ShareWriteCondition): Promise<ShareWriteResult> {
    return this.write(key, value, false, condition);
  }

  async deleteRecord(key: string): Promise<ShareWriteResult> {
    this.store.delete(key);
    return { ok: true };
  }

  async listKeys(prefix: string, cursor?: string): Promise<ShareListResult> {
    this.counters.lists++;
    const keys = [...this.store.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = cursor === undefined ? 0 : Number(cursor);
    const page = keys.slice(start, start + this.pageSize);
    const next = start + this.pageSize < keys.length ? String(start + this.pageSize) : undefined;
    return next === undefined ? { status: "ok", keys: page } : { status: "ok", keys: page, cursor: next };
  }

  async readRaw(key: string): Promise<ShareRawRead> {
    this.counters.rawReads++;
    const entry = this.store.get(key);
    if (entry === undefined) return { status: "not_found" };
    return { status: "ok", bytes: entry.value instanceof Uint8Array ? entry.value : encoder.encode(JSON.stringify(entry.value)), etag: entry.etag };
  }

  async writeRaw(key: string, value: Readonly<Record<string, unknown>>, condition: ShareWriteCondition): Promise<ShareWriteResult> {
    return this.write(key, value, true, condition);
  }

  /** Put raw bytes as an agent could (no checks). */
  putRawBytes(key: string, bytes: Uint8Array): void {
    this.store.set(key, { value: bytes, etag: this.nextEtag(), raw: true });
  }
}

// ---------------------------------------------------------------------------
// Keys, UCANs, SIWE stand-ins.

export interface TestKey { readonly privateKey: Uint8Array; readonly did: string }

export function newKey(): TestKey {
  const privateKey = ed25519.utils.randomPrivateKey();
  return { privateKey, did: didKeyFromEd25519PublicKey(ed25519.getPublicKey(privateKey)) };
}

/** Sign a WASM-style link UCAN (non-JCS JSON, no nbf/fct) or a root-style one. */
export function signUcan(key: TestKey, payload: Record<string, unknown>, options: { readonly signWith?: Uint8Array; readonly jwkOf?: TestKey } = {}): string {
  const header = { alg: "EdDSA", typ: "JWT", ucv: "0.10.0", jwk: { kty: "OKP", crv: "Ed25519", x: toBase64Url(ed25519.getPublicKey((options.jwkOf ?? key).privateKey)) } };
  const h = toBase64Url(encoder.encode(JSON.stringify(header)));
  const p = toBase64Url(encoder.encode(JSON.stringify({ iss: key.did, ...payload })));
  const signature = ed25519.sign(encoder.encode(`${h}.${p}`), options.signWith ?? key.privateKey);
  return `${h}.${p}.${toBase64Url(signature)}`;
}

export function rawCid(bytes: Uint8Array): string {
  return CID.createV1(0x55, createDigest(0x1e, blake3(bytes))).toString();
}

/**
 * A SIWE CACAO stand-in. The real parser (sdk-core `parseSignedSiweCacao`)
 * verifies the EIP-191 signature; it is exercised with real CACAOs in the
 * live and sdk-core tests. Here the parser returns the encoded fields, with
 * the CID over the exact bytes, so the checks this package adds are tested.
 */
export function fakeSiwe(fields: Omit<ParsedSiweCacao, "cid">): { readonly authorization: string; readonly cid: string } {
  const bytes = encoder.encode(JSON.stringify(fields));
  return { authorization: toBase64Url(bytes), cid: rawCid(bytes) };
}

export const fakeSiweParser: SiweCacaoParser = async (authorization, expectedCid) => {
  const bytes = fromBase64Url(authorization.replace(/=+$/, ""));
  const cid = rawCid(bytes);
  if (cid !== expectedCid) throw new Error("CACAO CID does not match exact Authorization bytes");
  const fields = JSON.parse(new TextDecoder().decode(bytes)) as Omit<ParsedSiweCacao, "cid">;
  if ("forged" in fields && fields.forged === true) throw new Error("CACAO signature is invalid");
  return { cid, ...fields };
};

export const SESSION_ATTENUATION = { [`${SPACE_ID}/kv`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}], "tinycloud.kv/list": [{}] } };
/** The owner's `default` space: where the CLI keeps share content (records live in `applications`). */
export const CONTENT_SPACE_ID = "tinycloud:pkh:eip155:1:0xabcdef0123456789abcdef0123456789abcdef01:default";

export interface BearerFixture {
  readonly record: SenderShareRecord;
  readonly session: TestKey;
  readonly sessionCid: string;
  readonly linkCid: string;
}

/** A complete, valid agent bearer record: owner→session CACAO, session-issued link delegation. */
export function bearerFixture(options: {
  readonly session?: TestKey;
  readonly shareId?: string;
  readonly now?: Date;
  readonly expSeconds?: number;
  readonly siwe?: Partial<Omit<ParsedSiweCacao, "cid">>;
  readonly link?: Record<string, unknown>;
  readonly withSession?: boolean;
  readonly record?: Partial<SenderShareRecord>;
  /** Space holding the shared content (default: the records space). */
  readonly contentSpace?: string;
} = {}): BearerFixture {
  const now = options.now ?? new Date();
  const session = options.session ?? newKey();
  const space = options.contentSpace ?? SPACE_ID;
  const siwe = fakeSiwe({ issuer: OWNER_DID, audience: `${session.did}#${session.did.slice("did:key:".length)}`, attenuation: { [`${space}/kv`]: SESSION_ATTENUATION[`${SPACE_ID}/kv`]! }, expiresAt: new Date(now.getTime() + 3600_000).toISOString(), ...options.siwe });
  const path = `xyz.tinycloud.share/shares/${options.shareId ?? "s"}/note.txt`;
  const link = signUcan(session, {
    aud: newKey().did,
    att: { [`${space}/kv/${path}`]: { "tinycloud.kv/get": [{}] } },
    exp: Math.floor(now.getTime() / 1000) + (options.expSeconds ?? 3600),
    nnc: "n",
    prf: [siwe.cid],
    ...options.link,
  });
  const linkCid = rawCid(encoder.encode(link));
  const shareId = options.shareId ?? linkCid;
  const record: SenderShareRecord = {
    shareId,
    target: { origin: "https://node.test", nodeAudience: "did:key:z6MkNode", spaceId: space },
    resource: { kind: "exact", path: options.shareId === undefined ? path : path },
    actions: ["tinycloud.kv/get"],
    recipientMatcher: { kind: "bearer" },
    targetKind: "bearer",
    registeredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    enforcementDelegationCid: linkCid,
    link: `${SHARE_ORIGIN}/viewer#tc1=opaque-token`,
    filename: "note.txt",
    proofs: { link, ...(options.withSession === false ? {} : { session: siwe.authorization }) },
    ...options.record,
  };
  return { record, session, sessionCid: siwe.cid, linkCid };
}
