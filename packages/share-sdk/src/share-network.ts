import { canonicalize, signCompactUcanAuthorization, toBase64Url } from "@tinycloud/share-envelope";
import { sha256 } from "@noble/hashes/sha256";
import type { ShareKeySigner } from "./share-key-signer.js";
import { ShareRootError, errorMessage, parseOwnerDid, readJsonCapped, sameOwner, seconds, type Owner } from "./share-root.js";

/**
 * One encryption network per addressed share (TC-1423, PERSHARE-NETWORK
 * design): `urn:tinycloud:encryption:<owner did:pkh, lowercase>:share-<shareId>`.
 * A stored ciphertext is wrapped to exactly one share's network, so a key or
 * recipient session holding decrypt on it reaches that one share only.
 */
export const SHARE_NETWORK_NAME_PREFIX = "share-";
/** Network names the SDK accepts are `^[a-z0-9][a-z0-9-]*$`; a shareId must fit as-is (no re-encoding). */
const NETWORK_SAFE_SHARE_ID = /^[a-z0-9][a-z0-9-]{15,35}$/;
const NETWORK_URN = /^urn:tinycloud:encryption:did:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40}):([a-z0-9][a-z0-9-]*)$/;
export const NETWORK_CREATE_ABILITY = "tinycloud.encryption/network.create";
export const NETWORK_REVOKE_ABILITY = "tinycloud.encryption/network.revoke";
export const DECRYPT_ABILITY = "tinycloud.encryption/decrypt";
const NETWORK_ADMIN_TYPE = "tinycloud.encryption.network-admin/v1";
const NETWORK_ALG = "x25519-aes256gcm/v1";

type FetchFn = (input: URL, init?: RequestInit) => Promise<Response>;

/** Throws `share-id-not-network-safe` unless `shareId` matches `^[a-z0-9][a-z0-9-]{15,35}$` (UUIDs and 32-hex ids do). */
export function assertNetworkSafeShareId(shareId: string): void {
  if (typeof shareId !== "string" || !NETWORK_SAFE_SHARE_ID.test(shareId)) {
    throw new ShareRootError("share-id-not-network-safe", "shareId must match ^[a-z0-9][a-z0-9-]{15,35}$ to name its encryption network");
  }
}

/** The share's own network: `urn:tinycloud:encryption:<owner did:pkh, lowercase>:share-<shareId>`. */
export function perShareNetworkIdFor(ownerDid: string, shareId: string): string {
  const owner = parseOwnerDid(ownerDid);
  assertNetworkSafeShareId(shareId);
  return `urn:tinycloud:encryption:did:pkh:eip155:${owner.chainId}:${owner.address}:${SHARE_NETWORK_NAME_PREFIX}${shareId}`;
}

/**
 * True only when `networkId` is exactly `perShareNetworkIdFor(ownerDid, <a
 * network-safe shareId>)`: the canonical lowercase spelling of one of this
 * owner's per-share networks. `:default`, `:share`, `:vault` or any other
 * name, another owner, mixed case or anything non-ASCII is false.
 */
export function isPerShareNetworkOf(ownerDid: string, networkId: string): boolean {
  const parsed = typeof networkId === "string" ? parseOwnerNetworkUrn(networkId) : undefined;
  if (parsed === undefined) return false;
  const shareId = parsed.name.slice(SHARE_NETWORK_NAME_PREFIX.length);
  if (!NETWORK_SAFE_SHARE_ID.test(shareId)) return false;
  return networkId === perShareNetworkIdFor(ownerDid, shareId);
}

/** A did:pkh-owned network URN, parsed; `undefined` for anything else. */
export function parseOwnerNetworkUrn(urn: string): { readonly owner: Owner; readonly name: string } | undefined {
  const match = typeof urn === "string" ? NETWORK_URN.exec(urn) : null;
  return match === null ? undefined : { owner: { chainId: match[1]!, address: match[2]!.toLowerCase() }, name: match[3]! };
}

/** Parsed equality: same owner (address in any case, as the Node compares) and the exact same name. */
export function sameNetworkUrn(left: string, right: string): boolean {
  const a = parseOwnerNetworkUrn(left);
  const b = parseOwnerNetworkUrn(right);
  return a !== undefined && b !== undefined && sameOwner(a.owner, b.owner) && a.name === b.name;
}

/** The Node's `nodeId` from `GET /info` (capped JSON). */
export async function nodeDidOf(nodeOrigin: string, fetchFn: FetchFn): Promise<string> {
  let info: unknown;
  try { info = await readJsonCapped(await fetchFn(new URL("/info", nodeOrigin), { redirect: "error" })); } catch (error) { throw new ShareRootError("node-refused", `node identity is unavailable: ${errorMessage(error)}`); }
  const nodeDid = typeof info === "object" && info !== null && "nodeId" in info ? info.nodeId : undefined;
  if (typeof nodeDid !== "string" || !nodeDid.startsWith("did:key:")) throw new ShareRootError("node-refused", "node identity is unavailable");
  return nodeDid;
}

export type ShareNetworkLookup =
  | { readonly state: "absent" }
  | { readonly state: string; readonly networkId: string; readonly descriptor: Readonly<Record<string, unknown>> };

