import { ed25519PublicKeyFromDidKey, toBase64Url, fromBase64Url, type CompactUcanAuthorization } from "@tinycloud/share-envelope";
import { decodeOwnerRootCacao, type DecodedOwnerRootCacao } from "./owner-root-cacao.js";
import type { CreateOwnerDelegationParams, DelegatedShareKey, OwnerDelegationPermission, OwnerDelegationReceipt } from "./owner-policy.js";
import { assertNonExtractableShareKey, signShareKeyDelegation } from "./share-key-signer.js";

const DAY_MS = 86_400_000;

/** KV prefix every share lives under; the root never reaches outside it. */
export const SHARE_ROOT_PREFIX = "xyz.tinycloud.share/shares/";
/** Longest lifetime of a Share (browser device) root. */
export const SHARE_ROOT_MAX_LIFETIME_MS = 37 * DAY_MS;
/** Longest lifetime of an agent root (the OpenKey device-grant cap). */
export const AGENT_SHARE_ROOT_MAX_LIFETIME_MS = 30 * DAY_MS;
/** Product cap on a bearer link signed under a root. */
export const SHARE_ROOT_LINK_MAX_LIFETIME_MS = 30 * DAY_MS;
/**
 * NODE-B2 (§9 "Advertised mode"): a Node lists these in the `features` of
 * its public `GET /info` (sdk-core `checkNodeInfo` → `NodeInfo.features`):
 * the capability marker plus exactly one active mode. A share root signs
 * email/domain policy roots only while the mode is `enforce`; it never gates
 * on the Node version. Read in one place, {@link readPolicyOwnerAuthorityMode}.
 */
export const POLICY_OWNER_AUTHORITY_FEATURES = {
  marker: "policy-owner-authority-v1",
  record: "policy-owner-authority-record",
  enforce: "policy-owner-authority-enforce",
} as const;
/** How long a known mode is trusted before the Node is asked again (NODE-B2: at most 5 minutes). */
export const POLICY_OWNER_AUTHORITY_PROBE_TTL_MS = 5 * 60_000;

/** `share`: one per browser device, `applications` space, bearer + (gated) policy owner. `agent`: `default` space, bearer only. */
export type ShareRootKind = "share" | "agent";

const PROFILES = {
  share: { spaceName: "applications", maxLifetimeMs: SHARE_ROOT_MAX_LIFETIME_MS, decrypt: true },
  agent: { spaceName: "default", maxLifetimeMs: AGENT_SHARE_ROOT_MAX_LIFETIME_MS, decrypt: false },
} as const;

const KV_ABILITIES = ["tinycloud.kv/get", "tinycloud.kv/metadata"] as const;
const DECRYPT_ABILITY = "tinycloud.encryption/decrypt";

export type ShareRootErrorCode =
  | "invalid-request"
  | "invalid-key"
  | "lifetime-exceeds-cap"
  | "expired"
  | "malformed-root"
  | "issuer-mismatch"
  | "audience-mismatch"
  | "resource-mismatch"
  | "ability-mismatch"
  | "expiry-mismatch"
  | "reroot-same-key"
  | "link-out-of-scope"
  | "policy-roots-disabled"
  | "policy-roots-not-enforced-by-node";

export class ShareRootError extends Error {
  readonly code: ShareRootErrorCode;
  /**
   * Set when the owner already signed, and the Node imported, the rejected
   * root. The share key has been cleared, so nothing here can use it; the
   * owner may still revoke `rootCid` (owner SIWE `POST /revoke`).
   */
  readonly rootCid?: string;

  constructor(code: ShareRootErrorCode, message: string, rootCid?: string) {
    super(message);
    this.name = "ShareRootError";
    this.code = code;
    if (rootCid !== undefined) this.rootCid = rootCid;
  }
}

