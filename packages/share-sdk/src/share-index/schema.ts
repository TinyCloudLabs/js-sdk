import type { SenderShareRecord } from "../history.js";
import { canonicalAddressSpelling } from "./agent-record.js";
import { checkStoredFullShareLink, STORED_DELIVERY_MATERIAL_KEYS, type StoredShareRecord } from "./delivery.js";
import { parseArtifactVersionPath } from "../artifact-core.js";

/**
 * Index document schema v1, rows, `project()`, and the versioned agent-record
 * schema (design C §2, §5 check 5). The index holds display fields only:
 * never `link`, `deliveryMaterial`, share keys, unmasked emails or `#k=`.
 * Unknown fields on the header, on agent entries and on rows are kept.
 */

export const INDEX_SCHEMA_VERSION = 1;

export type ShareProofState = "proven" | "chained" | "unproven";

export interface ShareIndexRow {
  /** Display name: ≤120 characters, bidi and control characters stripped. */
  readonly n: string;
  readonly k: "file" | "folder";
  /** Content kind: the lowercase file extension, when there is a short one. */
  readonly ck?: string;
  readonly ak: "bearer" | "recipientDid" | "exactEmail" | "emailDomain";
  /** Masked audience label. */
  readonly al: string;
  readonly a: readonly string[];
  /** Created (`registeredAt`) and expires, ISO 8601. */
  readonly c: string;
  readonly x: string;
  /** Revocation; only `confirmed` (node-confirmed) is sticky. */
  readonly r?: { readonly at: string; readonly confirmed: boolean };
  /**
   * Revoke kind. For agent rows the revoke action is decided at click time
   * from the freshly verified record (§6). Observed on a local node (C5,
   * TC-1432 slice 2):
   * - per share: the owner wallet can revoke an agent's v3 root (`policyRoot`,
   *   `enforcementRoot` CIDs from the signed envelope) through the generic
   *   `/revoke` route: 200, and an open recipient session's next read gets 403
   *   `root-revoked`. Only the JSON root-revocation route answers 403
   *   `root-revocation-issuer-invalid` to the owner.
   * - session-wide: revoking the agent's owner→session delegation kills its
   *   bearer links and fails new v3 claims at once, but an already-open v3
   *   recipient session keeps reading for its lifetime (3,598 s observed).
   *   The node liveness check (N3, test B-1) closes that.
   */
  readonly rk: "policy-v3" | "delegation" | "none";
  /** The share's revoke CID; unique across rows. */
  readonly cid?: string;
  /** Every CID this row claims (one row per CID, §5 check 7). */
  readonly cc?: readonly string[];
  /** Provenance, derived from the key path: `web` or `agent:<agentId>`. */
  readonly src: string;
  /** Agent and migrated rows: the proof state of the verified chain. */
  readonly ps?: ShareProofState;
  /** `migrated`: a one-time owner import (shown as "imported"); ranks by `ps`, never as a web row. */
  readonly pv?: "migrated";
  /** The verified chain has expired (shown as Expired, not rejected). */
  readonly pe?: true;
  /** Needs attention: unreadable record, or `shareId` ≠ key basename. */
  readonly na?: true;
  readonly [unknown: string]: unknown;
}

export interface ShareIndexAgentEntry {
  /** The agent DID, once a record with a valid header was seen. */
  readonly did: string | null;
  readonly rows: number;
  readonly rejected: Readonly<Record<string, number>>;
  /** Raw key suffixes (≤64 chars) refused on first sight: never refetched. At most 100. */
  readonly rejectedKeys: readonly string[];
  /** Keys whose `recordV` is newer than this build: skipped until an upgrade. At most 100. */
  readonly newerKeys?: readonly string[];
  readonly newerV?: number;
  readonly paused: false | { readonly reason: "rejections" | "row-cap" | "newer"; readonly at: string };
  readonly firstSeen: string;
  readonly [unknown: string]: unknown;
}

