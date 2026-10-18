import { fromBase64Url, toBase64Url } from "@tinycloud/share-envelope";
import type { AgentKeyMaterial } from "./agent-key.js";

/**
 * Agent record codec: the double-wrapped data key (design C §3, R1, V3-3..6).
 * Security-sensitive: keep this module small; nothing here logs, and no
 * error carries key bytes.
 *
 * One stored value per record, `vault/…/records/agents/<agentId>/<shareId>`:
 *
 *   { hdr: { v: 1, agentDid, kid, alg: "A256GCM", ownerNetworkId, recordV },
 *     ct:        b64url(iv ‖ AES-256-GCM(encKey, record, aad = B)),
 *     commit:    b64url(HMAC-SHA256(commitKey, B)),
 *     wrapAgent: b64url(iv ‖ AES-256-GCM(KEK_a, DEK, aad = B)) | null,
 *     wrapOwner: owner-network envelope of DEK with aad = B }
 *
 *   B         = "xyz.tinycloud.share/agent-record/v1|" + spaceId + "|" + vaultKey
 *               + "|" + agentDid + "|" + ownerNetworkId   (EVM addresses lowercased)
 *   encKey    = HKDF-SHA256(DEK, info "enc|" + B)
 *   commitKey = HKDF-SHA256(DEK, info "commit|" + B)
 *
 * Every seal takes a fresh random 32-byte DEK and fresh random 96-bit nonces.
 * The DEK itself is never used as a key. Opening requires the unwrapped DEK
 * to be exactly 32 bytes, checks `commit` in constant time, and zeroes the
 * DEK on every path.
 */

export const AGENT_RECORD_VERSION = 1;
/** Record schema versions this build understands. */
export const SUPPORTED_AGENT_RECORD_V = 1;
/**
 * Stored agent records larger than this are refused before any crypto.
 * Design C proposed 16 KiB (open decision 1); a real CLI bearer record that
 * carries its link and its full chain (C1: link UCAN + owner→session CACAO)
 * measured 16,918 B on a local node, so the cap is 32 KiB.
 */
export const MAX_AGENT_RECORD_BYTES = 32 * 1024;

const BINDING_DOMAIN = "xyz.tinycloud.share/agent-record/v1|";
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const encoder = new TextEncoder();

export type AgentRecordFailure = "size" | "shape" | "header" | "newer" | "decrypt" | "commit";

/** A refused agent record. The message is fixed per reason. */
export class AgentRecordError extends Error {
  constructor(readonly reason: AgentRecordFailure) {
    super(`agent record refused: ${reason}`);
    this.name = "AgentRecordError";
  }
}

/** Thrown by an {@link OwnerNetworkUnwrap} when the decrypt service is unreachable (not a refusal). */
export class OwnerUnwrapUnavailableError extends Error {
  constructor() {
    super("owner-network decrypt is unavailable");
    this.name = "OwnerUnwrapUnavailableError";
  }
}

export interface AgentRecordHeader {
  readonly v: 1;
  readonly agentDid: string;
  readonly kid: string | null;
  readonly alg: "A256GCM";
  readonly ownerNetworkId: string;
  readonly recordV: number;
}

export interface StoredAgentRecord {
  readonly hdr: AgentRecordHeader;
  readonly ct: string;
  readonly commit: string;
  readonly wrapAgent: string | null;
  readonly wrapOwner: Readonly<Record<string, unknown>>;
}

/** Encrypts the DEK to the owner network (needs no capability). */
export interface OwnerNetworkWrap {
  wrap(dek: Uint8Array, aad: Uint8Array): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * Network-decrypts the owner wrap. Implementations must pass `aad` to the
 * decrypt call so the envelope's declared AAD is compared before any POST.
 */
export interface OwnerNetworkUnwrap {
  unwrap(envelope: Readonly<Record<string, unknown>>, aad: Uint8Array): Promise<Uint8Array>;
}

export interface AgentRecordBindingInput {
  readonly spaceId: string;
  /** Full vault key: `sender-history/v2/records/agents/<agentId>/<shareId>`. */
  readonly vaultKey: string;
  readonly agentDid: string;
  readonly ownerNetworkId: string;
}

/** Space ids and network ids spell EVM addresses either way; B uses lowercase. */
export function canonicalAddressSpelling(value: string): string {
  return value.replace(/0x[0-9a-fA-F]{40}/g, (address) => address.toLowerCase());
}

export function agentRecordBinding(input: AgentRecordBindingInput): Uint8Array {
  for (const part of [input.spaceId, input.vaultKey, input.agentDid, input.ownerNetworkId]) {
    if (typeof part !== "string" || part.length === 0 || part.includes("|")) throw new TypeError("agent record binding input is invalid");
  }
  return encoder.encode(`${BINDING_DOMAIN}${canonicalAddressSpelling(input.spaceId)}|${input.vaultKey}|${input.agentDid}|${canonicalAddressSpelling(input.ownerNetworkId)}`);
}

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (value === undefined) throw new Error("WebCrypto is required for agent records");
  return value;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}

