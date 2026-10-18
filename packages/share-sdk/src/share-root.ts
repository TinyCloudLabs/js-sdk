import { ed25519PublicKeyFromDidKey, signCompactUcanAuthorization, toBase64Url, fromBase64Url, type CompactUcanAuthorization } from "@tinycloud/share-envelope";
import type { AddressedOwnerRootInput, AddressedOwnerRootReceipt } from "./addressed-publish.js";
import { decodeOwnerRootCacao, ownerRootCacaoCid, type DecodedOwnerRootCacao } from "./owner-root-cacao.js";
import { createDelegatedShareKey, type CreateOwnerDelegationParams, type DelegatedShareKey, type OwnerDelegationPermission, type OwnerDelegationReceipt } from "./owner-policy.js";
import { assertNonExtractableShareKey, signShareKeyDelegation } from "./share-key-signer.js";

const DAY_MS = 86_400_000;

/** KV prefix every share lives under; the root never reaches outside it. */
export const SHARE_ROOT_PREFIX = "xyz.tinycloud.share/shares/";
/** Longest lifetime of a Share (browser device or CLI profile) root. */
export const SHARE_ROOT_MAX_LIFETIME_MS = 37 * DAY_MS;
/** Longest lifetime of an agent root (the OpenKey device-grant cap). */
export const AGENT_SHARE_ROOT_MAX_LIFETIME_MS = 30 * DAY_MS;
/** Product cap on a bearer link or policy root signed under a root. */
export const SHARE_ROOT_LINK_MAX_LIFETIME_MS = 30 * DAY_MS;
/**
 * Signer clock skew tolerated on a signed root's `exp - iat` (only there:
 * `exp - now` stays strict), so an approval is not wasted when the signer
 * sets its own issue time.
 */
export const SHARE_ROOT_CLOCK_SKEW_MS = 5 * 60_000;
/** `ensureShareRoot` asks for the cap minus this margin, so a clamping or slow signer stays inside the cap. */
export const SHARE_ROOT_REQUEST_MARGIN_MS = 10 * 60_000;
/**
 * NODE-B2 (§9 "Advertised mode"): a Node lists these in the `features` of
 * its public `GET /info` (sdk-core `checkNodeInfo` → `NodeInfo.features`):
 * the capability marker plus exactly one active mode. Read in one place,
 * {@link readPolicyOwnerAuthorityMode}; the Node version is never consulted.
 */
export const POLICY_OWNER_AUTHORITY_FEATURES = {
  marker: "policy-owner-authority-v1",
  record: "policy-owner-authority-record",
  enforce: "policy-owner-authority-enforce",
} as const;
/** How long a known mode is trusted before the Node is asked again (NODE-B2: at most 5 minutes). */
export const POLICY_OWNER_AUTHORITY_PROBE_TTL_MS = 5 * 60_000;
const MAX_INFO_BYTES = 64 * 1024;
const MAX_POLICY_ROOT_MS = 31 * DAY_MS;

/** `share`: Share/CLI root in `applications`. `agent`: `default` space, bearer only. */
export type ShareRootKind = "share" | "agent";
/**
 * What the owner signed. `kv`: get + metadata on the share prefix only.
 * `kv+share-decrypt`: also decrypt on the owner's `:share` network, which a
 * policy owner needs; minted only while the Node advertises `enforce` and
 * `shareRootPolicyRoots` is on.
 */
export type ShareRootScope = "kv" | "kv+share-decrypt";

const PROFILES = {
  share: { spaceName: "applications", maxLifetimeMs: SHARE_ROOT_MAX_LIFETIME_MS },
  agent: { spaceName: "default", maxLifetimeMs: AGENT_SHARE_ROOT_MAX_LIFETIME_MS },
} as const;

export const KV_ABILITIES = ["tinycloud.kv/get", "tinycloud.kv/metadata"] as const;
export const DECRYPT_ABILITY = "tinycloud.encryption/decrypt";

export type ShareRootErrorCode =
  | "invalid-request"
  | "invalid-key"
  | "key-cleared"
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
  | "policy-roots-not-enforced-by-node"
  | "root-not-policy-capable"
  | "node-refused";

export interface ShareRootErrorDetails {
  /** The delegation CID the Node imported (the receipt's), when the owner already signed. */
  readonly rootCid?: string;
  /** CID of the signed bytes, when it differs from `rootCid`. */
  readonly signedCid?: string;
  /** The imported root may grant more, or longer, than requested: the owner must revoke `rootCid`. */
  readonly mustRevoke?: boolean;
}

export class ShareRootError extends Error {
  readonly code: ShareRootErrorCode;
  readonly rootCid?: string;
  readonly signedCid?: string;
  readonly mustRevoke: boolean;

