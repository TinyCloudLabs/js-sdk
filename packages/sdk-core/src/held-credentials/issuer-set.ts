import { decodeBase64Url, isObject } from "./encoding";
import { isStrictEd25519Point } from "./crypto";
import { refuse } from "./errors";

export const ISSUER_SET_FORMAT = "tinycloud.credentials-issuers/v1";

/** A pinned issuer entry (spec §6). Times are epoch milliseconds. */
export interface IssuerEntry {
  issuerDid: string;
  kid: string;
  alg: "EdDSA";
  publicKey: Uint8Array;
  vcts: readonly string[];
  profiles: readonly string[];
  notBefore: number;
  /** Rotation: the key stops issuing at this instant. null = not retired. */
  retiredAt: number | null;
  /** Withdrawal: nothing verifies under the key once now >= this. null = no end. */
  notAfter: number | null;
}

const CONSTRUCT = Symbol("IssuerSet.construct");

/** Module-private read of the private entry map; assigned once by the class's static block. */
let readEntry: (set: IssuerSet, issuerDid: string, kid: string) => IssuerEntry | undefined;

/** A fresh, frozen entry: the public key is a new copy on every lookup. */
function copyEntry(entry: IssuerEntry): IssuerEntry {
  return Object.freeze({ ...entry, publicKey: entry.publicKey.slice() });
}

/**
 * An issuer set that has passed every rule of `parseIssuerSet`. Only `parseIssuerSet` creates one,
 * and the verifier accepts only genuine instances (`IssuerSet.is`). The instance, its prototype and
 * the class are frozen, and the verifier reads entries through the module-private `lookupIssuerEntry`.
 * Use one build (ESM or CJS) of this package per process. Details: TC-1540
 */
export class IssuerSet {
  readonly version: number;
  readonly #entries: ReadonlyMap<string, IssuerEntry>;

  static {
    readEntry = (set, issuerDid, kid) => {
      const entry = set.#entries.get(kid);
      return entry && entry.issuerDid === issuerDid ? copyEntry(entry) : undefined;
    };
  }

  /** @internal Use `parseIssuerSet`. */
  constructor(token: symbol, version: number, entries: ReadonlyMap<string, IssuerEntry>) {
    if (token !== CONSTRUCT) throw new TypeError("IssuerSet can only be created by parseIssuerSet");
    this.version = version;
    this.#entries = entries;
    Object.freeze(this);
  }

  /** True only for an instance built by `parseIssuerSet` (a real private-field brand check). */
  static is(value: unknown): value is IssuerSet {
    return typeof value === "object" && value !== null && #entries in value;
  }

  /**
   * The one lookup seam (TC-1132 would plug an allow-listed did:web resolver in here). Returns the
   * FULL entry, never just a key, so vct/profile admission and the validity window come from the
   * same entry. Exact (issuerDid, kid) match only. Every call returns a copy.
   */
  resolveIssuer(issuerDid: string, kid: string): IssuerEntry | undefined {
    return readEntry(this, issuerDid, kid);
  }
}
Object.freeze(IssuerSet.prototype);
Object.freeze(IssuerSet);

/** What `verifyHeldPresentation` calls. Not exported from the package index. */
export function lookupIssuerEntry(set: IssuerSet, issuerDid: string, kid: string): IssuerEntry | undefined {
  return readEntry(set, issuerDid, kid);
}

export interface IssuerSetOptions {
  /** DID methods allowed for issuers (docs/principles.md principle 2), e.g. ["web"]. */
  didMethods: { issuer: readonly string[] };
}

const ENTRY_KEYS = ["issuerDid", "kid", "alg", "publicKey", "vcts", "profiles", "notBefore", "retiredAt", "notAfter"].sort();
const RFC3339_Z = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;
const DID_WEB = /^did:web:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const DID_SELF_DESCRIBING = /^did:(?:key|jwk):[A-Za-z0-9_-]+$/;

export function didMethod(did: string): string | null {
  const match = /^did:([a-z0-9]+):/.exec(did);
  return match ? match[1]! : null;
}

