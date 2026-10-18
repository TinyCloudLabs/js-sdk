import { fromBase64Url, toBase64Url, type UnifiedContentSource } from "@tinycloud/share-envelope";
import type { AddressedPublishAuthority } from "./addressed-publish.js";
import { parseArtifactVersionPath } from "./artifact.js";
import { decodeOwnerRootCacao, ownerRootCacaoCid, type DecodedOwnerRootCacao } from "./owner-root-cacao.js";
import { createDelegatedShareKey, type DelegatedShareKey, type OwnerDelegationPermission, type OwnerDelegationReceipt } from "./owner-policy.js";
import type { ShareKeySigner } from "./share-key-signer.js";
import {
  DECRYPT_ABILITY, NETWORK_CREATE_ABILITY, NETWORK_REVOKE_ABILITY,
  assertActiveShareNetwork, lookupShareNetwork, nodeDidOf, perShareNetworkIdFor, retireShareNetwork, sameNetworkUrn, sendNetworkAdmin,
} from "./share-network.js";
import {
  SHARE_ROOT_LINK_MAX_LIFETIME_MS, ShareRootError,
  assertSpace, assertUsableKey, errorMessage, isExactKeyUnder, isRevokeReceiptFor, ownerPolicySigner, parseOwnerDid, requireNodeOrigin, sameOwner,
  validateSignedOwnerDelegation,
  type Owner, type SharePolicySigner, type ShareRootOwnerAuthority,
} from "./share-root.js";

/** `view`: kv get + metadata. `edit`: also kv put. Both on one exact key. */
export type ShareGrantAccess = "view" | "edit";

const KV_ACTIONS: Record<ShareGrantAccess, readonly string[]> = {
  view: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
  edit: ["tinycloud.kv/get", "tinycloud.kv/metadata", "tinycloud.kv/put"],
};
const NETWORK_ACTIONS = [NETWORK_CREATE_ABILITY, NETWORK_REVOKE_ABILITY, DECRYPT_ABILITY] as const;
const SHARE_KV_ROOT = "xyz.tinycloud.share/";
/** P2(a): a read-back key lives at most one hour. */
export const EDIT_SHARE_READER_MAX_LIFETIME_MS = 60 * 60_000;

