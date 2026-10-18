import { canonicalize, signCompactUcanAuthorization, toBase64Url } from "@tinycloud/share-envelope";
import { sha256 } from "@noble/hashes/sha256";
import { decodeOwnerRootCacao, ownerRootCacaoCid, type DecodedOwnerRootCacao } from "./owner-root-cacao.js";
import { createDelegatedShareKey, type DelegatedShareKey } from "./owner-policy.js";
import {
  ShareRootError,
  assertSpace, assertUsableKey, errorMessage, isShareNetworkOf, parseOwnerDid, readJsonCapped, requireNodeOrigin, sameOwner, seconds,
  validateSignedOwnerDelegation,
  type ShareRootOwnerAuthority,
} from "./share-root.js";

const NETWORK_CREATE_ABILITY = "tinycloud.encryption/network.create";
const NETWORK_ADMIN_TYPE = "tinycloud.encryption.network-admin/v1";
/** The one-time network-admin grant lives just long enough to create the network. */
const NETWORK_GRANT_LIFETIME_MS = 10 * 60_000;

export interface ShareNetworkResult {
  /** `urn:tinycloud:encryption:<owner did:pkh>:share`. */
  readonly networkId: string;
  /** Owner wallet approvals this call used: 0 when the network already existed, else 1. */
  readonly approvals: 0 | 1;
}

/**
 * The owner's `:share` network URN, `urn:tinycloud:encryption:<owner
 * did:pkh>:share`: where Share sources are encrypted, and the network a
 * per-share grant or a `kv+share-decrypt` root may decrypt. The Node compares
 * the did:pkh address case-insensitively.
 */
export function shareNetworkIdFor(ownerDid: string): string {
  parseOwnerDid(ownerDid);
  return `urn:tinycloud:encryption:${ownerDid}:share`;
}

