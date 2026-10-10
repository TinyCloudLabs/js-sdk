import { join } from "node:path";
import { parseSignedCompactUcanAttenuation } from "@tinycloud/sdk-core";

// Keep the value import namespace-shaped so modules that import this one stay
// compatible with lightweight node-sdk test doubles.
import * as nodeSdk from "@tinycloud/node-sdk";
import type {
  PermissionEntry,
  PortableDelegation,
  RuntimeDelegationActivator,
  ValidatedRuntimeDelegation,
} from "@tinycloud/node-sdk";

import { DelegationRequestBindingSchema } from "./artifacts.js";
import { delegationWithinRequest, type OperationSpaceResolver } from "./authority.js";
import { DELEGATION_CID_PATTERN, STORED_GRANT_SKIP_REASONS, type OperationWarning, type StoredGrantSkipReason } from "./contract.js";
import {
  profilePath,
  readAdditionalDelegations,
  readJson,
  readSession,
  updateProfileStore,
  withProfileLock,
  writeJsonAtomic,
} from "./state.js";

export { operationSpaceResolver } from "./secrets.js";
export { STORED_GRANT_SKIP_REASONS } from "./contract.js";
export type { OperationWarning, StoredGrantSkipReason } from "./contract.js";

/**
 * Request bindings for delegations stored in `additional-delegations.json`.
 *
 * A compact-UCAN or signed-login (SIWE) record replays only when its
 * `authorityRequest` binding is valid and the capabilities its signed bytes
 * grant fit inside the binding's `requested`. Validated activation checks that
 * before anything is activated. Three writers produce bindings:
 *
 * - `tinycloud.auth.import`: the stored request the delegation was checked
 *   against (`requestId` is that request's).
 * - `tc auth import` of an artifact with no request: exactly the delegation's
 *   own signed capabilities (`unbound-import:<cid>`).
 * - The one-time migration of records stored before bindings existed: exactly
 *   each record's own signed capabilities (`migrated:<cid>`).
 * - The CLI's own grants (`tc auth request --grant`, permission escalation),
 *   once checked against the request they answer: exactly each grant's own
 *   signed capabilities (`cli-grant:<cid>`). Their signed-login records carry
 *   the `siweProof` replay verifies them from.
 *
 * Signed-login records the CLI stored without a `siweProof` cannot be
 * verified from signed bytes and are not installed by either runtime.
 *
 * The binding is local profile data. It stops records written by any other
 * path from granting authority. It does not stop someone who can write the
 * profile directory, who already holds the session key and the signed bytes.
 */

export type BindingSource = "migration" | "unbound-import" | "cli-grant";

const REQUEST_ID_PREFIX: Record<BindingSource, string> = {
  migration: "migrated",
  "unbound-import": "unbound-import",
  "cli-grant": "cli-grant",
};

/** The audit note written beside a binding the record's writer synthesized. */
export const BINDING_NOTES: Record<BindingSource, string> = {
  migration:
    "Stored without a request binding before bindings were required. Bound at migration to exactly " +
    "its own signed capabilities, so replay refuses any delegation in this record that exceeds them.",
  "unbound-import":
    "Imported by `tc auth import` without a stored request. Bound to exactly its own signed " +
    "capabilities, so replay refuses any delegation in this record that exceeds them.",
  "cli-grant":
    "Granted to this CLI by `tc auth request --grant` or a permission escalation, and checked " +
    "against the request it answered. Bound to exactly its own signed capabilities, so replay " +
    "refuses any delegation in this record that exceeds them.",
};

/** Short so a busy profile only defers migration to a later runtime. */
const MIGRATION_LOCK_TIMEOUT_MS = 250;

/** The per-profile marker: present once that profile's unbound records were migrated. */
export function bindingMigrationPath(profile: string): string {
  return join(profilePath(profile), "delegation-binding-migration.json");
}