/** What a signed-in owner session provides: TinyCloudNode / web-sdk `createOwnerDelegation`. */
export interface ShareRootOwnerAuthority {
  /** `did:pkh:eip155:<chain>:<address>` of the owner wallet. */
  readonly ownerDid: string;
  /** Sign one CACAO with exactly `permissions` (one wallet approval) and import it into the Node. */
  createOwnerDelegation(params: CreateOwnerDelegationParams): Promise<OwnerDelegationReceipt>;
}

export interface ShareRootOptions {
  readonly kind?: ShareRootKind;
  /**
   * Feature flag `shareRootPolicyRoots`, off by default. Even when on, policy
   * roots are signed only while `nodeOrigin` advertises the owner-authority
   * mode `enforce` (see {@link POLICY_OWNER_AUTHORITY_FEATURES}).
   */
  readonly shareRootPolicyRoots?: boolean;
  readonly nodeOrigin?: string;
  /** Defaults to a process-wide probe with {@link POLICY_OWNER_AUTHORITY_PROBE_TTL_MS}. */
  readonly policyOwnerModeProbe?: PolicyOwnerModeProbe;
  readonly now?: () => number;
}

/** Persistable root metadata. Holds no key material: the key lives in its own store. */
export interface ShareRootRecord {
  readonly version: 1;
  readonly kind: ShareRootKind;
  readonly cid: string;
  /** Base64url of the exact owner-signed CACAO bytes. */
  readonly authorization: string;
  readonly spaceId: string;
  readonly ownerDid: string;
  readonly keyDid: string;
  readonly expiresAt: string;
}

export interface ShareRootLink {
  readonly rootCid: string;
  readonly linkDid: string;
  readonly path: string;
  readonly expiresAt: Date;
  /** Compact UCAN for `POST /delegate`, then the link's bearer token. */
  readonly delegation: CompactUcanAuthorization;
}

/** Signing material for Policy/v3 roots, returned only when the policy-root gate is open. */
export interface ShareRootPolicySigner {
  /** The share key DID: the `ownerDid` of the policy roots. */
  readonly ownerDid: string;
  readonly rootCid: string;
  /** The interim rule: no policy root may outlive the share root. */
  readonly notAfter: Date;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

interface Owner { readonly chainId: string; readonly address: string }

function parseOwnerDid(ownerDid: string): Owner {
  const match = /^did:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40})$/.exec(ownerDid);
  if (match === null) throw new ShareRootError("invalid-request", "share root owner must be did:pkh:eip155");
  return { chainId: match[1]!, address: match[2]!.toLowerCase() };
}

function sameOwner(left: Owner, right: Owner): boolean {
  return left.chainId === right.chainId && left.address === right.address;
}

function assertSpace(spaceId: string, owner: Owner, kind: ShareRootKind): void {
  const match = /^tinycloud:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40}):([A-Za-z0-9_-]+)$/.exec(spaceId);
  if (match === null || !sameOwner({ chainId: match[1]!, address: match[2]!.toLowerCase() }, owner) || match[3] !== PROFILES[kind].spaceName) {
    throw new ShareRootError("invalid-request", `${kind} root must target the owner's ${PROFILES[kind].spaceName} space`);
  }
}

function shareNetworkId(owner: Owner): string {
  return `urn:tinycloud:encryption:did:pkh:eip155:${owner.chainId}:${owner.address}:share`;
}

/** The exact permissions of a root, and nothing else. */
function rootPermissions(kind: ShareRootKind, owner: Owner): OwnerDelegationPermission[] {
  const permissions: OwnerDelegationPermission[] = [{ service: "tinycloud.kv", path: SHARE_ROOT_PREFIX, actions: [...KV_ABILITIES] }];
  if (PROFILES[kind].decrypt) permissions.push({ service: "tinycloud.encryption", path: shareNetworkId(owner), actions: [DECRYPT_ABILITY] });
  return permissions;
}

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function parseTime(value: string | undefined, label: string, rootCid: string): number {
  const time = value === undefined ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(time)) throw new ShareRootError("malformed-root", `share root ${label} is missing or invalid`, rootCid);
  return time;
}

interface ExpectedRoot {
  readonly kind: ShareRootKind;
  readonly owner: Owner;
  readonly spaceId: string;
  readonly keyDid: string;
  readonly requestedExpiresAt?: Date;
  readonly now: number;
}