/** Canonical issuer DID: lowercase, no port, path or query (did:web); `did:key`/`did:jwk` only when allowed. */
export function isCanonicalIssuerDid(did: string): boolean {
  return DID_WEB.test(did) || DID_SELF_DESCRIBING.test(did);
}

export function isWellFormedKid(kid: string, issuerDid: string): boolean {
  return kid.startsWith(`${issuerDid}#`) && /^[A-Za-z0-9._-]+$/.test(kid.slice(issuerDid.length + 1));
}

function parseTime(value: unknown, field: string): number {
  if (typeof value !== "string") return refuse("bad-issuer-set", `${field} must be an RFC 3339 UTC string`);
  const match = RFC3339_Z.exec(value);
  if (!match) return refuse("bad-issuer-set", `${field} must be RFC 3339 UTC ending in Z`);
  const ms = Date.parse(value);
  const [, y, mo, d, h, mi, s] = match.map(Number) as number[];
  const check = new Date(ms);
  if (Number.isNaN(ms) || check.getUTCFullYear() !== y || check.getUTCMonth() + 1 !== mo || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== s) {
    return refuse("bad-issuer-set", `${field} is not a real instant`);
  }
  return ms;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || v === "")) {
    return refuse("bad-issuer-set", `${field} must be a non-empty list of strings`);
  }
  return value as string[];
}

/** Validates a whole issuer set. Any violation makes the whole set invalid. */
export function parseIssuerSet(raw: unknown, options: IssuerSetOptions): IssuerSet {
  if (!isObject(raw) || Object.keys(raw).sort().join() !== ["format", "issuers", "version"].join()) {
    return refuse("bad-issuer-set", "unexpected shape");
  }
  if (raw.format !== ISSUER_SET_FORMAT) refuse("bad-issuer-set", "unknown format");
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) refuse("bad-issuer-set", "version must be a positive integer");
  if (!Array.isArray(raw.issuers) || raw.issuers.length === 0) refuse("bad-issuer-set", "issuers must be a non-empty list");
  const entries = new Map<string, IssuerEntry>();
  for (const item of raw.issuers) {
    if (!isObject(item) || Object.keys(item).sort().join() !== ENTRY_KEYS.join()) refuse("bad-issuer-set", "entry has missing or unknown fields");
    const issuerDid = item.issuerDid, kid = item.kid;
    if (typeof issuerDid !== "string" || !isCanonicalIssuerDid(issuerDid)) refuse("bad-issuer-set", "issuerDid is not canonical");
    const method = didMethod(issuerDid as string);
    if (method === null || !options.didMethods.issuer.includes(method)) refuse("did-method-not-allowed", `issuer DID method ${method} is not on the allow-list`);
    if (typeof kid !== "string" || !isWellFormedKid(kid, issuerDid as string)) refuse("bad-issuer-set", "kid must be issuerDid#fragment");
    if (entries.has(kid as string)) refuse("bad-issuer-set", "duplicate kid");
    if (item.alg !== "EdDSA") refuse("bad-issuer-set", "alg must be EdDSA");
    if (typeof item.publicKey !== "string") refuse("bad-issuer-set", "publicKey must be base64url");
    const publicKey = decodeBase64Url(item.publicKey, "bad-issuer-set");
    if (publicKey.length !== 32 || !isStrictEd25519Point(publicKey)) refuse("bad-issuer-set", "publicKey is not a strict 32-byte Ed25519 key");
    const notBefore = parseTime(item.notBefore, "notBefore");
    const retiredAt = item.retiredAt === null ? null : parseTime(item.retiredAt, "retiredAt");
    const notAfter = item.notAfter === null ? null : parseTime(item.notAfter, "notAfter");
    if (retiredAt !== null && notAfter !== null && retiredAt > notAfter) refuse("bad-issuer-set", "retiredAt must not be after notAfter");
    entries.set(kid as string, Object.freeze({
      issuerDid: issuerDid as string,
      kid: kid as string,
      alg: "EdDSA",
      publicKey,
      vcts: Object.freeze([...stringList(item.vcts, "vcts")]),
      profiles: Object.freeze([...stringList(item.profiles, "profiles")]),
      notBefore,
      retiredAt,
      notAfter,
    }));
  }
  return new IssuerSet(CONSTRUCT, raw.version as number, entries);
}