  constructor(code: ShareRootErrorCode, message: string, details: ShareRootErrorDetails = {}) {
    super(details.mustRevoke === true && details.rootCid !== undefined
      ? `${message}; the Node imported root ${details.rootCid}, which may grant more than requested: the owner must revoke it`
      : message);
    this.name = "ShareRootError";
    this.code = code;
    this.mustRevoke = details.mustRevoke === true;
    if (details.rootCid !== undefined) this.rootCid = details.rootCid;
    if (details.signedCid !== undefined) this.signedCid = details.signedCid;
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
   * Feature flag `shareRootPolicyRoots`, off by default. A root gains `:share`
   * decrypt, and can sign policy roots through {@link ShareRoot.policyRootSigner},
   * only while this is on and the root's Node advertises owner-authority
   * mode `enforce`.
   */
  readonly shareRootPolicyRoots?: boolean;
  /** Defaults to {@link defaultPolicyOwnerModeProbe}. */
  readonly policyOwnerModeProbe?: PolicyOwnerModeProbe;
  readonly now?: () => number;
}

/** Persistable root metadata. Holds no key material: the key lives in its own store. */
export interface ShareRootRecord {
  readonly version: 1;
  readonly kind: ShareRootKind;
  readonly scope: ShareRootScope;
  /** The Node the root was created against; its advertised mode gates policy signing. */
  readonly nodeOrigin: string;
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

/**
 * Policy/v3 owner signing for a `kv+share-decrypt` root. Shaped like
 * `AddressedPublishAuthority` without `registerPolicy`. Every call re-checks
 * the whole gate (flag, the Node's advertised mode within the probe TTL, root
 * live, key present), so a signer kept past a mode change stops working.
 */
export interface ShareRootPolicySigner {
  /** The share key DID: the `ownerDid` of the policy roots. */
  readonly ownerDid: string;
  readonly rootCid: string;
  /** Interim rule: no policy root may outlive the share root. */
  readonly notAfter: Date;
  /** Build and sign one proofless policy root; its expiry must be within `notAfter` and 31 days. */
  createOwnerRoot(input: AddressedOwnerRootInput): Promise<AddressedOwnerRootReceipt>;
  /** Sign a 32-byte digest (policy or envelope); nothing else. */
  sign(digest: Uint8Array): Promise<Uint8Array>;
}

/* Internal helpers below are exported for `share-grant.ts` and `share-network.ts`; the subpath entry does not re-export them. */
export interface Owner { readonly chainId: string; readonly address: string }

export function parseOwnerDid(ownerDid: string): Owner {
  const match = /^did:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40})$/.exec(ownerDid);
  if (match === null) throw new ShareRootError("invalid-request", "share root owner must be did:pkh:eip155");
  return { chainId: match[1]!, address: match[2]!.toLowerCase() };
}

export function sameOwner(left: Owner, right: Owner): boolean {
  return left.chainId === right.chainId && left.address === right.address;
}

export function assertSpace(spaceId: string, owner: Owner, kind: ShareRootKind): void {
  const match = /^tinycloud:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40}):([A-Za-z0-9_-]+)$/.exec(spaceId);
  if (match === null || !sameOwner({ chainId: match[1]!, address: match[2]!.toLowerCase() }, owner) || match[3] !== PROFILES[kind].spaceName) {
    throw new ShareRootError("invalid-request", `${kind} root must target the owner's ${PROFILES[kind].spaceName} space`);
  }
}

export function shareNetworkId(owner: Owner): string {
  return `urn:tinycloud:encryption:did:pkh:eip155:${owner.chainId}:${owner.address}:share`;
}

/** True for the owner's `:share` network in any address casing (the Node canonicalizes did:pkh addresses). */
export function isShareNetworkOf(resource: string, owner: Owner): boolean {
  const match = /^urn:tinycloud:encryption:did:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40}):share$/.exec(resource);
  return match !== null && sameOwner({ chainId: match[1]!, address: match[2]!.toLowerCase() }, owner);
}

/**
 * The origin a Node is known by, or `undefined`: `https:` only (plus `http:`
 * on loopback, for local nodes and tests). The scheme allowlist also refuses
 * opaque origins (`file:`, `data:`, all serialized as `"null"`), so they can
 * never share a cache entry.
 */
function nodeOriginOf(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.origin : undefined;
}

export function requireNodeOrigin(value: string): string {
  const origin = typeof value === "string" ? nodeOriginOf(value) : undefined;
  if (origin === undefined) throw new ShareRootError("invalid-request", "node origin must be https (http only on loopback)");
  return origin;
}

export function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function parseTime(value: string | undefined, label: string, rootCid: string): number {
  const time = value === undefined ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(time)) throw new ShareRootError("malformed-root", `share root ${label} is missing or invalid`, { rootCid, mustRevoke: true });
  return time;
}

/** What an owner-signed delegation to a share key must say, exactly. */
export interface ExpectedOwnerDelegation {
  /** "share root", "per-share grant", …: used in error messages. */
  readonly label: string;
  readonly owner: Owner;
  readonly keyDid: string;
  /** Resource -> the exact ability set; nothing else may be granted. */
  readonly wanted: Readonly<Record<string, readonly string[]>>;
  readonly maxLifetimeMs: number;
  readonly requestedExpiresAt?: Date;
  readonly now: number;
}