type FetchFn = (input: URL, init?: RequestInit) => Promise<Response>;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The owner's `:share` network descriptor, `undefined` when the Node has none, or a thrown error when it is unusable. */
async function existingShareNetwork(nodeOrigin: string, networkId: string, ownerDid: string, fetchFn: FetchFn): Promise<string | undefined> {
  const response = await fetchFn(new URL(`/encryption/networks/${encodeURIComponent(networkId)}`, nodeOrigin), { redirect: "error" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new ShareRootError("invalid-request", `share network lookup failed: HTTP ${response.status}`);
  let body: unknown;
  try { body = await readJsonCapped(response); } catch (error) { throw new ShareRootError("invalid-request", `share network descriptor is unreadable: ${errorMessage(error)}`); }
  const descriptor = typeof body === "object" && body !== null && "descriptor" in body ? body.descriptor : body;
  if (typeof descriptor !== "object" || descriptor === null || !("networkId" in descriptor) || !("ownerDid" in descriptor) || !("state" in descriptor)) {
    throw new ShareRootError("invalid-request", "share network descriptor is malformed");
  }
  const { networkId: foundId, ownerDid: foundOwner, state } = descriptor;
  const owner = parseOwnerDid(ownerDid);
  if (typeof foundId !== "string" || !isShareNetworkOf(foundId, owner) || typeof foundOwner !== "string" || !sameOwner(parseOwnerDid(foundOwner), owner)) {
    throw new ShareRootError("invalid-request", "share network is not owned by this owner");
  }
  if (state === "revoked" || state === "failed") throw new ShareRootError("invalid-request", `share network is ${String(state)}`);
  return foundId;
}

/**
 * Make sure the owner's dedicated `:share` encryption network exists (D3
 * addendum §1, review B1). Per owner: `urn:tinycloud:encryption:<owner
 * did:pkh>:share`. The owner owns it, never a share key or per-share key: a
 * network whose owner is the key would be root authority for that key
 * (tinycloud-node `delegation.rs:792-809`), so revoking its grant would not
 * cut decrypt.
 *
 * Idempotent: when the Node already has it, nothing is signed (0 approvals).
 * Otherwise the owner signs one short-lived CACAO (one approval, once per
 * owner) granting only `network.create` on that URN to a throwaway
 * non-extractable key, which creates the network with the owner as
 * `ownerDid` and is then cleared. A 409 from a concurrent creator counts as
 * created. Two first calls racing each prompt (2 approvals, one 409);
 * callers that can race should serialize. Share sources encrypt to it;
 * vault and secrets stay on `:default`.
 */
export async function ensureShareNetwork(input: {
  readonly owner: ShareRootOwnerAuthority;
  readonly spaceId: string;
  readonly nodeOrigin: string;
  readonly fetch?: FetchFn;
  readonly keyFactory?: () => Promise<DelegatedShareKey>;
  readonly now?: () => number;
}): Promise<ShareNetworkResult> {
  const clock = input.now ?? Date.now;
  const fetchFn: FetchFn = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const owner = parseOwnerDid(input.owner.ownerDid);
  assertSpace(input.spaceId, owner, "share");
  const nodeOrigin = requireNodeOrigin(input.nodeOrigin);
  const networkId = shareNetworkIdFor(input.owner.ownerDid);

  const existing = await existingShareNetwork(nodeOrigin, networkId, input.owner.ownerDid, fetchFn);
  if (existing !== undefined) return { networkId: existing, approvals: 0 };

  let info: unknown;
  try { info = await readJsonCapped(await fetchFn(new URL("/info", nodeOrigin), { redirect: "error" })); } catch (error) { throw new ShareRootError("invalid-request", `node identity is unavailable: ${errorMessage(error)}`); }
  const nodeDid = typeof info === "object" && info !== null && "nodeId" in info ? info.nodeId : undefined;
  if (typeof nodeDid !== "string" || !nodeDid.startsWith("did:key:")) throw new ShareRootError("invalid-request", "node identity is unavailable");

  const key = await (input.keyFactory ?? (() => createDelegatedShareKey({ extractable: false })))();
  try {
    await assertUsableKey(key);
    const expiresAt = new Date(clock() + NETWORK_GRANT_LIFETIME_MS);
    const receipt = await input.owner.createOwnerDelegation({
      delegateDid: key.did,
      spaceId: input.spaceId,
      expiresAt,
      permissions: [{ service: "tinycloud.encryption", path: networkId, actions: [NETWORK_CREATE_ABILITY] }],
    });
    const authorization = new Uint8Array(receipt.signedDagCbor);
    const signedCid = ownerRootCacaoCid(authorization);
    if (signedCid !== receipt.delegationCid) throw new ShareRootError("malformed-root", "signed network grant bytes do not match the imported delegation CID", { rootCid: receipt.delegationCid, signedCid, mustRevoke: true });
    let decoded: DecodedOwnerRootCacao;
    try { decoded = decodeOwnerRootCacao(authorization); } catch (error) { throw new ShareRootError("malformed-root", errorMessage(error), { rootCid: receipt.delegationCid, mustRevoke: true }); }
    validateSignedOwnerDelegation(decoded, {
      label: "share network grant",
      owner,
      keyDid: key.did,
      wanted: { [networkId]: [NETWORK_CREATE_ABILITY] },
      maxLifetimeMs: NETWORK_GRANT_LIFETIME_MS,
      requestedExpiresAt: expiresAt,
      now: clock(),
    });

    const body = { name: "share", ownerDid: input.owner.ownerDid, threshold: { n: 1, t: 1 } };
    const canonicalBody = canonicalize(body);
    const now = seconds(clock());
    const invocation = await signCompactUcanAuthorization({
      issuerDid: key.did,
      audienceDid: nodeDid,
      attenuation: { [networkId]: { [NETWORK_CREATE_ABILITY]: [{}] } },
      facts: [{ type: NETWORK_ADMIN_TYPE, targetNode: nodeDid, networkId, bodyHash: hex(sha256(new TextEncoder().encode(canonicalBody))), action: NETWORK_CREATE_ABILITY }],
      proofs: [decoded.cid],
      notBefore: now,
      expiresAt: now + 60,
      nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
      sign: (bytes) => key.sign(bytes),
    });
    const response = await fetchFn(new URL("/encryption/networks", nodeOrigin), {
      method: "POST",
      redirect: "error",
      headers: { Authorization: invocation.authorization, "content-type": "application/json" },
      body: canonicalBody,
    });
    if (!response.ok && response.status !== 409) throw new ShareRootError("invalid-request", `share network creation failed: HTTP ${response.status} ${(await response.text()).slice(0, 120)}`);
    const created = await existingShareNetwork(nodeOrigin, networkId, input.owner.ownerDid, fetchFn);
    if (created === undefined) throw new ShareRootError("invalid-request", "share network was not created");
    return { networkId: created, approvals: 1 };
  } finally {
    key.clear();
  }
}