/** `GET /encryption/networks/<id>`: `absent` on 404, else the descriptor's state (not yet validated). */
export async function lookupShareNetwork(nodeOrigin: string, networkId: string, fetchFn: FetchFn): Promise<ShareNetworkLookup> {
  const response = await fetchFn(new URL(`/encryption/networks/${encodeURIComponent(networkId)}`, nodeOrigin), { redirect: "error" });
  if (response.status === 404) return { state: "absent" };
  if (!response.ok) throw new ShareRootError("node-refused", `share network lookup failed: HTTP ${response.status}`);
  let body: unknown;
  try { body = await readJsonCapped(response); } catch (error) { throw new ShareRootError("node-refused", `share network descriptor is unreadable: ${errorMessage(error)}`); }
  const descriptor = typeof body === "object" && body !== null && "descriptor" in body ? body.descriptor : body;
  if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor) || !("state" in descriptor) || typeof descriptor.state !== "string" || !("networkId" in descriptor) || typeof descriptor.networkId !== "string") {
    throw new ShareRootError("node-refused", "share network descriptor is malformed");
  }
  return { state: descriptor.state, networkId: descriptor.networkId, descriptor: descriptor as Readonly<Record<string, unknown>> };
}

/**
 * Accept only a usable per-share network: state exactly `active` (an
 * allowlist), the expected owner (parsed) and exact name, the one algorithm,
 * key version 1 and threshold 1/1. Membership is not checked (decrypt never
 * reads it). The Node spells the owner in EIP-55 case; ids compare parsed.
 */
export function assertActiveShareNetwork(lookup: ShareNetworkLookup, expectedNetworkId: string): void {
  if (lookup.state !== "active" || !("descriptor" in lookup)) throw new ShareRootError("network-not-active", `share network is ${lookup.state}`);
  const { descriptor } = lookup;
  const expected = parseOwnerNetworkUrn(expectedNetworkId);
  if (expected === undefined) throw new ShareRootError("invalid-request", "network id must be a did:pkh-owned network URN");
  const threshold = descriptor.threshold;
  const ownerDid = descriptor.ownerDid;
  let ownerMatches = false;
  try { ownerMatches = typeof ownerDid === "string" && sameOwner(parseOwnerDid(ownerDid), expected.owner); } catch { ownerMatches = false; }
  if (
    !sameNetworkUrn(lookup.networkId, expectedNetworkId)
    || !ownerMatches
    || descriptor.name !== expected.name
    || descriptor.alg !== NETWORK_ALG
    || descriptor.keyVersion !== 1
    || typeof threshold !== "object" || threshold === null || !("n" in threshold) || !("t" in threshold) || threshold.n !== 1 || threshold.t !== 1
  ) throw new ShareRootError("network-not-active", "share network descriptor does not match the share");
}

export interface NetworkAdminInput {
  readonly nodeOrigin: string;
  readonly nodeDid: string;
  readonly networkId: string;
  readonly action: typeof NETWORK_CREATE_ABILITY | typeof NETWORK_REVOKE_ABILITY;
  readonly signer: ShareKeySigner;
  readonly proof: string;
  readonly fetch: FetchFn;
  readonly now?: () => number;
}

/**
 * Sign and send one network-admin invocation (`network.create` or
 * `network.revoke`) with `signer`, proved by `proof` (a grant or an owner
 * control). Returns the HTTP status; callers decide on a fresh lookup.
 */
export async function sendNetworkAdmin(input: NetworkAdminInput): Promise<number> {
  const parsed = parseOwnerNetworkUrn(input.networkId);
  if (parsed === undefined) throw new ShareRootError("invalid-request", "network id must be a did:pkh-owned network URN");
  const body = input.action === NETWORK_CREATE_ABILITY
    ? canonicalize({ name: parsed.name, ownerDid: `did:pkh:eip155:${parsed.owner.chainId}:${parsed.owner.address}`, threshold: { n: 1, t: 1 } })
    : canonicalize({});
  const now = seconds((input.now ?? Date.now)());
  const bodyHash = [...sha256(new TextEncoder().encode(body))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const invocation = await signCompactUcanAuthorization({
    issuerDid: input.signer.did,
    audienceDid: input.nodeDid,
    attenuation: { [input.networkId]: { [input.action]: [{}] } },
    facts: [{ type: NETWORK_ADMIN_TYPE, targetNode: input.nodeDid, networkId: input.networkId, bodyHash, action: input.action }],
    proofs: [input.proof],
    notBefore: now,
    expiresAt: now + 60,
    nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    sign: input.signer.sign,
  });
  const path = input.action === NETWORK_CREATE_ABILITY ? "/encryption/networks" : `/encryption/networks/${encodeURIComponent(input.networkId)}/revoke`;
  const response = await input.fetch(new URL(path, input.nodeOrigin), {
    method: "POST",
    redirect: "error",
    headers: { Authorization: invocation.authorization, ...(input.action === NETWORK_CREATE_ABILITY ? { "content-type": "application/json" } : {}) },
    ...(input.action === NETWORK_CREATE_ABILITY ? { body } : {}),
  });
  await response.body?.cancel();
  return response.status;
}

/**
 * Retire (revoke) one network: permanent, recipients included, at the next
 * request. 204 (also on a repeat) or 404 (never created) count as done; the
 * result is confirmed with a fresh lookup.
 */
export async function retireShareNetwork(input: Omit<NetworkAdminInput, "action">): Promise<"retired" | "absent"> {
  const status = await sendNetworkAdmin({ ...input, action: NETWORK_REVOKE_ABILITY });
  const lookup = await lookupShareNetwork(input.nodeOrigin, input.networkId, input.fetch);
  if (lookup.state === "absent" && (status === 404 || status === 204)) return "absent";
  if (lookup.state === "revoked") return "retired";
  throw new ShareRootError("node-refused", `share network retire failed: HTTP ${status}, state ${lookup.state}`);
}