/**
 * Check what the owner actually signed: the decoded ReCap must grant exactly
 * `wanted` to exactly the share key, with no other resource, no parent, and
 * a lifetime within the cap. Returns the signed times.
 */
export function validateSignedOwnerDelegation(decoded: DecodedOwnerRootCacao, expected: ExpectedOwnerDelegation): { issuedAt: Date; expiresAt: Date } {
  const { label } = expected;
  const wider = { rootCid: decoded.cid, mustRevoke: true };
  let issuer: Owner;
  try { issuer = parseOwnerDid(decoded.issuer); } catch { throw new ShareRootError("issuer-mismatch", `${label} is not signed by a did:pkh owner`, wider); }
  if (!sameOwner(issuer, expected.owner)) throw new ShareRootError("issuer-mismatch", `${label} is signed by another owner`, wider);
  if (decoded.audience !== expected.keyDid) throw new ShareRootError("audience-mismatch", `${label} is not delegated to its key`, wider);
  if (decoded.resources.length !== 1 || !decoded.resources[0]!.startsWith("urn:recap:")) throw new ShareRootError("resource-mismatch", `${label} must carry exactly one ReCap resource`, wider);
  if (decoded.reCapProofs.length !== 0) throw new ShareRootError("resource-mismatch", `${label} must not have parent capabilities`, wider);

  const { wanted } = expected;
  for (const resource of Object.keys(decoded.attenuation)) if (wanted[resource] === undefined) throw new ShareRootError("resource-mismatch", `${label} grants a resource outside its scope`, wider);
  for (const [resource, abilities] of Object.entries(wanted)) {
    const granted = decoded.attenuation[resource];
    if (granted === undefined) throw new ShareRootError("resource-mismatch", `${label} is missing one of its resources`, wider);
    const names = Object.keys(granted);
    if (names.length !== abilities.length || abilities.some((ability) => !names.includes(ability))) throw new ShareRootError("ability-mismatch", `${label} abilities differ from the request`, wider);
    for (const ability of abilities) {
      const caveats = granted[ability]!;
      if (caveats.length !== 1 || typeof caveats[0] !== "object" || caveats[0] === null || Array.isArray(caveats[0]) || Object.keys(caveats[0]).length !== 0) {
        throw new ShareRootError("ability-mismatch", `${label} abilities carry unexpected caveats`, wider);
      }
    }
  }

  const issuedAt = parseTime(decoded.issuedAt, "issued-at time", decoded.cid);
  const expiresAt = parseTime(decoded.expiresAt, "expiration time", decoded.cid);
  if (decoded.notBefore !== undefined && parseTime(decoded.notBefore, "not-before time", decoded.cid) > expected.now) throw new ShareRootError("malformed-root", `${label} is not valid yet`, { rootCid: decoded.cid });
  const cap = expected.maxLifetimeMs;
  if (expiresAt - issuedAt > cap + SHARE_ROOT_CLOCK_SKEW_MS || expiresAt - expected.now > cap) throw new ShareRootError("lifetime-exceeds-cap", `${label} lifetime exceeds its cap`, wider);
  if (expiresAt <= expected.now) throw new ShareRootError("expired", `${label} has expired`, { rootCid: decoded.cid });
  if (expected.requestedExpiresAt !== undefined && seconds(expiresAt) !== seconds(expected.requestedExpiresAt.getTime())) {
    throw new ShareRootError("expiry-mismatch", `${label} was signed with a different expiry than requested`, { rootCid: decoded.cid, mustRevoke: expiresAt > expected.requestedExpiresAt.getTime() });
  }
  return { issuedAt: new Date(issuedAt), expiresAt: new Date(expiresAt) };
}

function validateSignedRoot(decoded: DecodedOwnerRootCacao, expected: { kind: ShareRootKind; scope: ShareRootScope; owner: Owner; spaceId: string; keyDid: string; requestedExpiresAt?: Date; now: number }): { issuedAt: Date; expiresAt: Date } {
  const wanted: Record<string, readonly string[]> = { [`${expected.spaceId}/kv/${SHARE_ROOT_PREFIX}`]: KV_ABILITIES };
  if (expected.scope === "kv+share-decrypt") wanted[shareNetworkId(expected.owner)] = [DECRYPT_ABILITY];
  return validateSignedOwnerDelegation(decoded, {
    label: `${expected.kind} root`,
    owner: expected.owner,
    keyDid: expected.keyDid,
    wanted,
    maxLifetimeMs: PROFILES[expected.kind].maxLifetimeMs,
    ...(expected.requestedExpiresAt === undefined ? {} : { requestedExpiresAt: expected.requestedExpiresAt }),
    now: expected.now,
  });
}