export interface ShareIndexDocument {
  readonly v: number;
  readonly ownerDid: string;
  readonly spaceId: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly archives: readonly { readonly name: string; readonly ids: readonly string[] }[];
  readonly tombstones: readonly { readonly key: string; readonly at: string }[];
  readonly reconcile: { readonly cursor?: string };
  readonly agents: Readonly<Record<string, ShareIndexAgentEntry>>;
  readonly rows: Readonly<Record<string, ShareIndexRow>>;
  readonly [unknown: string]: unknown;
}

export interface ShareIndexArchiveDocument {
  readonly v: number;
  readonly rows: Readonly<Record<string, ShareIndexRow>>;
  readonly [unknown: string]: unknown;
}

export function emptyIndexDocument(input: { readonly ownerDid: string; readonly spaceId: string; readonly writer: string; readonly now: Date }): ShareIndexDocument {
  return {
    v: INDEX_SCHEMA_VERSION,
    ownerDid: input.ownerDid,
    spaceId: input.spaceId,
    updatedAt: input.now.toISOString(),
    updatedBy: input.writer,
    archives: [],
    tombstones: [],
    reconcile: {},
    agents: {},
    rows: {},
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * An RFC 3339 UTC time as the SDK and node write it: whole seconds or a fraction (`publishAddressedShare` omits it).
 * It must round-trip: `Date.parse` rolls `2026-02-30`, a non-leap Feb 29 or `24:00:00` over to another instant.
 */
function isIsoTime(value: unknown): value is string {
  const match = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value) : null;
  const parsed = match === null ? NaN : Date.parse(value as string);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === `${match![1]}.${(match![2] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
}

function isRow(value: unknown): value is ShareIndexRow {
  if (!isObject(value)) return false;
  return typeof value.n === "string" && (value.k === "file" || value.k === "folder")
    && typeof value.ak === "string" && typeof value.al === "string"
    && Array.isArray(value.a) && value.a.every((item) => typeof item === "string")
    && typeof value.c === "string" && typeof value.x === "string"
    && (value.r === undefined || (isObject(value.r) && typeof value.r.at === "string" && typeof value.r.confirmed === "boolean"))
    && typeof value.rk === "string" && (value.cid === undefined || typeof value.cid === "string")
    && (value.cc === undefined || (Array.isArray(value.cc) && value.cc.every((item) => typeof item === "string")))
    && typeof value.src === "string";
}

function isAgentEntry(value: unknown): value is ShareIndexAgentEntry {
  return isObject(value) && (value.did === null || typeof value.did === "string") && Number.isSafeInteger(value.rows)
    && isObject(value.rejected) && Object.values(value.rejected).every((count) => Number.isSafeInteger(count))
    && Array.isArray(value.rejectedKeys) && value.rejectedKeys.every((item) => typeof item === "string")
    && (value.newerKeys === undefined || (Array.isArray(value.newerKeys) && value.newerKeys.every((item) => typeof item === "string")))
    && (value.paused === false || (isObject(value.paused) && typeof value.paused.reason === "string" && typeof value.paused.at === "string"))
    && typeof value.firstSeen === "string";
}

export type ParsedIndexDocument =
  | { readonly status: "ok"; readonly doc: ShareIndexDocument }
  /** A higher `v`: render read-only, never write. */
  | { readonly status: "newer"; readonly v: number }
  /** Decrypted, but not a valid document: deterministic corruption. */
  | { readonly status: "invalid" };

export function parseIndexDocument(value: unknown): ParsedIndexDocument {
  if (!isObject(value) || !Number.isSafeInteger(value.v)) return { status: "invalid" };
  if ((value.v as number) > INDEX_SCHEMA_VERSION) return { status: "newer", v: value.v as number };
  if (value.v !== INDEX_SCHEMA_VERSION || typeof value.ownerDid !== "string" || typeof value.spaceId !== "string" || typeof value.updatedAt !== "string" || typeof value.updatedBy !== "string") return { status: "invalid" };
  if (!Array.isArray(value.archives) || !value.archives.every((item) => isObject(item) && typeof item.name === "string" && Array.isArray(item.ids) && item.ids.every((id) => typeof id === "string"))) return { status: "invalid" };
  if (!Array.isArray(value.tombstones) || !value.tombstones.every((item) => isObject(item) && typeof item.key === "string" && typeof item.at === "string")) return { status: "invalid" };
  if (!isObject(value.reconcile) || (value.reconcile.cursor !== undefined && typeof value.reconcile.cursor !== "string")) return { status: "invalid" };
  if (!isObject(value.agents) || !Object.values(value.agents).every(isAgentEntry)) return { status: "invalid" };
  if (!isObject(value.rows) || !Object.values(value.rows).every(isRow)) return { status: "invalid" };
  return { status: "ok", doc: value as unknown as ShareIndexDocument };
}

export function parseArchiveDocument(value: unknown): ShareIndexArchiveDocument | undefined {
  if (!isObject(value) || value.v !== INDEX_SCHEMA_VERSION || !isObject(value.rows) || !Object.values(value.rows).every(isRow)) return undefined;
  return value as unknown as ShareIndexArchiveDocument;
}

// ---------------------------------------------------------------------------
// project(): the display-only row of a record.

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
export const MAX_ROW_NAME = 120;

/** Strip bidi/control/format characters and cap at 120 code points. */
export function displayName(value: unknown, fallback: string): string {
  const cleaned = typeof value === "string" ? [...value.replace(UNSAFE_TEXT, "").trim()].slice(0, MAX_ROW_NAME).join("") : "";
  return cleaned.length > 0 ? cleaned : fallback;
}

function maskedAudience(matcher: SenderShareRecord["recipientMatcher"]): Pick<ShareIndexRow, "ak" | "al"> {
  if (matcher.kind === "exactEmail") {
    const at = matcher.value.lastIndexOf("@");
    const domain = at < 0 ? "" : matcher.value.slice(at + 1);
    return { ak: "exactEmail", al: `${displayName(matcher.value.slice(0, 1), "?")}…@${displayName(domain, "?")}` };
  }
  if (matcher.kind === "emailDomain") return { ak: "emailDomain", al: `@${displayName(matcher.value, "?")}` };
  if (matcher.kind === "recipientDid") {
    const did = displayName(matcher.value, "did");
    return { ak: "recipientDid", al: did.length > 24 ? `${did.slice(0, 16)}…${did.slice(-4)}` : did };
  }
  return { ak: "bearer", al: "Anyone with the link" };
}

/** The CIDs a record names: one row per CID across all of them. */
export function recordCids(record: Pick<SenderShareRecord, "registrationCid" | "policyCid" | "ownerDelegationCid" | "enforcementDelegationCid">): string[] {
  return [record.registrationCid, record.policyCid, record.ownerDelegationCid, record.enforcementDelegationCid]
    .filter((value, index, all): value is string => typeof value === "string" && value.length > 0 && all.indexOf(value) === index);
}

export function revokeKind(record: StoredShareRecord): ShareIndexRow["rk"] {
  if (record.targetKind !== undefined && record.targetKind !== "bearer" && record.policyCid !== undefined && record.enforcementDelegationCid !== undefined) return "policy-v3";
  return record.enforcementDelegationCid === undefined ? "none" : "delegation";
}

/**
 * The display-only projection of a record. `claims` overrides the CIDs the
 * row may claim (agent rows claim only what their chain verified).
 */
export function project(record: StoredShareRecord, input: { readonly key: string; readonly src: string; readonly claims?: readonly string[]; readonly proof?: { readonly state: ShareProofState; readonly expired: boolean } }): ShareIndexRow {
  const basename = input.key.slice(input.key.lastIndexOf("/") + 1);
  const extension = /\.([a-z0-9]{1,10})$/i.exec(typeof record.filename === "string" ? record.filename : "")?.[1]?.toLowerCase();
  const claims = input.claims ?? recordCids(record);
  return {
    n: displayName(record.filename, "Untitled share"),
    k: record.resource.kind === "prefix" ? "folder" : "file",
    ...(extension === undefined ? {} : { ck: extension }),
    ...maskedAudience(record.recipientMatcher),
    a: [...record.actions],
    c: record.registeredAt,
    x: record.expiresAt,
    ...(record.revokedAt === undefined ? {} : { r: { at: record.revokedAt, confirmed: false } }),
    rk: revokeKind(record),
    ...(record.enforcementDelegationCid !== undefined && claims.includes(record.enforcementDelegationCid) ? { cid: record.enforcementDelegationCid } : {}),
    ...(claims.length === 0 ? {} : { cc: [...claims] }),
    src: input.src,
    ...(input.proof === undefined ? {} : { ps: input.proof.state, ...(input.proof.expired ? { pe: true as const } : {}) }),
    ...(record.provenance === "migrated" ? { pv: "migrated" as const } : {}),
    ...(record.shareId === basename ? {} : { na: true as const }),
  };
}

// ---------------------------------------------------------------------------
// Agent record schema, versioned by `recordV` (§5 check 5).

export const SHARE_ACTIONS: readonly string[] = ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/metadata", "tinycloud.kv/put"];
/** Share resource prefixes: native bearer sources and Policy/v3 addressed sources. */
export const SHARE_RESOURCE_PREFIXES: readonly string[] = ["xyz.tinycloud.share/shares/", "shares/"];

const REQUIRED_V1 = ["shareId", "target", "resource", "actions", "recipientMatcher", "registeredAt", "expiresAt"];
const OPTIONAL_V1 = ["registrationCid", "policyCid", "ownerDelegationCid", "enforcementDelegationCid", "shareKeyDid", "ownerDid", "enforcerDid", "targetKind", "revokedAt", "envelopeCid", "shareCid", "link", "filename", "deliveryMaterial", "deliveredRecipients", "proofs", "provenance"];
const PROOF_STRING_FIELDS = ["session", "link", "ownerPolicy", "ownerDelegation"];
const PROOF_OBJECT_FIELDS = ["enforcementDelegation", "registration"];
/** Allowed fields per `recordV`: an unknown field at a known `recordV` is rejected. */
const FIELDS_BY_RECORD_V: Readonly<Record<number, { readonly required: readonly string[]; readonly optional: readonly string[] }>> = {
  1: { required: REQUIRED_V1, optional: OPTIONAL_V1 },
};

/** Canonical share paths and exact artifact version files use the existing path checks. Details: TC-1739 */
export function isShareResourcePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024 || /[\\%\u0000-\u001f]/.test(path)) return false;
  if (!SHARE_RESOURCE_PREFIXES.some((prefix) => path.startsWith(prefix) && path.length > prefix.length) && parseArtifactVersionPath(path) === undefined) return false;
  return path.split("/").every((segment, index, all) => (segment !== "" || index === all.length - 1) && segment !== "." && segment !== "..");
}

export interface AgentRecordSchemaContext {
  readonly recordV: number;
  readonly shareId: string;
  readonly accountOwnerDid: string;
  /** `hdr.agentDid` for agent records; "" for migrated records, which have no agent binding. */
  readonly agentDid: string;
  /**
   * `agent`: a record in `records/agents/<id>/`, which may never claim a
   * provenance. `migrated`: an owner-layout record that must claim
   * `provenance: "migrated"` (one-time owner import).
   */
  readonly source: "agent" | "migrated";
}

/**
 * Whether `spaceId` (`tinycloud:pkh:eip155:<chain>:<address>:<name>`) is a
 * space of the account `ownerDid` (`did:pkh:eip155:<chain>:<address>`),
 * whatever its name: the CLI keeps share content in `default` while the
 * records live in `applications`. Address spelling is ignored.
 */
export function isSpaceOwnedBy(spaceId: string, ownerDid: string): boolean {
  const space = /^tinycloud:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40}):[A-Za-z0-9_.-]+$/.exec(spaceId);
  const owner = /^did:pkh:eip155:([1-9]\d*):(0x[0-9a-fA-F]{40})$/.exec(ownerDid);
  return space !== null && owner !== null && space[1] === owner[1] && space[2]!.toLowerCase() === owner[2]!.toLowerCase();
}

/** `registeredAt` may sit at most this far from the chain's signed issuance time (M2). */
export const REGISTERED_AT_SKEW_MS = 24 * 60 * 60 * 1000;
/** Clock skew tolerated for a `registeredAt` slightly in the future. */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * `registeredAt` against signed times from the verified chain, never against
 * when the owner happens to look: inside `[earliest, latest]` (already
 * widened by {@link REGISTERED_AT_SKEW_MS} where the bound is an issuance
 * time) and not in the future.
 */
export function registeredAtFits(registeredAt: string, window: { readonly earliest?: number; readonly latest?: number }, now: Date): boolean {
  const at = Date.parse(registeredAt);
  return Number.isFinite(at) && at <= now.getTime() + FUTURE_SKEW_MS && (window.earliest === undefined || at >= window.earliest) && (window.latest === undefined || at <= window.latest);
}

/** A record refused by the schema. `provenance`: an agent-subtree record claiming `migrated`. */
export class ShareRecordSchemaError extends Error {
  constructor(readonly reason: "schema" | "provenance") {
    super(`share record schema: ${reason}`);
    this.name = "ShareRecordSchemaError";
  }
}

/** Whether a link embeds the sealed record: the full form (`/s/full#v=4&k=…&r=…`) or an inline payload (`p=`). */
function carriesSealedRecord(link: string): boolean {
  try {
    const url = new URL(link);
    const fragment = new URLSearchParams(url.hash.slice(1));
    return url.pathname === "/s/full" || fragment.has("r") || fragment.has("p");
  } catch {
    return false;
  }
}

/** Throws {@link ShareRecordSchemaError} when the decrypted value fails the schema. */
export function checkAgentRecordSchema(value: unknown, context: AgentRecordSchemaContext): StoredShareRecord {
  const fail = (): never => { throw new ShareRecordSchemaError("schema"); };
  const fields = FIELDS_BY_RECORD_V[context.recordV];
  if (fields === undefined || !isObject(value)) return fail();
  const keys = Object.keys(value);
  if (!fields.required.every((key) => keys.includes(key)) || !keys.every((key) => fields.required.includes(key) || fields.optional.includes(key))) return fail();
  const record = value as Record<string, unknown>;
  if (context.source === "agent" && record.provenance === "migrated") throw new ShareRecordSchemaError("provenance");
  if (context.source === "agent" ? record.provenance !== undefined : record.provenance !== "migrated") return fail();
  if (record.shareId !== context.shareId) return fail();
  const target = record.target;
  // `historyRecordForPublishedShare` keeps the publication's `target.kind`.
  const targetKeys = Object.keys(target ?? {});
  if (!isObject(target) || !targetKeys.every((key) => ["origin", "nodeAudience", "spaceId", "kind"].includes(key)) || typeof target.origin !== "string" || typeof target.nodeAudience !== "string" || typeof target.spaceId !== "string"
    || (target.kind !== undefined && (typeof target.kind !== "string" || !["bearer", "recipientDid", "email", "emailDomain"].includes(target.kind)))) return fail();
  // Content may sit in any space of the account owner (the CLI uses `default`, records live in `applications`).
  if (!isSpaceOwnedBy(target.spaceId as string, context.accountOwnerDid)) return fail();
  const resource = record.resource;
  if (!isObject(resource) || Object.keys(resource).length !== 2 || (resource.kind !== "exact" && resource.kind !== "prefix") || !isShareResourcePath(resource.path)) return fail();
  if (!Array.isArray(record.actions) || record.actions.length === 0 || new Set(record.actions).size !== record.actions.length || !record.actions.every((action) => typeof action === "string" && SHARE_ACTIONS.includes(action))) return fail();
  const artifact = parseArtifactVersionPath(resource.path) !== undefined;
  if (artifact && (resource.kind !== "exact" || record.actions.some(action => action !== "tinycloud.kv/get" && action !== "tinycloud.kv/metadata"))) return fail();
  const matcher = record.recipientMatcher;
  if (!isObject(matcher) || !(matcher.kind === "bearer" ? Object.keys(matcher).length === 1 : ["exactEmail", "emailDomain", "recipientDid"].includes(matcher.kind as string) && Object.keys(matcher).length === 2 && typeof matcher.value === "string")) return fail();
  if (!isIsoTime(record.registeredAt) || !isIsoTime(record.expiresAt) || Date.parse(record.registeredAt) >= Date.parse(record.expiresAt)) return fail();
  for (const key of ["registrationCid", "policyCid", "ownerDelegationCid", "enforcementDelegationCid", "envelopeCid", "shareCid"]) {
    if (record[key] !== undefined && (typeof record[key] !== "string" || !/^[a-z0-9]{8,128}$/.test(record[key] as string))) return fail();
  }
  for (const key of ["shareKeyDid", "enforcerDid", "ownerDid"]) {
    if (record[key] !== undefined && (typeof record[key] !== "string" || !(record[key] as string).startsWith("did:"))) return fail();
  }
  // CLI Policy/v3 records name the policy owner, which is the agent session key. A
  // migrated record's earlier session key is bound by its chain (the v3 verifier
  // requires ownerDid == the signed policy owner).
  if (record.ownerDid !== undefined && canonicalAddressSpelling(record.ownerDid as string) !== canonicalAddressSpelling(context.accountOwnerDid) && record.ownerDid !== context.agentDid
    && !(context.source === "migrated" && (record.ownerDid as string).startsWith("did:key:"))) return fail();
  if (record.targetKind !== undefined && !["bearer", "recipientDid", "email", "emailDomain"].includes(record.targetKind as string)) return fail();
  if (record.revokedAt !== undefined && !isIsoTime(record.revokedAt)) return fail();
  if (record.link !== undefined && typeof record.link !== "string") return fail();
  if (record.filename !== undefined && (typeof record.filename !== "string" || record.filename.length > 512)) return fail();
  // Each blob once (stored form, `delivery.ts`): a Policy/v3 record keeps the sealed envelope and its key, never
  // the envelope it decrypts to. Its `link` is the short link the sender printed, checked against the sealed
  // material when the record is accepted. A full link carries the sealed record and the key in its fragment, so a
  // record that stores one beside its delivery material is refused.
  if (record.deliveryMaterial !== undefined) {
    const material = record.deliveryMaterial;
    if (!isObject(material) || !STORED_DELIVERY_MATERIAL_KEYS.every((key) => typeof material[key] === "string")
      || Object.keys(material).some(key => !STORED_DELIVERY_MATERIAL_KEYS.includes(key) && key !== "fullLink")) return fail();
    if (Object.hasOwn(material, "fullLink")) {
      try { checkStoredFullShareLink(material.fullLink); } catch { return fail(); }
    }
    if (typeof record.link === "string" && carriesSealedRecord(record.link)) return fail();
  }
  if (record.deliveredRecipients !== undefined && (!Array.isArray(record.deliveredRecipients) || !record.deliveredRecipients.every((item) => typeof item === "string"))) return fail();
  if (record.proofs !== undefined) {
    const proofs = record.proofs;
    if (!isObject(proofs) || !Object.keys(proofs).every((key) => PROOF_STRING_FIELDS.includes(key) ? typeof proofs[key] === "string" : PROOF_OBJECT_FIELDS.includes(key) && isObject(proofs[key]))) return fail();
  }
  if (artifact) {
    const proofs = record.proofs;
    if (isObject(proofs) && proofs.ownerPolicy !== undefined) return fail();
    if (record.deliveryMaterial !== undefined) {
      if (record.targetKind === undefined || record.targetKind === "bearer" || (isObject(proofs) && proofs.link !== undefined)) return fail();
    } else if (record.targetKind !== undefined && record.targetKind !== "bearer") return fail();
  }
  return record as unknown as StoredShareRecord;
}