/**
 * Check what the owner actually signed: the decoded ReCap must grant exactly
 * the root's abilities to exactly the share key, with no other resource, no
 * parent, and a lifetime within the cap. Returns the signed expiry.
 */
function validateSignedRoot(decoded: DecodedOwnerRootCacao, expected: ExpectedRoot): { issuedAt: Date; expiresAt: Date } {
  const { cid } = decoded;
  let issuer: Owner;
  try { issuer = parseOwnerDid(decoded.issuer); } catch { throw new ShareRootError("issuer-mismatch", "share root is not signed by a did:pkh owner", cid); }
  if (!sameOwner(issuer, expected.owner)) throw new ShareRootError("issuer-mismatch", "share root is signed by another owner", cid);
  if (decoded.audience !== expected.keyDid) throw new ShareRootError("audience-mismatch", "share root is not delegated to the share key", cid);
  if (decoded.resources.length !== 1 || !decoded.resources[0]!.startsWith("urn:recap:")) throw new ShareRootError("resource-mismatch", "share root must carry exactly one ReCap resource", cid);
  if (decoded.reCapProofs.length !== 0) throw new ShareRootError("resource-mismatch", "share root must not have parent capabilities", cid);

  const wanted: Record<string, readonly string[]> = { [`${expected.spaceId}/kv/${SHARE_ROOT_PREFIX}`]: KV_ABILITIES };
  if (PROFILES[expected.kind].decrypt) wanted[shareNetworkId(expected.owner)] = [DECRYPT_ABILITY];
  const signed = Object.keys(decoded.attenuation);
  for (const resource of signed) if (wanted[resource] === undefined) throw new ShareRootError("resource-mismatch", "share root grants a resource outside its scope", cid);
  for (const [resource, abilities] of Object.entries(wanted)) {
    const granted = decoded.attenuation[resource];
    if (granted === undefined) throw new ShareRootError("resource-mismatch", "share root is missing one of its resources", cid);
    const names = Object.keys(granted);
    if (names.length !== abilities.length || abilities.some((ability) => !names.includes(ability))) throw new ShareRootError("ability-mismatch", "share root abilities differ from the request", cid);
    for (const ability of abilities) {
      const caveats = granted[ability]!;
      if (caveats.length !== 1 || typeof caveats[0] !== "object" || caveats[0] === null || Array.isArray(caveats[0]) || Object.keys(caveats[0]).length !== 0) {
        throw new ShareRootError("ability-mismatch", "share root abilities carry unexpected caveats", cid);
      }
    }
  }

  const issuedAt = parseTime(decoded.issuedAt, "issued-at time", cid);
  const expiresAt = parseTime(decoded.expiresAt, "expiration time", cid);
  if (decoded.notBefore !== undefined && parseTime(decoded.notBefore, "not-before time", cid) > expected.now) throw new ShareRootError("malformed-root", "share root is not valid yet", cid);
  const cap = PROFILES[expected.kind].maxLifetimeMs;
  if (expiresAt - issuedAt > cap || expiresAt - expected.now > cap) throw new ShareRootError("lifetime-exceeds-cap", `${expected.kind} root lifetime exceeds ${cap / DAY_MS} days`, cid);
  if (expiresAt <= expected.now) throw new ShareRootError("expired", "share root has expired", cid);
  if (expected.requestedExpiresAt !== undefined && seconds(expiresAt) !== seconds(expected.requestedExpiresAt.getTime())) {
    throw new ShareRootError("expiry-mismatch", "share root was signed with a different expiry than requested", cid);
  }
  return { issuedAt: new Date(issuedAt), expiresAt: new Date(expiresAt) };
}