export function assertLinkPath(path: string): void {
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function assertUsableKey(key: DelegatedShareKey): Promise<void> {
  try {
    await assertNonExtractableShareKey(key);
  } catch (error) {
    throw new ShareRootError("invalid-key", errorMessage(error));
  }
}

/** The facts and attenuation of a Policy/v3 owner root, identical to node-sdk `createUnifiedOwnerRoot`. */
function policyRootContents(input: AddressedOwnerRootInput): { facts: Record<string, string>; attenuation: Record<string, Record<string, readonly Record<string, unknown>[]>> } {
  const facts: Record<string, string> = {
    role: input.role,
    mode: input.role === "policy-authority" ? "policy-source" : "conditional-mint",
    ownerDid: input.ownerDid,
    policyId: input.policyId,
    policyDigestHex: input.policyDigestHex,
    policyCid: input.policyCid,
    contentSourceDigestHex: input.contentSourceDigestHex,
    capabilityCeilingHashHex: input.capabilityCeilingHashHex,
    nativeProjectionHashHex: input.nativeProjectionHashHex,
    nodeAudience: input.nodeAudience,
    ...(input.role === "policy-enforcement" ? { enforcerDid: input.audienceDid } : {}),
  };
  const attenuation: Record<string, Record<string, readonly Record<string, unknown>[]>> = {};
  for (const capability of input.capabilities) {
    if (attenuation[capability.resource] !== undefined) throw new ShareRootError("invalid-request", "policy root contains a duplicate resource");
    attenuation[capability.resource] = capability.kind === "encryption"
      ? { [capability.action]: [{}] }
      : Object.fromEntries(capability.actions.map((action) => [action, [{ type: "xyz.tinycloud.resource/selector", kind: capability.selector, value: capability.resource }]]));
  }
  return { facts, attenuation };
}

/**
 * Policy/v3 owner signing for one owner delegation (a share root or a
 * per-share grant). `gate` runs before every signature and returns the key;
 * `createOwnerRoot` builds the proofless root itself, bounds its expiry by
 * `notAfter` and 31 days, and admits only capabilities `inScope` accepts;
 * `sign` takes 32-byte digests only.
 */
export function ownerPolicySigner(input: {
  readonly ownerDid: string;
  readonly authorityCid: string;
  readonly notAfter: Date;
  readonly gate: () => Promise<DelegatedShareKey>;
  readonly now: () => number;
  readonly inScope: (capability: AddressedOwnerRootInput["capabilities"][number]) => boolean;
}): ShareRootPolicySigner {
  const { ownerDid, authorityCid, notAfter, gate } = input;
  return {
    ownerDid,
    rootCid: authorityCid,
    notAfter,
    createOwnerRoot: async (root) => {
      const key = await gate();
      const now = input.now();
      const notBefore = root.notBefore instanceof Date ? root.notBefore.getTime() : Number.NaN;
      const expiry = root.expiresAt instanceof Date ? root.expiresAt.getTime() : Number.NaN;
      if (root.ownerDid !== ownerDid || (root.role !== "policy-authority" && root.role !== "policy-enforcement")) throw new ShareRootError("invalid-request", "policy root must be owned by this key");
      if (!Number.isFinite(notBefore) || !Number.isFinite(expiry) || notBefore >= expiry || expiry <= now) throw new ShareRootError("invalid-request", "policy root validity is invalid");
      if (expiry > notAfter.getTime() || expiry - notBefore > MAX_POLICY_ROOT_MS) throw new ShareRootError("lifetime-exceeds-cap", "policy root must not outlive its owner delegation or 31 days", { rootCid: authorityCid });
      for (const capability of root.capabilities) {
        if (!input.inScope(capability)) throw new ShareRootError("invalid-request", "policy root capability is outside the owner delegation");
      }
      const { facts, attenuation } = policyRootContents(root);
      const signed = await signShareKeyDelegation({
        key,
        audienceDid: root.audienceDid,
        attenuation,
        facts: [facts],
        proofs: [],
        notBefore: seconds(notBefore),
        expiresAt: seconds(expiry),
        nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
      });
      return { cid: signed.cid, delegationHeader: { Authorization: signed.authorization } };
    },
    sign: async (digest) => {
      const key = await gate();
      if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new ShareRootError("invalid-request", "policy signer signs 32-byte digests only");
      return key.sign(digest);
    },
  };
}

/**
 * The single adapter over the Node's advertisement. Takes the `features`
 * list of `GET /info` and returns `"enforce"` only for the marker plus the
 * `-enforce` mode and no `-record`; `"record"` for the marker plus
 * `-record` only; `undefined` for anything else (no marker, as on every
 * Node up to 1.21.0, both modes, or a malformed list). Only `"enforce"`
 * enables policy-capable roots.
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

/** Read a Node JSON answer: `application/json` only, at most 64 KiB. */
export async function readJsonCapped(response: Response): Promise<unknown> {
  if (!/^application\/json\s*(;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("node answer is not JSON");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("node answer has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_INFO_BYTES) {
      await reader.cancel();
      throw new Error("node answer is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/**
 * Keep each Node's answer in memory for `ttlMs` (default and ceiling 5
 * minutes), then read `GET /info` again, so a Node that stops advertising
 * `enforce` turns the gate off within one TTL. Only `https:` origins (and
 * `http:` on loopback) are probed. A failure, a non-JSON or oversized
 * (64 KiB) answer, or a malformed list counts as not enforcing and is cached
 * for the same TTL.
 */
export function createPolicyOwnerModeProbe(options: { readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>; readonly ttlMs?: number; readonly now?: () => number } = {}): PolicyOwnerModeProbe {
  const fetchFn = options.fetch ?? ((input: URL, init: RequestInit) => globalThis.fetch(input, init));
  const ttlMs = Math.min(options.ttlMs ?? POLICY_OWNER_AUTHORITY_PROBE_TTL_MS, POLICY_OWNER_AUTHORITY_PROBE_TTL_MS);
  const now = options.now ?? Date.now;
  const cache = new Map<string, { readonly enforced: boolean; readonly checkedAt: number }>();
  return {
    async isEnforced(nodeOrigin) {
      const origin = nodeOriginOf(nodeOrigin);
      if (origin === undefined) return false;
      const cached = cache.get(origin);
      if (cached !== undefined && now() - cached.checkedAt < ttlMs) return cached.enforced;
      let enforced = false;
      try {
        const response = await fetchFn(new URL("/info", origin), { redirect: "error", signal: AbortSignal.timeout(5000) });
        const info = response.ok ? await readJsonCapped(response) : undefined;
        enforced = typeof info === "object" && info !== null && "features" in info && readPolicyOwnerAuthorityMode(info.features) === "enforce";
      } catch {
        enforced = false;
      }
      cache.set(origin, { enforced, checkedAt: now() });
      return enforced;
    },
    observe(nodeOrigin, features) {
      const origin = nodeOriginOf(nodeOrigin);
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
 * - Scope: `kv/get` + `kv/metadata` on the share prefix. `:share` decrypt is
 *   added (scope `kv+share-decrypt`) only when the root is created while
 *   `shareRootPolicyRoots` is on and its Node advertises owner-authority mode
 *   `enforce`; a `kv` root holds no `:share` decrypt, so its key cannot own a
 *   policy over `:share`-encrypted content (the Node answers
 *   `policy-owner-not-authorized`). Never put, del, list, `capabilities/read`,
 *   `network.create` or `:default`.
 * - Created only through `createOwnerDelegation({ permissions })`; the signed
 *   bytes are decoded and checked here.
 * - Lifetime: at most 37 days (`agent`: 30). One key per root.
 * - Key custody: `create` generates the non-extractable key itself and never
 *   exposes it; `clear()` drops the only handle. Browser persistence of a
 *   share key requires the composer to be on its own origin first (REVIEW-D3
 *   V2-2); this package provides none. CLI profiles may keep a key in a 0600
 *   file and rebuild with `restore`.
 * - The client flag and `policyRootSigner` gate only this API: whoever holds
 *   the key can sign through other APIs. What bounds that is the scope of the
 *   root (no decrypt before `enforce`) and the Node.
 */
export class ShareRoot {
  readonly kind: ShareRootKind;
  readonly scope: ShareRootScope;
  readonly nodeOrigin: string;
  readonly cid: string;
  readonly ownerDid: string;
  readonly spaceId: string;
  readonly keyDid: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly #authorization: Uint8Array;
  #key: DelegatedShareKey | undefined;
  readonly #options: ShareRootOptions;

  private constructor(input: { kind: ShareRootKind; scope: ShareRootScope; nodeOrigin: string; cid: string; ownerDid: string; spaceId: string; issuedAt: Date; expiresAt: Date; authorization: Uint8Array; key: DelegatedShareKey; options: ShareRootOptions }) {
    this.kind = input.kind;
    this.scope = input.scope;
    this.nodeOrigin = input.nodeOrigin;
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
   * Ask the owner for a new root (one approval) for a fresh share key. The
   * scope is chosen now: `kv+share-decrypt` only for a `share` root with the
   * flag on and `nodeOrigin` advertising `enforce`, otherwise `kv`. All request
   * checks run before anything is signed. If the signed result is rejected,
   * the key is cleared and the error carries the imported `rootCid` (and
   * `mustRevoke` when the root may be wider than requested).
   *
   * `keyFactory` defaults to a fresh non-extractable WebCrypto key that only
   * this root holds. A custom factory must not persist the key before
   * `create` resolves.
   */
  static async create(input: {
    readonly owner: ShareRootOwnerAuthority;
    readonly spaceId: string;
    readonly nodeOrigin: string;
    readonly expiresAt: Date;
    readonly keyFactory?: () => Promise<DelegatedShareKey>;
    readonly options?: ShareRootOptions;
  }): Promise<ShareRoot> {
    const options = input.options ?? {};
    const kind = options.kind ?? "share";
    const now = (options.now ?? Date.now)();
    const owner = parseOwnerDid(input.owner.ownerDid);
    assertSpace(input.spaceId, owner, kind);
    const nodeOrigin = requireNodeOrigin(input.nodeOrigin);
    const expiry = input.expiresAt instanceof Date ? input.expiresAt.getTime() : Number.NaN;
    if (!Number.isFinite(expiry) || expiry <= now) throw new ShareRootError("invalid-request", "share root expiry must be in the future");
    if (expiry - now > PROFILES[kind].maxLifetimeMs) throw new ShareRootError("lifetime-exceeds-cap", `${kind} root lifetime exceeds ${PROFILES[kind].maxLifetimeMs / DAY_MS} days`);
    const scope: ShareRootScope = kind === "share" && options.shareRootPolicyRoots === true
      && await (options.policyOwnerModeProbe ?? defaultPolicyOwnerModeProbe).isEnforced(nodeOrigin)
      ? "kv+share-decrypt"
      : "kv";
    const key = await (input.keyFactory ?? (() => createDelegatedShareKey({ extractable: false })))();
    try {
      await assertUsableKey(key);
    } catch (error) {
      key.clear();
      throw error;
    }

    const permissions: OwnerDelegationPermission[] = [{ service: "tinycloud.kv", path: SHARE_ROOT_PREFIX, actions: [...KV_ABILITIES] }];
    if (scope === "kv+share-decrypt") permissions.push({ service: "tinycloud.encryption", path: shareNetworkId(owner), actions: [DECRYPT_ABILITY] });
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
      if (signedCid !== receipt.delegationCid) throw new ShareRootError("malformed-root", "signed root bytes do not match the imported delegation CID", { rootCid: receipt.delegationCid, signedCid, mustRevoke: true });
      let decoded: DecodedOwnerRootCacao;
      try { decoded = decodeOwnerRootCacao(authorization); } catch (error) { throw new ShareRootError("malformed-root", errorMessage(error), { rootCid: receipt.delegationCid, mustRevoke: true }); }
      const times = validateSignedRoot(decoded, { kind, scope, owner, spaceId: input.spaceId, keyDid: key.did, requestedExpiresAt: input.expiresAt, now: (options.now ?? Date.now)() });
      return new ShareRoot({ kind, scope, nodeOrigin, cid: decoded.cid, ownerDid: input.owner.ownerDid, spaceId: input.spaceId, ...times, authorization, key, options });
    } catch (error) {
      key.clear();
      if (error instanceof ShareRootError) throw error;
      throw new ShareRootError("malformed-root", errorMessage(error), { rootCid: receipt.delegationCid, mustRevoke: true });
    }
  }

  /** Rebuild a stored root with its key (e.g. a CLI 0600 key file); the signed bytes are checked again. */
  static async restore(input: { readonly record: ShareRootRecord; readonly key: DelegatedShareKey; readonly options?: ShareRootOptions }): Promise<ShareRoot> {
    const { record } = input;
    const options = { ...input.options, kind: record.kind };
    if (record.version !== 1 || (record.kind !== "share" && record.kind !== "agent") || (record.scope !== "kv" && record.scope !== "kv+share-decrypt") || (record.kind === "agent" && record.scope !== "kv")) {
      throw new ShareRootError("malformed-root", "share root record is not supported");
    }
    if (record.keyDid !== input.key.did) throw new ShareRootError("audience-mismatch", "share root record belongs to another key");
    const owner = parseOwnerDid(record.ownerDid);
    assertSpace(record.spaceId, owner, record.kind);
    const nodeOrigin = requireNodeOrigin(record.nodeOrigin);
    await assertUsableKey(input.key);
    let authorization: Uint8Array;
    let decoded: DecodedOwnerRootCacao;
    try {
      authorization = fromBase64Url(record.authorization);
      decoded = decodeOwnerRootCacao(authorization, record.cid);
    } catch (error) { throw new ShareRootError("malformed-root", errorMessage(error), { rootCid: record.cid }); }
    const times = validateSignedRoot(decoded, { kind: record.kind, scope: record.scope, owner, spaceId: record.spaceId, keyDid: input.key.did, now: (options.now ?? Date.now)() });
    return new ShareRoot({ kind: record.kind, scope: record.scope, nodeOrigin, cid: decoded.cid, ownerDid: record.ownerDid, spaceId: record.spaceId, ...times, authorization, key: input.key, options });
  }

  /** The `Authorization` value the Node knows this root by (base64url CACAO). */
  get authorization(): string {
    return toBase64Url(this.#authorization);
  }

  /** True when the root holds `:share` decrypt and may act as a policy owner (still gated per call). */
  get policyCapable(): boolean {
    return this.scope === "kv+share-decrypt";
  }

  toRecord(): ShareRootRecord {
    return { version: 1, kind: this.kind, scope: this.scope, nodeOrigin: this.nodeOrigin, cid: this.cid, authorization: this.authorization, spaceId: this.spaceId, ownerDid: this.ownerDid, keyDid: this.keyDid, expiresAt: this.expiresAt.toISOString() };
  }

  /** True while the root is live, its key is held, and it lasts at least until `expiresAt`. Revocation is not visible here. */
  covers(expiresAt: Date, now: number = this.#now()): boolean {
    return this.#key !== undefined && now < this.expiresAt.getTime() && expiresAt.getTime() <= this.expiresAt.getTime();
  }

  /**
   * Sign a 60-second `POST /revoke` invocation, by the share key, for one
   * delegation this root issued (a bearer link). Zero approvals. The Node
   * authorizes it because the share key is that delegation's delegator. The
   * root itself is never revoked this way: only the owner does that.
   */
  async signLinkRevocation(input: { readonly delegationCid: string; readonly nodeDid: string }): Promise<string> {
    const key = this.#activeKey();
    if (typeof input.delegationCid !== "string" || !/^b[a-z2-7]+$/.test(input.delegationCid)) throw new ShareRootError("invalid-request", "delegation CID is invalid");
    if (input.delegationCid === this.cid) throw new ShareRootError("invalid-request", "the share key does not revoke its own root; the owner does");
    try { ed25519PublicKeyFromDidKey(input.nodeDid); } catch { throw new ShareRootError("invalid-request", "node DID must be an Ed25519 did:key"); }
    const now = seconds(this.#now());
    const revocation = await signCompactUcanAuthorization({
      issuerDid: key.did,
      audienceDid: input.nodeDid,
      attenuation: { [`urn:cid:${input.delegationCid}`]: { "tinycloud.delegation/revoke": [{}] } },
      facts: [{}],
      proofs: [],
      notBefore: now,
      expiresAt: now + 60,
      nonce: `urn:uuid:${crypto.randomUUID()}`,
      sign: (bytes) => key.sign(bytes),
    });
    return revocation.authorization;
  }

  /**
   * Sign a bearer link: `kv/get` on one exact key under the prefix, to the
   * link's own key, with this root as its only proof. It never outlives the
   * root (the Node refuses that too) or 30 days. Zero approvals.
   */
  async signBearerLink(input: { readonly linkDid: string; readonly path: string; readonly expiresAt: Date }): Promise<ShareRootLink> {
    const key = this.#activeKey();
    const now = this.#now();
    if (now >= this.expiresAt.getTime()) throw new ShareRootError("expired", "share root has expired", { rootCid: this.cid });
    assertLinkPath(input.path);
    try { ed25519PublicKeyFromDidKey(input.linkDid); } catch { throw new ShareRootError("invalid-request", "link key must be an Ed25519 did:key"); }
    if (input.linkDid === this.keyDid) throw new ShareRootError("invalid-request", "link key must not be the share key");
    const expiry = input.expiresAt instanceof Date ? input.expiresAt.getTime() : Number.NaN;
    if (!Number.isFinite(expiry) || expiry <= now) throw new ShareRootError("invalid-request", "link expiry must be in the future");
    if (expiry > this.expiresAt.getTime()) throw new ShareRootError("lifetime-exceeds-cap", "link must not outlive its share root", { rootCid: this.cid });
    if (expiry - now > SHARE_ROOT_LINK_MAX_LIFETIME_MS) throw new ShareRootError("lifetime-exceeds-cap", "link lifetime exceeds 30 days", { rootCid: this.cid });
    const delegation = await signShareKeyDelegation({
      key,
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
   * The only ShareRoot API that signs Policy/v3 (email/domain) owner material.
   * Needs a `kv+share-decrypt` root, the `shareRootPolicyRoots` flag, a live
   * root and key, and the root's Node advertising `enforce`; the returned
   * signer re-checks all of it on every call. Until then addressed shares use
   * per-share owner grants. Agent roots are bearer-only.
   */
  async policyRootSigner(): Promise<ShareRootPolicySigner> {
    await this.#assertPolicyGate();
    const owner = parseOwnerDid(this.ownerDid);
    return ownerPolicySigner({
      ownerDid: this.keyDid,
      authorityCid: this.cid,
      notAfter: new Date(this.expiresAt),
      gate: () => this.#assertPolicyGate(),
      now: () => this.#now(),
      inScope: (capability) => capability.kind === "encryption"
        ? isShareNetworkOf(capability.resource, owner) && capability.action === DECRYPT_ABILITY
        : capability.resource.startsWith(`${this.spaceId}/kv/${SHARE_ROOT_PREFIX}`) && capability.actions.every((action) => (KV_ABILITIES as readonly string[]).includes(action)),
    });
  }

  /** Drop this root's key handle. It does not revoke the root: only the owner does that. */
  clear(): void {
    this.#key?.clear();
    this.#key = undefined;
  }

  #activeKey(): DelegatedShareKey {
    if (this.#key === undefined) throw new ShareRootError("key-cleared", "share root key has been cleared", { rootCid: this.cid });
    return this.#key;
  }

  async #assertPolicyGate(): Promise<DelegatedShareKey> {
    const key = this.#activeKey();
    if (this.#options.shareRootPolicyRoots !== true) throw new ShareRootError("policy-roots-disabled", "share root policy roots are disabled (shareRootPolicyRoots is off)", { rootCid: this.cid });
    if (this.kind !== "share") throw new ShareRootError("policy-roots-disabled", "agent roots are bearer-only", { rootCid: this.cid });
    if (!this.policyCapable) throw new ShareRootError("root-not-policy-capable", "this share root holds no :share decrypt; re-root once the Node enforces", { rootCid: this.cid });
    if (this.#now() >= this.expiresAt.getTime()) throw new ShareRootError("expired", "share root has expired", { rootCid: this.cid });
    if (!await (this.#options.policyOwnerModeProbe ?? defaultPolicyOwnerModeProbe).isEnforced(this.nodeOrigin)) {
      throw new ShareRootError("policy-roots-not-enforced-by-node", "the Node does not advertise owner-authority mode enforce", { rootCid: this.cid });
    }
    return key;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }
}

/**
 * Re-root only when needed. `purpose: "bearer"` (default) keeps any live root
 * of the same kind, space and Node that covers `expiresAt`. `purpose:
 * "policy"` additionally needs a `kv+share-decrypt` root: it throws unless the
 * flag is on and the Node enforces, and re-roots when the current root is
 * `kv`; it never hands back a `kv` root. A re-root costs one approval, uses a
 * new key and requests the kind's cap minus {@link SHARE_ROOT_REQUEST_MARGIN_MS}.
 *
 * - Links and policies signed under the old root stay valid until their own
 *   expiry; keep the old root (and its key) to revoke them (REVIEW-D3 V2-5).
 * - Concurrent calls each re-root (two approvals, and one orphaned root if
 *   both write the same store slot): callers serialize, e.g. with a lock.
 * - A revoked root still "covers" here: re-root when `/delegate` answers
 *   `delegation-revoked`.
 */
export async function ensureShareRoot(input: {
  readonly current?: ShareRoot;
  readonly expiresAt: Date;
  readonly purpose?: "bearer" | "policy";
  readonly owner: ShareRootOwnerAuthority;
  readonly spaceId: string;
  readonly nodeOrigin: string;
  readonly keyFactory?: () => Promise<DelegatedShareKey>;
  readonly options?: ShareRootOptions;
}): Promise<{ readonly root: ShareRoot; readonly rerooted: boolean }> {
  const options = input.options ?? {};
  const kind = options.kind ?? "share";
  const purpose = input.purpose ?? "bearer";
  const now = (options.now ?? Date.now)();
  const nodeOrigin = requireNodeOrigin(input.nodeOrigin);
  const lifetime = PROFILES[kind].maxLifetimeMs - SHARE_ROOT_REQUEST_MARGIN_MS;
  if (input.expiresAt.getTime() - now > Math.min(lifetime, SHARE_ROOT_LINK_MAX_LIFETIME_MS)) throw new ShareRootError("lifetime-exceeds-cap", "no share root can cover this expiry");
  if (purpose === "policy") {
    if (options.shareRootPolicyRoots !== true || kind !== "share") throw new ShareRootError("policy-roots-disabled", "share root policy roots are disabled");
    if (!await (options.policyOwnerModeProbe ?? defaultPolicyOwnerModeProbe).isEnforced(nodeOrigin)) throw new ShareRootError("policy-roots-not-enforced-by-node", "the Node does not advertise owner-authority mode enforce");
  }
  const { current } = input;
  if (
    current !== undefined && current.kind === kind && current.spaceId === input.spaceId && current.nodeOrigin === nodeOrigin
    && current.covers(input.expiresAt, now) && (purpose === "bearer" || current.policyCapable)
  ) return { root: current, rerooted: false };
  const factory = input.keyFactory ?? (() => createDelegatedShareKey({ extractable: false }));
  const root = await ShareRoot.create({
    owner: input.owner,
    spaceId: input.spaceId,
    nodeOrigin,
    expiresAt: new Date(now + lifetime),
    keyFactory: async () => {
      const key = await factory();
      if (current !== undefined && key.did === current.keyDid) throw new ShareRootError("reroot-same-key", "a re-root needs a new share key");
      return key;
    },
    options,
  });
  if (purpose === "policy" && !root.policyCapable) {
    throw new ShareRootError("policy-roots-not-enforced-by-node", "the Node stopped advertising enforce while re-rooting; the new root is kv-only", { rootCid: root.cid });
  }
  return { root, rerooted: true };
}
