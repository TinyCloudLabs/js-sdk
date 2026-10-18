import { fromBase64Url, toBase64Url } from "@tinycloud/share-envelope";
import type { AddressedPublishAuthority } from "./addressed-publish.js";
import { decodeOwnerRootCacao, ownerRootCacaoCid, type DecodedOwnerRootCacao } from "./owner-root-cacao.js";
import { createDelegatedShareKey, type DelegatedShareKey, type OwnerDelegationPermission, type OwnerDelegationReceipt } from "./owner-policy.js";
import {
  DECRYPT_ABILITY, SHARE_ROOT_LINK_MAX_LIFETIME_MS, ShareRootError,
  assertLinkPath, assertSpace, assertUsableKey, errorMessage, isShareNetworkOf, ownerPolicySigner, parseOwnerDid, requireNodeOrigin, shareNetworkId,
  validateSignedOwnerDelegation,
  type Owner, type ShareRootOwnerAuthority, type ShareRootPolicySigner,
} from "./share-root.js";

/** `view`: kv get + metadata. `edit`: also kv put. Both on one exact key. */
export type ShareGrantAccess = "view" | "edit";

const ACTIONS: Record<ShareGrantAccess, readonly string[]> = {
  view: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
  edit: ["tinycloud.kv/get", "tinycloud.kv/metadata", "tinycloud.kv/put"],
};

/** Persistable grant metadata. Holds no key material. */
export interface ShareGrantRecord {
  readonly version: 1;
  readonly cid: string;
  /** Base64url of the exact owner-signed CACAO bytes. */
  readonly authorization: string;
  readonly spaceId: string;
  readonly ownerDid: string;
  readonly keyDid: string;
  readonly nodeOrigin: string;
  /** The one exact KV key under `xyz.tinycloud.share/shares/`. */
  readonly path: string;
  readonly access: ShareGrantAccess;
  readonly expiresAt: string;
}

function wantedFor(spaceId: string, path: string, access: ShareGrantAccess, owner: Owner): Record<string, readonly string[]> {
  return { [`${spaceId}/kv/${path}`]: ACTIONS[access], [shareNetworkId(owner)]: [DECRYPT_ABILITY] };
}

/**
 * A per-share owner grant (TC-1423 D3, the interim path for addressed shares
 * while the Node does not enforce owner-authority binding).
 *
 * The owner signs one CACAO (one approval per share) to a FRESH per-share
 * key, never the share-root key:
 * - kv `get` + `metadata` (+ `put` for `edit`) on exactly one KV key under
 *   the share prefix, in the `applications` space;
 * - `decrypt` on the owner's `:share` network, which a Policy/v3 owner must
 *   hold (every v3 policy's capability ceiling includes decrypt on the
 *   source's network; without it the Node answers
 *   `policy-owner-not-authorized`);
 * - at most 30 days, and exactly the requested expiry.
 * The per-share key then owns that one share's policy: `publishAuthority`
 * signs its two policy roots (bounded by the grant's expiry and exact path)
 * and its 32-byte policy and envelope digests.
 *
 * Revoking the grant (one owner SIWE `POST /revoke` on `cid`) cuts the
 * per-share key's own reads and its decrypt, for this share only. Until the
 * Node binds policy registrations to the owner delegation (NODE-B2), an
 * already-registered policy keeps admitting recipients until its own expiry,
 * which never exceeds the grant's.
 *
 * Key custody: `create` generates a non-extractable key and never exposes
 * it. Keep the grant (in memory, or a CLI 0600 key file via `restore`) until
 * the share expires, to sign `RootRevocation` later. No browser persistence:
 * that needs the composer on its own origin first (REVIEW-D3 V2-2).
 */
export class ShareGrant {
  readonly cid: string;
  readonly ownerDid: string;
  readonly spaceId: string;
  readonly keyDid: string;
  readonly nodeOrigin: string;
  readonly path: string;
  readonly access: ShareGrantAccess;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly #authorization: Uint8Array;
  #key: DelegatedShareKey | undefined;
  readonly #now: () => number;