function assertLinkPath(path: string): void {
  if (
    typeof path !== "string"
    || !path.startsWith(SHARE_ROOT_PREFIX)
    || path.length === SHARE_ROOT_PREFIX.length
    || path.endsWith("/")
    || path.includes("//")
    || path.split("/").some((segment) => segment === "." || segment === "..")
    || /[\u0000-\u001f\u007f\\*?#]/.test(path)
  ) throw new ShareRootError("link-out-of-scope", "link path must be one exact key under the share prefix");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function assertUsableKey(key: DelegatedShareKey): Promise<void> {
  try {
    await assertNonExtractableShareKey(key);
  } catch (error) {
    throw new ShareRootError("invalid-key", errorMessage(error));
  }
}

/**
 * The single adapter over the Node's advertisement. Takes the `features`
 * list of `GET /info` and returns `"enforce"` only for the marker plus the
 * `-enforce` mode and no `-record`; `"record"` for the marker plus
 * `-record` only; `undefined` for anything else (no marker, as on every
 * Node up to 1.21.0, both modes, or a malformed list). Only `"enforce"` opens
 * the policy-root gate.
 */
export function readPolicyOwnerAuthorityMode(features: unknown): "enforce" | "record" | undefined {
  if (!Array.isArray(features) || !features.includes(POLICY_OWNER_AUTHORITY_FEATURES.marker)) return undefined;
  const enforce = features.includes(POLICY_OWNER_AUTHORITY_FEATURES.enforce);
  const record = features.includes(POLICY_OWNER_AUTHORITY_FEATURES.record);
  if (enforce === record) return undefined;
  return enforce ? "enforce" : "record";
}

/** Per-Node cache of "does this Node enforce owner-authority expiry". */
export interface PolicyOwnerModeProbe {
  /** True only when the Node currently advertises `enforce`. Never throws. */
  isEnforced(nodeOrigin: string): Promise<boolean>;
  /**
   * Record the `features` a sign-in just read from `GET /info`
   * (`NodeInfo.features`), so each sign-in refreshes the answer without a
   * second fetch.
   */
  observe(nodeOrigin: string, features: readonly string[]): void;
}

/**
 * Keep each Node's answer in memory for `ttlMs` (default 5 minutes), then
 * read `GET /info` again, so a Node that stops advertising `enforce` turns
 * the gate off within one TTL. Unreachable, non-2xx, non-JSON or malformed
 * answers count as not enforcing (and are cached for the same TTL).
 */
export function createPolicyOwnerModeProbe(options: { readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>; readonly ttlMs?: number; readonly now?: () => number } = {}): PolicyOwnerModeProbe {
  const fetchFn = options.fetch ?? ((input: URL, init: RequestInit) => globalThis.fetch(input, init));
  const ttlMs = Math.min(options.ttlMs ?? POLICY_OWNER_AUTHORITY_PROBE_TTL_MS, POLICY_OWNER_AUTHORITY_PROBE_TTL_MS);
  const now = options.now ?? Date.now;
  const cache = new Map<string, { readonly enforced: boolean; readonly checkedAt: number }>();
  const originOf = (nodeOrigin: string): string | undefined => {
    try { return new URL(nodeOrigin).origin; } catch { return undefined; }
  };
  return {
    async isEnforced(nodeOrigin) {
      const origin = originOf(nodeOrigin);
      if (origin === undefined) return false;
      const cached = cache.get(origin);
      if (cached !== undefined && now() - cached.checkedAt < ttlMs) return cached.enforced;
      let enforced = false;
      try {
        const response = await fetchFn(new URL("/info", origin), { redirect: "error", signal: AbortSignal.timeout(5000) });
        const info: unknown = response.ok ? await response.json() : undefined;
        enforced = typeof info === "object" && info !== null && "features" in info && readPolicyOwnerAuthorityMode(info.features) === "enforce";
      } catch {
        enforced = false;
      }
      cache.set(origin, { enforced, checkedAt: now() });
      return enforced;
    },
    observe(nodeOrigin, features) {
      const origin = originOf(nodeOrigin);
      if (origin !== undefined) cache.set(origin, { enforced: readPolicyOwnerAuthorityMode(features) === "enforce", checkedAt: now() });
    },
  };
}

/** Process-wide default; sign-in code should feed it `NodeInfo.features` through `observe`. */
export const defaultPolicyOwnerModeProbe: PolicyOwnerModeProbe = createPolicyOwnerModeProbe();

/**
 * A wallet-signed, read-only root delegated to one non-extractable share key,
 * so shares outlive the owner's login session (TC-1423 D3, option B').
 *
 * - Scope: `kv/get` + `kv/metadata` on the share prefix, plus `decrypt` on the
 *   owner's `:share` network for a `share` root. Never put, del, list,
 *   `capabilities/read`, `network.create` or `:default`.
 * - Created only through `createOwnerDelegation({ permissions })`, and the
 *   signed bytes are decoded and checked here.
 * - Lifetime: at most 37 days (`agent`: 30). One key per root.
 * - Bearer links may be signed now; policy (email/domain) roots only while
 *   `shareRootPolicyRoots` is on and the Node advertises owner-authority
 *   mode `enforce`.
 */
export class ShareRoot {
  readonly kind: ShareRootKind;
  readonly cid: string;
  readonly ownerDid: string;
  readonly spaceId: string;
  readonly keyDid: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly #authorization: Uint8Array;
  readonly #key: DelegatedShareKey;
  readonly #options: ShareRootOptions;

  private constructor(input: { kind: ShareRootKind; cid: string; ownerDid: string; spaceId: string; issuedAt: Date; expiresAt: Date; authorization: Uint8Array; key: DelegatedShareKey; options: ShareRootOptions }) {
    this.kind = input.kind;
    this.cid = input.cid;
    this.ownerDid = input.ownerDid;
    this.spaceId = input.spaceId;
    this.keyDid = input.key.did;
    this.issuedAt = input.issuedAt;
    this.expiresAt = input.expiresAt;
    this.#authorization = input.authorization;
    this.#key = input.key;
    this.#options = input.options;
  }

  /**
   * Ask the owner for a new root (one approval) for a fresh share key. All
   * request checks run before anything is signed. If the signed result is
   * rejected, the key is cleared and the error carries the imported `rootCid`.
   */
  static async create(input: { readonly owner: ShareRootOwnerAuthority; readonly key: DelegatedShareKey; readonly spaceId: string; readonly expiresAt: Date; readonly options?: ShareRootOptions }): Promise<ShareRoot> {
    const options = input.options ?? {};
    const kind = options.kind ?? "share";
    const now = (options.now ?? Date.now)();
    const owner = parseOwnerDid(input.owner.ownerDid);
    assertSpace(input.spaceId, owner, kind);
    await assertUsableKey(input.key);
    const expiry = input.expiresAt instanceof Date ? input.expiresAt.getTime() : Number.NaN;
    if (!Number.isFinite(expiry) || expiry <= now) throw new ShareRootError("invalid-request", "share root expiry must be in the future");
    if (expiry - now > PROFILES[kind].maxLifetimeMs) throw new ShareRootError("lifetime-exceeds-cap", `${kind} root lifetime exceeds ${PROFILES[kind].maxLifetimeMs / DAY_MS} days`);

    const receipt = await input.owner.createOwnerDelegation({
      delegateDid: input.key.did,
      spaceId: input.spaceId,
      expiresAt: input.expiresAt,
      permissions: rootPermissions(kind, owner),
    });
    try {
      const authorization = new Uint8Array(receipt.signedDagCbor);
      let decoded: DecodedOwnerRootCacao;
      try { decoded = decodeOwnerRootCacao(authorization, receipt.delegationCid); } catch (error) { throw new ShareRootError("malformed-root", errorMessage(error), receipt.delegationCid); }
      const times = validateSignedRoot(decoded, { kind, owner, spaceId: input.spaceId, keyDid: input.key.did, requestedExpiresAt: input.expiresAt, now: (options.now ?? Date.now)() });
      return new ShareRoot({ kind, cid: decoded.cid, ownerDid: input.owner.ownerDid, spaceId: input.spaceId, ...times, authorization, key: input.key, options });
    } catch (error) {
      input.key.clear();
      if (error instanceof ShareRootError) throw error.rootCid === undefined ? new ShareRootError(error.code, error.message, receipt.delegationCid) : error;
      throw new ShareRootError("malformed-root", errorMessage(error), receipt.delegationCid);
    }
  }

  /** Rebuild a stored root with its key; the signed bytes are checked again (no expiry-equality check). */
  static async restore(input: { readonly record: ShareRootRecord; readonly key: DelegatedShareKey; readonly options?: ShareRootOptions }): Promise<ShareRoot> {
    const { record } = input;
    const options = { ...input.options, kind: record.kind };
    if (record.version !== 1 || (record.kind !== "share" && record.kind !== "agent")) throw new ShareRootError("malformed-root", "share root record is not supported");
    if (record.keyDid !== input.key.did) throw new ShareRootError("audience-mismatch", "share root record belongs to another key");
    const owner = parseOwnerDid(record.ownerDid);
    assertSpace(record.spaceId, owner, record.kind);
    await assertUsableKey(input.key);
    let authorization: Uint8Array;
    let decoded: DecodedOwnerRootCacao;
    try {
      authorization = fromBase64Url(record.authorization);
      decoded = decodeOwnerRootCacao(authorization, record.cid);
    } catch (error) { throw new ShareRootError("malformed-root", errorMessage(error), record.cid); }
    const times = validateSignedRoot(decoded, { kind: record.kind, owner, spaceId: record.spaceId, keyDid: input.key.did, now: (options.now ?? Date.now)() });
    return new ShareRoot({ kind: record.kind, cid: decoded.cid, ownerDid: record.ownerDid, spaceId: record.spaceId, ...times, authorization, key: input.key, options });
  }

  /** The `Authorization` value the Node knows this root by (base64url CACAO). */
  get authorization(): string {
    return toBase64Url(this.#authorization);
  }

  toRecord(): ShareRootRecord {
    return { version: 1, kind: this.kind, cid: this.cid, authorization: this.authorization, spaceId: this.spaceId, ownerDid: this.ownerDid, keyDid: this.keyDid, expiresAt: this.expiresAt.toISOString() };
  }

  /** True while the root is live and lasts at least until `expiresAt`. */
  covers(expiresAt: Date, now: number = this.#now()): boolean {
    return now < this.expiresAt.getTime() && expiresAt.getTime() <= this.expiresAt.getTime();
  }

  /**
   * Sign a bearer link: `kv/get` on one exact key under the prefix, to the
   * link's own key, with this root as its only proof. It never outlives the
   * root (the Node refuses that too) or 30 days. Zero approvals.
   */
  async signBearerLink(input: { readonly linkDid: string; readonly path: string; readonly expiresAt: Date }): Promise<ShareRootLink> {
    const now = this.#now();
    if (now >= this.expiresAt.getTime()) throw new ShareRootError("expired", "share root has expired", this.cid);
    assertLinkPath(input.path);
    try { ed25519PublicKeyFromDidKey(input.linkDid); } catch { throw new ShareRootError("invalid-request", "link key must be an Ed25519 did:key"); }
    if (input.linkDid === this.keyDid) throw new ShareRootError("invalid-request", "link key must not be the share key");
    const expiry = input.expiresAt instanceof Date ? input.expiresAt.getTime() : Number.NaN;
    if (!Number.isFinite(expiry) || expiry <= now) throw new ShareRootError("invalid-request", "link expiry must be in the future");
    if (expiry > this.expiresAt.getTime()) throw new ShareRootError("lifetime-exceeds-cap", "link must not outlive its share root", this.cid);
    if (expiry - now > SHARE_ROOT_LINK_MAX_LIFETIME_MS) throw new ShareRootError("lifetime-exceeds-cap", "link lifetime exceeds 30 days", this.cid);
    const delegation = await signShareKeyDelegation({
      key: this.#key,
      audienceDid: input.linkDid,
      attenuation: { [`${this.spaceId}/kv/${input.path}`]: { "tinycloud.kv/get": [{}] } },
      proofs: [this.cid],
      // The Node allows no clock skew; back-date a little, never before the root.
      notBefore: Math.max(seconds(this.issuedAt.getTime()), seconds(now) - 30),
      expiresAt: seconds(expiry),
    });
    return { rootCid: this.cid, linkDid: input.linkDid, path: input.path, expiresAt: new Date(seconds(expiry) * 1000), delegation };
  }

  /**
   * The only way to sign Policy/v3 (email/domain) roots with the share key.
   * Throws unless the `shareRootPolicyRoots` flag is on and the Node
   * currently advertises owner-authority mode exactly `enforce` (absent,
   * `record`, malformed or unreachable all refuse). Until then addressed
   * shares use per-share owner grants. Agent roots are bearer-only.
   */
  async policyRootSigner(input: { readonly expiresAt: Date }): Promise<ShareRootPolicySigner> {
    if (this.#options.shareRootPolicyRoots !== true) throw new ShareRootError("policy-roots-disabled", "share root policy roots are disabled (shareRootPolicyRoots is off)", this.cid);
    if (this.kind !== "share") throw new ShareRootError("policy-roots-disabled", "agent roots are bearer-only", this.cid);
    const enforced = this.#options.nodeOrigin !== undefined && await (this.#options.policyOwnerModeProbe ?? defaultPolicyOwnerModeProbe).isEnforced(this.#options.nodeOrigin);
    if (!enforced) throw new ShareRootError("policy-roots-not-enforced-by-node", "the Node does not advertise owner-authority mode enforce", this.cid);
    const now = this.#now();
    if (now >= this.expiresAt.getTime()) throw new ShareRootError("expired", "share root has expired", this.cid);
    const expiry = input.expiresAt instanceof Date ? input.expiresAt.getTime() : Number.NaN;
    if (!Number.isFinite(expiry) || expiry <= now) throw new ShareRootError("invalid-request", "policy root expiry must be in the future");
    if (expiry > this.expiresAt.getTime()) throw new ShareRootError("lifetime-exceeds-cap", "policy root must not outlive its share root", this.cid);
    const key = this.#key;
    return { ownerDid: this.keyDid, rootCid: this.cid, notAfter: new Date(this.expiresAt), sign: (bytes) => key.sign(bytes) };
  }

  /** Forget the key in this process. It does not revoke the root: only the owner does that. */
  clear(): void {
    this.#key.clear();
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }
}

/**
 * Re-root only when needed: keep `current` while it covers `linkExpiresAt`;
 * otherwise mint one new root (one approval) with a new key and the full
 * lifetime of its kind.
 */
export async function ensureShareRoot(input: {
  readonly current?: ShareRoot;
  readonly linkExpiresAt: Date;
  readonly owner: ShareRootOwnerAuthority;
  readonly spaceId: string;
  readonly newKey: () => Promise<DelegatedShareKey>;
  readonly options?: ShareRootOptions;
}): Promise<{ readonly root: ShareRoot; readonly rerooted: boolean }> {
  const options = input.options ?? {};
  const kind = options.kind ?? "share";
  const now = (options.now ?? Date.now)();
  if (input.current !== undefined && input.current.kind === kind && input.current.spaceId === input.spaceId && input.current.covers(input.linkExpiresAt, now)) {
    return { root: input.current, rerooted: false };
  }
  const maxLifetime = PROFILES[kind].maxLifetimeMs;
  if (input.linkExpiresAt.getTime() - now > Math.min(maxLifetime, SHARE_ROOT_LINK_MAX_LIFETIME_MS)) throw new ShareRootError("lifetime-exceeds-cap", "no share root can cover this link expiry");
  const key = await input.newKey();
  if (input.current !== undefined && key.did === input.current.keyDid) throw new ShareRootError("reroot-same-key", "a re-root needs a new share key");
  const root = await ShareRoot.create({ owner: input.owner, key, spaceId: input.spaceId, expiresAt: new Date(now + maxLifetime), options });
  return { root, rerooted: true };
}