/**
 * Compact and signed-login records require a valid request binding and signed
 * proof. A legacy record with no proof is classified `other` only so replay
 * can report `proof_missing`; it never installs. Malformed headers are refused.
 *
 * A header must contain exactly one `Authorization` string key: other shapes
 * might reach the node as authorization bytes this rule never examined.
 */
export function storedDelegationKind(
  entry: unknown,
): "compact" | "signed-login" | "other" | "refused" {
  // A stored element that is not an object is not a record at all.
  if (!isRecord(entry)) return "refused";
  const delegation = entry.delegation;
  if (!isRecord(delegation)) return "refused";
  const header = delegation.delegationHeader;
  if (
    !isRecord(header) ||
    Object.keys(header).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(header, "Authorization") ||
    typeof header.Authorization !== "string"
  ) {
    return "refused";
  }
  if ("siweProof" in delegation) return "signed-login";
  if (header.Authorization.includes(".")) return "compact";
  return "other";
}

/** A record replays only within a valid stored request binding. */
export function replayLimit(entry: unknown): readonly PermissionEntry[] | undefined {
  const kind = storedDelegationKind(entry);
  if (!isRecord(entry) || (kind !== "compact" && kind !== "signed-login")) return undefined;
  const binding = DelegationRequestBindingSchema.safeParse(entry.authorityRequest);
  return binding.success ? binding.data.requested : undefined;
}

/** Match node-sdk's normalization before validating a compact signature. */
export function withoutBearer(authorization: string): string {
  return authorization.replace(/^Bearer /i, "");
}

export type StoredDelegationSource = "cli-grant" | "unbound-import" | "migration" | "request" | "legacy" | "unknown";

/** Constrained labels only; never publish untrusted request IDs or audit notes. */
export function storedDelegationSource(entry: unknown): StoredDelegationSource {
  if (!isRecord(entry) || storedDelegationKind(entry) === "refused") return "unknown";
  if (!("authorityRequest" in entry)) return "legacy";
  const binding = DelegationRequestBindingSchema.safeParse(entry.authorityRequest);
  if (!binding.success) return "unknown";
  const cid = storedCid(entry);
  if (cid === undefined) return "unknown";
  if (binding.data.requestId === `cli-grant:${cid}`) return "cli-grant";
  if (binding.data.requestId === `unbound-import:${cid}`) return "unbound-import";
  if (binding.data.requestId === `migrated:${cid}`) return "migration";
  return "request";
}

/**
 * Binds a record to `requested`, with an audit note naming where the binding
 * came from. Throws when `requested` cannot form a valid binding.
 */
function bindToRequest<T extends { readonly delegation: { readonly cid: string } }>(
  record: T,
  requested: readonly PermissionEntry[],
  source: BindingSource,
  recordedAt = new Date().toISOString(),
): T & Record<"authorityRequest" | "authorityRequestAudit", unknown> {
  return {
    ...record,
    authorityRequest: DelegationRequestBindingSchema.parse({
      requestId: `${REQUEST_ID_PREFIX[source]}:${record.delegation.cid}`,
      requested: structuredClone(requested),
    }),
    authorityRequestAudit: { source, recordedAt, note: BINDING_NOTES[source] },
  };
}

/**
 * Binds the record of one of the CLI's own grants, already checked against
 * the request it answers, to exactly the capabilities its signed bytes grant.
 * They are read through the validated activation replay uses (nothing is
 * activated), so the binding is the authority replay will derive. Throws when
 * validated activation cannot read them for `node`'s session.
 */
export async function bindCliGrant<T extends { readonly delegation: PortableDelegation }>(
  node: RuntimeDelegationActivator,
  record: T,
  host: string,
): Promise<T & Record<"authorityRequest" | "authorityRequestAudit", unknown>> {
  const signed = await signedCapabilities(node, record.delegation, host);
  if (signed === undefined) {
    throw new Error("The grant's signed authority could not be validated for this session.");
  }
  return bindToRequest(record, signed, "cli-grant");
}

/**
 * Validates and activates an imported compact or signed-login delegation,
 * binding its record to exactly its verified signed capabilities.
 */
