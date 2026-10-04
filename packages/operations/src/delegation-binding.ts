import { join } from "node:path";

import type { PermissionEntry } from "@tinycloud/node-sdk";

import {
  DelegationRequestBindingSchema,
  type DelegationRequestBinding,
} from "./artifacts.js";
import {
  profilePath,
  readJson,
  updateProfileStore,
  withProfileLock,
  writeJsonAtomic,
} from "./state.js";

/**
 * Request bindings for stored runtime delegations.
 *
 * Replay installs a record from `additional-delegations.json` only when its
 * `authorityRequest` binding is valid and its signed capabilities stay inside
 * the binding's `requested`. `tinycloud.auth.import` writes that binding.
 *
 * Records stored before bindings existed carry none. Each profile migrates
 * them once: the first authenticated runtime that finds no migration marker
 * replays unbound records as before, binds every one whose signed authority
 * it read to exactly that authority, and then writes the marker. From then on
 * an unbound record installs nothing.
 */

/** Written into a migrated record beside its synthesized binding. */
export const BINDING_MIGRATION_NOTE =
  "Stored without a request binding before bindings were required. Bound at migration to exactly " +
  "its own signed capabilities, so replay refuses any delegation in this record that exceeds them.";

/** Short so a busy profile only defers migration to a later runtime. */
const MIGRATION_LOCK_TIMEOUT_MS = 250;

/** The per-profile marker: present once that profile's unbound records were migrated. */
export function bindingMigrationPath(profile: string): string {
  return join(profilePath(profile), "delegation-binding-migration.json");
}

/** Whether a stored record carries a binding replay accepts. */
export function hasRequestBinding(entry: Record<string, unknown>): boolean {
  return DelegationRequestBindingSchema.safeParse(entry.authorityRequest).success;
}

/**
 * Starts this runtime's part of the migration, or returns `undefined` once the
 * profile has migrated. An unreadable marker counts as migrated: a damaged
 * marker never reopens migration.
 */
export async function beginBindingMigration(profile: string): Promise<BindingMigration | undefined> {
  try {
    if (await readJson<unknown>(bindingMigrationPath(profile)) !== null) return undefined;
  } catch {
    return undefined;
  }
  return new BindingMigration(profile);
}

export class BindingMigration {
  readonly #profile: string;
  /** Signed capabilities read by replay, keyed by CID and authorization bytes. */
  readonly #signed = new Map<string, readonly PermissionEntry[]>();

  constructor(profile: string) {
    this.#profile = profile;
  }

  /**
   * The replay authorization for an unbound record, which also records the
   * signed capabilities it is about to install. `undefined` when the record is
   * not one migration binds: it has an `authorityRequest` member (valid or
   * not), or it is a signed-login (SIWE) record, whose binding only a
   * validated import may write.
   */
  authorizer(entry: Record<string, unknown>): ((effective: readonly PermissionEntry[]) => boolean) | undefined {
    const key = migrationKey(entry);
    if (key === undefined) return undefined;
    return (effective) => {
      this.#signed.set(key, structuredClone(effective));
      return true;
    };
  }

  /**
   * Binds every still-unbound record whose signed capabilities this runtime
   * read, then writes the marker. Any failure (a busy lock, an unwritable
   * profile, a binding replay would not accept) leaves the marker unwritten,
   * so the next runtime replays as before and retries.
   */
  async commit(): Promise<void> {
    const migratedAt = new Date().toISOString();
    try {
      await withProfileLock(this.#profile, async () => {
        if (await readJson<unknown>(bindingMigrationPath(this.#profile)) !== null) return;
        const bound: string[] = [];
        if (this.#signed.size > 0) {
          await updateProfileStore<Record<string, unknown>, void>(
            this.#profile,
            "additional-delegations",
            (records) => ({
              records: records.map((entry) => {
                const key = migrationKey(entry);
                const signed = key === undefined ? undefined : this.#signed.get(key);
                if (signed === undefined) return entry;
                const cid = (entry.delegation as { cid: string }).cid;
                const authorityRequest: DelegationRequestBinding = DelegationRequestBindingSchema.parse({
                  requestId: `migrated:${cid}`,
                  requested: signed,
                });
                bound.push(cid);
                return {
                  ...entry,
                  authorityRequest,
                  authorityRequestMigration: { migratedAt, note: BINDING_MIGRATION_NOTE },
                };
              }),
              result: undefined,
            }),
          );
        }
        await writeJsonAtomic(bindingMigrationPath(this.#profile), { formatVersion: 1, migratedAt, bound });
      }, { timeoutMs: MIGRATION_LOCK_TIMEOUT_MS });
    } catch {
      // Replay already ran under the pre-migration rule for this runtime.
    }
  }
}

/** Identifies an unbound, non-SIWE record by its CID and exact authorization bytes. */
function migrationKey(entry: Record<string, unknown>): string | undefined {
  if ("authorityRequest" in entry) return undefined;
  const delegation = entry.delegation;
  if (delegation === null || typeof delegation !== "object" || "siweProof" in delegation) {
    return undefined;
  }
  const { cid, delegationHeader } = delegation as { cid?: unknown; delegationHeader?: unknown };
  const authorization = delegationHeader !== null && typeof delegationHeader === "object"
    ? (delegationHeader as { Authorization?: unknown }).Authorization
    : undefined;
  if (typeof cid !== "string" || typeof authorization !== "string") return undefined;
  return JSON.stringify([cid, authorization]);
}
