import { join } from "node:path";

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
import {
  profilePath,
  readAdditionalDelegations,
  readJson,
  updateProfileStore,
  withProfileLock,
  writeJsonAtomic,
} from "./state.js";

export { operationSpaceResolver } from "./secrets.js";

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
 *
 * Records the CLI stores from its own signed-login grants carry no
 * `siweProof`, cannot be verified here, and keep their legacy CLI replay.
 *
 * The binding is local profile data. It stops records written by any other
 * path from granting authority. It does not stop someone who can write the
 * profile directory, who already holds the session key and the signed bytes.
 */

export type BindingSource = "migration" | "unbound-import";

const REQUEST_ID_PREFIX: Record<BindingSource, string> = {
  migration: "migrated",
  "unbound-import": "unbound-import",
};

/** The audit note written beside a binding synthesized from a record's own signed capabilities. */
export const BINDING_NOTES: Record<BindingSource, string> = {
  migration:
    "Stored without a request binding before bindings were required. Bound at migration to exactly " +
    "its own signed capabilities, so replay refuses any delegation in this record that exceeds them.",
  "unbound-import":
    "Imported by `tc auth import` without a stored request. Bound to exactly its own signed " +
    "capabilities, so replay refuses any delegation in this record that exceeds them.",
};

/** Short so a busy profile only defers migration to a later runtime. */
const MIGRATION_LOCK_TIMEOUT_MS = 250;

/** The per-profile marker: present once that profile's unbound records were migrated. */
export function bindingMigrationPath(profile: string): string {
  return join(profilePath(profile), "delegation-binding-migration.json");
}

/**
 * How replay treats a stored record:
 *
 * - `compact` and `signed-login` records go through validated activation and
 *   the binding rule.
 * - `other` records (the CLI's own signed-login grants, a CACAO without
 *   `siweProof`) keep the CLI's legacy replay; the operations runtime never
 *   installs them.
 * - `malformed` records install nothing anywhere.
 *
 * A record is `malformed` unless its `delegationHeader` has exactly one own
 * key, `Authorization`, with a string value: header names are matched
 * case-insensitively on the wire, and other value types are stringified, so
 * any other shape could reach the node as authorization bytes this rule never
 * read. Bytes containing a `.` are never `other`: a CACAO has none, and
 * validated activation refuses anything compact-shaped that it cannot parse.
 */
export function storedDelegationKind(
  entry: Record<string, unknown>,
): "compact" | "signed-login" | "other" | "malformed" {
  const delegation = entry.delegation;
  if (!isRecord(delegation)) return "malformed";
  const header = delegation.delegationHeader;
  if (
    !isRecord(header) ||
    Object.keys(header).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(header, "Authorization") ||
    typeof header.Authorization !== "string"
  ) {
    return "malformed";
  }
  if ("siweProof" in delegation) return "signed-login";
  return header.Authorization.includes(".") ? "compact" : "other";
}

/**
 * What replay holds a stored record to: its binding's `requested`, `"signed"`
 * for an unbound compact record before the profile has migrated (it installs
 * with its own signed authority, as before bindings existed), or `undefined`
 * when the record installs nothing.
 */
export function replayLimit(
  entry: Record<string, unknown>,
  migrated: boolean,
): readonly PermissionEntry[] | "signed" | undefined {
  const kind = storedDelegationKind(entry);
  if (kind !== "compact" && kind !== "signed-login") return undefined;
  const binding = DelegationRequestBindingSchema.safeParse(entry.authorityRequest);
  if (binding.success) return binding.data.requested;
  return !migrated && kind === "compact" && !("authorityRequest" in entry) ? "signed" : undefined;
}

/**
 * Binds a record to exactly the capabilities its signed bytes grant, with an
 * audit note naming where the binding came from.
 */
function bindToSignedCapabilities<T extends { readonly delegation: { readonly cid: string } }>(
  record: T,
  signed: readonly PermissionEntry[],
  source: BindingSource,
  recordedAt = new Date().toISOString(),
): T & Record<"authorityRequest" | "authorityRequestAudit", unknown> {
  return {
    ...record,
    authorityRequest: DelegationRequestBindingSchema.parse({
      requestId: `${REQUEST_ID_PREFIX[source]}:${record.delegation.cid}`,
      requested: structuredClone(signed),
    }),
    authorityRequestAudit: { source, recordedAt, note: BINDING_NOTES[source] },
  };
}

/**
 * Validates and activates a compact delegation that `tc auth import` received
 * without a stored request, through the same validated activation replay uses,
 * and returns its record bound to exactly the capabilities its signed bytes
 * grant. Throws when validation or activation fails.
 */
export async function activateUnboundCompactImport(
  node: RuntimeDelegationActivator,
  delegation: PortableDelegation,
  host: string,
): Promise<{ delegation: PortableDelegation; permissions: PermissionEntry[] } & Record<string, unknown>> {
  const activated = await nodeSdk.activateValidatedRuntimeDelegation(node, delegation, { host });
  return bindToSignedCapabilities(
    // The record keeps the delegation as imported; replay validates it again.
    { delegation, permissions: [...activated.effectivePermissions] },
    activated.effectivePermissions,
    "unbound-import",
  );
}