export async function activateUnboundImport(
  node: RuntimeDelegationActivator,
  delegation: PortableDelegation,
  host: string,
): Promise<{ delegation: PortableDelegation; permissions: PermissionEntry[] } & Record<string, unknown>> {
  const activated = await nodeSdk.activateValidatedRuntimeDelegation(node, delegation, {
    host,
    authorize: () => {
      verifyCompactProof(delegation);
      return true;
    },
  });
  return bindToRequest(
    { delegation, permissions: [...activated.effectivePermissions] },
    activated.effectivePermissions,
    "unbound-import",
  );
}

/**
 * The stored records after adding records written without a stored request
 * (by `tc auth import` or a CLI grant). A stored record for the same CID that
 * carries an `authorityRequest` is kept as it is, so this route never drops,
 * replaces or weakens a binding; otherwise each record replaces every row for
 * its CID, at the first one's position, or is appended. Callers write the
 * result under the profile lock they already use for this store.
 */
export function mergeDelegationsWithoutRequest(
  stored: readonly unknown[],
  incoming: readonly ({ readonly delegation: { readonly cid: string } } & Record<string, unknown>)[],
): unknown[] {
  let records = [...stored];
  for (const record of incoming) {
    const cid = record.delegation.cid;
    if (records.some((entry) => storedCid(entry) === cid && isRecord(entry) && "authorityRequest" in entry)) continue;
    const position = records.findIndex((entry) => storedCid(entry) === cid);
    const others = records.filter((entry) => storedCid(entry) !== cid);
    records = position === -1
      ? [...records, record]
      : [...others.slice(0, position), record, ...others.slice(position)];
  }
  return records;
}

/**
 * Runs migration before replay reads the profile's records. Returns whether
 * the marker exists; replay refuses unbound records either way.
 *
 * Migration runs under the profile lock, and only while the persisted session
 * is still the one `node` restored. Each unbound compact record is checked
 * without activation and bound to exactly its signed capabilities, or left
 * unbound when validation fails. `migrate` must be false unless the node
 * holds the profile's own restored session.
 *
 * Migration is best-effort and restartable. Bound records are written before
 * the marker; a busy lock or failure leaves migration for a later runtime.
 * Records already bound by an interrupted run keep their bindings.
 */
export async function prepareStoredDelegationReplay(
  profile: string,
  node: RuntimeDelegationActivator,
  options: { readonly host: string; readonly migrate: boolean },
): Promise<boolean> {
  if (await bindingMigrationRecorded(profile)) return true;
  // A persisted session without a `verificationMethod`, or one this node did
  // not restore, never migrates here; skip the lock rather than take it for
  // nothing on every command.
  if (!options.migrate || !await holdsPersistedSession(profile, node)) return false;
  try {
    return await withProfileLock(profile, async () => {
      if (await bindingMigrationRecorded(profile)) return true;
      // Checked again under the lock: a session rotated since the restore
      // leaves migration to a runtime of the new session.
      if (!await holdsPersistedSession(profile, node)) return false;
      const recordedAt = new Date().toISOString();
      const bound = new Map<string, Record<string, unknown>>();
      const unbound: string[] = [];
      for (const entry of await readAdditionalDelegations<unknown>(profile)) {
        // Elements that are not objects are skipped: they install nothing.
        if (!isRecord(entry) || "authorityRequest" in entry || storedDelegationKind(entry) !== "compact") continue;
        const migrated = await migratedRecord(node, entry, options.host, recordedAt);
        if (migrated === undefined) unbound.push(String(storedCid(entry)));
        else bound.set(recordKey(entry)!, migrated);
      }
      if (bound.size > 0) {
        await updateProfileStore<unknown, void>(profile, "additional-delegations", (records) => ({
          records: records.map((entry) => {
            const key = !isRecord(entry) || "authorityRequest" in entry ? undefined : recordKey(entry);
            return (key === undefined ? undefined : bound.get(key)) ?? entry;
          }),
          result: undefined,
        }));
      }
      await writeJsonAtomic(bindingMigrationPath(profile), {
        formatVersion: 1,
        migratedAt: recordedAt,
        bound: [...bound.values()].map(storedCid),
        unbound,
      });
      return true;
    }, { timeoutMs: MIGRATION_LOCK_TIMEOUT_MS });
  } catch {
    return false;
  }
}