  private constructor(input: { cid: string; ownerDid: string; spaceId: string; nodeOrigin: string; path: string; access: ShareGrantAccess; issuedAt: Date; expiresAt: Date; authorization: Uint8Array; key: DelegatedShareKey; now: () => number }) {
    this.cid = input.cid;
    this.ownerDid = input.ownerDid;
    this.spaceId = input.spaceId;
    this.keyDid = input.key.did;
    this.nodeOrigin = input.nodeOrigin;
    this.path = input.path;
    this.access = input.access;
    this.issuedAt = input.issuedAt;
    this.expiresAt = input.expiresAt;
    this.#authorization = input.authorization;
    this.#key = input.key;
    this.#now = input.now;
  }

  /**
   * Ask the owner for one per-share grant (one approval). Path, access,
   * expiry, space and Node origin are checked before the wallet is asked; the
   * signed CACAO is decoded and must match exactly, or the key is cleared and
   * the error carries the imported CID (`mustRevoke` when it may be wider).
   */
  static async create(input: {
    readonly owner: ShareRootOwnerAuthority;
    readonly spaceId: string;
    readonly nodeOrigin: string;
    readonly path: string;
    readonly access: ShareGrantAccess;
    readonly expiresAt: Date;
    readonly keyFactory?: () => Promise<DelegatedShareKey>;
    readonly now?: () => number;
  }): Promise<ShareGrant> {
    const clock = input.now ?? Date.now;
    const now = clock();
    const owner = parseOwnerDid(input.owner.ownerDid);
    assertSpace(input.spaceId, owner, "share");
    const nodeOrigin = requireNodeOrigin(input.nodeOrigin);
    assertLinkPath(input.path);
    if (input.access !== "view" && input.access !== "edit") throw new ShareRootError("invalid-request", "share grant access must be view or edit");
    const expiry = input.expiresAt instanceof Date ? input.expiresAt.getTime() : Number.NaN;
    if (!Number.isFinite(expiry) || expiry <= now) throw new ShareRootError("invalid-request", "share grant expiry must be in the future");
    if (expiry - now > SHARE_ROOT_LINK_MAX_LIFETIME_MS) throw new ShareRootError("lifetime-exceeds-cap", "share grant lifetime exceeds 30 days");
    const key = await (input.keyFactory ?? (() => createDelegatedShareKey({ extractable: false })))();
    try {
      await assertUsableKey(key);
    } catch (error) {
      key.clear();
      throw error;
    }

    const permissions: OwnerDelegationPermission[] = [
      { service: "tinycloud.kv", path: input.path, actions: [...ACTIONS[input.access]] },
      { service: "tinycloud.encryption", path: shareNetworkId(owner), actions: [DECRYPT_ABILITY] },
    ];
    let receipt: OwnerDelegationReceipt;
    try {
      receipt = await input.owner.createOwnerDelegation({ delegateDid: key.did, spaceId: input.spaceId, expiresAt: input.expiresAt, permissions });
    } catch (error) {
      key.clear();
      throw error;
    }
    try {
      const authorization = new Uint8Array(receipt.signedDagCbor);
      const signedCid = ownerRootCacaoCid(authorization);
      if (signedCid !== receipt.delegationCid) throw new ShareRootError("malformed-root", "signed grant bytes do not match the imported delegation CID", { rootCid: receipt.delegationCid, signedCid, mustRevoke: true });
      let decoded: DecodedOwnerRootCacao;
      try { decoded = decodeOwnerRootCacao(authorization); } catch (error) { throw new ShareRootError("malformed-root", errorMessage(error), { rootCid: receipt.delegationCid, mustRevoke: true }); }
      const times = validateSignedOwnerDelegation(decoded, {
        label: "per-share grant",
        owner,
        keyDid: key.did,
        wanted: wantedFor(input.spaceId, input.path, input.access, owner),
        maxLifetimeMs: SHARE_ROOT_LINK_MAX_LIFETIME_MS,
        requestedExpiresAt: input.expiresAt,
        now: clock(),
      });
      return new ShareGrant({ cid: decoded.cid, ownerDid: input.owner.ownerDid, spaceId: input.spaceId, nodeOrigin, path: input.path, access: input.access, ...times, authorization, key, now: clock });
    } catch (error) {
      key.clear();
      if (error instanceof ShareRootError) throw error;
      throw new ShareRootError("malformed-root", errorMessage(error), { rootCid: receipt.delegationCid, mustRevoke: true });
    }
  }