type FetchFn = (input: URL, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchFn = (url, init) => globalThis.fetch(url, init);

/**
 * The share's one content key (I1): `xyz.tinycloud.share/shares/<shareId>/<file>`,
 * or, for `view` only, a TC-1428 version file
 * `xyz.tinycloud.share/artifacts/<aid>/versions/<n>/<file>` (versions are
 * immutable, and that path is not bound to the shareId, so `edit` is refused).
 */
export function assertShareGrantPath(path: string, shareId: string, access: ShareGrantAccess): void {
  const inShare = isExactKeyUnder(path, `${SHARE_KV_ROOT}shares/${shareId}/`) && !path.slice(`${SHARE_KV_ROOT}shares/${shareId}/`.length).includes("/");
  const inArtifact = isExactKeyUnder(path, `${SHARE_KV_ROOT}artifacts/`) && parseArtifactVersionPath(path.slice(SHARE_KV_ROOT.length)) !== undefined;
  if (!inShare && !inArtifact) throw new ShareRootError("invalid-request", "share grant path must be xyz.tinycloud.share/shares/<shareId>/<file> or an artifact version file");
  if (inArtifact && access !== "view") throw new ShareRootError("invalid-request", "artifact versions are immutable: only view grants may name a version file");
}

/** Progress of one addressed share, for the consumer's history/index row (the SDK does not store rows). */
export type ShareGrantRowState = "pending" | "granted" | "network" | "active" | "abandoned" | "retired";

/** The history/index row to persist at each step. Write `pending` BEFORE the approval prompt. */
export interface ShareGrantRow {
  readonly shareId: string;
  /** Network name, `share-<shareId>`. */
  readonly nw: string;
  readonly networkId: string;
  readonly keyDid: string;
  readonly access: ShareGrantAccess;
  readonly path: string;
  readonly state: ShareGrantRowState;
  readonly grantCid?: string;
}

/** Persistable grant metadata (record v2). Holds no key material. */
export interface ShareGrantRecord {
  readonly version: 2;
  readonly cid: string;
  /** Base64url of the exact owner-signed CACAO bytes. */
  readonly authorization: string;
  readonly spaceId: string;
  readonly ownerDid: string;
  readonly keyDid: string;
  readonly nodeOrigin: string;
  readonly shareId: string;
  readonly networkId: string;
  readonly path: string;
  readonly access: ShareGrantAccess;
  readonly expiresAt: string;
}

interface GrantSpec {
  readonly owner: Owner;
  readonly ownerDid: string;
  readonly spaceId: string;
  readonly nodeOrigin: string;
  readonly shareId: string;
  readonly networkId: string;
  readonly path: string;
  readonly access: ShareGrantAccess;
}

function wantedFor(spec: GrantSpec): Record<string, readonly string[]> {
  return { [`${spec.spaceId}/kv/${spec.path}`]: KV_ACTIONS[spec.access], [spec.networkId]: NETWORK_ACTIONS };
}

function rowOf(spec: GrantSpec, keyDid: string, state: ShareGrantRowState, grantCid?: string): ShareGrantRow {
  return { shareId: spec.shareId, nw: spec.networkId.slice(spec.networkId.lastIndexOf(":") + 1), networkId: spec.networkId, keyDid, access: spec.access, path: spec.path, state, ...(grantCid === undefined ? {} : { grantCid }) };
}

/** What one addressed or edit share asks the owner for. */
export interface ShareGrantRequest {
  readonly owner: ShareRootOwnerAuthority;
  /** The owner's `applications` space. */
  readonly spaceId: string;
  readonly nodeOrigin: string;
  /** Names the network `share-<shareId>`: must match `^[a-z0-9][a-z0-9-]{15,35}$`. */
  readonly shareId: string;
  /** The share's one content key (see `assertShareGrantPath`). */
  readonly path: string;
  readonly access: ShareGrantAccess;
  /** At most 30 days ahead. */
  readonly expiresAt: Date;
  /**
   * Key-gone recovery only: accept the share's network when it already
   * exists and is `active` (a half-published share whose key was lost), and
   * grant a new key on it. Without it, `prepare` refuses an existing network
   * (`share-id-in-use`) before the prompt. A retired network is always
   * refused.
   */
  readonly resumeExistingNetwork?: boolean;
  readonly keyFactory?: () => Promise<DelegatedShareKey>;
  readonly fetch?: FetchFn;
  readonly now?: () => number;
}

/** A per-share grant whose key exists but which the owner has not approved yet. Persist `row` first, then `approve()`. */
export interface PendingShareGrant {
  readonly shareId: string;
  readonly networkId: string;
  readonly keyDid: string;
  /** The `pending` row: write it before calling `approve()`. */
  readonly row: ShareGrantRow;
  /** Ask the owner for the grant: exactly one approval. */
  approve(): Promise<ShareGrant>;
  /** Drop the key without asking (e.g. the row write failed). */
  discard(): void;
}

/**
 * A per-share owner grant on the share's own encryption network (TC-1423,
 * PERSHARE-NETWORK design v2). Every addressed (email/domain) or edit share
 * gets one, before and after the Node enforces owner-authority binding; the
 * share root never decrypts.
 *
 * One owner approval signs one CACAO to a FRESH non-extractable per-share key:
 * - kv `get` + `metadata` (+ `put` for `edit`) on the share's one content key;
 * - `network.create`, `network.revoke` and `decrypt` on exactly
 *   `urn:tinycloud:encryption:<owner did:pkh>:share-<shareId>`, and nothing
 *   else (the Node matches network resources by exact parsed id, so these
 *   reach no other network).
 * The key creates that network (owned by the owner) and owns the share's
 * policy. Decrypt therefore covers this one share's ciphertext only, for the
 * key and for the share's recipients.
 *
 * Publish order (the consumer stores the rows; see `ShareGrantRow`):
 * 0. `ShareGrant.prepare`: shareId rule, path, access, expiry, space and
 *    origin are checked, and the network is looked up (an existing or
 *    retired one is refused); a typed error costs no approval.
 * 1. Persist `pending.row` (state `pending`), and a CLI persists the key file.
 * 2. `pending.approve()`: one approval; row `granted` with `grantCid`.
 * 3. `grant.ensureNetwork()`: creates the network if absent, re-reads it after
 *    any answer (racing creates can answer 500), accepts only `active`; row
 *    `network`. Retry at no approval while the key is held.
 * 4. The owner session encrypts to `grant.networkId` and stores the object
 *    (`grant.assertContentSource`); on failure `grant.retireNetwork()`, row
 *    `abandoned`.
 * 5. `publishAddressedShare({ authority: grant.publishAuthority(registerPolicy) })`:
 *    the network is re-read as `active` right before registration.
 * 6. Row `active`.
 *
 * Revoke: `revokeShareGrant` retires the network first (permanent; every
 * recipient loses decrypt at the next request; no approval while the key is
 * held), then revokes the grant (one owner approval). Revoking the grant
 * first would strand an active network the dead key can no longer retire.
 *
 * Key custody: no browser persistence (needs the composer on its own origin
 * first, REVIEW-D3 V2-2); keep the grant in memory, or in a CLI 0600 key file
 * via `restore`, until the share is retired or expired.
 */
export class ShareGrant {
  readonly cid: string;
  readonly ownerDid: string;
  readonly spaceId: string;
  readonly keyDid: string;
  readonly nodeOrigin: string;
  readonly shareId: string;
  readonly networkId: string;
  readonly path: string;
  readonly access: ShareGrantAccess;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly #spec: GrantSpec;
  readonly #authorization: Uint8Array;
  #key: DelegatedShareKey | undefined;
  readonly #now: () => number;
  readonly #fetch: FetchFn;

  private constructor(input: { spec: GrantSpec; cid: string; issuedAt: Date; expiresAt: Date; authorization: Uint8Array; key: DelegatedShareKey; now: () => number; fetch: FetchFn }) {
    this.#spec = input.spec;
    this.cid = input.cid;
    this.ownerDid = input.spec.ownerDid;
    this.spaceId = input.spec.spaceId;
    this.keyDid = input.key.did;
    this.nodeOrigin = input.spec.nodeOrigin;
    this.shareId = input.spec.shareId;
    this.networkId = input.spec.networkId;
    this.path = input.spec.path;
    this.access = input.spec.access;
    this.issuedAt = input.issuedAt;
    this.expiresAt = input.expiresAt;
    this.#authorization = input.authorization;
    this.#key = input.key;
    this.#now = input.now;
    this.#fetch = input.fetch;
  }

  /**
   * Step 0: check everything that does not need the owner, and make the key.
   * Also looks the share's network up (no approval): a shareId whose network
   * is retired (burned), or already exists from an earlier grant, is refused
   * with `share-id-in-use` before the prompt (see `resumeExistingNetwork`).
   * Throws `share-id-not-network-safe`, `invalid-request`, `lifetime-exceeds-cap`,
   * `share-id-in-use`, `node-refused` or `invalid-key` with no approval spent.
   */
  static async prepare(input: ShareGrantRequest): Promise<PendingShareGrant> {
    const clock = input.now ?? Date.now;
    const now = clock();
    const owner = parseOwnerDid(input.owner.ownerDid);
    const networkId = perShareNetworkIdFor(input.owner.ownerDid, input.shareId);
    assertSpace(input.spaceId, owner, "share");
    const nodeOrigin = requireNodeOrigin(input.nodeOrigin);
    if (input.access !== "view" && input.access !== "edit") throw new ShareRootError("invalid-request", "share grant access must be view or edit");
    assertShareGrantPath(input.path, input.shareId, input.access);
    const expiry = input.expiresAt instanceof Date ? input.expiresAt.getTime() : Number.NaN;
    if (!Number.isFinite(expiry) || expiry <= now) throw new ShareRootError("invalid-request", "share grant expiry must be in the future");
    if (expiry - now > SHARE_ROOT_LINK_MAX_LIFETIME_MS) throw new ShareRootError("lifetime-exceeds-cap", "share grant lifetime exceeds 30 days");
    const existing = await lookupShareNetwork(nodeOrigin, networkId, input.fetch ?? defaultFetch);
    if (existing.state !== "absent") {
      if (existing.state !== "active") throw new ShareRootError("share-id-in-use", `this shareId's network is ${existing.state}; a retired shareId is never reused`);
      if (input.resumeExistingNetwork !== true) throw new ShareRootError("share-id-in-use", "this shareId already has an active network from an earlier grant");
      assertActiveShareNetwork(existing, networkId);
    }
    const key = await (input.keyFactory ?? (() => createDelegatedShareKey({ extractable: false })))();
    try {
      await assertUsableKey(key);
    } catch (error) {
      key.clear();
      throw error;
    }
    const spec: GrantSpec = { owner, ownerDid: input.owner.ownerDid, spaceId: input.spaceId, nodeOrigin, shareId: input.shareId, networkId, path: input.path, access: input.access };
    let settled = false;
    return {
      shareId: spec.shareId,
      networkId,
      keyDid: key.did,
      row: rowOf(spec, key.did, "pending"),
      approve: async () => {
        if (settled) throw new ShareRootError("invalid-request", "this pending grant was already approved or discarded");
        settled = true;
        return ShareGrant.#approve(spec, key, input.owner, input.expiresAt, clock, input.fetch ?? defaultFetch);
      },
      discard: () => {
        settled = true;
        key.clear();
      },
    };
  }

  /** `prepare` then `approve`, for callers that keep no `pending` row (tests, one-shot tools). */
  static async create(input: ShareGrantRequest): Promise<ShareGrant> {
    return (await ShareGrant.prepare(input)).approve();
  }

  static async #approve(spec: GrantSpec, key: DelegatedShareKey, owner: ShareRootOwnerAuthority, expiresAt: Date, clock: () => number, fetchFn: FetchFn): Promise<ShareGrant> {
    const permissions: OwnerDelegationPermission[] = [
      { service: "tinycloud.kv", path: spec.path, actions: [...KV_ACTIONS[spec.access]] },
      { service: "tinycloud.encryption", path: spec.networkId, actions: [...NETWORK_ACTIONS] },
    ];
    let receipt: OwnerDelegationReceipt;
    try {
      receipt = await owner.createOwnerDelegation({ delegateDid: key.did, spaceId: spec.spaceId, expiresAt, permissions });
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
      const times = validateSignedOwnerDelegation(decoded, { label: "per-share grant", owner: spec.owner, keyDid: key.did, wanted: wantedFor(spec), maxLifetimeMs: SHARE_ROOT_LINK_MAX_LIFETIME_MS, requestedExpiresAt: expiresAt, now: clock() });
      return new ShareGrant({ spec, cid: decoded.cid, ...times, authorization, key, now: clock, fetch: fetchFn });
    } catch (error) {
      key.clear();
      if (error instanceof ShareRootError) throw error;
      throw new ShareRootError("malformed-root", errorMessage(error), { rootCid: receipt.delegationCid, mustRevoke: true });
    }
  }

  /** Rebuild a stored grant with its key (e.g. a CLI 0600 key file); the signed bytes are checked again. Only record v2. */
  static async restore(input: { readonly record: ShareGrantRecord; readonly key: DelegatedShareKey; readonly now?: () => number; readonly fetch?: FetchFn }): Promise<ShareGrant> {
    const { record } = input;
    const clock = input.now ?? Date.now;
    if (record.version !== 2) throw new ShareRootError("malformed-root", "share grant record is not supported (only per-share network grants, record v2)");
    if (record.access !== "view" && record.access !== "edit") throw new ShareRootError("malformed-root", "share grant record access is invalid");
    if (record.keyDid !== input.key.did) throw new ShareRootError("audience-mismatch", "share grant record belongs to another key");
    const owner = parseOwnerDid(record.ownerDid);
    const networkId = perShareNetworkIdFor(record.ownerDid, record.shareId);
    if (!sameNetworkUrn(networkId, record.networkId)) throw new ShareRootError("malformed-root", "share grant record network does not match its shareId");
    assertSpace(record.spaceId, owner, "share");
    const nodeOrigin = requireNodeOrigin(record.nodeOrigin);
    assertShareGrantPath(record.path, record.shareId, record.access);
    await assertUsableKey(input.key);
    const spec: GrantSpec = { owner, ownerDid: record.ownerDid, spaceId: record.spaceId, nodeOrigin, shareId: record.shareId, networkId, path: record.path, access: record.access };
    let authorization: Uint8Array;
    let decoded: DecodedOwnerRootCacao;
    try {
      authorization = fromBase64Url(record.authorization);
      decoded = decodeOwnerRootCacao(authorization, record.cid);
    } catch (error) { throw new ShareRootError("malformed-root", errorMessage(error), { rootCid: record.cid }); }
    const times = validateSignedOwnerDelegation(decoded, { label: "per-share grant", owner, keyDid: input.key.did, wanted: wantedFor(spec), maxLifetimeMs: SHARE_ROOT_LINK_MAX_LIFETIME_MS, now: clock() });
    return new ShareGrant({ spec, cid: decoded.cid, ...times, authorization, key: input.key, now: clock, fetch: input.fetch ?? defaultFetch });
  }

  /**
   * This grant's CACAO as base64url, UNPADDED (the record form). As a Node
   * `Authorization` header it must be padded to a multiple of 4 characters:
   * the Node refuses an unpadded value otherwise.
   */
  get authorization(): string {
    return toBase64Url(this.#authorization);
  }

  /** The exact KV resource this grant covers. */
  get resource(): string {
    return `${this.spaceId}/kv/${this.path}`;
  }

  toRecord(): ShareGrantRecord {
    return { version: 2, cid: this.cid, authorization: this.authorization, spaceId: this.spaceId, ownerDid: this.ownerDid, keyDid: this.keyDid, nodeOrigin: this.nodeOrigin, shareId: this.shareId, networkId: this.networkId, path: this.path, access: this.access, expiresAt: this.expiresAt.toISOString() };
  }

  /** The history/index row for `state`. */
  row(state: ShareGrantRowState): ShareGrantRow {
    return rowOf(this.#spec, this.keyDid, state, this.cid);
  }

  /**
   * Step 3: make sure the share's network exists and is usable. Creates it
   * when absent (key-signed, no approval), then decides on a fresh lookup
   * after any answer. Returns `networkId` (the grant's lowercase spelling;
   * the Node echoes the owner in EIP-55 case). A retired network is never
   * re-created (the Node answers 409): `network-not-active`.
   */
  async ensureNetwork(): Promise<string> {
    const signer = this.#signer();
    const first = await lookupShareNetwork(this.nodeOrigin, this.networkId, this.#fetch);
    if (first.state === "absent") {
      const nodeDid = await nodeDidOf(this.nodeOrigin, this.#fetch);
      await sendNetworkAdmin({ nodeOrigin: this.nodeOrigin, nodeDid, networkId: this.networkId, action: NETWORK_CREATE_ABILITY, signer, proof: this.cid, fetch: this.#fetch, now: this.#now });
      return this.assertNetworkActive();
    }
    assertActiveShareNetwork(first, this.networkId);
    return this.networkId;
  }

  /** Throw `network-not-active` unless the share's network is `active` now (fresh lookup). */
  async assertNetworkActive(): Promise<string> {
    assertActiveShareNetwork(await lookupShareNetwork(this.nodeOrigin, this.networkId, this.#fetch), this.networkId);
    return this.networkId;
  }

  /**
   * Retire the share's network with the per-share key (no approval):
   * PERMANENT, and every holder of decrypt on it (recipients included) is
   * refused at their next request. Idempotent: a repeat or a never-created
   * network counts as done.
   */
  async retireNetwork(): Promise<"retired" | "absent"> {
    const signer = this.#signer();
    const nodeDid = await nodeDidOf(this.nodeOrigin, this.#fetch);
    return retireShareNetwork({ nodeOrigin: this.nodeOrigin, nodeDid, networkId: this.networkId, signer, proof: this.cid, fetch: this.#fetch, now: this.#now });
  }

  /** Step 4 check (I1): the stored object belongs to this share, on its exact key and network. */
  assertContentSource(contentSource: UnifiedContentSource): void {
    if (
      contentSource.shareId !== this.shareId
      || contentSource.kvResource !== this.resource
      || contentSource.selector !== "exact"
      || !sameNetworkUrn(contentSource.encryptionNetwork, this.networkId)
    ) throw new ShareRootError("invalid-request", "content source does not belong to this share's grant (shareId, exact key and network)");
  }

  /**
   * Policy/v3 owner signing for this one share. Every call checks the key is
   * held and the grant is live. Policy roots must be owned by the per-share
   * key, expire no later than the grant, and name only this grant's exact
   * KV resource (no action the grant lacks) and decrypt on this share's
   * network (parsed equality).
   */
  policySigner(): SharePolicySigner {
    const actions = KV_ACTIONS[this.access];
    return ownerPolicySigner({
      ownerDid: this.keyDid,
      authorityCid: this.cid,
      notAfter: new Date(this.expiresAt),
      gate: async () => this.#activeKey(),
      now: this.#now,
      inScope: (capability) => capability.kind === "encryption"
        ? sameNetworkUrn(capability.resource, this.networkId) && capability.action === DECRYPT_ABILITY
        : capability.resource === this.resource && capability.selector === "exact" && capability.actions.every((action) => actions.includes(action)),
    });
  }

  /**
   * Step 5: `publishAddressedShare`'s `authority` for this share. Its
   * `registerPolicy` first re-reads the network and refuses unless it is
   * `active` (released Nodes accept registrations on missing or retired
   * networks).
   */
  publishAuthority(registerPolicy: AddressedPublishAuthority["registerPolicy"]): AddressedPublishAuthority {
    return {
      ...this.policySigner(),
      registerPolicy: async (request) => {
        await this.assertNetworkActive();
        return registerPolicy(request);
      },
    };
  }

  /** Drop the per-share key. It does not retire the network or revoke the grant. */
  clear(): void {
    this.#key?.clear();
    this.#key = undefined;
  }

  #activeKey(): DelegatedShareKey {
    if (this.#key === undefined) throw new ShareRootError("key-cleared", "share grant key has been cleared", { rootCid: this.cid });
    if (this.#now() >= this.expiresAt.getTime()) throw new ShareRootError("expired", "share grant has expired", { rootCid: this.cid });
    return this.#key;
  }

  #signer(): ShareKeySigner {
    const key = this.#activeKey();
    return { did: key.did, sign: (bytes) => key.sign(bytes) };
  }
}

/**
 * Revoke one addressed share: retire its network with the per-share key
 * (permanent, no approval), THEN revoke the grant with an owner SIWE (one
 * approval). Only a `{ revoked: true, cid }` receipt counts. If the owner
 * step fails, decrypt is already cut: the error `grant-revoke-incomplete`
 * says so, and the caller can retry the grant revoke. Without the key, use
 * the owner control batch (`runShareControlBatch`).
 */
export async function revokeShareGrant(input: {
  readonly grant: ShareGrant;
  readonly owner: { signOwnerRevocation(cid: string): Promise<string> };
  readonly fetch?: FetchFn;
}): Promise<{ readonly network: "retired" | "absent"; readonly grant: "revoked" }> {
  const fetchFn = input.fetch ?? defaultFetch;
  const network = await input.grant.retireNetwork();
  try {
    const response = await fetchFn(new URL("/revoke", input.grant.nodeOrigin), { method: "POST", redirect: "error", headers: { Authorization: await input.owner.signOwnerRevocation(input.grant.cid) } });
    const status = response.status;
    if (!await isRevokeReceiptFor(response, input.grant.cid)) throw new Error(`HTTP ${status}: no receipt confirming this grant`);
  } catch (error) {
    throw new ShareRootError("grant-revoke-incomplete", `the share's network is retired (decrypt cut for everyone), but the grant revoke failed: ${errorMessage(error)}`, { rootCid: input.grant.cid });
  }
  return { network, grant: "revoked" };
}

/** A short-lived key that lets the owner read back one share's content (P2(a)). */
export interface EditShareReader {
  readonly cid: string;
  readonly keyDid: string;
  readonly networkId: string;
  readonly path: string;
  readonly expiresAt: Date;
  /** Signs this reader's kv/get and decrypt invocations; refuses after expiry or `clear()`. */
  readonly signer: ShareKeySigner;
  clear(): void;
}

/**
 * Let the owner read back an edit share (P2(a)): one approval for kv `get`
 * on the share's key and `decrypt` on its network, to a throwaway in-memory
 * key that lives at most one hour. Nothing is stored.
 */
export async function openEditShare(input: {
  readonly owner: ShareRootOwnerAuthority;
  readonly record: Pick<ShareGrantRecord, "spaceId" | "ownerDid" | "shareId" | "networkId" | "path">;
  readonly lifetimeMs?: number;
  readonly now?: () => number;
}): Promise<EditShareReader> {
  const clock = input.now ?? Date.now;
  const lifetime = input.lifetimeMs ?? EDIT_SHARE_READER_MAX_LIFETIME_MS;
  if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > EDIT_SHARE_READER_MAX_LIFETIME_MS) throw new ShareRootError("lifetime-exceeds-cap", "an edit-share reader lives at most one hour");
  const owner = parseOwnerDid(input.owner.ownerDid);
  if (!sameOwner(owner, parseOwnerDid(input.record.ownerDid))) throw new ShareRootError("invalid-request", "the share belongs to another owner");
  const networkId = perShareNetworkIdFor(input.record.ownerDid, input.record.shareId);
  if (!sameNetworkUrn(networkId, input.record.networkId)) throw new ShareRootError("invalid-request", "share network does not match its shareId");
  assertSpace(input.record.spaceId, owner, "share");
  assertShareGrantPath(input.record.path, input.record.shareId, "edit");
  const key = await createDelegatedShareKey({ extractable: false });
  const expiresAt = new Date(clock() + lifetime);
  let receipt: OwnerDelegationReceipt;
  try {
    receipt = await input.owner.createOwnerDelegation({
      delegateDid: key.did,
      spaceId: input.record.spaceId,
      expiresAt,
      permissions: [
        { service: "tinycloud.kv", path: input.record.path, actions: ["tinycloud.kv/get"] },
        { service: "tinycloud.encryption", path: networkId, actions: [DECRYPT_ABILITY] },
      ],
    });
  } catch (error) {
    key.clear();
    throw error;
  }
  try {
    const authorization = new Uint8Array(receipt.signedDagCbor);
    const signedCid = ownerRootCacaoCid(authorization);
    if (signedCid !== receipt.delegationCid) throw new ShareRootError("malformed-root", "signed reader grant bytes do not match the imported delegation CID", { rootCid: receipt.delegationCid, signedCid, mustRevoke: true });
    // Any decode or validation failure that is not already typed is wrapped below with `mustRevoke`.
    validateSignedOwnerDelegation(decodeOwnerRootCacao(authorization), {
      label: "edit-share reader",
      owner,
      keyDid: key.did,
      wanted: { [`${input.record.spaceId}/kv/${input.record.path}`]: ["tinycloud.kv/get"], [networkId]: [DECRYPT_ABILITY] },
      maxLifetimeMs: EDIT_SHARE_READER_MAX_LIFETIME_MS,
      requestedExpiresAt: expiresAt,
      now: clock(),
    });
  } catch (error) {
    key.clear();
    if (error instanceof ShareRootError) throw error;
    throw new ShareRootError("malformed-root", errorMessage(error), { rootCid: receipt.delegationCid, mustRevoke: true });
  }
  let live: DelegatedShareKey | undefined = key;
  const clear = (): void => { live?.clear(); live = undefined; };
  return {
    cid: receipt.delegationCid,
    keyDid: key.did,
    networkId,
    path: input.record.path,
    expiresAt,
    signer: {
      did: key.did,
      sign: async (bytes) => {
        if (live === undefined || clock() >= expiresAt.getTime()) throw new ShareRootError("expired", "edit-share reader has expired or was cleared");
        return live.sign(bytes);
      },
    },
    clear,
  };
}