/** Whether the profile's persisted session is the one `node` restored. */
async function holdsPersistedSession(profile: string, node: RuntimeDelegationActivator): Promise<boolean> {
  try {
    const persisted = await readSession<Record<string, unknown>>(profile);
    return typeof persisted?.verificationMethod === "string" &&
      typeof node.sessionDid === "string" &&
      persisted.verificationMethod.split("#", 1)[0] === node.sessionDid.split("#", 1)[0];
  } catch {
    return false;
  }
}

/** One record's migration: bound to its own signed capabilities, or `undefined` if it cannot be. */
async function migratedRecord(
  node: RuntimeDelegationActivator,
  entry: Record<string, unknown>,
  host: string,
  recordedAt: string,
): Promise<Record<string, unknown> | undefined> {
  const delegation = normalizeStoredDelegation(entry);
  if (delegation === undefined) return undefined;
  const signed = await signedCapabilities(node, delegation, host);
  if (signed === undefined) return undefined;
  try {
    // The stored delegation is kept exactly as it was; only the binding is added.
    return bindToRequest({ ...entry, delegation: { ...entry.delegation as object, cid: delegation.cid } }, signed, "migration", recordedAt);
  } catch {
    // Signed capabilities a request binding cannot hold (an empty action, say).
    return undefined;
  }
}

/**
 * What replay did with one stored record. `skipped` records grant nothing and
 * carry a fixed reason code that is safe to publish; `not-replayed` records
 * are routine (expired) and give nothing to act on.
 */
export type StoredDelegationReplay =
  | { readonly status: "installed"; readonly delegation: ValidatedRuntimeDelegation }
  | { readonly status: "skipped"; readonly reason: StoredGrantSkipReason }
  | { readonly status: "not-replayed" };

const NOT_REPLAYED: StoredDelegationReplay = { status: "not-replayed" };

function skipped(reason: StoredGrantSkipReason): StoredDelegationReplay {
  return { status: "skipped", reason };
}

/**
 * The single stored-grant replay path for CLI and canonical runtimes.
 * Migration runs before the store read; CID deduplication affects authority
 * only, not the per-record fixed-code skip diagnostics.
 */
export async function replayProfileDelegations(
  profile: string,
  node: RuntimeDelegationActivator,
  options: { readonly host: string; readonly migrate: boolean; readonly resolveSpace: OperationSpaceResolver },
): Promise<{ installed: ValidatedRuntimeDelegation[]; warnings: OperationWarning[] }> {
  await prepareStoredDelegationReplay(profile, node, { host: options.host, migrate: options.migrate });
  const installed: ValidatedRuntimeDelegation[] = [];
  const warnings: OperationWarning[] = [];
  const seen = new Set<string>();
  for (const entry of await readAdditionalDelegations<unknown>(profile)) {
    const replay = await replayStoredDelegation(node, entry, options);
    if (replay.status === "installed") {
      if (!seen.has(replay.delegation.cid)) {
        seen.add(replay.delegation.cid);
        installed.push(replay.delegation);
      }
    } else if (replay.status === "skipped") {
      const grantCid = verifiedStoredCid(node, entry);
      warnings.push({
        code: "STORED_GRANT_SKIPPED",
        reason: replay.reason,
        ...(grantCid === undefined ? {} : { grantCid }),
      });
    }
  }
  return { installed, warnings };
}

/**
 * Publish a stored CID only when it matches the stored authorization bytes.
 * Free-text and even correctly shaped CIDs of different bytes stay private.
 */