/**
 * Stores a record written without a stored request (by `tc auth import` or a
 * CLI grant). Any stored record for the same CID that carries a binding is
 * kept as it is, so this route never drops, replaces or weakens a binding;
 * otherwise the record replaces every row for its CID, at the first one's
 * position.
 */
export async function storeDelegationWithoutRequest(
  profile: string,
  record: { readonly delegation: { readonly cid: string } } & Record<string, unknown>,
): Promise<void> {
  const cid = record.delegation.cid;
  await updateProfileStore<Record<string, unknown>, void>(profile, "additional-delegations", (records) => {
    const position = records.findIndex((entry) => storedCid(entry) === cid);
    if (records.some((entry) => storedCid(entry) === cid && "authorityRequest" in entry)) {
      return { records, result: undefined };
    }
    const others = records.filter((entry) => storedCid(entry) !== cid);
    return {
      records: position === -1
        ? [...records, record]
        : [...others.slice(0, position), record, ...others.slice(position)],
      result: undefined,
    };
  });
}

/**
 * Runs before replay reads the profile's records, so those records and the
 * migration marker agree. Returns whether the profile has migrated.
 *
 * Migration is one locked read-modify-write of the current records. Each
 * compact record with no `authorityRequest` is handled on its own: if
 * validated activation can read its signed capabilities (CID, expiry,
 * audience and declared resources checked, nothing activated) and they form a
 * valid binding, the record is bound to exactly those capabilities; otherwise
 * it stays unbound, is listed in the marker's `unbound`, and installs nothing
 * after migration. A compact record whose capabilities cannot be read could
 * not activate for this session either. The marker is written in the same
 * critical section. `migrate` must be false unless `node` holds the profile's
 * own restored session. If the lock is busy or a write fails, nothing is
 * written and this runtime replays under the pre-migration rule.
 */
export async function prepareStoredDelegationReplay(
  profile: string,
  node: RuntimeDelegationActivator,
  options: { readonly host: string; readonly migrate: boolean },
): Promise<boolean> {
  if (await bindingMigrationRecorded(profile)) return true;
  if (!options.migrate) return false;
  try {
    return await withProfileLock(profile, async () => {
      if (await bindingMigrationRecorded(profile)) return true;
      const recordedAt = new Date().toISOString();
      const bound = new Map<string, Record<string, unknown>>();
      const unbound: string[] = [];
      for (const entry of await readAdditionalDelegations<Record<string, unknown>>(profile)) {
        if ("authorityRequest" in entry || storedDelegationKind(entry) !== "compact") continue;
        const migrated = await migratedRecord(node, entry, options.host, recordedAt);
        if (migrated === undefined) unbound.push(String(storedCid(entry)));
        else bound.set(recordKey(entry)!, migrated);
      }
      if (bound.size > 0) {
        await updateProfileStore<Record<string, unknown>, void>(profile, "additional-delegations", (records) => ({
          records: records.map((entry) => {
            const key = "authorityRequest" in entry ? undefined : recordKey(entry);
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
    return bindToSignedCapabilities({ ...entry, delegation: { ...entry.delegation as object, cid: delegation.cid } }, signed, "migration", recordedAt);
  } catch {
    // Signed capabilities a request binding cannot hold (an empty action, say).
    return undefined;
  }
}

/**
 * Replays one stored record under the binding rule. A record with a valid
 * binding installs only if its signed capabilities fit inside it. Before the
 * profile has migrated, an unbound compact record installs with its signed
 * authority as it always did; after, it installs nothing. A signed-login
 * record installs only with a binding. Returns the installed delegation, or
 * `undefined` when the record installs nothing. Never throws: stored data is
 * untrusted transport material.
 */
export async function replayStoredDelegation(
  node: RuntimeDelegationActivator,
  entry: Record<string, unknown>,
  options: {
    readonly host: string;
    readonly migrated: boolean;
    readonly resolveSpace: OperationSpaceResolver;
  },
): Promise<ValidatedRuntimeDelegation | undefined> {
  const delegation = normalizeStoredDelegation(entry);
  if (delegation === undefined || delegation.expiry.getTime() <= Date.now()) return undefined;
  const limit = replayLimit(entry, options.migrated);
  if (limit === undefined) return undefined;
  const authorize = limit === "signed"
    ? () => true
    : (effective: readonly PermissionEntry[]) => delegationWithinRequest(limit, effective, options.resolveSpace);
  try {
    return await nodeSdk.activateValidatedRuntimeDelegation(node, delegation, { host: options.host, authorize });
  } catch {
    // An invalid, stale, wrong-session, or rejected record grants nothing and
    // must not reveal its contents through a safe operation channel.
    return undefined;
  }
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
        signed = effective;
        return false;
      },
    });
  } catch {
    // Refused by `authorize` once the capabilities were read, or failed a check before it.
  }
  return signed;
}

function normalizeStoredDelegation(entry: Record<string, unknown>): PortableDelegation | undefined {
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

function storedCid(entry: Record<string, unknown>): string | undefined {
  const cid = isRecord(entry.delegation) ? entry.delegation.cid : undefined;
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
