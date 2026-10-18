import { ed25519 } from "@noble/curves/ed25519";
import { didKeyFromEd25519PublicKey, toBase64Url } from "@tinycloud/share-envelope";
import { canonicalViewerUrl, NATIVE_SHARE_FRAGMENT_PARAMETER } from "./native.js";
import { nodeDidOf } from "./share-network.js";
import { ShareRootError, errorMessage, readJsonCapped, type ShareRoot } from "./share-root.js";

type FetchFn = (input: URL, init?: RequestInit) => Promise<Response>;

/** A bearer link minted under a share root, in today's `/viewer#tc1=` shape. */
export interface RootBearerLink {
  /** `https://<viewer>/viewer#tc1=<token>`: the token carries the link key and its delegation, as SharingService links do. */
  readonly url: string;
  readonly delegationCid: string;
  readonly rootCid: string;
  readonly spaceId: string;
  readonly path: string;
  readonly expiresAt: Date;
}

/**
 * Mint a view-only bearer link under a share root (TC-1423 D3, slice 3).
 * Zero approvals: the share key signs `kv/get` on one exact key under the
 * share prefix (`ShareRoot.signBearerLink`: never beyond the root, never
 * more than 30 days, exactly `expiresAt` to the second), the Node imports it
 * (`POST /delegate`), and the link is encoded exactly like a SharingService
 * link: a fresh per-link Ed25519 key and its delegation in a `tc1:` token in
 * the `/viewer` fragment, so viewers and `openNativeShare` read it unchanged.
 *
 * The per-link key travels in the fragment by design (anyone with the link
 * holds it). Links need no decrypt (share roots never have it). Use
 * `ensureShareRoot` first; a `delegation-revoked` or expired root fails here
 * and needs a re-root (one approval).
 */
export async function publishRootBearerLink(input: {
  readonly root: ShareRoot;
  readonly path: string;
  readonly expiresAt: Date;
  readonly viewerOrigin: string;
  readonly fetch?: FetchFn;
}): Promise<RootBearerLink> {
  const fetchFn: FetchFn = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const viewerUrl = canonicalViewerUrl(input.viewerOrigin);
  const secret = ed25519.utils.randomPrivateKey();
  try {
    const publicKey = ed25519.getPublicKey(secret);
    const linkDid = didKeyFromEd25519PublicKey(publicKey);
    const link = await input.root.signBearerLink({ linkDid, path: input.path, expiresAt: input.expiresAt });
    const response = await fetchFn(new URL("/delegate", input.root.nodeOrigin), { method: "POST", redirect: "error", headers: { Authorization: link.delegation.authorization } });
    if (!response.ok) throw new ShareRootError("node-refused", `the Node refused the link delegation: HTTP ${response.status} ${(await response.text()).slice(0, 120)}`, { rootCid: input.root.cid });
    const createdAt = new Date();
    const shareData = {
      key: { kty: "OKP", crv: "Ed25519", x: toBase64Url(publicKey), d: toBase64Url(secret) },
      keyDid: `${linkDid}#${linkDid.slice("did:key:".length)}`,
      delegation: {
        cid: link.delegation.cid,
        delegateDID: linkDid,
        delegatorDID: input.root.keyDid,
        spaceId: input.root.spaceId,
        path: input.path,
        actions: ["tinycloud.kv/get"],
        expiry: link.expiresAt,
        isRevoked: false,
        allowSubDelegation: true,
        createdAt,
        parentCid: input.root.cid,
        authHeader: link.delegation.authorization,
      },
      path: input.path,
      host: input.root.nodeOrigin,
      spaceId: input.root.spaceId,
      version: 1,
    };
    const token = `tc1:${toBase64Url(new TextEncoder().encode(JSON.stringify(shareData)))}`;
    viewerUrl.hash = `${NATIVE_SHARE_FRAGMENT_PARAMETER}=${encodeURIComponent(token)}`;
    return { url: viewerUrl.toString(), delegationCid: link.delegation.cid, rootCid: input.root.cid, spaceId: input.root.spaceId, path: input.path, expiresAt: link.expiresAt };
  } finally {
    secret.fill(0);
  }
}

/**
 * Revoke one bearer link with the share key that issued it (zero
 * approvals): a share-key-signed `POST /revoke` on the link's delegation CID.
 * Only a `{ revoked: true, cid }` receipt counts as done. The owner can
 * always revoke the same CID with an owner SIWE (one approval).
 */
export async function revokeRootBearerLink(input: { readonly root: ShareRoot; readonly delegationCid: string; readonly fetch?: FetchFn }): Promise<{ readonly revoked: true; readonly cid: string }> {
  const fetchFn: FetchFn = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const nodeDid = await nodeDidOf(input.root.nodeOrigin, fetchFn);
  const authorization = await input.root.signLinkRevocation({ delegationCid: input.delegationCid, nodeDid });
  const response = await fetchFn(new URL("/revoke", input.root.nodeOrigin), { method: "POST", redirect: "error", headers: { Authorization: authorization } });
  if (!response.ok) throw new ShareRootError("node-refused", `the Node refused the link revocation: HTTP ${response.status} ${(await response.text()).slice(0, 120)}`, { rootCid: input.root.cid });
  let receipt: unknown;
  try { receipt = await readJsonCapped(response); } catch (error) { throw new ShareRootError("invalid-request", `link revocation receipt is unreadable: ${errorMessage(error)}`); }
  if (typeof receipt !== "object" || receipt === null || !("revoked" in receipt) || receipt.revoked !== true || !("cid" in receipt) || receipt.cid !== input.delegationCid) {
    throw new ShareRootError("invalid-request", "link revocation receipt does not confirm this delegation");
  }
  return { revoked: true, cid: input.delegationCid };
}