export function verifiedStoredCid(node: RuntimeDelegationActivator, entry: unknown): string | undefined {
  const delegation = isRecord(entry) && isRecord(entry.delegation) ? entry.delegation : undefined;
  const header = isRecord(delegation?.delegationHeader) ? delegation.delegationHeader : undefined;
  const cid = delegation?.cid;
  if (typeof cid !== "string" || typeof header?.Authorization !== "string" ||
    typeof node.computeDelegationCid !== "function") return undefined;
  try {
    return node.computeDelegationCid(header.Authorization) === cid &&
      DELEGATION_CID.test(cid) ? cid : undefined;
  } catch {
    return undefined;
  }
}

const DELEGATION_CID = new RegExp(DELEGATION_CID_PATTERN);

/**
 * Replays one stored record under its binding, never installing an unbound or
 * unproven grant. Stored bytes and node messages are never published.
 */
export async function replayStoredDelegation(
  node: RuntimeDelegationActivator,
  entry: unknown,
  options: { readonly host: string; readonly resolveSpace: OperationSpaceResolver },
): Promise<StoredDelegationReplay> {
  const result = await assess(node, entry, options, { activate: true });
  return result.status === "verified" ? skipped("invalid") : result;
}

export type StoredDelegationInspection =
  | { readonly local: "verified"; readonly cid: string; readonly effectivePermissions: readonly PermissionEntry[]; readonly expiry: Date }
  | { readonly local: "refused"; readonly reason: StoredGrantSkipReason }
  | { readonly local: "not_checked"; readonly because: "expired" | "no_session" };

/**
 * Checks only local signed bytes, expiry, audience, resources and binding.
 * The node still decides delegation-chain validity and revocation at install.
 */
export async function inspectStoredDelegation(
  entry: unknown,
  options: { readonly node?: RuntimeDelegationActivator; readonly host?: string; readonly resolveSpace?: OperationSpaceResolver } = {},
): Promise<StoredDelegationInspection> {
  const delegation = normalizeStoredDelegation(entry);
  if (storedDelegationKind(entry) === "refused" || delegation === undefined) {
    return { local: "refused", reason: "malformed" };
  }
  if (delegation.expiry.getTime() <= Date.now()) return { local: "not_checked", because: "expired" };
  if (options.node === undefined) return { local: "not_checked", because: "no_session" };
  const result = await assess(options.node, entry, {
    host: options.host ?? delegation.host ?? "",
    resolveSpace: options.resolveSpace,
  }, { activate: false });
  if (result.status === "verified") {
    return { local: "verified", cid: result.cid, effectivePermissions: result.effectivePermissions, expiry: result.expiry };
  }
  if (result.status === "not-replayed") return { local: "not_checked", because: "expired" };
  return { local: "refused", reason: result.status === "skipped" ? result.reason : "invalid" };
}

type Assessment = StoredDelegationReplay |
  { readonly status: "verified"; readonly cid: string; readonly effectivePermissions: readonly PermissionEntry[]; readonly expiry: Date };

async function assess(
  node: RuntimeDelegationActivator,
  entry: unknown,
  options: { readonly host: string; readonly resolveSpace?: OperationSpaceResolver },
  mode: { readonly activate: boolean },
): Promise<Assessment> {
  const kind = storedDelegationKind(entry);
  const delegation = normalizeStoredDelegation(entry);
  if (kind === "refused" || delegation === undefined) return skipped("malformed");
  if (delegation.expiry.getTime() <= Date.now()) return NOT_REPLAYED;
  if (kind === "other") return skipped("proof_missing");
  const limit = replayLimit(entry);
  if (limit === undefined) return skipped("unbound");
  let outsideRequest = false;
  let effectivePermissions: readonly PermissionEntry[] | undefined;
  try {
    const installed = await nodeSdk.activateValidatedRuntimeDelegation(node, delegation, {
      host: options.host,
      authorize: (effective) => {
        verifyCompactProof(delegation);
        outsideRequest = !delegationWithinRequest(limit, effective, options.resolveSpace);
        if (outsideRequest) return false;
        effectivePermissions = effective;
        return mode.activate;
      },
    });
    return { status: "installed", delegation: installed };
  } catch (error) {
    if (outsideRequest) return skipped("outside_request");
    if (effectivePermissions !== undefined && !mode.activate) {
      return { status: "verified", cid: delegation.cid, effectivePermissions, expiry: delegation.expiry };
    }
    return skipped(rejectionReason(error));
  }
}