/** Constant-time equality for equal-length byte strings. */
export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++) diff |= left[index]! ^ right[index]!;
  return diff === 0;
}

interface Subkeys { readonly enc: CryptoKey; readonly commit: CryptoKey }

async function deriveSubkeys(dek: Uint8Array, binding: Uint8Array): Promise<Subkeys> {
  const base = await subtle().importKey("raw", dek, "HKDF", false, ["deriveBits"]);
  const derive = async (label: string, usage: "enc" | "commit"): Promise<CryptoKey> => {
    const bits = new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: concat(encoder.encode(label), binding) }, base, 256));
    try {
      return usage === "enc"
        ? await subtle().importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
        : await subtle().importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    } finally {
      bits.fill(0);
    }
  };
  return { enc: await derive("enc|", "enc"), commit: await derive("commit|", "commit") };
}

async function gcmSeal(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plaintext));
  return toBase64Url(concat(iv, sealed));
}

async function gcmOpen(key: CryptoKey, encoded: string, aad: Uint8Array): Promise<Uint8Array> {
  const bytes = fromBase64Url(encoded);
  if (bytes.length < NONCE_BYTES + 16) throw new AgentRecordError("decrypt");
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: bytes.subarray(0, NONCE_BYTES), additionalData: aad }, key, bytes.subarray(NONCE_BYTES)));
}

export interface SealAgentRecordInput extends AgentRecordBindingInput {
  /** UTF-8 JSON of the full `SenderShareRecord` (link and `proofs` included). */
  readonly plaintext: Uint8Array;
  /** Absent for a remote-signer-only profile: the record is then owner-readable only (`kid: null`). */
  readonly agentKey?: AgentKeyMaterial;
  readonly ownerWrap: OwnerNetworkWrap;
  readonly recordV?: number;
}

/** Seal one agent record. Each call draws a fresh DEK and fresh nonces. */
export async function sealAgentRecord(input: SealAgentRecordInput): Promise<StoredAgentRecord> {
  if (input.agentKey !== undefined && input.agentKey.agentDid !== input.agentDid) throw new TypeError("agent key does not belong to the agent DID");
  const binding = agentRecordBinding(input);
  const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
  try {
    const subkeys = await deriveSubkeys(dek, binding);
    const ct = await gcmSeal(subkeys.enc, input.plaintext, binding);
    const commit = toBase64Url(new Uint8Array(await subtle().sign("HMAC", subkeys.commit, binding)));
    const wrapAgent = input.agentKey === undefined ? null : await gcmSeal(input.agentKey.kek, dek, binding);
    const wrapOwner = await input.ownerWrap.wrap(dek, binding);
    return {
      hdr: { v: AGENT_RECORD_VERSION, agentDid: input.agentDid, kid: input.agentKey?.kid ?? null, alg: "A256GCM", ownerNetworkId: input.ownerNetworkId, recordV: input.recordV ?? SUPPORTED_AGENT_RECORD_V },
      ct,
      commit,
      wrapAgent,
      wrapOwner,
    };
  } finally {
    dek.fill(0);
  }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Parse the stored bytes and check the header against the path (§5 checks
 * 2–3), before any crypto. `newer` means a higher `recordV` than this build
 * knows: skip and re-check after an upgrade, do not reject.
 */
export function parseStoredAgentRecord(bytes: Uint8Array, expected: { readonly agentDid?: string; readonly ownerNetworkId: string }): StoredAgentRecord {
  if (bytes.byteLength > MAX_AGENT_RECORD_BYTES) throw new AgentRecordError("size");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new AgentRecordError("shape"); }
  if (!exactKeys(value, ["hdr", "ct", "commit", "wrapAgent", "wrapOwner"])) throw new AgentRecordError("shape");
  const hdr = value.hdr;
  if (!exactKeys(hdr, ["v", "agentDid", "kid", "alg", "ownerNetworkId", "recordV"])) throw new AgentRecordError("header");
  if (typeof value.ct !== "string" || typeof value.commit !== "string" || (value.wrapAgent !== null && typeof value.wrapAgent !== "string") || value.wrapOwner === null || typeof value.wrapOwner !== "object" || Array.isArray(value.wrapOwner)) throw new AgentRecordError("shape");
  if (hdr.v !== AGENT_RECORD_VERSION || hdr.alg !== "A256GCM" || typeof hdr.agentDid !== "string" || (hdr.kid !== null && typeof hdr.kid !== "string") || typeof hdr.ownerNetworkId !== "string" || !Number.isSafeInteger(hdr.recordV) || (hdr.recordV as number) < 1) throw new AgentRecordError("header");
  if (expected.agentDid !== undefined && hdr.agentDid !== expected.agentDid) throw new AgentRecordError("header");
  if (canonicalAddressSpelling(hdr.ownerNetworkId) !== canonicalAddressSpelling(expected.ownerNetworkId)) throw new AgentRecordError("header");
  if ((hdr.recordV as number) > SUPPORTED_AGENT_RECORD_V) throw new AgentRecordError("newer");
  return value as unknown as StoredAgentRecord;
}