  /** Rebuild a stored grant with its key (e.g. a CLI 0600 key file); the signed bytes are checked again. */
  static async restore(input: { readonly record: ShareGrantRecord; readonly key: DelegatedShareKey; readonly now?: () => number }): Promise<ShareGrant> {
    const { record } = input;
    const clock = input.now ?? Date.now;
    if (record.version !== 1 || (record.access !== "view" && record.access !== "edit")) throw new ShareRootError("malformed-root", "share grant record is not supported");
    if (record.keyDid !== input.key.did) throw new ShareRootError("audience-mismatch", "share grant record belongs to another key");
    const owner = parseOwnerDid(record.ownerDid);
    assertSpace(record.spaceId, owner, "share");
    const nodeOrigin = requireNodeOrigin(record.nodeOrigin);
    assertLinkPath(record.path);
    await assertUsableKey(input.key);
    let authorization: Uint8Array;
    let decoded: DecodedOwnerRootCacao;
    try {
      authorization = fromBase64Url(record.authorization);
      decoded = decodeOwnerRootCacao(authorization, record.cid);
    } catch (error) { throw new ShareRootError("malformed-root", errorMessage(error), { rootCid: record.cid }); }
    const times = validateSignedOwnerDelegation(decoded, {
      label: "per-share grant",
      owner,
      keyDid: input.key.did,
      wanted: wantedFor(record.spaceId, record.path, record.access, owner),
      maxLifetimeMs: SHARE_ROOT_LINK_MAX_LIFETIME_MS,
      now: clock(),
    });
    return new ShareGrant({ cid: decoded.cid, ownerDid: record.ownerDid, spaceId: record.spaceId, nodeOrigin, path: record.path, access: record.access, ...times, authorization, key: input.key, now: clock });
  }

  /** The `Authorization` value the Node knows this grant by (base64url CACAO). */
  get authorization(): string {
    return toBase64Url(this.#authorization);
  }

  /** The exact KV resource this grant covers. */
  get resource(): string {
    return `${this.spaceId}/kv/${this.path}`;
  }

  toRecord(): ShareGrantRecord {
    return { version: 1, cid: this.cid, authorization: this.authorization, spaceId: this.spaceId, ownerDid: this.ownerDid, keyDid: this.keyDid, nodeOrigin: this.nodeOrigin, path: this.path, access: this.access, expiresAt: this.expiresAt.toISOString() };
  }

  /**
   * Policy/v3 owner signing for this one share. Every call checks the key is
   * held and the grant is live. Policy roots must be owned by the per-share
   * key, expire no later than the grant, and name only this grant's exact
   * KV resource (with no action the grant lacks) and decrypt on `:share`.
   */
  policySigner(): ShareRootPolicySigner {
    const owner = parseOwnerDid(this.ownerDid);
    const actions = ACTIONS[this.access];
    return ownerPolicySigner({
      ownerDid: this.keyDid,
      authorityCid: this.cid,
      notAfter: new Date(this.expiresAt),
      gate: async () => this.#activeKey(),
      now: this.#now,
      inScope: (capability) => capability.kind === "encryption"
        ? isShareNetworkOf(capability.resource, owner) && capability.action === DECRYPT_ABILITY
        : capability.resource === this.resource && capability.selector === "exact" && capability.actions.every((action) => actions.includes(action)),
    });
  }

  /** `publishAddressedShare`'s `authority` for this share: the policy signer plus the caller's `registerPolicy`. */
  publishAuthority(registerPolicy: AddressedPublishAuthority["registerPolicy"]): AddressedPublishAuthority {
    return { ...this.policySigner(), registerPolicy };
  }

  /** Drop the per-share key. It does not revoke the grant: only the owner does that. */
  clear(): void {
    this.#key?.clear();
    this.#key = undefined;
  }

  #activeKey(): DelegatedShareKey {
    if (this.#key === undefined) throw new ShareRootError("key-cleared", "share grant key has been cleared", { rootCid: this.cid });
    if (this.#now() >= this.expiresAt.getTime()) throw new ShareRootError("expired", "share grant has expired", { rootCid: this.cid });
    return this.#key;
  }
}