/** Compact grants must pass the strict local verifier before any installation. */
function verifyCompactProof(delegation: PortableDelegation): void {
  const authorization = delegation.delegationHeader.Authorization;
  if (!withoutBearer(authorization).includes(".")) return;
  try {
    parseSignedCompactUcanAttenuation(withoutBearer(authorization), delegation.cid);
  } catch {
    throw new nodeSdk.RuntimeDelegationRejectedError("proof_invalid", "The compact delegation proof is invalid.");
  }
}

/** The published reason node-sdk attached to a refused delegation, else `invalid`. */
function rejectionReason(error: unknown): StoredGrantSkipReason {
  const reason = isRecord(error) ? error.reason : undefined;
  return typeof reason === "string" && (STORED_GRANT_SKIP_REASONS as readonly string[]).includes(reason)
    ? reason as StoredGrantSkipReason
    : "invalid";
}

/** An unreadable marker counts as migrated: a damaged marker never reopens migration. */
export async function bindingMigrationRecorded(profile: string): Promise<boolean> {
  try {
    return await readJson<unknown>(bindingMigrationPath(profile)) !== null;
  } catch {
    return true;
  }
}

/**
 * The capabilities a stored delegation's signed bytes grant, read through
 * validated activation, which `authorize` stops before anything is activated.
 */
async function signedCapabilities(
  node: RuntimeDelegationActivator,
  delegation: PortableDelegation,
  host: string,
): Promise<readonly PermissionEntry[] | undefined> {
  let signed: readonly PermissionEntry[] | undefined;
  try {
    await nodeSdk.activateValidatedRuntimeDelegation(node, delegation, {
      // The transport host is not signed authority; check it at replay instead.
      host: delegation.host ?? host,
      authorize: (effective) => {
        verifyCompactProof(delegation);
        signed = effective;
        return false;
      },
    });
  } catch {
    // Refused by `authorize` once the capabilities were read, or failed a check before it.
  }
  return signed;
}

function normalizeStoredDelegation(entry: unknown): PortableDelegation | undefined {
  if (!isRecord(entry)) return undefined;
  const raw = entry.delegation;
  if (!isRecord(raw) || !isRecord(raw.delegationHeader)) return undefined;
  const expiry = raw.expiry instanceof Date
    ? raw.expiry
    : typeof raw.expiry === "string" ? new Date(raw.expiry) : undefined;
  if (
    expiry === undefined || Number.isNaN(expiry.getTime()) ||
    typeof raw.cid !== "string" ||
    typeof raw.spaceId !== "string" ||
    typeof raw.path !== "string" ||
    !Array.isArray(raw.actions) || !raw.actions.every((action) => typeof action === "string") ||
    typeof raw.delegateDID !== "string" ||
    typeof raw.ownerAddress !== "string" ||
    typeof raw.chainId !== "number" ||
    typeof raw.delegationHeader.Authorization !== "string"
  ) {
    return undefined;
  }
  return { ...raw, expiry } as PortableDelegation;
}

function storedCid(entry: unknown): string | undefined {
  const cid = isRecord(entry) && isRecord(entry.delegation) ? entry.delegation.cid : undefined;
  return typeof cid === "string" ? cid : undefined;
}

/** A record's CID and exact authorization bytes. */
function recordKey(entry: Record<string, unknown>): string | undefined {
  const delegation = entry.delegation;
  if (!isRecord(delegation) || !isRecord(delegation.delegationHeader)) return undefined;
  return JSON.stringify([delegation.cid, delegation.delegationHeader.Authorization]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