function bindingFor(record: StoredAgentRecord, location: { readonly spaceId: string; readonly vaultKey: string }): Uint8Array {
  return agentRecordBinding({ spaceId: location.spaceId, vaultKey: location.vaultKey, agentDid: record.hdr.agentDid, ownerNetworkId: record.hdr.ownerNetworkId });
}

function decodeStandardBase64(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return undefined;
  try { return fromBase64Url(value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")); } catch { return undefined; }
}

/** DEK → subkeys → constant-time `commit` → open `ct`. Zeroes the DEK. */
async function openWithDek(record: StoredAgentRecord, binding: Uint8Array, dek: Uint8Array): Promise<Uint8Array> {
  try {
    if (dek.length !== DEK_BYTES) throw new AgentRecordError("decrypt");
    const subkeys = await deriveSubkeys(dek, binding);
    let stored: Uint8Array;
    try { stored = fromBase64Url(record.commit); } catch { throw new AgentRecordError("commit"); }
    const computed = new Uint8Array(await subtle().sign("HMAC", subkeys.commit, binding));
    if (!constantTimeEqual(stored, computed)) throw new AgentRecordError("commit");
    try { return await gcmOpen(subkeys.enc, record.ct, binding); } catch { throw new AgentRecordError("decrypt"); }
  } finally {
    dek.fill(0);
  }
}

/**
 * Owner path (§3 steps 2–4): refuse locally, before any network call, an
 * owner wrap whose declared AAD is not exactly B or whose network is not the
 * owner's; then network-unwrap, and open.
 */
export async function openAgentRecordAsOwner(record: StoredAgentRecord, location: { readonly spaceId: string; readonly vaultKey: string }, unwrap: OwnerNetworkUnwrap): Promise<Uint8Array> {
  const binding = bindingFor(record, location);
  const declared = typeof record.wrapOwner.aad === "string" ? decodeStandardBase64(record.wrapOwner.aad) : undefined;
  if (declared === undefined || !constantTimeEqual(declared, binding)) throw new AgentRecordError("decrypt");
  if (typeof record.wrapOwner.networkId !== "string" || canonicalAddressSpelling(record.wrapOwner.networkId) !== canonicalAddressSpelling(record.hdr.ownerNetworkId)) throw new AgentRecordError("decrypt");
  let dek: Uint8Array;
  try { dek = await unwrap.unwrap(record.wrapOwner, binding); } catch (error) {
    // An outage is not a verdict on the record: let the reconciler retry it later.
    if (error instanceof OwnerUnwrapUnavailableError) throw error;
    throw new AgentRecordError("decrypt");
  }
  return openWithDek(record, binding, dek);
}

/** Agent read-back: `wrapAgent` under KEK_a; no owner-network decrypt anywhere. */
export async function openAgentRecordAsAgent(record: StoredAgentRecord, location: { readonly spaceId: string; readonly vaultKey: string }, agentKey: AgentKeyMaterial): Promise<Uint8Array> {
  if (record.hdr.agentDid !== agentKey.agentDid || record.hdr.kid !== agentKey.kid || record.wrapAgent === null) throw new AgentRecordError("decrypt");
  const binding = bindingFor(record, location);
  let dek: Uint8Array;
  try { dek = await gcmOpen(agentKey.kek, record.wrapAgent, binding); } catch { throw new AgentRecordError("decrypt"); }
  return openWithDek(record, binding, dek);
}
