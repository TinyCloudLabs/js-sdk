/**
 * `sqliteReplicaStorage` — Node/CLI SQLite replicas with a mandatory
 * profile lifecycle gate and durable identity-scoped pending file.
 *
 * `@tinycloud/replica`, `@tinycloud/replica/sqlite` and
 * `@tinycloud/node-sdk-wasm` load lazily — only inside `open`, `purge`,
 * `sync` and device-key creation — so this module never lands in the `/core`
 * entry and flag-off Node processes never evaluate replica code. The replica
 * types are the structural declarations in `./replica-contract` (never an
 * import of replica's own `.d.ts`), so this package's build — DTS included —
 * does not depend on replica's dist being built first. `replica-contract.test.ts`
 * pins the declarations against the real modules wherever replica IS built.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, statSync, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, open as openFile, readFile, readdir, realpath, rename, rm, rmdir, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";


import { KVService, ServiceContext, principalDid } from "@tinycloud/sdk-core";
import {
  canonicalReplicationIdentity,
  replicationIdentityKey,
  requiresSecretsOptIn,
} from "@tinycloud/sdk-services";
import type {
  KVReplicaHandle,
  KVReplicaSpec,
  KVReplicaStorage,
  LocalGetResult,
  LocalListResult,
  LocalReadMeta,
  LocalReplicaStatus,
  LocalSyncResult,
  PendingWriteState,
  PendingWriteStore,
  PurgeTarget,
  ReplicaDevice,
  ReplicaGrantInfo,
  ReplicationIdentity,
} from "@tinycloud/sdk-services";
import type {
  ProfileReplicaApprovalEntry,
  ProfileReplicaDeferredDenyOutcome,
  ProfileReplicaDeferredToken,
  ProfileReplicaLogoutPending,
  ProfileReplicaPreflight,
  ProfileReplicaPurge,
  ProfileReplicaRemoteLogoutState,
  ProfileReplicaRootIdentity,
  ProfileReplicaUnknownEntry,
  ReplicaAccountGate,
  ReplicaDenyOutcome,
  ReplicaDenyInput,
  ReplicaEraseReport,
  ReplicaGateAccess,
  ReplicaLifecycleGate,
  ReplicaConsentAnchor,
  ReplicaPurgeIntent,
  ReplicaSessionStamp,
} from "@tinycloud/sdk-services/kv/replication";
import { CONSENT_WINDOW_MS, MAX_GRANT_TTL_MS, REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";
import type {
  GrantRecord,
  MutationGuard,
  ReplicaListEntry,
  ReplicaRuntime,
  ReplicaTransport,
  SqliteReplicaStore,
  SqliteGrantInstall,
  SqliteGrantPolicy,
  SqliteRuntime,
} from "./replica-contract";
import { ucanAttUnconstrainedFor } from "./authority";
export type { ProfileReplicaDeferredToken, ProfileReplicaPurge };

/** CLI-only crash fence; generic SQLite stores do not opt in to this path. */
export const REPLICA_LOGOUT_PENDING_FILE = "replica-logout-pending.json";

/** Every CLI read path, including legacy replica commands, checks this marker before delivery. */
export function assertProfileLogoutClear(profileDir: string): void {
  assertLogoutClear(join(profileDir, REPLICA_LOGOUT_PENDING_FILE));
}

function assertLogoutClear(path: string | undefined): void {
  if (path === undefined) return;
  try {
    lstatSync(path);
  } catch (error) {
    if (isNotFound(error)) return;
  }
  throw gated("gate_unavailable");
}

function safeInventoryPath(path: string): boolean {
  return path.length > 0 && path.split("/").every((part) =>
    part.length > 0 && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0")) &&
    (path === "replication" || path.startsWith("replication/") ||
     path === "replicas" || path.startsWith("replicas/"));
}

/** The domain-separated owner binding persisted as a logout marker's `principalDigest`. */
export function logoutPrincipalDigest(principal: string): string {
  return createHash("sha256").update("tinycloud-replica-logout\0").update(principal, "utf8").digest("hex");
}
function compareInventoryString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function approvalEntries(report: ProfileReplicaPreflight): ProfileReplicaApprovalEntry[] {
  return [
    ...report.unknownEntries,
    ...report.knownEntries,
    ...report.knownRoots.map((root) => ({ ...root, kind: "directory" as const })),
    ...report.missingDatabases.map((path) => ({ path, kind: "missing" as const, dev: "", ino: "" })),
  ].map(({ path, kind, dev, ino }) => ({ path, kind, dev, ino }))
    .sort((a, b) => compareInventoryString(a.path, b.path) ||
      compareInventoryString(a.kind, b.kind) ||
      compareInventoryString(a.dev, b.dev) ||
      compareInventoryString(a.ino, b.ino));
}

/** A visible confirmation fence, not authority: every field is rechecked under the profile lock. */
function inventoryApprovalToken(
  marker: ProfileReplicaLogoutPending, principal: string, entries: readonly ProfileReplicaApprovalEntry[],
): string {
  const markerId = marker.v === 2
    ? [marker.v, marker.nonce, marker.principalDigest]
    : [marker.v, marker.incarnation, marker.lifecycleEpoch, marker.principalDigest];
  return createHash("sha256").update("tc-logout-approve-v1\0")
    .update(JSON.stringify([markerId, marker.approvalSalt, principal,
      marker.v === 2 ? null : marker.lifecycleEpoch, entries]))
    .digest().subarray(0, 16).toString("hex");
}

function changedInventoryRefusal(
  marker: ProfileReplicaLogoutPending, principal: string, report: ProfileReplicaPreflight,
  entries = approvalEntries(report),
): Error & { code: "REPLICA_GATED"; gate: string; inventoryApprovalToken: string;
  inventoryApprovalEntries: ProfileReplicaApprovalEntry[] } {
  const token = inventoryApprovalToken(marker, principal, entries);
  const error = localChangesRefusal(report.unknownPaths);
  error.message += ` Current token-bound inventory (path/kind/dev/ino): ${entries.length === 0 ?
    "(empty)" : entries.map((entry) => JSON.stringify(entry)).join(", ")}.` +
    ` To approve this exact changed inventory in a separate command, use --discard-local-changes --approve-inventory ${token}.`;
  return Object.assign(error, { inventoryApprovalToken: token, inventoryApprovalEntries: entries });
}
function storedInventoryChanged(
  marker: ProfileReplicaLogoutPending, report: ProfileReplicaPreflight,
): boolean {
  try {
    assertApprovedInventory(report, {
      unknownEntries: marker.approvedUnknown, knownRoots: marker.knownRoots,
      knownEntries: marker.knownEntries, missingDatabases: marker.missingDatabases,
    });
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
        error.code === "REPLICA_GATED" && "gate" in error && error.gate === "gate_unavailable") {
      return true;
    }
    throw error;
  }
}


function decimalIdentity(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function logoutMarkerOf(value: unknown): ProfileReplicaLogoutPending {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw gated("gate_unavailable");
  const row = value as Record<string, unknown>;
  const entry = (item: unknown): item is ProfileReplicaUnknownEntry =>
    item !== null && typeof item === "object" && !Array.isArray(item) &&
    Object.keys(item).length === 4 && typeof (item as ProfileReplicaUnknownEntry).path === "string" &&
    safeInventoryPath((item as ProfileReplicaUnknownEntry).path) &&
    ["file", "directory", "symlink"].includes((item as ProfileReplicaUnknownEntry).kind) &&
    decimalIdentity((item as ProfileReplicaUnknownEntry).dev) &&
    decimalIdentity((item as ProfileReplicaUnknownEntry).ino);
  const root = (item: unknown): item is ProfileReplicaRootIdentity =>
    item !== null && typeof item === "object" && !Array.isArray(item) &&
    Object.keys(item).length === 3 && typeof (item as ProfileReplicaRootIdentity).path === "string" &&
    safeInventoryPath((item as ProfileReplicaRootIdentity).path) &&
    decimalIdentity((item as ProfileReplicaRootIdentity).dev) &&
    decimalIdentity((item as ProfileReplicaRootIdentity).ino);
  if (typeof row.principalDigest !== "string" || !/^[0-9a-f]{64}$/.test(row.principalDigest) ||
      typeof row.approvalSalt !== "string" || !/^[0-9a-f]{32}$/.test(row.approvalSalt) ||
      !Array.isArray(row.approvedUnknown) || !row.approvedUnknown.every(entry) ||
      !Array.isArray(row.knownRoots) || !row.knownRoots.every(root) ||
      !Array.isArray(row.knownEntries) || !row.knownEntries.every(entry) ||
      !Array.isArray(row.missingDatabases) || !row.missingDatabases.every(
        (path: unknown) => typeof path === "string" && safeInventoryPath(path) && path.endsWith("/replica.db")) ||
      (row.discardLocalChanges !== undefined && row.discardLocalChanges !== true) ||
      (row.remotePending !== undefined && row.remotePending !== true) ||
      (row.remoteAbandoned !== undefined && row.remoteAbandoned !== true) ||
      (row.remotePending === true && row.remoteAbandoned === true)) throw gated("gate_unavailable");
  const optional = Number(row.discardLocalChanges === true) + Number(row.remotePending === true) +
    Number(row.remoteAbandoned === true);
  if (row.v === 2 && Object.keys(row).length === 9 + optional &&
      row.scope === "orphan_profile" && typeof row.nonce === "string" &&
      /^[0-9a-f]{32}$/.test(row.nonce)) return row as ProfileReplicaLogoutPending;
  if (row.v === 3 && Object.keys(row).length === 10 + optional &&
      row.scope === "inactive_gate" &&
      typeof row.incarnation === "string" && row.incarnation.length > 0 &&
      Number.isSafeInteger(row.lifecycleEpoch) && (row.lifecycleEpoch as number) >= 0) {
    return row as ProfileReplicaLogoutPending;
  }
  // A v1 marker may carry its bound denial epoch, always past the pre-denial epoch.
  const bound = Number(row.deniedEpoch !== undefined);
  if (Object.keys(row).length !== 10 + optional + bound || row.v !== 1 ||
      typeof row.incarnation !== "string" || row.incarnation.length === 0 ||
      !Number.isSafeInteger(row.lifecycleEpoch) || (row.lifecycleEpoch as number) < 0 ||
      typeof row.principalHash !== "string" || !/^[0-9a-f]{64}$/.test(row.principalHash) ||
      (bound === 1 && (!Number.isSafeInteger(row.deniedEpoch) ||
        (row.deniedEpoch as number) <= (row.lifecycleEpoch as number)))) {
    throw gated("gate_unavailable");
  }
  return row as ProfileReplicaLogoutPending;
}

async function readLogoutMarker(path: string): Promise<ProfileReplicaLogoutPending | null> {
  const value = await readJsonFile(path);
  return value === undefined ? null : logoutMarkerOf(value);
}

/** Only a real selected profile or its Linux directory-fd pin may own a wipe. */
async function orphanRoot(profileDir: string, name: "replication" | "replicas"): Promise<string | null> {
  let profile;
  try {
    profile = await lstat(profileDir);
  } catch {
    throw gated("gate_unavailable");
  }
  let pinned = false;
  if (process.platform === "linux" && /^\/proc\/self\/fd\/[1-9]\d*$/.test(profileDir) &&
      profile.isSymbolicLink()) {
    try {
      pinned = (await stat(profileDir)).isDirectory();
    } catch {
      throw gated("gate_unavailable");
    }
  }
  if (!profile.isDirectory() && !pinned) throw gated("gate_unavailable");
  const root = join(profileDir, name);
  let entry;
  try {
    entry = await lstat(root);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (!entry.isDirectory() ||
      await realpath(root) !== join(await realpath(profileDir), name)) {
    throw gated("gate_unavailable");
  }
  return root;
}

/** Without a readable gate, uncertain pending files are treated as local changes. */
async function hasOrphanPending(profileDir: string): Promise<boolean> {
  const root = await orphanRoot(profileDir, "replication");
  if (root === null) return false;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) return true;
    const dir = join(root, entry.name);
    try {
      if (!(await lstat(dir)).isDirectory()) return true;
    } catch {
      return true;
    }
    if (!/^[a-z2-7]{26}$/.test(entry.name)) return true;
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    // Only a verified empty pending index proves no unsynced writes. A missing
    // index, a replica DB, device key, or any future child format is unknown.
    if (children.length !== 2 || children.some((child) =>
      !child.isFile() || (child.name !== "identity.json" && child.name !== "pending.json"))) return true;
    const pendingFile = join(dir, "pending.json");
    let text: string;
    try {
      const pending = await lstat(pendingFile);
      if (!pending.isFile()) return true;
      text = await readFile(pendingFile, "utf8");
    } catch (error) {
      if (isNotFound(error)) return true;
      return true;
    }
    try {
      const identityFile = join(dir, "identity.json");
      if (!(await lstat(identityFile)).isFile()) return true;
      const identity = identityRecordOf(await readJsonFile(identityFile));
      if (identity === undefined || parsePendingState(text, pendingFile, identity).records.length !== 0) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function inventoryIdentity(path: string, dev: bigint, ino: bigint): ProfileReplicaRootIdentity {
  return { path, dev: dev.toString(), ino: ino.toString() };
}

async function inventoryUnknown(
  profileDir: string, relative: string, entries: ProfileReplicaUnknownEntry[],
): Promise<void> {
  const path = join(profileDir, relative);
  const info = await lstat(path, { bigint: true });
  const kind = info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "file";
  entries.push({ ...inventoryIdentity(relative, info.dev, info.ino), kind });
  if (kind === "directory") {
    for (const child of await readdir(path)) await inventoryUnknown(profileDir, `${relative}/${child}`, entries);
  }
}

/**
 * Inventory all unknown descendants of both the CLI legacy and flag-owned roots. `legacyOnly`
 * (another account's logout) never opens, lists or reports the flag-owned `replication/`
 * root: its files are not the caller's to approve and stay byte-identical. `diagnosticFiles`
 * are the CLI-supplied exact names directly under `replication/` that count as known, and
 * only while they are regular files.
 */
async function inspectProfileReplicaLayout(
  profileDir: string, gateReadable: boolean, approvedMarker?: ProfileReplicaLogoutPending, legacyOnly = false,
  diagnosticFiles: readonly string[] = [],
): Promise<ProfileReplicaPreflight> {
  const report: ProfileReplicaPreflight = {
    knownLegacyReplicas: 0, unknownLegacyPaths: [], unknownPaths: [],
    unknownEntries: [], knownRoots: [], knownEntries: [], missingDatabases: [],
  };
  const legacy = await orphanRoot(profileDir, "replicas");
  const active = legacyOnly ? null : await orphanRoot(profileDir, "replication");
  for (const [name, dir] of [["replicas", legacy], ["replication", active]] as const) {
    if (dir === null) continue;
    const info = await lstat(dir, { bigint: true });
    report.knownRoots.push(inventoryIdentity(name, info.dev, info.ino));
  }
  if (legacy !== null) {
    // @ts-ignore — optional replica dependency is checked by replica-contract.test.ts.
    const sqlite = await import("@tinycloud/replica/sqlite") as SqliteRuntime;
    for (const entry of await readdir(legacy, { withFileTypes: true })) {
      const relative = `replicas/${entry.name}`;
      const child = join(legacy, entry.name);
      if (!entry.isDirectory()) {
        await inventoryUnknown(profileDir, relative, report.unknownEntries);
        continue;
      }
      try {
        const layout = await sqlite.inspectSqliteReplicaLayout(child);
        report.knownRoots.push({ path: relative, ...layout.rootIdentity });
        report.unknownEntries.push(...layout.unknownEntries.map((item) => ({
          ...item, path: `${relative}/${item.path}`,
        })));
        report.knownEntries.push(...layout.knownEntries.map((item) => ({
          ...item, path: `${relative}/${item.path}`,
        })));
        if (layout.unknownPaths.length === 0) report.knownLegacyReplicas++;
        if (layout.unknownPaths.includes("replica.db") &&
            !layout.unknownEntries.some((item) => item.path === "replica.db")) {
          report.missingDatabases.push(`${relative}/replica.db`);
        }
      } catch {
        // Failed inspection cannot establish a source-owned layout.
        await inventoryUnknown(profileDir, relative, report.unknownEntries);
      }
    }
  }
  if (active !== null) {
    const cleanOrphan = !gateReadable &&
      (approvedMarker?.v === 2 || !(await hasOrphanPending(profileDir)));
    for (const entry of await readdir(active, { withFileTypes: true })) {
      const relative = `replication/${entry.name}`;
      const dir = join(active, entry.name);
      // Explicitly approved opaque roots remain opaque through replay; a
      // marker must not turn their children into newly trusted control files.
      if (approvedMarker?.approvedUnknown.some((item) => item.path === relative)) {
        await inventoryUnknown(profileDir, relative, report.unknownEntries);
        continue;
      }
      if (gateReadable && diagnosticFiles.includes(entry.name)) {
        const info = await lstat(dir, { bigint: true });
        if (info.isFile()) {
          report.knownEntries.push({ ...inventoryIdentity(relative, info.dev, info.ino), kind: "file" });
          continue;
        }
      }
      if ((!gateReadable && !cleanOrphan) || !entry.isDirectory() || !/^[a-z2-7]{26}$/.test(entry.name)) {
        await inventoryUnknown(profileDir, relative, report.unknownEntries);
        continue;
      }
      const info = await lstat(dir, { bigint: true });
      report.knownRoots.push(inventoryIdentity(relative, info.dev, info.ino));
      const identityPath = join(dir, "identity.json");
      let identity: ReplicationIdentity | undefined;
      try {
        if ((await lstat(identityPath)).isFile()) identity = identityRecordOf(await readJsonFile(identityPath));
      } catch { /* Conservatively inventory the whole identity directory below. */ }
      if (identity === undefined) {
        const approvedRoot = approvedMarker?.knownRoots.find((item) => item.path === relative);
        if (approvedRoot?.dev === info.dev.toString() && approvedRoot.ino === info.ino.toString()) {
          const children = await readdir(dir);
          if (children.length === 0) continue; // Crash after the final source file was unlinked.
          if (children.length === 1 && children[0] === "replicas") {
            const replicasPath = `${relative}/replicas`;
            const replicasDir = join(dir, "replicas");
            const replicasInfo = await lstat(replicasDir, { bigint: true });
            const approvedReplicas = approvedMarker!.knownRoots.find((item) => item.path === replicasPath);
            if (replicasInfo.isDirectory() && !replicasInfo.isSymbolicLink() &&
                approvedReplicas?.dev === replicasInfo.dev.toString() &&
                approvedReplicas.ino === replicasInfo.ino.toString() &&
                (await readdir(replicasDir)).length === 0) {
              report.knownRoots.push(inventoryIdentity(replicasPath, replicasInfo.dev, replicasInfo.ino));
              continue;
            }
          }
        }
        report.knownRoots.pop();
        await inventoryUnknown(profileDir, relative, report.unknownEntries);
        continue;
      }
      for (const child of await readdir(dir, { withFileTypes: true })) {
        const childRelative = `${relative}/${child.name}`;
        const childPath = join(dir, child.name);
        if ((child.name === "identity.json" || child.name === "device.jwk") && child.isFile()) {
          const childInfo = await lstat(childPath, { bigint: true });
          report.knownEntries.push({ ...inventoryIdentity(childRelative, childInfo.dev, childInfo.ino), kind: "file" });
          continue;
        }
        if (child.name === "pending.json" && child.isFile()) {
          try {
            if (parsePendingState(await readFile(childPath, "utf8"), childPath, identity).records.length === 0) {
              const childInfo = await lstat(childPath, { bigint: true });
              report.knownEntries.push({ ...inventoryIdentity(childRelative, childInfo.dev, childInfo.ino), kind: "file" });
              continue;
            }
          } catch { /* An unreadable pending index is never known-safe. */ }
        }
        if (child.name === "replicas" && child.isDirectory()) {
          const replicasInfo = await lstat(childPath, { bigint: true });
          report.knownRoots.push(inventoryIdentity(childRelative, replicasInfo.dev, replicasInfo.ino));
          for (const replicaChild of await readdir(childPath, { withFileTypes: true })) {
            const replicaRelative = `${childRelative}/${replicaChild.name}`;
            if (!replicaChild.isDirectory() || !/^[a-z2-7]{26}$/.test(replicaChild.name)) {
              await inventoryUnknown(profileDir, replicaRelative, report.unknownEntries);
              continue;
            }
            // @ts-ignore — optional replica dependency is checked by replica-contract.test.ts.
            const sqlite = await import("@tinycloud/replica/sqlite") as SqliteRuntime;
            try {
              const layout = await sqlite.inspectSqliteReplicaLayout(join(childPath, replicaChild.name), {
                allowAdapterFence: true,
              });
              report.knownRoots.push({ path: replicaRelative, ...layout.rootIdentity });
              report.unknownEntries.push(...layout.unknownEntries.map((item) => ({
                ...item, path: `${replicaRelative}/${item.path}`,
              })));
              report.knownEntries.push(...layout.knownEntries.map((item) => ({
                ...item, path: `${replicaRelative}/${item.path}`,
              })));
              if (layout.unknownPaths.includes("replica.db") &&
                  !layout.unknownEntries.some((item) => item.path === "replica.db")) {
                report.missingDatabases.push(`${replicaRelative}/replica.db`);
              }
            } catch {
              await inventoryUnknown(profileDir, replicaRelative, report.unknownEntries);
            }
          }
          continue;
        }
        await inventoryUnknown(profileDir, childRelative, report.unknownEntries);
      }
    }
  }
  report.unknownEntries.sort((a, b) => a.path.localeCompare(b.path));
  report.knownEntries.sort((a, b) => a.path.localeCompare(b.path));
  report.knownRoots.sort((a, b) => a.path.localeCompare(b.path));
  report.missingDatabases.sort();
  report.unknownPaths = [...report.unknownEntries.map((entry) => entry.path), ...report.missingDatabases].sort();
  report.unknownLegacyPaths = [...report.unknownPaths];
  return report;
}

function assertApprovedInventory(
  current: ProfileReplicaPreflight,
  approval: Pick<ProfileReplicaPreflight, "unknownEntries" | "knownRoots" | "knownEntries" | "missingDatabases">,
  allowRemoved = false,
): void {
  const approved = new Map(approval.unknownEntries.map((item) => [item.path, item]));
  const known = new Map(approval.knownRoots.map((item) => [item.path, item]));
  const knownFiles = new Map(approval.knownEntries.map((item) => [item.path, item]));
  for (const entry of current.unknownEntries) {
    const expected = approved.get(entry.path);
    if (expected?.kind !== entry.kind || expected.dev !== entry.dev || expected.ino !== entry.ino) {
      throw localChangesRefusal(current.unknownPaths);
    }
  }
  for (const root of current.knownRoots) {
    const expected = known.get(root.path);
    if (expected?.dev !== root.dev || expected.ino !== root.ino) throw localChangesRefusal([root.path]);
  }
  for (const entry of current.knownEntries) {
    if (allowRemoved && entry.kind === "file" &&
        /^(?:replication\/[a-z2-7]{26}\/replicas\/[a-z2-7]{26}|replicas\/[^/]+)\/replica\.db-(?:wal|shm|journal)$/.test(entry.path)) {
      const database = entry.path.replace(/-(?:wal|shm|journal)$/, "");
      const original = knownFiles.get(database);
      const present = current.knownEntries.find((item) => item.path === database);
      // SQLite can create/recreate only these source-owned sidecars after
      // approval. The database and replica root must retain their inode;
      // the remover captures each sidecar's current inode before unlink.
      if (!approved.has(entry.path) && original?.kind === "file" &&
          present?.dev === original.dev && present.ino === original.ino) continue;
    }
    const expected = knownFiles.get(entry.path);
    if (expected?.kind !== entry.kind || expected.dev !== entry.dev || expected.ino !== entry.ino) {
      throw localChangesRefusal([entry.path]);
    }
  }
  for (const path of current.missingDatabases) {
    if (!approval.missingDatabases.includes(path) &&
        !(allowRemoved && knownFiles.get(path)?.kind === "file")) throw localChangesRefusal([path]);
  }
  if (!allowRemoved &&
      (current.unknownEntries.length !== approved.size || current.knownRoots.length !== known.size ||
       current.knownEntries.length !== knownFiles.size ||
       current.missingDatabases.length !== approval.missingDatabases.length)) {
    throw localChangesRefusal(current.unknownPaths);
  }
}

/** Recheck every named component and the approved parent inode immediately before unlink. */
async function assertApprovedParents(
  profileDir: string, marker: ProfileReplicaLogoutPending, path: string,
): Promise<boolean> {
  if (process.platform !== "linux") {
    const absolute = resolve(profileDir);
    let ancestor = parse(absolute).root;
    for (const part of absolute.slice(ancestor.length).split(sep).filter(Boolean)) {
      ancestor = join(ancestor, part);
      const details = await lstat(ancestor, { bigint: true });
      if (!details.isDirectory() || details.isSymbolicLink()) throw localChangesRefusal([path]);
    }
  }
  let relativeParent = "";
  for (const part of path.split("/").slice(0, -1)) {
    relativeParent = relativeParent ? `${relativeParent}/${part}` : part;
    let details;
    try { details = await lstat(join(profileDir, relativeParent), { bigint: true }); }
    catch (error) {
      if (isNotFound(error)) return false; // already removed by an interrupted replay
      throw error;
    }
    const expected = marker.knownRoots.find((root) => root.path === relativeParent) ??
      marker.approvedUnknown.find((item) => item.path === relativeParent && item.kind === "directory");
    if (!details.isDirectory() || details.isSymbolicLink() ||
        expected?.dev !== details.dev.toString() || expected.ino !== details.ino.toString()) {
      throw localChangesRefusal([relativeParent]);
    }
  }
  return true;
}

async function eraseApprovedUnknown(
  profileDir: string, marker: ProfileReplicaLogoutPending, prefix: "replication" | "replicas",
  diagnosticFiles: readonly string[],
): Promise<void> {
  const entries = marker.approvedUnknown.filter((entry) => entry.path.startsWith(`${prefix}/`));
  for (const entry of entries.sort((a, b) => b.path.length - a.path.length)) {
    assertApprovedInventory(await inspectProfileReplicaLayout(profileDir, marker.v !== 2, marker, false, diagnosticFiles), {
      unknownEntries: marker.approvedUnknown, knownRoots: marker.knownRoots,
      knownEntries: marker.knownEntries, missingDatabases: marker.missingDatabases,
    }, true);
    if (!(await assertApprovedParents(profileDir, marker, entry.path))) continue;
    const file = join(profileDir, entry.path);
    let current;
    try { current = await lstat(file, { bigint: true }); }
    catch (error) { if (isNotFound(error)) continue; throw error; }
    const kind = current.isDirectory() ? "directory" : current.isSymbolicLink() ? "symlink" : "file";
    if (kind !== entry.kind || current.dev.toString() !== entry.dev ||
        current.ino.toString() !== entry.ino) throw localChangesRefusal([entry.path]);
    if (process.platform !== "linux" && kind === "symlink") throw localChangesRefusal([entry.path]);
    // Nonrecursive directory removal leaves any unlisted new child untouched.
    if (kind === "directory") await rmdir(file);
    else await rm(file);
  }
}

/** Remove only source-owned control residue and the named diagnostics after every scoped intent has committed. */
async function eraseKnownFlagResidue(
  profileDir: string, marker: ProfileReplicaLogoutPending, diagnosticFiles: readonly string[],
): Promise<void> {
  const diagnostics = new Set(diagnosticFiles.map((name) => `replication/${name}`));
  for (const entry of marker.knownEntries.filter((item) => diagnostics.has(item.path) ||
    /^replication\/[a-z2-7]{26}\/(?:identity\.json|pending\.json|device\.jwk)$/.test(item.path))
    .sort((a, b) => Number(a.path.endsWith("/identity.json")) -
      Number(b.path.endsWith("/identity.json")))) {
    if (!(await assertApprovedParents(profileDir, marker, entry.path))) continue;
    const file = join(profileDir, entry.path);
    let details;
    try { details = await lstat(file, { bigint: true }); }
    catch (error) { if (isNotFound(error)) continue; throw error; }
    if (!details.isFile() || details.dev.toString() !== entry.dev ||
        details.ino.toString() !== entry.ino) throw localChangesRefusal([entry.path]);
    await rm(file);
  }
  const roots = marker.knownRoots.filter((item) =>
    item.path === "replication" || item.path.startsWith("replication/"));
  roots.sort((a, b) => b.path.split("/").length - a.path.split("/").length);
  for (const entry of roots) {
    if (!(await assertApprovedParents(profileDir, marker, entry.path))) continue;
    const path = join(profileDir, entry.path);
    let details;
    try { details = await lstat(path, { bigint: true }); }
    catch (error) { if (isNotFound(error)) continue; throw error; }
    if (!details.isDirectory() || details.isSymbolicLink() ||
        details.dev.toString() !== entry.dev || details.ino.toString() !== entry.ino) {
      throw localChangesRefusal([entry.path]);
    }
    await rmdir(path); // An unlisted child leaves the marker intact.
  }
}


function localChangesRefusal(unknownPaths: readonly string[] = []): Error & { code: "REPLICA_GATED"; gate: string } {
  const error = gated("gate_unavailable");
  error.message = "Unknown or unsynced local replica data may be lost; sync first, or retry logout with --discard-local-changes." +
    (unknownPaths.length === 0 ? "" : ` Unknown: ${unknownPaths.map((path) => JSON.stringify(path)).join(", ")}.`);
  return error;
}

type V1Marker = Extract<ProfileReplicaLogoutPending, { v: 1 }>;
type LogoutGateRead = { state: FileGateState; floorLagging: boolean } | undefined;

/** Active (or deferred-denied) for a principal other than `principalHash`: never this caller's to deny. */
function gateOwnedByAnother(state: FileGateState, principalHash: string): boolean {
  return state.principalHash !== null
    ? state.principalHash !== principalHash
    : state.eraseDeferred && state.deferredPrincipalHash !== principalHash;
}

function isGateUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "REPLICA_GATED" &&
    "gate" in error && error.gate === "gate_unavailable";
}

/**
 * A v1 marker whose bound denial no longer matches the gate: no in-place exit (CONTRACT.md §2).
 * Recovery reports it as `gate_restored` so the CLI can name the route.
 */
function restoredGate(): Error & { code: "REPLICA_GATED"; gate: string; reportCode: "gate_restored" } {
  const error = gated("stamp_stale");
  error.message = RESTORED_GATE_MESSAGE;
  return Object.assign(error, { reportCode: "gate_restored" as const });
}

/** Exported for the CLI, which shows the same route for a recovery report's `gate_restored`. */
export const RESTORED_GATE_MESSAGE =
  "The replica gate does not match this logout's recorded sign-out; an older gate may have been restored. " +
  "Local replicas stay disabled for this profile: switch the default profile first if needed " +
  "(`tc profile switch <other>`), then run `tc profile delete <name>` and sign in again.";

/** A floor-lagging gate this path may not complete. */
function interruptedSignOut(): Error & { code: "REPLICA_GATED"; gate: string } {
  const error = gated("gate_unavailable");
  error.message = "A previous sign-out was interrupted; re-running `tc auth logout` completes it.";
  return error;
}


/** Reject an approval that the named-path remover cannot safely replay. */
function assertSupportedProfileLayout(report: ProfileReplicaPreflight): void {
  if (process.platform === "linux") return;
  const link = report.unknownEntries.find((entry) => entry.kind === "symlink");
  if (link === undefined) return;
  const error = gated("gate_unavailable");
  error.message = `Replica symlink ${JSON.stringify(link.path)} cannot be removed safely on this platform.`;
  throw error;
}

type FileGateState = ReplicaAccountGate & {
  intents: ReplicaPurgeIntent[];
  pendingGenerations: Record<string, number>;
  firstInstall: Record<string, number>;
  grantInstall: Record<string, number>;
  eraseDeferred: boolean;
  deferredPrincipalHash: string | null;
};

type FileGate = {
  readGateSnapshot(profileDir: string): Promise<FileGateState | undefined>;
  /** Past the floor check: a gate whose deny was interrupted reads as `floorLagging`. */
  readLogoutGate(profileDir: string): Promise<{ state: FileGateState; floorLagging: boolean } | undefined>;
  advanceInactiveGate(profileDir: string): Promise<FileGateState>;
  identityHashOf(salt: string, identityKey: string): Promise<string>;
  principalHashOf(salt: string, principal: string): Promise<string>;
  grantInstallHashOf(salt: string, identityKeyHash: string, cid: string): Promise<string>;
  assertGateAccess(profileDir: string, access: ReplicaGateAccess, salt: string): Promise<FileGateState>;
  readFirstInstall(profileDir: string, identityKeyHash: string): Promise<number | undefined>;
  recordFirstInstall(profileDir: string, identityKeyHash: string, atMs: number): Promise<number>;
  recordGrantInstall(profileDir: string, hash: string, atMs: number): Promise<number>;
  establishSessionStamp(profileDir: string, principal: string, o: { siweIssuedAt: number }): Promise<ReplicaSessionStamp>;
  restoreSessionStamp(profileDir: string, principal: string, persisted: ReplicaSessionStamp | undefined): Promise<ReplicaSessionStamp>;
  denyGate(
    profileDir: string,
    input: ReplicaDenyInput,
    collectIntents: (principalHash: string) => Promise<readonly ReplicaPurgeIntent[]>,
    precomputed?: { salt: string; principalHash: string },
    options?: { deferErase?: boolean },
  ): Promise<ReplicaDenyOutcome>;
  deferredGateToken(profileDir: string): Promise<ProfileReplicaDeferredToken | null>;
  resumeDeferredGate(profileDir: string, token: ProfileReplicaDeferredToken): Promise<boolean>;
  clearGateIntent(profileDir: string, id: string): Promise<void>;
};

async function fileGate(): Promise<FileGate> {
  // @ts-ignore — node-sdk's DTS build precedes replica; the structural FileGate above is checked at use.
  return import("@tinycloud/replica/profile-gate") as Promise<FileGate>;
}

function gated(reason: "gate_unavailable" | "not_established" | "stamp_stale" | "purge_pending" | "principal_mismatch"): Error & { code: "REPLICA_GATED"; gate: string } {
  return Object.assign(new Error(`Replica gate refused: ${reason}`), { code: "REPLICA_GATED" as const, gate: reason });
}

async function requiredGuard<T>(guard: MutationGuard | undefined, section: () => Promise<T>): Promise<T> {
  if (guard === undefined) throw gated("gate_unavailable");
  let entered = false;
  try {
    return await guard(async () => {
      entered = true;
      return section();
    });
  } catch (error) {
    if (!entered) throw gated("gate_unavailable");
    throw error;
  }
}

/** A storage-layer failure carrying the replica error-code convention. */
class ReplicaStorageError extends Error {
  readonly code: string;
  readonly cause: unknown;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ReplicaStorageError";
    this.code = code;
    this.cause = options?.cause;
  }
}

function storageError(code: string, action: string, error: unknown): ReplicaStorageError {
  if (error instanceof ReplicaStorageError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ReplicaStorageError(code, `${action} failed: ${detail}`, { cause: error });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * Whether `path` exists. ONLY ENOENT means absent: every other `stat`
 * failure (permissions, I/O) propagates so a purge can never turn a
 * filesystem error into a successful wipe (review: pending protection).
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw storageError("STORAGE_ERROR", `Reading ${path}`, error);
  }
}

/** True for a real directory, false when absent. A symlink or other file type is a replaced root. */
async function realDirectoryExists(path: string): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw storageError("STORAGE_ERROR", `Reading ${path}`, error);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ReplicaStorageError("STORAGE_ERROR", `Refusing the replaced replica path ${path}.`);
  }
  return true;
}

/** `did:key:…#fragment` → the bare principal DID (replica's principalOf). */
function principalOf(did: string): string {
  return principalDid(did);
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function sha256Base32(material: string): string {
  const digest = createHash("sha256").update(material, "utf8").digest();
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out.slice(0, 26);
}

/** `<dir>/<idHash>` — the durable partition of one canonical identity (§6.3). */
function partitionDirOf(root: string, identity: ReplicationIdentity): string {
  return join(root, sha256Base32(replicationIdentityKey(identity)));
}

/**
 * `<idHash>/replicas/<replicaHash>` — one replica per (prefix, device
 * principal). The principal strips any `#fragment` so verification-method
 * spellings of one device share the replica (the `replicaIdOf` precedent).
 */
function replicaHashOf(prefix: string, deviceDid: string): string {
  return sha256Base32(`${prefix}\n${principalOf(deviceDid)}`);
}

/** Directory-fsync boundary: durable renames for the pending store (a test seam lets a unit test observe the code path). */
export type DirSync = (dir: string) => Promise<void>;

/** Write `value` as JSON via temp+fsync+rename+dir-fsync: readers never see a partial file, and the rename survives a crash. */
async function writeJsonAtomic(
  path: string,
  value: unknown,
  dirSync: DirSync = fsyncDir,
): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await openFile(tmp, "w", 0o600);
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
    await handle.close();
    await rename(tmp, path);
    // Crash durability (review): the rename is durable only once the
    // PARENT DIRECTORY is fsynced — without it a power loss can resurrect
    // the previous pending.json. Platforms that cannot fsync a directory
    // skip this rather than failing the write.
    await dirSync(dirname(path));
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // best effort
    }
    await rm(tmp, { force: true }).catch(() => undefined);
    throw storageError("STORAGE_ERROR", `Writing ${path}`, error);
  }
}

/** The errno codes of "this platform cannot fsync a directory". */
const DIR_SYNC_UNSUPPORTED: Record<string, true> = {
  ENOTSUP: true,
  ENOSYS: true,
  EINVAL: true,
  EISDIR: true,
  EPERM: true,
};

/**
 * fsync a directory so renames inside it are crash-durable. Where the
 * platform does not support directory fsync (Windows, some filesystems),
 * this is a documented no-op — the write already happened; pretending the
 * sync ran is the only option short of failing every write.
 */
async function fsyncDir(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await openFile(dir, "r");
    await handle.sync();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (typeof code === "string" && DIR_SYNC_UNSUPPORTED[code] === true) return;
    throw storageError("STORAGE_ERROR", `Syncing ${dir}`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw storageError("STORAGE_ERROR", `Reading ${path}`, error);
  }
}

/** A parsed `{v:1, host, space, principal}` identity record, or undefined for any other shape. */
function identityRecordOf(value: unknown): ReplicationIdentity | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (
    !("host" in value) ||
    !("space" in value) ||
    !("principal" in value) ||
    typeof value.host !== "string" ||
    typeof value.space !== "string" ||
    typeof value.principal !== "string"
  ) {
    return undefined;
  }
  return { host: value.host, space: value.space, principal: value.principal };
}

/** A parsed `{did, jwk}` device record, or undefined for any other shape. */
function deviceRecordOf(value: unknown): ReplicaDevice | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (
    !("did" in value) ||
    !("jwk" in value) ||
    typeof value.did !== "string" ||
    value.jwk === null ||
    typeof value.jwk !== "object"
  ) {
    return undefined;
  }
  return { did: value.did, jwk: value.jwk };
}

function sameIdentity(a: ReplicationIdentity, b: ReplicationIdentity): boolean {
  try {
    const left = canonicalReplicationIdentity(a);
    const right = canonicalReplicationIdentity(b);
    return (
      left.host === right.host &&
      left.space === right.space &&
      left.principal === right.principal
    );
  } catch {
    return false;
  }
}

/**
 * Ensure `dir` exists and `identity.json` names exactly `identity`: written
 * once (atomically) when absent, verified on every open — a file naming a
 * different identity is STORAGE_ERROR, never silently shared (§6.3). Used
 * by the pending store and by `open`, which must not depend on pending
 * state having been requested first.
 */
async function ensurePartitionIdentity(
  dir: string,
  identity: ReplicationIdentity,
  dirSync?: DirSync,
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  } catch (error) {
    throw storageError("STORAGE_ERROR", `Creating ${dir}`, error);
  }
  const file = join(dir, "identity.json");
  const existing = await readJsonFile(file);
  if (existing === undefined) {
    await writeJsonAtomic(file, { v: 1, ...canonicalReplicationIdentity(identity) }, dirSync);
    return;
  }
  const record = identityRecordOf(existing);
  if (record === undefined || !sameIdentity(record, identity)) {
    throw new ReplicaStorageError(
      "STORAGE_ERROR",
      `The partition at ${dir} belongs to a different identity.`,
    );
  }
}

/**
 * Durable identity-scoped pending file. The profile lock covers the gate and
 * both sides of every file snapshot; only updates create a partition.
 */

/**
 * In-process serialization of pending.json read-modify-writes, keyed by the
 * canonical (realpath) file path and shared by every `FilePendingWriteStore`
 * instance — two stores on one partition (or two `update` calls on one
 * store) can never interleave reads and writes, even when they reach the
 * partition through different paths (a symlink and its target agree on one
 * chain). Entries delete themselves once their section is the chain tail,
 * so the map stays bounded by in-flight updates.
 *
 * PRECONDITION: `file` MUST already be the canonical real path of the
 * target — this function does not resolve symlinks itself (path.resolve is
 * lexical and would split the chain exactly like the bug it replaced).
 */
const PENDING_WRITE_LOCKS = new Map<string, Promise<unknown>>();

/** Run `section` after every queued section for `file`; the chain tail never rejects. */
function serializePendingWrite<T>(file: string, section: () => Promise<T>): Promise<T> {
  const tail = PENDING_WRITE_LOCKS.get(file) ?? Promise.resolve();
  const entered = tail.then(section);
  // The tail swallows each section's outcome; the caller still gets it via
  // `entered`.
  const next: Promise<unknown> = entered.then(
    () => undefined,
    () => undefined,
  );
  PENDING_WRITE_LOCKS.set(file, next);
  void next.then(() => {
    if (PENDING_WRITE_LOCKS.get(file) === next) PENDING_WRITE_LOCKS.delete(file);
  });
  return entered;
}

function parsePendingState(text: string, file: string, identity: ReplicationIdentity): PendingWriteState {
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch (error) {
    throw storageError("STORAGE_ERROR", `Parsing ${file}`, error);
  }
  if (
    state === null ||
    typeof state !== "object" ||
    !("v" in state) ||
    state.v !== 2 ||
    !("identity" in state) ||
    !("committedEpoch" in state) ||
    typeof state.committedEpoch !== "number" ||
    !("seq" in state) ||
    typeof state.seq !== "number" ||
    !("records" in state) ||
    !Array.isArray(state.records)
  ) {
    throw new ReplicaStorageError("STORAGE_ERROR", `Pending-write state at ${file} is corrupt.`);
  }
  const storedIdentity = identityRecordOf(state.identity);
  if (storedIdentity === undefined || !sameIdentity(storedIdentity, identity)) {
    throw new ReplicaStorageError("STORAGE_ERROR", `Pending-write state at ${file} belongs to a different identity.`);
  }
  return state as PendingWriteState;
}

export class FilePendingWriteStore implements PendingWriteStore {
  readonly durable = true;
  readonly identity: ReplicationIdentity;
  readonly #dir: string;
  readonly #profileDir: string;
  readonly #guard: MutationGuard | undefined;
  readonly #stamp: ReplicaSessionStamp | undefined;
  readonly #dirSync?: DirSync;
  readonly #logoutPendingFile: string | undefined;
  #generation: number | undefined;
  #canonicalDir: string | undefined;

  constructor(
    identity: ReplicationIdentity,
    dir: string,
    profileDir: string,
    guard: MutationGuard | undefined,
    stamp: ReplicaSessionStamp | undefined,
    dirSync?: DirSync,
    logoutPendingFile?: string,
  ) {
    this.identity = identity;
    this.#dir = dir;
    this.#profileDir = profileDir;
    this.#guard = guard;
    this.#stamp = stamp;
    this.#dirSync = dirSync;
    this.#logoutPendingFile = logoutPendingFile;
  }

  async #withGate<T>(section: (file: string) => Promise<T>): Promise<T> {
    if (this.#stamp === undefined) throw gated("not_established");
    if (this.#guard === undefined) throw gated("gate_unavailable");
    const gate = await fileGate();
    const snapshot = await gate.readGateSnapshot(this.#profileDir);
    if (snapshot === undefined) throw gated("gate_unavailable");
    const [principalHash, identityKeyHash] = await Promise.all([
      gate.principalHashOf(snapshot.salt, this.identity.principal),
      gate.identityHashOf(snapshot.salt, replicationIdentityKey(this.identity)),
    ]);
    const access: ReplicaGateAccess = {
      stamp: this.#stamp, incarnation: snapshot.incarnation, principalHash, identityKeyHash,
    };
    // This stable queue key exists even when the identity partition does not.
    // Canonicalizing the root keeps symlink aliases in the same process chain.
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(dirname(this.#dir));
    } catch (error) {
      if (!isNotFound(error)) throw storageError("STORAGE_ERROR", `Resolving ${dirname(this.#dir)}`, error);
      canonicalRoot = join(await realpath(dirname(dirname(this.#dir))), basename(dirname(this.#dir)));
    }
    const queueKey = join(canonicalRoot, basename(this.#dir), "pending.json");
    return serializePendingWrite(queueKey, () => requiredGuard(this.#guard, async () => {
      assertLogoutClear(this.#logoutPendingFile);
      const before = await gate.assertGateAccess(this.#profileDir, access, snapshot.salt);
      const generation = before.pendingGenerations[identityKeyHash] ?? 0;
      if (this.#generation !== undefined && this.#generation !== generation) {
        throw new ReplicaStorageError("RESET_REQUIRED", "The pending identity was erased; reopen the store.");
      }
      let file = join(this.#dir, "pending.json");
      try {
        file = join(await realpath(this.#dir), "pending.json");
        const recorded = identityRecordOf(await readJsonFile(join(dirname(file), "identity.json")));
        if (recorded === undefined || !sameIdentity(recorded, this.identity)) {
          throw new ReplicaStorageError("STORAGE_ERROR", "The pending partition belongs to a different identity.");
        }
      } catch (error) {
        if (error instanceof ReplicaStorageError) throw error;
        if (!isNotFound(error)) throw storageError("STORAGE_ERROR", `Resolving ${this.#dir}`, error);
      }
      if (this.#canonicalDir !== undefined && dirname(file) !== this.#canonicalDir) {
        throw new ReplicaStorageError("STORAGE_ERROR", "The pending-write partition changed while open.");
      }
      const result = await section(file);
      await gate.assertGateAccess(this.#profileDir, access, snapshot.salt);
      assertLogoutClear(this.#logoutPendingFile);
      this.#generation = generation;
      if (await pathExists(this.#dir)) this.#canonicalDir = await realpath(this.#dir);
      return result;
    }));
  }

  async #readFile(file: string): Promise<PendingWriteState | undefined> {
    try {
      return parsePendingState(await readFile(file, "utf8"), file, this.identity);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error instanceof ReplicaStorageError) throw error;
      throw storageError("STORAGE_ERROR", `Reading ${file}`, error);
    }
  }

  async read(): Promise<PendingWriteState> {
    return this.#withGate(async (file) =>
      (await this.#readFile(file)) ?? { v: 2, identity: this.identity, committedEpoch: 0, seq: 0, records: [] });
  }

  async readExisting(): Promise<PendingWriteState | undefined> {
    return this.#withGate((file) => this.#readFile(file));
  }

  async update<T>(mutate: (state: PendingWriteState) => T): Promise<T> {
    return this.#withGate(async (file) => {
      // Gate and generation have already been checked while locked. No file
      // or directory is created for a denied or stale session.
      await ensurePartitionIdentity(this.#dir, this.identity, this.#dirSync);
      const currentFile = join(await realpath(this.#dir), "pending.json");
      if (this.#canonicalDir !== undefined && dirname(currentFile) !== this.#canonicalDir) {
        throw new ReplicaStorageError("STORAGE_ERROR", "The pending-write partition changed while open.");
      }
      const state = (await this.#readFile(currentFile)) ??
        { v: 2 as const, identity: this.identity, committedEpoch: 0, seq: 0, records: [] };
      const result = await mutate(state);
      await writeJsonAtomic(currentFile, state, this.#dirSync);
      return result;
    });
  }
}

/**
 * The persisted device key of a partition (`device.jwk`): the audience
 * minted-grant UCANs are issued to. Read-only when the file exists —
 * `open(spec)` without `spec.device` creates it on first use.
 */
async function loadOrCreateDevice(
  idDir: string,
  guard: MutationGuard,
  createDevice: () => Promise<ReplicaDevice>,
  dirSync?: DirSync,
): Promise<ReplicaDevice> {
  return guard(async () => {
    try {
      await mkdir(idDir, { recursive: true, mode: 0o700 });
      await chmod(idDir, 0o700);
    } catch (error) {
      throw storageError("STORAGE_ERROR", `Creating ${idDir}`, error);
    }
    const file = join(idDir, "device.jwk");
    const existing = await readJsonFile(file);
    if (existing !== undefined) {
      const device = deviceRecordOf(existing);
      if (device === undefined) {
        throw new ReplicaStorageError(
          "STORAGE_ERROR",
          `The replica device key at ${file} is unreadable; remove the partition or restore it.`,
        );
      }
      return device;
    }
    const device = await createDevice();
    await writeJsonAtomic(file, { did: device.did, jwk: device.jwk }, dirSync);
    return device;
  });
}

/** A session key for the adapter's own replica device, via the WASM session manager. */
async function createDeviceKey(): Promise<ReplicaDevice> {
  const wasm = await import("@tinycloud/node-sdk-wasm");
  const manager = new wasm.TCWSessionManager();
  const keyId = manager.createSessionKey("replica-device") ?? "replica-device";
  const jwkText = manager.jwk(keyId);
  if (jwkText === null || jwkText === undefined) {
    throw new ReplicaStorageError(
      "STORAGE_ERROR",
      "The session manager returned no JWK for the replica device key.",
    );
  }
  return { did: manager.getDID(keyId), jwk: JSON.parse(jwkText) as object };
}

export interface SqliteReplicaStorageOptions {
  /** Root directory holding every identity partition (mode 0700). */
  dir: string;
  /** Mandatory cross-process profile lock; no unlocked replica or pending path. */
  guard?: MutationGuard;
  /** Full path to replica-gate.json; defaults to the directory next to dir. */
  gateFile?: string;
  /** CLI opt-in. Generic SQLite replica stores never infer a session-file layout. */
  logoutPendingFile?: string;
  /**
   * CLI opt-in: exact names of regular diagnostics files directly under `dir` (for example
   * `events.jsonl`). Logout inventory treats only those names, only as regular files (never
   * symlinks), as known and erases them; generic storage infers none.
   */
  diagnosticFiles?: readonly string[];
  /**
   * Profile byte budget (CONTRACT §4, §5). Applies when the open spec carries no
   * `quota.maxBytes`. Absent means unbounded, and the store opens with no admit hook.
   * Bounds the COMMITTED replica blob content of the profile (not the database, WAL, rows or the
   * pending store). Replaced blobs are unlinked only after their page commits, so on-disk bytes
   * can transiently reach `maxBytes` plus the bytes one page replaces. Crash orphans are
   * collected on open and before each admission.
   */
  maxBytes?: number;
  /**
   * Test seam: supply sync transports without WASM/KVService. Production
   * builds invoke through `kvSyncTransport` like the CLI's `grantTransports`.
   * @internal
   */
  transportFor?: (
    grant: GrantRecord,
    spec: KVReplicaSpec,
    device: ReplicaDevice,
  ) => ReplicaTransport;
  /**
   * Test seam: device-key creation without WASM.
   * @internal
   */
  createDevice?: () => Promise<ReplicaDevice>;
  /**
   * Test seam: observe/replace the parent-directory fsync that makes each
   * atomic JSON rename crash-durable. Defaults to `fsyncDir`.
   * @internal
   */
  dirSync?: DirSync;
}

const SYNC_LEASE_TTL_MS = 120_000;
const FENCE_FILE = "fence.json";

/** The persisted per-replica fence; 0 until the first successful sync. */
async function readFence(replicaDir: string): Promise<number> {
  const fence = await readJsonFile(join(replicaDir, FENCE_FILE));
  return typeof fence === "object" &&
    fence !== null &&
    "syncedThroughEpoch" in fence &&
    typeof fence.syncedThroughEpoch === "number"
    ? fence.syncedThroughEpoch
    : 0;
}

/** The newest grant on the store, or null — a pending install supersedes the active one. */
function newestGrantInfo(
  replica: ReplicaRuntime,
  record: GrantRecord | null,
  pending: GrantRecord | null,
  spec: KVReplicaSpec,
  install: SqliteGrantInstall | null,
): ReplicaGrantInfo | null {
  if (record === null) return null;
  const parsed = replica.parseUcanGrant(record.bytes);
  return {
    cid: record.cid,
    parentCid: parsed.prf[0] ?? null,
    expiresAt: record.expiresAt === null ? null : record.expiresAt * 1000,
    state: pending !== null && record === pending ? "pending" : "active",
    unconstrained: ucanAttUnconstrainedFor(parsed.att, spec.space, spec.prefix),
    ...(install === null ? {} : install),
  };
}

class SqliteReplicaHandle implements KVReplicaHandle {
  readonly spec: KVReplicaSpec;
  readonly deviceDid: string;
  readonly replicaId: string;
  readonly #device: ReplicaDevice;
  readonly #store: SqliteReplicaStore;
  readonly #replicaDir: string;
  readonly #replica: ReplicaRuntime;
  readonly #guard: MutationGuard;
  readonly #read: <T>(section: (snapshot: SqliteReplicaStore, syncedThroughEpoch: number) => Promise<T>, withFence?: boolean) => Promise<T>;
  readonly #policy: (at: number, recordFirst: boolean) => Promise<SqliteGrantPolicy | null>;
  readonly #recordGrantInstall: (cid: string, at: number) => Promise<number>;
  readonly #dirSync?: DirSync;
  /** The replica row generation this handle opened under — the durable fence a purge commits past (browser-parity wipe). */
  readonly #generation: number;
  /** The inode of `replica.db` at open — a directory recreated in place is a different replica. */
  readonly #ino: number | undefined;
  readonly #transportOverride: SqliteReplicaStorageOptions["transportFor"];
  #closed = false;
  readonly #inFlight = new Set<{ promise: Promise<unknown>; abort: () => void }>();
  #transportFactory: Promise<(grant: GrantRecord) => ReplicaTransport> | undefined;

  constructor(input: {
    spec: KVReplicaSpec;
    replicaId: string;
    device: ReplicaDevice;
    store: SqliteReplicaStore;
    replicaDir: string;
    replica: ReplicaRuntime;
    guard: MutationGuard;
    read: <T>(section: (snapshot: SqliteReplicaStore, syncedThroughEpoch: number) => Promise<T>, withFence?: boolean) => Promise<T>;
    policy: (at: number, recordFirst: boolean) => Promise<SqliteGrantPolicy | null>;
    recordGrantInstall: (cid: string, at: number) => Promise<number>;
    transportFor?: SqliteReplicaStorageOptions["transportFor"];
    dirSync?: DirSync;
    generation: number;
    ino: number | undefined;
  }) {
    this.spec = input.spec;
    this.replicaId = input.replicaId;
    this.#device = input.device;
    this.deviceDid = input.device.did;
    this.#store = input.store;
    this.#replicaDir = input.replicaDir;
    this.#replica = input.replica;
    this.#guard = input.guard;
    this.#read = input.read;
    this.#policy = input.policy;
    this.#recordGrantInstall = input.recordGrantInstall;
    this.#transportOverride = input.transportFor;
    this.#dirSync = input.dirSync;
    this.#generation = input.generation;
    this.#ino = input.ino;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new this.#replica.ReplicaError(
        this.#replica.ReplicaErrorCode.CLOSED,
        "The replica handle is closed.",
      );
    }
  }

  /**
   * The purge fence (review): `purge()` bumps the replica row's generation
   * before the directory is removed — the same wipe-then-tombstone contract
   * the browser store's purge commits. A handle opened before the purge is
   * fenced on its next call, in two durable ways: the live row's generation
   * no longer matches the one this handle opened under, and once the
   * directory is gone (or recreated under another inode) `stat` reports it.
   * Only ENOENT means "purged"; other `stat` errors are STORAGE_ERROR.
   */
  async #assertLive(): Promise<void> {
    this.#assertOpen();
    try {
      const stats = await stat(join(this.#replicaDir, "replica.db"));
      if (this.#ino !== undefined && stats.ino !== this.#ino) {
        throw new this.#replica.ReplicaError(
          this.#replica.ReplicaErrorCode.RESET_REQUIRED,
          "The replica was recreated; open it again to continue.",
        );
      }
    } catch (error) {
      if (isNotFound(error)) {
        throw new this.#replica.ReplicaError(
          this.#replica.ReplicaErrorCode.RESET_REQUIRED,
          "The replica was purged; open it again to continue.",
        );
      }
      throw error;
    }
    const state = await this.#store.open();
    if (state !== null && state.generation !== this.#generation) {
      throw new this.#replica.ReplicaError(
        this.#replica.ReplicaErrorCode.RESET_REQUIRED,
        "The replica was purged or reopened; open it again to continue.",
      );
    }
  }

  /**
   * Transports that each invoke with exactly one grant and this handle's
   * device key against the identity's pinned host — the CLI's
   * `grantTransports` (replica.ts), with `spec.fetch` for the graph-scoped
   * fetch. Built lazily on the first sync so read-only handles never load
   * the WASM binding.
   */
  async #transports(): Promise<(grant: GrantRecord) => ReplicaTransport> {
    if (this.#transportOverride !== undefined) {
      const override = this.#transportOverride;
      const spec = this.spec;
      const device = this.#device;
      return (grant) => override(grant, spec, device);
    }
    this.#transportFactory ??= (async () => {
      const wasm = await import("@tinycloud/node-sdk-wasm");
      const kvSyncTransport = this.#replica.kvSyncTransport;
      const spec = this.spec;
      const device = this.#device;
      const fetch = spec.fetch ?? globalThis.fetch.bind(globalThis);
      return (grant: GrantRecord): ReplicaTransport => {
        const context = new ServiceContext({
          invoke: wasm.invoke,
          invokeAny: wasm.invokeAny,
          fetch,
          hosts: [spec.identity.host],
        });
        const kv = new KVService({});
        kv.initialize(context);
        context.registerService("kv", kv);
        context.setSession({
          delegationHeader: { Authorization: new TextDecoder().decode(grant.bytes) },
          delegationCid: grant.cid,
          spaceId: spec.space,
          verificationMethod: device.did,
          jwk: device.jwk,
        });
        return kvSyncTransport(kv);
      };
    })();
    return this.#transportFactory;
  }

  async #assertEffective(snapshot: SqliteReplicaStore): Promise<void> {
    const state = await snapshot.open();
    if (state?.grant === undefined || state.grant === null) return;
    const installed = await snapshot.getGrantInstall(state.grant.cid);
    if (installed === null || !Number.isSafeInteger(installed.effectiveExpiresAt) ||
        Date.now() >= installed.effectiveExpiresAt || Date.now() >= installed.consentDeadline) {
      throw new ReplicaStorageError("GRANT_EXPIRED", "The replica grant's effective lifetime has expired.");
    }
  }

  /** Refuse an expired installed grant before constructing transports or fetching pages. */
  async #assertSyncEffective(): Promise<void> {
    const state = await this.#store.open();
    const selected = state?.pendingGrant ?? state?.grant;
    if (selected === undefined || selected === null) return;
    const installed = await this.#store.getGrantInstall(selected.cid);
    const now = Date.now();
    if (installed === null || !Number.isSafeInteger(installed.effectiveExpiresAt) ||
        now >= installed.effectiveExpiresAt || now >= installed.consentDeadline) {
      throw new ReplicaStorageError("GRANT_EXPIRED", "The replica grant's effective lifetime has expired.");
    }
  }

  async get(key: string): Promise<LocalGetResult> {
    return this.#read(async (snapshot, syncedThroughEpoch) => {
    this.#assertOpen();
    await this.#assertEffective(snapshot);
    const result = await new this.#replica.Replica({ store: snapshot }).get(key);
    await this.#assertEffective(snapshot);
    const meta: LocalReadMeta = {
      asOf: result.meta.asOf,
      coverage: result.meta.coverage,
      authority: result.meta.authority,
      syncedThroughEpoch,
    };
    switch (result.status) {
      case "present":
        return {
          status: "present",
          key: result.key,
          value: result.value,
          etag: result.etag,
          metadata: result.metadata,
          meta,
        };
      case "content_missing":
        return {
          status: "content_missing",
          key: result.key,
          etag: result.etag,
          metadata: result.metadata,
          meta,
        };
      default:
        return { status: result.status, key: result.key, meta };
    }
    }, true);
  }

  async list(options: { prefix: string; after?: string; limit?: number }): Promise<LocalListResult> {
    return this.#read(async (snapshot, syncedThroughEpoch) => {
    this.#assertOpen();
    await this.#assertEffective(snapshot);
    const result = await new this.#replica.Replica({ store: snapshot }).list({
      prefix: options.prefix,
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    await this.#assertEffective(snapshot);
    return {
      keys: result.entries.map((entry: ReplicaListEntry) => entry.key),
      meta: {
        asOf: result.meta.asOf,
        coverage: result.meta.coverage,
        authority: result.meta.authority,
        syncedThroughEpoch,
      },
    };
    }, true);
  }

  /**
   * The newest installed grant — the pending one when a not-yet-promoted
   * install exists — with `parentCid` = signed `prf[0]` and `unconstrained`
   * computed from the signed `att` (replica's own grantCovers ignores
   * caveats, so the adapter computes it, §2.1). A constrained installed
   * grant is still reported (unconstrained: false) and never reused.
   */
  async grant(): Promise<ReplicaGrantInfo | null> {
    return this.#read(async (snapshot) => {
    this.#assertOpen();
    const state = await snapshot.open();
    if (state === null) return null;
    const selected = state.pendingGrant ?? state.grant;
    const install = selected === null ? null : await snapshot.getGrantInstall(selected.cid);
    return newestGrantInfo(
      this.#replica,
      state.pendingGrant ?? state.grant,
      state.pendingGrant,
      this.spec,
      install,
    );
    });
  }

  async installGrant(ucan: string): Promise<ReplicaGrantInfo> {
    return this.#guard(async () => {
    await this.#assertLive();
    const parsed = this.#replica.parseUcanGrant(ucan);
    const state = await this.#store.open();
    if (state === null) {
      throw new this.#replica.ReplicaError(
        this.#replica.ReplicaErrorCode.NOT_FOUND,
        "The replica has not been created.",
      );
    }
    this.#replica.assertGrantInstallable(parsed, {
      deviceDid: principalOf(this.#device.did),
      space: this.spec.space,
      prefix: this.spec.prefix,
      now: Date.now(),
    });
    // Reuse-rule enforcement on every grant path: a caveated get/sync grant
    // can never serve this replica, so it must never be installed.
    if (!ucanAttUnconstrainedFor(parsed.att, this.spec.space, this.spec.prefix)) {
      throw new this.#replica.ReplicaError(
        this.#replica.ReplicaErrorCode.GRANT_NOT_COVERING,
        "The grant's get or sync coverage carries caveats; re-mint instead of installing it.",
      );
    }
    const now = Date.now();
    const policy = await this.#policy(now, true);
    if (policy === null || now >= policy.consentDeadline) {
      throw new ReplicaStorageError("CONSENT_EXPIRED", "The replica's consent window has expired.");
    }
    // The profile gate survives targeted partition purge; persist the CID
    // floor before the SQLite install so a crash cannot refresh its TTL.
    const installedAt = await this.#recordGrantInstall(parsed.cid, now);
    const installed = await this.#store.installGatedGrant(parsed, { ...policy, at: installedAt });
    return newestGrantInfo(this.#replica, parsed, parsed, this.spec, installed)!;
    });
  }

  async sync(options: { signal: AbortSignal; syncStartEpoch: number }): Promise<LocalSyncResult> {
    await this.#guard(async () => {
      await this.#assertLive();
      await this.#assertSyncEffective();
    });
    const transportFor = await this.#transports();
    const abort = new AbortController();
    options.signal.throwIfAborted();
    const onAbort = (): void => abort.abort(options.signal.reason);
    options.signal.addEventListener("abort", onAbort, { once: true });
    const engine = new this.#replica.Replica({
      store: this.#store,
      transportFor,
      ...(this.spec.contentFetch === undefined ? {} : { contentFetch: this.spec.contentFetch }),
    });
    const running = engine.sync({ signal: abort.signal });
    const registration = { promise: running, abort: () => abort.abort() };
    this.#inFlight.add(registration);
    try {
      const report = await running;
      // The per-replica fence (amendment §1): the identity's committedEpoch
      // captured at this sync's start, persisted only on success, atomically.
      await this.#guard(() =>
        writeJsonAtomic(
          join(this.#replicaDir, FENCE_FILE),
          { v: 1, syncedThroughEpoch: options.syncStartEpoch },
          this.#dirSync,
        ),
      );
      return {
        status: "synced",
        pages: report.pages,
        changes: report.changes,
        deleted: report.deleted,
        fetched: report.fetched,
        contentMissing: report.contentMissing,
        coverage: report.coverage,
        syncedThroughEpoch: options.syncStartEpoch,
      };
    } catch (error) {
      if (this.#replica.isReplicaError(error, this.#replica.ReplicaErrorCode.BUSY)) {
        return { status: "busy" };
      }
      throw error;
    } finally {
      this.#inFlight.delete(registration);
      options.signal.removeEventListener("abort", onAbort);
    }
  }

  async status(): Promise<LocalReplicaStatus> {
    return this.#read(async (snapshot, syncedThroughEpoch) => {
    this.#assertOpen();
    const engine = new this.#replica.Replica({ store: snapshot });
    const status = await engine.status();
    // The fence was captured before the SQLite snapshot began.
    const state = await snapshot.open();
    const selected = state?.pendingGrant ?? state?.grant ?? null;
    const selectedInstall = selected === null ? null : await snapshot.getGrantInstall(selected.cid);
    const activeRecord = state?.grant ?? null;
    const activeInstall = activeRecord === null ? null : await snapshot.getGrantInstall(activeRecord.cid);
    const grant =
      state === null
        ? null
        : newestGrantInfo(
            this.#replica,
            state.pendingGrant ?? state.grant,
            state.pendingGrant,
            this.spec,
            selectedInstall,
          );
    return {
      coverage: status.coverage,
      lastSyncAt: status.lastSyncAt,
      syncedThroughEpoch,
      authority: activeRecord !== null && (activeInstall === null ||
          Date.now() >= activeInstall.effectiveExpiresAt || !Number.isSafeInteger(activeInstall.effectiveExpiresAt))
        ? { state: "expired", expiresAt: activeInstall === null ? null : new Date(activeInstall.effectiveExpiresAt).toISOString() }
        : { state: status.authority.state, expiresAt: status.authority.expiresAt },
      grant,
      counts: status.counts,
      bytes: status.bytes,
      lastError: status.lastError,
    };
    }, true);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const sync of this.#inFlight) sync.abort();
    await Promise.allSettled([...this.#inFlight].map((sync) => sync.promise));
    await this.#store.close();
  }
}

/** Directory entries, or none when the path is absent or not a directory. */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return [];
    }
    throw error;
  }
}

/**
 * Content bytes across every replica in the profile at `root` (`<root>/<partition>/replicas/<replica>`).
 * Blobs are stored per replica directory, so a hash held by two replicas counts twice, matching disk use.
 */
/**
 * Remove crash orphans (blobs no committed row references) from every replica in the profile.
 * Callers hold the profile guard, which every writer holds across its blob write and commit, so an
 * unreferenced blob cannot belong to an in-flight write.
 */
async function collectProfileOrphans(root: string, collectOrphans: (dir: string) => Promise<number>): Promise<void> {
  for (const partition of await listDir(root)) {
    const replicasDir = join(root, partition, "replicas");
    for (const replicaName of await listDir(replicasDir)) {
      await collectOrphans(join(replicasDir, replicaName));
    }
  }
}

async function profileContentBytes(root: string, contentBytes: (dir: string) => Promise<number>): Promise<number> {
  let total = 0;
  for (const partition of await listDir(root)) {
    const replicasDir = join(root, partition, "replicas");
    for (const replicaName of await listDir(replicasDir)) {
      total += await contentBytes(join(replicasDir, replicaName));
    }
  }
  return total;
}

export function createSqliteReplicaStorage(
  options: SqliteReplicaStorageOptions,
): KVReplicaStorage & { lifecycle: ReplicaLifecycleGate & ProfileReplicaPurge } {
  const root = options.dir;
  const profileDir = dirname(options.gateFile ?? join(dirname(root), REPLICA_GATE_FILE));
  const diagnosticFiles = [...(options.diagnosticFiles ?? [])];
  for (const name of diagnosticFiles) {
    // A plain file name that can never be an identity directory or reach outside the root.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || /^[a-z2-7]{26}$/.test(name)) {
      throw new TypeError(`Invalid replication diagnostics file name ${JSON.stringify(name)}.`);
    }
  }
  const inspectLayout = (
    gateReadable: boolean, approvedMarker?: ProfileReplicaLogoutPending, legacyOnly = false,
  ) => inspectProfileReplicaLayout(profileDir, gateReadable, approvedMarker, legacyOnly, diagnosticFiles);
  const guard = options.guard;
  const createDevice = options.createDevice ?? createDeviceKey;
  const heldLock = new AsyncLocalStorage<boolean>();
  let visibleStamp: ReplicaSessionStamp | undefined;
  let visiblePrincipalHash: string | undefined;
  let checkedGate: { ino: bigint; mtimeNs: bigint; size: bigint; incarnation: string; epoch: number; principalHash: string | null } | undefined;

  async function profileSection<T>(section: () => Promise<T>): Promise<T> {
    if (heldLock.getStore() === true) return section();
    return requiredGuard(guard, () => heldLock.run(true, section));
  }

  async function guarded<T>(
    principal: string,
    stamp: ReplicaSessionStamp | undefined,
    identity: ReplicationIdentity | undefined,
    partitionId: string | undefined,
    section: () => Promise<T>,
  ): Promise<T> {
    if (stamp === undefined) throw gated("not_established");
    if (guard === undefined) throw gated("gate_unavailable");
    const gate = await fileGate();
    const snapshot = await gate.readGateSnapshot(profileDir);
    if (snapshot === undefined) throw gated("gate_unavailable");
    const [principalHash, identityKeyHash] = await Promise.all([
      gate.principalHashOf(snapshot.salt, principal),
      identity === undefined ? Promise.resolve(undefined) : gate.identityHashOf(snapshot.salt, replicationIdentityKey(identity)),
    ]);
    return profileSection(async () => {
      assertLogoutClear(options.logoutPendingFile);
      await gate.assertGateAccess(profileDir, {
        stamp, incarnation: snapshot.incarnation, principalHash, identityKeyHash, partitionId,
      }, snapshot.salt);
      const result = await section();
      assertLogoutClear(options.logoutPendingFile);
      return result;
    });
  }

  async function readGated<T>(
    spec: KVReplicaSpec,
    partitionId: string,
    store: SqliteReplicaStore,
    replicaDir: string,
    generation: number,
    section: (snapshot: SqliteReplicaStore, syncedThroughEpoch: number) => Promise<T>,
    withFence = false,
  ): Promise<T> {
    if (spec.stamp === undefined) throw gated("not_established");
    const gate = await fileGate();
    const snapshot = await gate.readGateSnapshot(profileDir);
    if (snapshot === undefined) throw gated("gate_unavailable");
    const [principalHash, identityKeyHash] = await Promise.all([
      gate.principalHashOf(snapshot.salt, spec.identity.principal),
      gate.identityHashOf(snapshot.salt, replicationIdentityKey(spec.identity)),
    ]);
    const access: ReplicaGateAccess = {
      stamp: spec.stamp, incarnation: snapshot.incarnation, principalHash, identityKeyHash, partitionId,
    };
    const path = options.gateFile ?? join(profileDir, REPLICA_GATE_FILE);
    let checked: { ino: bigint; size: bigint; mtimeNs: bigint } | undefined;
    const checkGate = async (): Promise<void> => {
      assertLogoutClear(options.logoutPendingFile);
      let before;
      try {
        before = await stat(path, { bigint: true });
      } catch {
        throw gated("gate_unavailable");
      }
      if (checked?.ino === before.ino && checked.size === before.size && checked.mtimeNs === before.mtimeNs) return;
      const checkedState = await gate.assertGateAccess(profileDir, access, snapshot.salt);
      if (spec.grantPolicy?.consentAnchor === null && checkedState.firstInstall[identityKeyHash] === undefined) {
        const installed = await store.open();
        if (installed !== null && (installed.grant !== null || installed.pendingGrant !== null)) throw gated("gate_unavailable");
      }
      let after;
      try {
        after = await stat(path, { bigint: true });
      } catch {
        throw gated("gate_unavailable");
      }
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
        throw gated("gate_unavailable");
      }
      checked = after;
    };
    if (withFence) await checkGate();
    // A fence written after the SQLite snapshot starts belongs to newer rows.
    // Capture it first; a concurrent sync can only make this value conservative.
    const fence = withFence ? await readFence(replicaDir) : 0;
    return store.readTransaction(generation, checkGate, (sqliteSnapshot) => section(sqliteSnapshot, fence));
  }

  async function identityDirs(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      // Only a missing root means no partitions; any later ENOENT is a concurrent change.
      if (isNotFound(error)) return [];
      throw storageError("STORAGE_ERROR", `Listing ${root}`, error);
    }
    try {
      const marker = await readLogoutMarker(join(profileDir, REPLICA_LOGOUT_PENDING_FILE));
      if (marker !== null) {
        const inventory = await inspectLayout(true);
        assertApprovedInventory(inventory, {
          unknownEntries: marker.approvedUnknown, knownRoots: marker.knownRoots,
          knownEntries: marker.knownEntries, missingDatabases: marker.missingDatabases,
        }, true);
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory() ||
            !/^[a-z2-7]{26}$/.test(entry.name)) {
          if (marker?.approvedUnknown.some((item) =>
              item.path === `replication/${entry.name}` &&
              (entry.isDirectory() ? item.kind === "directory" : entry.isSymbolicLink() ?
                item.kind === "symlink" : item.kind === "file"))) continue;
          // The CLI's named diagnostics log, only as a regular file, is not a partition. One the
          // appender rotated away since the listing is gone, not a reason to list nothing.
          if (diagnosticFiles.includes(entry.name)) {
            const info = await lstat(join(root, entry.name)).catch((error: unknown) => {
              if (isNotFound(error)) return null;
              throw error;
            });
            if (info === null || info.isFile()) continue;
          }
          throw new ReplicaStorageError("STORAGE_ERROR", `Unknown identity partition at ${root}.`);
        }
      }
      return entries.filter((entry) => entry.isDirectory() &&
        /^[a-z2-7]{26}$/.test(entry.name) &&
        !marker?.approvedUnknown.some((item) =>
          item.path === `replication/${entry.name}` && item.kind === "directory"))
        .map((entry) => join(root, entry.name));
    } catch (error) {
      throw storageError("STORAGE_ERROR", `Listing ${root}`, error);
    }
  }

  async function collectIntents(principalHash: string, salt: string): Promise<ReplicaPurgeIntent[]> {
    const gate = await fileGate();
    const intents: ReplicaPurgeIntent[] = [];
    for (const idDir of await identityDirs()) {
      const identity = identityRecordOf(await readJsonFile(join(idDir, "identity.json")));
      if (identity === undefined) throw new ReplicaStorageError("STORAGE_ERROR", `Missing identity at ${idDir}.`);
      if (await gate.principalHashOf(salt, identity.principal) !== principalHash) continue;
      const identityKeyHash = await gate.identityHashOf(salt, replicationIdentityKey(identity));
      const recordedAt = Date.now();
      if (await pathExists(join(idDir, "pending.json")) || await pathExists(join(idDir, "device.jwk"))) {
        intents.push({ id: `pending:${identityKeyHash}`, kind: "pending", identityKeyHash, principalHash, recordedAt });
      }
      const replicasDir = join(idDir, "replicas");
      let entries;
      try {
        entries = await readdir(replicasDir, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) continue;
        throw storageError("STORAGE_ERROR", `Listing ${replicasDir}`, error);
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!/^[a-z2-7]{26}$/.test(entry.name)) {
          throw new ReplicaStorageError("STORAGE_ERROR", `Unrecognized replica partition at ${replicasDir}.`);
        }
        const partitionId = `${identityKeyHash}:${entry.name}`;
        intents.push({ id: partitionId, kind: "partition", partitionId, principalHash, recordedAt });
      }
    }
    return intents;
  }

  /** Preserve even superseded CIDs before legacy DBs are purged or recomputed. Call with the profile lock held. */
  async function retainGrantInstalls(
    gate: FileGate,
    gateState: FileGateState,
    identityKeyHash: string,
    store: SqliteReplicaStore,
  ): Promise<void> {
    for (const { cid, installedAt } of await store.grantInstallTimes()) {
      const key = await gate.grantInstallHashOf(gateState.salt, identityKeyHash, cid);
      await gate.recordGrantInstall(profileDir, key, installedAt);
    }
  }

  /** A v2 marker must be durable before an unreadable old gate can be unlinked. */
  async function removeCorruptOrphanGate(gate: FileGate): Promise<void> {
    const path = join(profileDir, REPLICA_GATE_FILE);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw gated("gate_unavailable");
    let corrupt = false;
    try {
      await gate.readGateSnapshot(profileDir);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error &&
          error.code === "REPLICA_GATED" && "gate" in error && error.gate === "gate_unavailable") {
        corrupt = true;
      } else throw error;
    }
    if (!corrupt) throw gated("stamp_stale");
    const current = await lstat(path, { bigint: true });
    if (current.dev !== before.dev || current.ino !== before.ino ||
        current.mtimeNs !== before.mtimeNs || current.size !== before.size) throw gated("stamp_stale");
    await rm(path);
    await (options.dirSync ?? fsyncDir)(profileDir);
    if (await gate.readGateSnapshot(profileDir) !== undefined) throw gated("stamp_stale");
  }

  /** Logout reads the gate past its floor; an unreadable or lost gate is `corrupt`. */
  async function readLogoutState(gate: FileGate): Promise<{ read: LogoutGateRead; corrupt: boolean }> {
    try {
      return { read: await gate.readLogoutGate(profileDir), corrupt: false };
    } catch (error) {
      if (isGateUnavailable(error)) return { read: undefined, corrupt: true };
      throw error;
    }
  }

  /**
   * Validate a v1 marker under the profile lock. Its bound denial is checked by equality with
   * `deniedEpoch`, never `lifecycleEpoch + 1`. An unbound marker binds once to a denial that a
   * crash left unrecorded; otherwise the gate must still be the one the marker was written for:
   * active (when `active` allows it) or floor-lagging after an interrupted deny, which `deny`
   * completes (`deferred` for a remote-pending marker) and then binds. The rebound marker and
   * the current gate are returned; anything else refuses without mutation.
   */
  async function validateV1(
    gate: FileGate, path: string, marker: V1Marker, read: LogoutGateRead,
    mode: { active: boolean; deny?: "deferred" | "ordinary"; denyActive?: boolean; acceptLagging?: boolean },
  ): Promise<{ marker: V1Marker; state: FileGateState; active: boolean }> {
    if (read === undefined || read.state.incarnation !== marker.incarnation) throw gated("stamp_stale");
    const { state, floorLagging } = read;
    if (marker.deniedEpoch !== undefined) {
      if (floorLagging || !v1Denied(marker, state, marker.deniedEpoch)) throw restoredGate();
      return { marker, state, active: false };
    }
    if (!floorLagging && state.principalHash === null && state.lifecycleEpoch > marker.lifecycleEpoch &&
        (marker.remotePending
          ? state.eraseDeferred && state.deferredPrincipalHash === marker.principalHash
          : !state.eraseDeferred && state.deferredPrincipalHash === null)) {
      return { marker: await bindDeniedEpoch(path, marker, state.lifecycleEpoch), state, active: false };
    }
    if (state.principalHash !== marker.principalHash || state.lifecycleEpoch !== marker.lifecycleEpoch) {
      throw gated("stamp_stale");
    }
    if (!floorLagging && !mode.denyActive) {
      if (!mode.active) throw gated("stamp_stale");
      return { marker, state, active: true };
    }
    // The marker's own interrupted deny: a caller that denies next may accept it as is.
    if (mode.acceptLagging) return { marker, state, active: true };
    if (mode.deny === undefined) throw interruptedSignOut();
    const denied = await gate.denyGate(profileDir, { reason: "sign_out", principal: "" },
      (principalHash) => collectIntents(principalHash, state.salt),
      { salt: state.salt, principalHash: marker.principalHash },
      { deferErase: mode.deny === "deferred" });
    if (denied.status !== "denied") throw gated("gate_unavailable");
    const after = await gate.readLogoutGate(profileDir);
    if (after === undefined || after.floorLagging || !v1Denied(marker, after.state, denied.lifecycleEpoch)) {
      throw gated("gate_unavailable");
    }
    return { marker: await bindDeniedEpoch(path, marker, denied.lifecycleEpoch), state: after.state, active: false };
  }

  /** The marker's own denial: null principal at `epoch`, by the marker's principal when deferred. */
  function v1Denied(marker: V1Marker, state: FileGateState, epoch: number): boolean {
    return state.incarnation === marker.incarnation && state.principalHash === null &&
      state.lifecycleEpoch === epoch && (
        state.deferredPrincipalHash === marker.principalHash ||
        (!marker.remotePending && !state.eraseDeferred && state.deferredPrincipalHash === null));
  }

  /** The one-time v1 `deniedEpoch` rewrite; a bound marker is never rebound. */
  async function bindDeniedEpoch(path: string, marker: V1Marker, deniedEpoch: number): Promise<V1Marker> {
    if (marker.deniedEpoch !== undefined) throw gated("stamp_stale");
    const bound: V1Marker = { ...marker, deniedEpoch };
    await writeJsonAtomic(path, bound, options.dirSync);
    return bound;
  }

  /**
   * Remote markers: v2 needs no replacement gate, v3 its exact inactive epoch, v1 its bound
   * (or once-bindable) denial; `mode` admits an active or interrupted v1 gate where allowed.
   */
  async function validatedRemoteMarker(
    path: string, marker: ProfileReplicaLogoutPending, principal: string,
    mode: { active: boolean; deny?: "deferred" | "ordinary" },
  ): Promise<{ marker: ProfileReplicaLogoutPending; state: FileGateState | undefined }> {
    if (marker.principalDigest !== logoutPrincipalDigest(principal)) throw gated("principal_mismatch");
    const gate = await fileGate();
    const { read, corrupt } = await readLogoutState(gate);
    if (corrupt) throw gated("gate_unavailable");
    if (marker.v === 2) {
      if (read !== undefined) throw gated("stamp_stale");
      return { marker, state: undefined };
    }
    if (read === undefined || read.state.incarnation !== marker.incarnation) throw gated("stamp_stale");
    if (marker.v === 3) {
      if (read.floorLagging || read.state.lifecycleEpoch !== marker.lifecycleEpoch ||
          read.state.principalHash !== null || read.state.eraseDeferred) throw gated("stamp_stale");
      return { marker, state: read.state };
    }
    if (marker.principalHash !== await gate.principalHashOf(read.state.salt, principal)) {
      throw gated("principal_mismatch");
    }
    const checked = await validateV1(gate, path, marker, read, mode);
    return { marker: checked.marker, state: checked.state };
  }
  /** Read-only inventory of the current layout; an unreadable gate refuses. */
  async function currentLayout(): Promise<ProfileReplicaPreflight> {
    const { read, corrupt } = await readLogoutState(await fileGate());
    if (corrupt) throw gated("gate_unavailable");
    const report = await inspectLayout(read !== undefined);
    assertSupportedProfileLayout(report);
    return report;
  }

  async function commitPlainAbandon(
    path: string, marker: ProfileReplicaLogoutPending, report: ProfileReplicaPreflight,
    discardLocalChanges: boolean,
  ): Promise<ProfileReplicaLogoutPending> {
    const { remotePending: _, discardLocalChanges: _oldDiscard, ...previous } = marker;
    const abandoned: ProfileReplicaLogoutPending = {
      ...previous, remoteAbandoned: true,
      approvedUnknown: discardLocalChanges ? report.unknownEntries : [],
      knownRoots: report.knownRoots, knownEntries: report.knownEntries,
      missingDatabases: report.missingDatabases,
      ...(discardLocalChanges ? { discardLocalChanges: true } : {}),
    };
    await writeJsonAtomic(path, abandoned, options.dirSync);
    return abandoned;
  }


  /**
   * Flips this process's view before its first await; deferral only for sign-out (N3). Reads
   * past the deny floor, so an interrupted deny is completed. In the same guarded section a
   * committed sign-out denial binds the logout principal's unbound v1 marker to its epoch:
   * remote-pending markers only to a deferred denial, plain ones only to an ordinary one.
   */
  function deny(input: ReplicaDenyInput & { reason: "sign_out" }, options: { deferErase: true }): Promise<ProfileReplicaDeferredDenyOutcome>;
  function deny(input: ReplicaDenyInput, options?: { deferErase?: false }): Promise<ReplicaDenyOutcome>;
  function deny(
    input: ReplicaDenyInput, denyOptions?: { deferErase?: boolean },
  ): Promise<ReplicaDenyOutcome | ProfileReplicaDeferredDenyOutcome> {
    const deferErase = denyOptions?.deferErase === true;
    if (deferErase && input.reason !== "sign_out") {
      throw new TypeError("Deferred erase is only available for sign-out.");
    }
    visibleStamp = undefined;
    visiblePrincipalHash = undefined;
    checkedGate = undefined;
    return (async (): Promise<ReplicaDenyOutcome | ProfileReplicaDeferredDenyOutcome> => {
      try {
        const gate = await fileGate();
        return await profileSection(async () => {
          const snapshot = (await gate.readLogoutGate(profileDir))?.state;
          const precomputed = snapshot === undefined ? undefined : {
            salt: snapshot.salt, principalHash: await gate.principalHashOf(snapshot.salt, input.principal),
          };
          const result = await gate.denyGate(profileDir, input,
            async (principalHash) => {
              if (snapshot === undefined) throw gated("gate_unavailable");
              return collectIntents(principalHash, snapshot.salt);
            },
            precomputed, { deferErase });
          if (result.status !== "denied") return result;
          if (input.reason === "sign_out" && snapshot !== undefined && precomputed !== undefined) {
            const path = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
            const marker = await readLogoutMarker(path);
            if (marker?.v === 1 && marker.deniedEpoch === undefined &&
                marker.incarnation === snapshot.incarnation && marker.principalHash === precomputed.principalHash &&
                (marker.remotePending === true) === deferErase) {
              await bindDeniedEpoch(path, marker, result.lifecycleEpoch);
            }
          }
          if (!deferErase) return result;
          const resumeToken = await gate.deferredGateToken(profileDir);
          if (resumeToken === null || resumeToken.deniedEpoch !== result.lifecycleEpoch) {
            return { status: "unguarded", code: "gate_unavailable" };
          }
          return { ...result, resumeToken };
        });
      } catch (error) {
        return { status: "unguarded", code: typeof error === "object" && error !== null &&
          "code" in error && typeof error.code === "string" ? error.code : "gate_unavailable" };
      }
    })();
  }

  const lifecycle: ReplicaLifecycleGate & ProfileReplicaPurge = {
    kind: "file",
    async recover({ signal }) {
      try {
        return await lifecycle.erasePending({ signal });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
          ? error.code : "STORAGE_ERROR";
        let remaining = 0;
        try {
          remaining = (await (await fileGate()).readGateSnapshot(profileDir))?.intents.length ?? 0;
        } catch {
          // Failed inspection is already represented by the failed gate entry.
        }
        return { erased: [], failed: [{ id: "gate", code }], remaining };
      }
    },
    async establishSessionStamp(principal, { consentAnchor }) {
      if (consentAnchor?.source === "first_install" || !Number.isSafeInteger(consentAnchor?.at) || consentAnchor.at < 0) {
        throw gated("not_established");
      }
      const gate = await fileGate();
      const stamp = await profileSection(async () => {
        assertLogoutClear(options.logoutPendingFile);
        return gate.establishSessionStamp(profileDir, principal, { siweIssuedAt: consentAnchor.at });
      });
      const state = await gate.readGateSnapshot(profileDir);
      if (state === undefined) throw gated("gate_unavailable");
      visiblePrincipalHash = await gate.principalHashOf(state.salt, principal);
      checkedGate = undefined;
      visibleStamp = stamp;
      return stamp;
    },
    async restoreSessionStamp(principal, persisted) {
      const gate = await fileGate();
      const stamp = await profileSection(async () => {
        assertLogoutClear(options.logoutPendingFile);
        return gate.restoreSessionStamp(profileDir, principal, persisted);
      });
      const state = await gate.readGateSnapshot(profileDir);
      if (state === undefined) throw gated("gate_unavailable");
      visiblePrincipalHash = await gate.principalHashOf(state.salt, principal);
      checkedGate = undefined;
      visibleStamp = stamp;
      return stamp;
    },
    async activationAllowed(next) {
      if (guard === undefined) return false;
      try {
        const gate = await fileGate();
        return await profileSection(async () => {
          assertLogoutClear(options.logoutPendingFile);
          const state = await gate.readGateSnapshot(profileDir);
          return state !== undefined && !state.eraseDeferred && state.intents.length === 0 &&
            state.principalHash !== null && state.principalHash === await gate.principalHashOf(state.salt, next);
        });
      } catch {
        return false;
      }
    },
    checkDelivery(stamp) {
      if (guard === undefined || visiblePrincipalHash === undefined) return { status: "gated", gate: "gate_unavailable" };
      try {
        assertLogoutClear(options.logoutPendingFile);
      } catch {
        return { status: "gated", gate: "gate_unavailable" };
      }
      if (!stamp || visibleStamp?.incarnation !== stamp.incarnation ||
          visibleStamp.lifecycleEpoch !== stamp.lifecycleEpoch) {
        return { status: "gated", gate: "stamp_stale" };
      }
      try {
        const path = options.gateFile ?? join(profileDir, REPLICA_GATE_FILE);
        const stats = statSync(path, { bigint: true });
        if (checkedGate === undefined || checkedGate.ino !== stats.ino ||
            checkedGate.mtimeNs !== stats.mtimeNs || checkedGate.size !== stats.size) {
          const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
          if (typeof raw.incarnation !== "string" || !Number.isSafeInteger(raw.lifecycleEpoch) ||
              (raw.principalHash !== null && typeof raw.principalHash !== "string") ||
              !Array.isArray(raw.intents)) {
            return { status: "gated", gate: "gate_unavailable" };
          }
          checkedGate = {
            ino: stats.ino, mtimeNs: stats.mtimeNs, size: stats.size,
            incarnation: raw.incarnation, epoch: raw.lifecycleEpoch as number,
            principalHash: raw.principalHash,
          };
        }
      } catch {
        return { status: "gated", gate: "gate_unavailable" };
      }
      if (checkedGate.incarnation !== stamp.incarnation || checkedGate.epoch !== stamp.lifecycleEpoch) {
        return { status: "gated", gate: "stamp_stale" };
      }
      return checkedGate.principalHash === visiblePrincipalHash
        ? { status: "allow" }
        : { status: "gated", gate: "principal_mismatch" };
    },
    consentDeadline() { return null; },
    deliverable(stamp) { return lifecycle.checkDelivery(stamp).status === "allow"; },
    deny,
    deferredErase() {
      return profileSection(async () => (await fileGate()).deferredGateToken(profileDir));
    },
    async resumeDeferredErase(token, { signal }) {
      signal.throwIfAborted();
      await profileSection(async () => (await fileGate()).resumeDeferredGate(profileDir, token));
      return lifecycle.erasePending({ signal });
    },
    async preflightLogout({ principal, discardLocalChanges = false }) {
      return profileSection(async () => {
        const marker = await readLogoutMarker(join(profileDir, REPLICA_LOGOUT_PENDING_FILE));
        const gate = await fileGate();
        const { read, corrupt } = await readLogoutState(gate);
        const state = read?.state;
        let otherAccount = false;
        if (state !== undefined) {
          const hash = await gate.principalHashOf(state.salt, principal);
          otherAccount = gateOwnedByAnother(state, hash);
          if (marker?.v === 1 && marker.principalHash !== hash) throw gated("principal_mismatch");
        }
        // Another account's gate: only the profile's legacy mirror is inspected, listed or approved.
        const report = await inspectLayout(state !== undefined, undefined, otherAccount);
        assertSupportedProfileLayout(report);
        if (!discardLocalChanges && (report.unknownPaths.length > 0 || (corrupt && !otherAccount) ||
            (!otherAccount && (state === undefined || (state.principalHash === null && !state.eraseDeferred)) &&
              await hasOrphanPending(profileDir)))) {
          throw localChangesRefusal(report.unknownPaths);
        }
        return report;
      });
    },
    async prepareLogoutPending({ principal, approval, discardLocalChanges = false, remotePending }) {
      const gate = await fileGate();
      return profileSection(async () => {
        const path = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
        const previous = await readLogoutMarker(path);
        const { read, corrupt: corruptGate } = await readLogoutState(gate);
        let state = read?.state;
        const principalHash = state === undefined ? undefined : await gate.principalHashOf(state.salt, principal);
        const otherAccount = state !== undefined && gateOwnedByAnother(state, principalHash!);
        let report = await inspectLayout(state !== undefined, undefined, otherAccount);
        assertSupportedProfileLayout(report);
        // The approval is the inventory the caller displayed; it must match exactly.
        const assertApproved = (current: ProfileReplicaPreflight) => {
          assertApprovedInventory(current, approval);
          if (approval.knownLegacyReplicas !== current.knownLegacyReplicas ||
              JSON.stringify(approval.unknownPaths) !== JSON.stringify(current.unknownPaths) ||
              JSON.stringify(approval.unknownLegacyPaths) !== JSON.stringify(current.unknownLegacyPaths)) {
            throw localChangesRefusal(current.unknownPaths);
          }
        };
        assertApproved(report);
        if (otherAccount) {
          // "Logout by another account": no marker and no denial of the active account's gate.
          if (previous !== null) throw gated("principal_mismatch");
          if (!discardLocalChanges && report.unknownPaths.length > 0) throw localChangesRefusal(report.unknownPaths);
          return null;
        }
        if (!discardLocalChanges && (report.unknownPaths.length > 0 || corruptGate ||
            ((state === undefined || (state.principalHash === null && !state.eraseDeferred)) &&
              await hasOrphanPending(profileDir)))) {
          throw localChangesRefusal(report.unknownPaths);
        }
        if (previous !== null) {
          // An existing marker is returned unchanged (apart from the one-time v1 binding)
          // or refused; prepareLogoutPending never rewrites it.
          if (previous.principalDigest !== logoutPrincipalDigest(principal)) throw gated("principal_mismatch");
          // The marker has no original corrupt-gate identity: never unlink a file
          // first observed only after that marker was committed.
          if (corruptGate) throw gated("gate_unavailable");
          let current: ProfileReplicaLogoutPending = previous;
          if (previous.v === 2) {
            if (read !== undefined) throw gated("stamp_stale");
          } else if (read === undefined || previous.incarnation !== read.state.incarnation) {
            throw gated("stamp_stale");
          } else if (previous.v === 3) {
            if (read.floorLagging || read.state.lifecycleEpoch !== previous.lifecycleEpoch ||
                read.state.principalHash !== null || read.state.eraseDeferred) throw gated("stamp_stale");
          } else {
            if (previous.principalHash !== principalHash) throw gated("principal_mismatch");
            current = (await validateV1(gate, path, previous, read, { active: true, acceptLagging: true })).marker;
          }
          assertApprovedInventory(report, {
            unknownEntries: current.approvedUnknown, knownRoots: current.knownRoots,
            knownEntries: current.knownEntries, missingDatabases: current.missingDatabases,
          });
          if (current.remotePending !== remotePending || current.remoteAbandoned) {
            throw gated("gate_unavailable");
          }
          return current;
        }
        if (state?.eraseDeferred) throw gated("stamp_stale");
        if (read?.floorLagging) {
          // An interrupted deny without a marker: complete it here as an ordinary deny (deferral
          // comes only from a durable marker), re-inspect, then fence with a v3 marker below.
          if (state!.principalHash === null) {
            state = await gate.advanceInactiveGate(profileDir);
          } else {
            const salt = state!.salt;
            const denied = await gate.denyGate(profileDir, { reason: "sign_out", principal },
              (hash) => collectIntents(hash, salt), { salt, principalHash: principalHash! });
            if (denied.status !== "denied") throw gated("gate_unavailable");
            state = (await gate.readGateSnapshot(profileDir))!;
          }
          report = await inspectLayout(true);
          assertSupportedProfileLayout(report);
          assertApproved(report);
        }
        if (state === undefined && report.knownRoots.length === 0 && !corruptGate) return null;
        if (state !== undefined && state.principalHash === null && !state.eraseDeferred &&
            report.knownRoots.length === 0 && state.intents.length === 0) return null;
        const remoteState: ProfileReplicaRemoteLogoutState = remotePending ? { remotePending: true } : {};
        const approvalFields = {
          principalDigest: logoutPrincipalDigest(principal),
          approvalSalt: randomBytes(16).toString("hex"),
          approvedUnknown: discardLocalChanges ? report.unknownEntries : [],
          knownRoots: report.knownRoots, knownEntries: report.knownEntries,
          missingDatabases: report.missingDatabases,
          ...(discardLocalChanges ? { discardLocalChanges: true as const } : {}),
          ...remoteState,
        };
        let marker: ProfileReplicaLogoutPending;
        if (state === undefined) {
          marker = { v: 2, scope: "orphan_profile", nonce: randomBytes(16).toString("hex"),
            ...approvalFields };
        } else if (state.principalHash === null) {
          marker = { v: 3, scope: "inactive_gate", incarnation: state.incarnation,
            lifecycleEpoch: state.lifecycleEpoch, ...approvalFields };
        } else {
          // The logout principal's own active gate always gets a v1 marker, even with no
          // roots or intents: recovery denies it before credentials go.
          marker = { v: 1, incarnation: state.incarnation,
            lifecycleEpoch: state.lifecycleEpoch, principalHash: principalHash!, ...approvalFields };
        }
        await writeJsonAtomic(path, marker, options.dirSync);
        visibleStamp = undefined;
        visiblePrincipalHash = undefined;
        checkedGate = undefined;
        if (corruptGate) await removeCorruptOrphanGate(gate);
        return marker;
      });
    },
    async completeRemoteLogout({ principal }) {
      return profileSection(async () => {
        const path = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
        const marker = await readLogoutMarker(path);
        // Only a remote-pending marker transitions; abandoned or cleanup-ready refuses unchanged.
        if (marker === null || marker.remotePending !== true) throw gated("gate_unavailable");
        const checked = await validatedRemoteMarker(path, marker, principal, { active: false });
        const { remotePending: _, ...complete } = checked.marker;
        await writeJsonAtomic(path, complete, options.dirSync);
        return complete;
      });
    },
    async remotePendingLogout({ principal }) {
      return profileSection(async () => {
        const path = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
        const marker = await readLogoutMarker(path);
        if (marker === null || marker.remotePending !== true) return false;
        await validatedRemoteMarker(path, marker, principal, { active: false });
        return true;
      });
    },
    async abandonRemoteLogout({ principal, approval, discardLocalChanges = false }) {
      return profileSection(async () => {
        const path = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
        const marker = await readLogoutMarker(path);
        if (marker === null || marker.remotePending !== true) throw gated("gate_unavailable");
        if (marker.principalDigest !== logoutPrincipalDigest(principal)) throw gated("principal_mismatch");
        // Inventory and approval are compared before any gate completion or marker rewrite.
        const report = await currentLayout();
        if (storedInventoryChanged(marker, report)) throw changedInventoryRefusal(marker, principal, report);
        assertApprovedInventory(report, approval);
        if (approval.knownLegacyReplicas !== report.knownLegacyReplicas ||
            JSON.stringify(approval.unknownPaths) !== JSON.stringify(report.unknownPaths) ||
            JSON.stringify(approval.unknownLegacyPaths) !== JSON.stringify(report.unknownLegacyPaths) ||
            (!discardLocalChanges && report.unknownPaths.length > 0)) {
          throw localChangesRefusal(report.unknownPaths);
        }
        // Exactly one v1 classification: deferred-denied (bound now if a crash left it
        // unbound), active and never started (abandoned without a deny; recovery's ordinary
        // deny fences it), or floor-lagging (completed as the deferred deny it was, then bound).
        const checked = await validatedRemoteMarker(path, marker, principal, { active: true, deny: "deferred" });
        return commitPlainAbandon(path, checked.marker, report, discardLocalChanges);
      });
    },
    async approveChangedPlainLogout({ principal, approval, discardLocalChanges, inventoryApprovalToken: token }) {
      return profileSection(async () => {
        const path = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
        const marker = await readLogoutMarker(path);
        if (marker === null || marker.remotePending !== true) throw gated("gate_unavailable");
        if (marker.principalDigest !== logoutPrincipalDigest(principal)) throw gated("principal_mismatch");
        const report = await currentLayout();
        if (!storedInventoryChanged(marker, report)) throw gated("gate_unavailable");
        const entries = approvalEntries(report);
        if (discardLocalChanges !== true || typeof token !== "string" ||
            !/^[0-9a-f]{32}$/.test(token) || token !== inventoryApprovalToken(marker, principal, entries)) {
          throw changedInventoryRefusal(marker, principal, report, entries);
        }
        assertApprovedInventory(report, approval);
        if (approval.knownLegacyReplicas !== report.knownLegacyReplicas ||
            JSON.stringify(approval.unknownPaths) !== JSON.stringify(report.unknownPaths) ||
            JSON.stringify(approval.unknownLegacyPaths) !== JSON.stringify(report.unknownLegacyPaths)) {
          throw changedInventoryRefusal(marker, principal, report, entries);
        }
        const checked = await validatedRemoteMarker(path, marker, principal, { active: true, deny: "deferred" });
        return commitPlainAbandon(path, checked.marker, report, true);
      });
    },
    async reapproveLogoutPending({ principal, approval }) {
      return profileSection(async () => {
        const path = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
        const marker = await readLogoutMarker(path);
        if (marker === null || marker.remotePending) throw gated("gate_unavailable");
        if (marker.principalDigest !== logoutPrincipalDigest(principal)) throw gated("principal_mismatch");
        const report = await currentLayout();
        assertApprovedInventory(report, approval);
        if (JSON.stringify(report.unknownPaths) !== JSON.stringify(approval.unknownPaths)) {
          throw localChangesRefusal(report.unknownPaths);
        }
        const checked = await validatedRemoteMarker(path, marker, principal, { active: true });
        // Previously approved paths may have been removed by interrupted cleanup;
        // only the fresh list is authorized on this retry.
        const amended: ProfileReplicaLogoutPending = {
          ...checked.marker, approvedUnknown: report.unknownEntries,
          knownRoots: report.knownRoots, knownEntries: report.knownEntries,
          missingDatabases: report.missingDatabases,
          ...(report.unknownPaths.length > 0 ? { discardLocalChanges: true as const } : {}),
        };
        await writeJsonAtomic(path, amended, options.dirSync);
        return amended;
      });
    },
    async recoverLogoutPending({ signal, clearCredentials, eraseLegacyReplicas }) {
      const path = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
      const failure = async (error: unknown): Promise<ReplicaEraseReport> => ({
        erased: [],
        failed: [{ id: "logout", code: typeof error === "object" && error !== null &&
          "reportCode" in error && typeof error.reportCode === "string"
          ? error.reportCode
          : typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
            ? error.code === "REPLICA_GATED" && "gate" in error && typeof error.gate === "string"
              ? error.gate : error.code
            : "STORAGE_ERROR" }],
        remaining: Math.max(1, (await lifecycle.pendingPurge().catch(() => [])).length),
      });
      try {
        const prepared = await profileSection(async (): Promise<
          { marker: ProfileReplicaLogoutPending } | { report: ReplicaEraseReport }
        > => {
          const marker = await readLogoutMarker(path);
          if (marker === null) {
            const state = await (await fileGate()).readGateSnapshot(profileDir);
            return { report: { erased: [], failed: [], remaining: state?.intents.length ?? 0 } };
          }
          signal.throwIfAborted();
          if (marker.remotePending) throw gated("gate_unavailable");
          const gate = await fileGate();
          const { read, corrupt } = await readLogoutState(gate);
          if (corrupt) throw gated("gate_unavailable");
          let current: ProfileReplicaLogoutPending = marker;
          let state = read?.state;
          if (marker.v === 2) {
            if (read !== undefined) throw gated("stamp_stale");
          } else if (read === undefined || read.state.incarnation !== marker.incarnation) {
            throw gated("stamp_stale");
          } else if (marker.v === 3) {
            if (read.floorLagging || read.state.principalHash !== null || read.state.eraseDeferred ||
                read.state.lifecycleEpoch !== marker.lifecycleEpoch) throw gated("stamp_stale");
          } else {
            // Before credentials go, an active (or interrupted) v1 gate gets its full ordinary
            // denial, bound in this section; an already-denied one is checked by `deniedEpoch`.
            const checked = await validateV1(gate, path, marker, read,
              { active: true, deny: "ordinary", denyActive: true });
            current = checked.marker;
            state = checked.state;
          }
          await clearCredentials();
          for (const file of ["session.json", "key.json"]) {
            try { await lstat(join(profileDir, file)); throw gated("gate_unavailable"); }
            catch (error) { if (!isNotFound(error)) throw error; }
          }
          await (options.dirSync ?? fsyncDir)(profileDir);
          const report = await inspectLayout(state !== undefined, marker);
          assertApprovedInventory(report, { unknownEntries: marker.approvedUnknown,
            knownRoots: marker.knownRoots, knownEntries: marker.knownEntries,
            missingDatabases: marker.missingDatabases }, true);
          if (!marker.discardLocalChanges && report.unknownEntries.length > 0) {
            throw localChangesRefusal(report.unknownPaths);
          }
          if (current.v === 1 && state?.eraseDeferred) {
            await gate.resumeDeferredGate(profileDir, {
              deniedEpoch: current.deniedEpoch!, principalHash: current.principalHash,
            });
          }
          await eraseLegacyReplicas({ discardLocalChanges: marker.discardLocalChanges === true,
            approvedUnknown: marker.approvedUnknown, knownRoots: marker.knownRoots,
            knownEntries: marker.knownEntries, missingDatabases: marker.missingDatabases });
          try { await lstat(join(profileDir, "replicas")); throw gated("gate_unavailable"); }
          catch (error) { if (!isNotFound(error)) throw error; }
          return { marker: current };
        });
        if ("report" in prepared) return prepared.report;
        const marker = prepared.marker;
        let erased: ReplicaEraseReport = { erased: [], failed: [], remaining: 0 };
        if (marker.v !== 2) {
          erased = await eraseGateIntents({ signal }, marker);
          if (erased.failed.length > 0 || erased.remaining > 0) return erased;
        }
        await profileSection(async () => {
          const pending = await readLogoutMarker(path);
          if (pending === null || pending.remotePending || JSON.stringify(pending) !== JSON.stringify(marker)) {
            throw gated("stamp_stale");
          }
          const gate = await fileGate();
          const state = await gate.readGateSnapshot(profileDir);
          if (marker.v === 2 && state !== undefined) throw gated("stamp_stale");
          const report = await inspectLayout(state !== undefined, marker);
          assertApprovedInventory(report, { unknownEntries: marker.approvedUnknown,
            knownRoots: marker.knownRoots, knownEntries: marker.knownEntries,
            missingDatabases: marker.missingDatabases }, true);
          await eraseApprovedUnknown(profileDir, marker, "replication", diagnosticFiles);
          await eraseKnownFlagResidue(profileDir, marker, diagnosticFiles);
          const finalReport = await inspectLayout(state !== undefined, marker);
          assertApprovedInventory(finalReport, { unknownEntries: marker.approvedUnknown,
            knownRoots: marker.knownRoots, knownEntries: marker.knownEntries,
            missingDatabases: marker.missingDatabases }, true);
          if (finalReport.unknownPaths.length > 0) throw localChangesRefusal(finalReport.unknownPaths);
          if (finalReport.knownRoots.length > 0) throw gated("gate_unavailable");
          await (options.dirSync ?? fsyncDir)(profileDir);
          await rm(path);
          await (options.dirSync ?? fsyncDir)(profileDir);
        });
        return erased;
      } catch (error) {
        return failure(error);
      }
    },
    async pendingPurge() {
      const gate = await fileGate();
      return (await gate.readGateSnapshot(profileDir))?.intents ?? [];
    },
    erasePending({ signal }): Promise<ReplicaEraseReport> {
      return eraseGateIntents({ signal });
    },
  };

  async function eraseGateIntents(
    { signal }: { signal: AbortSignal }, marker?: ProfileReplicaLogoutPending,
  ): Promise<ReplicaEraseReport> {
    const gate = await fileGate();
    const erased: string[] = [];
    const failed: Array<{ id: string; code: string }> = [];
    const intents = await lifecycle.pendingPurge();
    try {
      if (marker === undefined) assertLogoutClear(options.logoutPendingFile);
      else if (marker.remotePending || await readLogoutMarker(join(profileDir, REPLICA_LOGOUT_PENDING_FILE)) === null) {
        throw gated("gate_unavailable");
      }
    } catch {
      return { erased, failed: [{ id: "logout", code: "REPLICA_GATED" }], remaining: Math.max(1, intents.length) };
    }
    const held = await profileSection(() => gate.readGateSnapshot(profileDir));
    if (held?.eraseDeferred) return { erased, failed, remaining: held.intents.length, deferred: true };
    for (const intent of intents) {
      signal.throwIfAborted();
      try {
        await profileSection(async () => {
          if (marker === undefined) assertLogoutClear(options.logoutPendingFile);
          else {
            const pending = await readLogoutMarker(join(profileDir, REPLICA_LOGOUT_PENDING_FILE));
            if (pending === null || pending.remotePending || JSON.stringify(pending) !== JSON.stringify(marker)) {
              throw gated("gate_unavailable");
            }
            assertApprovedInventory(await inspectLayout(true), {
              unknownEntries: marker.approvedUnknown, knownRoots: marker.knownRoots,
              knownEntries: marker.knownEntries, missingDatabases: marker.missingDatabases,
            }, true);
          }
          const state = await gate.readGateSnapshot(profileDir);
          if (state?.eraseDeferred) return;
          if (!state?.intents.some((queued) => queued.id === intent.id)) return;
          let idDir: string | undefined;
          for (const dir of await identityDirs()) {
            const identity = identityRecordOf(await readJsonFile(join(dir, "identity.json")));
            if (identity === undefined) throw new ReplicaStorageError("STORAGE_ERROR", `Missing identity at ${dir}.`);
            const hash = await gate.identityHashOf(state.salt, replicationIdentityKey(identity));
            if (intent.kind === "pending" ? hash === intent.identityKeyHash : intent.partitionId.startsWith(`${hash}:`)) {
              idDir = dir;
              break;
            }
          }
          if (intent.kind === "pending") {
            if (intent.id !== `pending:${intent.identityKeyHash}`) throw gated("gate_unavailable");
            if (idDir !== undefined) {
              for (const name of ["pending.json", "device.jwk"]) {
                const file = join(idDir, name);
                let info;
                try { info = await lstat(file, { bigint: true }); }
                catch (error) { if (isNotFound(error)) continue; throw error; }
                if (!info.isFile()) throw gated("gate_unavailable");
                if (marker !== undefined) {
                  const relative = `replication/${basename(idDir)}/${name}`;
                  const expected = [...marker.knownEntries, ...marker.approvedUnknown].find(
                    (item) => item.path === relative);
                  if (expected?.kind !== "file" || expected.dev !== info.dev.toString() ||
                      expected.ino !== info.ino.toString()) throw localChangesRefusal([relative]);
                }
                await rm(file);
              }
              await fsyncDir(idDir);
            }
          } else {
            if (!/^[0-9a-f]{64}:[a-z2-7]{26}$/.test(intent.partitionId) || intent.id !== intent.partitionId) {
              throw gated("gate_unavailable");
            }
            if (idDir !== undefined) {
              const replicaDir = join(idDir, "replicas", intent.partitionId.slice(65));
              // A replaced identity or replicas directory refuses; the intent stays queued.
              let dirInfo;
              if (await realDirectoryExists(join(idDir, "replicas"))) {
                try { dirInfo = await lstat(replicaDir, { bigint: true }); }
                catch (error) { if (!isNotFound(error)) throw error; }
              }
              if (dirInfo !== undefined) {
                const relative = `replication/${basename(idDir)}/replicas/${basename(replicaDir)}`;
                const expectedRoot = marker?.knownRoots.find((item) => item.path === relative);
                if (!dirInfo.isDirectory() || (marker !== undefined &&
                    (expectedRoot?.dev !== dirInfo.dev.toString() ||
                     expectedRoot.ino !== dirInfo.ino.toString()))) throw localChangesRefusal([relative]);
                const approvedUnknown = marker?.approvedUnknown.filter(
                  (item) => item.path.startsWith(`${relative}/`)).map(
                  (item) => ({ ...item, path: item.path.slice(relative.length + 1) }));
                const expectedKnown = marker?.knownEntries.filter(
                  (item) => item.path.startsWith(`${relative}/`)).map(
                  (item) => ({ ...item, path: item.path.slice(relative.length + 1) }));
                // @ts-ignore — optional replica dependency is checked by replica-contract.test.ts.
                const sqlite = await import("@tinycloud/replica/sqlite") as SqliteRuntime;
                if (!(await pathExists(join(replicaDir, "replica.db")))) {
                  const layout = await sqlite.inspectSqliteReplicaLayout(replicaDir, { allowAdapterFence: true });
                  if (!layout.unknownPaths.includes("replica.db") ||
                      layout.unknownEntries.some((item) => item.path === "replica.db") ||
                      layout.unknownPaths.some((path) =>
                        path !== "replica.db" && !approvedUnknown?.some((item) => item.path === path))) {
                    throw localChangesRefusal([relative]);
                  }
                  // A formerly approved database inode may already be gone after a crash.
                  // Only the still-present, re-inventoried files are passed to exact removal.
                  await sqlite.removeSqliteReplicaLayout(replicaDir, { approvedUnknown,
                    expectedKnown: layout.knownEntries, expectedRoot, allowAdapterFence: true,
                    allowMissingDatabase: true });
                } else {
                  let store: SqliteReplicaStore | undefined;
                  try {
                    store = await sqlite.SqliteReplicaStore.open(replicaDir, { create: false, guard: profileSection });
                    const row = await store.open();
                    if (row !== null) {
                      const lease = await store.acquireSyncLease(SYNC_LEASE_TTL_MS);
                      if (lease === null) throw gated("gate_unavailable");
                      try {
                        if (row.revoked === null) await store.reset(lease, "purged");
                        let deletionKnown = expectedKnown;
                        if (marker !== undefined) {
                          // Opening/resetting SQLite may create its own WAL sidecars after
                          // preflight. The database and every other known inode stay pinned.
                          const current = await sqlite.inspectSqliteReplicaLayout(replicaDir, {
                            allowAdapterFence: true,
                          });
                          if (current.rootIdentity.dev !== expectedRoot?.dev ||
                              current.rootIdentity.ino !== expectedRoot.ino) throw localChangesRefusal([relative]);
                          const approved = new Map(expectedKnown?.map((entry) => [entry.path, entry]));
                          for (const entry of current.knownEntries) {
                            const prior = approved.get(entry.path);
                            if (prior?.kind === entry.kind && prior.dev === entry.dev && prior.ino === entry.ino) continue;
                            if (entry.kind !== "file" ||
                                !["replica.db-wal", "replica.db-shm", "replica.db-journal"].includes(entry.path)) {
                              throw localChangesRefusal([`${relative}/${entry.path}`]);
                            }
                          }
                          deletionKnown = current.knownEntries;
                        }
                        await store.destroy(lease, { approvedUnknown, expectedKnown: deletionKnown,
                          expectedRoot, allowAdapterFence: true });
                      } finally {
                        await store.releaseLease(lease).catch(() => undefined);
                      }
                    } else {
                      await sqlite.removeSqliteReplicaLayout(replicaDir, { approvedUnknown,
                        expectedKnown, expectedRoot, allowAdapterFence: true });
                    }
                  } finally {
                    await store?.close().catch(() => undefined);
                  }
                }
                await fsyncDir(join(idDir, "replicas"));
              }
            }
          }
          await gate.clearGateIntent(profileDir, intent.id);
          erased.push(intent.id);
        });
      } catch (error) {
        failed.push({ id: intent.id, code: typeof error === "object" && error !== null &&
          "code" in error && typeof error.code === "string" ? error.code : "STORAGE_ERROR" });
      }
    }
    return { erased, failed, remaining: (await lifecycle.pendingPurge()).length };
  }

  async function openHandle(spec: KVReplicaSpec): Promise<KVReplicaHandle> {
    // Lazy by contract (§11.1): only the Node entry reaches this module,
    // and only enabled replicas reach this point.
    // Literal specifiers so bundlers can follow the dependency; @ts-ignore
    // (not expect-error) because tsc resolves replica when its dist exists.
    const [replica, sqlite] = (await Promise.all([
      // @ts-ignore — TS2307 when replica's dist is absent (CI builds node-sdk first).
      import("@tinycloud/replica"),
      // @ts-ignore — same as above.
      import("@tinycloud/replica/sqlite"),
    ])) as [ReplicaRuntime, SqliteRuntime];
    if (spec.stamp === undefined) throw gated("not_established");
    if (guard === undefined) throw gated("gate_unavailable");
    if (spec.grantPolicy === undefined) {
      throw new ReplicaStorageError("REPLICA_INVALID_ARGUMENT", "A replica grant policy is required.");
    }
    const gate = await fileGate();
    const snapshot = await gate.readGateSnapshot(profileDir);
    if (snapshot === undefined) throw gated("gate_unavailable");
    const identityKeyHash = await gate.identityHashOf(snapshot.salt, replicationIdentityKey(spec.identity));
    const resolvePolicy = async (at: number, recordFirst: boolean): Promise<SqliteGrantPolicy | null> => {
      const policy = spec.grantPolicy!;
      if (!Number.isSafeInteger(policy.grantTtlMs) || policy.grantTtlMs <= 0 ||
          policy.grantTtlMs > MAX_GRANT_TTL_MS) {
        throw new TypeError("A replica grant requires a finite TTL not exceeding seven days.");
      }
      const verified = policy.consentAnchor;
      if (verified !== null && (!Number.isSafeInteger(verified.at) || verified.at < 0 ||
          verified.source === "first_install")) {
        throw new ReplicaStorageError("CONSENT_EXPIRED", "The verified consent anchor is unavailable.");
      }
      const first = recordFirst
        ? await gate.recordFirstInstall(profileDir, identityKeyHash, at)
        : await gate.readFirstInstall(profileDir, identityKeyHash);
      const anchor: ReplicaConsentAnchor | null = verified === null
        ? (first === undefined ? null : { at: first, source: "first_install" })
        : { at: Math.min(verified.at, at), source: verified.source };
      if (anchor === null) return null;
      const deadline = anchor.at + CONSENT_WINDOW_MS;
      if (!Number.isSafeInteger(anchor.at) || anchor.at < 0 || !Number.isSafeInteger(deadline)) {
        throw new ReplicaStorageError("CONSENT_EXPIRED", "The durable consent anchor is invalid.");
      }
      return { at, ttlMs: policy.grantTtlMs, consentDeadline: deadline, consentAnchor: anchor };
    };
    let partitionId: string | undefined;
    const storeGuard: MutationGuard = (section) =>
      guarded(spec.identity.principal, spec.stamp, spec.identity, partitionId, section);
    return guarded(spec.identity.principal, spec.stamp, spec.identity, undefined, async () => {
    // Defense in depth (§10.1): the secrets gate again at open, on the
    // session's actual verbatim space — even when sign-in never ran.
    if (requiresSecretsOptIn(spec.space, spec.prefix) && spec.allowSecrets !== true) {
      throw new replica.ReplicaError(
        replica.ReplicaErrorCode.SECRETS_OPT_IN_REQUIRED,
        `Replicating ${spec.space}/kv/${spec.prefix} copies secret material to disk; pass allowSecrets to opt in.`,
      );
    }
    const idDir = partitionDirOf(root, spec.identity);
    // The partition's identity record is written/verified on every open,
    // pending store or not (§6.3). A mismatched file fails closed.
    await ensurePartitionIdentity(idDir, spec.identity, options.dirSync);
    // Delegate posture (§2.1): a spec.device handle never reads or creates
    // the partition's own device key.
    const createdDevice = spec.device ?? (await loadOrCreateDevice(idDir, profileSection, createDevice, options.dirSync));
    // Device key APIs return a verification-method DID URL. Replica grants
    // use the key's principal DID as their audience and stored device identity.
    const device = { ...createdDevice, did: principalOf(createdDevice.did) };
    const replicaHash = replicaHashOf(spec.prefix, device.did);
    partitionId = `${identityKeyHash}:${replicaHash}`;
    const replicaDir = join(idDir, "replicas", replicaHash);
    // Quota admission (TC-858 S5). Without maxBytes the store opens exactly as
    // before: no admit hook. Admission runs inside the store's guarded write,
    // which is already the profile section, so both share one hold.
    const quota = spec.quota?.maxBytes ?? options.maxBytes;
    if (quota !== undefined && (!Number.isSafeInteger(quota) || quota < 0)) {
      throw new TypeError(`maxBytes must be a non-negative safe integer, got ${quota}.`);
    }
    // Recover crash leftovers before this handle's first admission, inside the profile hold.
    if (quota !== undefined) await collectProfileOrphans(root, sqlite.SqliteReplicaStore.collectOrphans);
    const store = await sqlite.SqliteReplicaStore.open(
      replicaDir,
      quota === undefined
        ? { create: true, guard: storeGuard }
        : {
            create: true,
            guard: storeGuard,
            partitionId: basename(idDir),
            admit: async (page) => {
              await collectProfileOrphans(root, sqlite.SqliteReplicaStore.collectOrphans);
              const used = await profileContentBytes(root, sqlite.SqliteReplicaStore.contentBytes);
              // `blobBytes` is the page's NET bytes (replaced or deleted content is credited), so a
              // page that frees at least what it adds is always admitted.
              if (page.blobBytes > 0 && used + page.blobBytes > quota) {
                throw new replica.ReplicaError(
                  replica.ReplicaErrorCode.STORAGE_BUDGET,
                  `Profile storage holds ${used} bytes; this page adds ${page.blobBytes} against a ${quota}-byte quota. Nothing was committed.`,
                );
              }
            },
          },
    );
    let generation: number;
    try {
      // First-open race (review): the existence check must run INSIDE the
      // store's guarded init, not in an unguarded read — two processes that
      // both saw "no row" raced to init and one failed spuriously. init is
      // deterministic, so a CONFIG_MISMATCH "already exists" from a
      // concurrent identical init is benign; the config check below is the
      // real mismatch gate.
      try {
        await store.init({
          name: spec.prefix.replace(/\/+$/, "") || "replica",
          replicaId: replicaHash,
          host: spec.identity.host,
          space: spec.space,
          prefix: spec.prefix,
          deviceDid: device.did,
          allowSecrets: spec.allowSecrets,
          localReadPolicy: "whileGrantValid",
          retentionGrantCid: null,
        });
      } catch (error) {
        if (!replica.isReplicaError(error, replica.ReplicaErrorCode.CONFIG_MISMATCH)) {
          throw error;
        }
      }
      const state = await store.open();
      if (state === null) {
        throw new replica.ReplicaError(
          replica.ReplicaErrorCode.NOT_FOUND,
          "The replica row vanished during init.",
        );
      }
      const config = state.config;
      if (
        config.host !== spec.identity.host ||
        config.space !== spec.space ||
        config.prefix !== spec.prefix
      ) {
        throw new replica.ReplicaError(
          replica.ReplicaErrorCode.CONFIG_MISMATCH,
          `This replica follows ${config.host} ${config.space}/kv/${config.prefix}, not ${spec.identity.host} ${spec.space}/kv/${spec.prefix}.`,
        );
      }
      if (principalOf(config.deviceDid) !== principalOf(device.did)) {
        throw new replica.ReplicaError(
          replica.ReplicaErrorCode.CONFIG_MISMATCH,
          "The stored replica belongs to a different device key; purge the partition to rekey.",
        );
      }
      await retainGrantInstalls(gate, snapshot, identityKeyHash, store);
      if (state.grant !== null || state.pendingGrant !== null) {
        const policy = await resolvePolicy(Date.now(), false);
        if (policy === null) throw gated("gate_unavailable");
        if (state.grant !== null) await store.recomputeGrantInstall(state.grant, policy);
        if (state.pendingGrant !== null) await store.recomputeGrantInstall(state.pendingGrant, policy);
      }
      generation = state.generation;
    } catch (error) {
      await store.close().catch(() => undefined);
      throw error;
    }
    // The inode at handle open: a replica dir recreated in place (or after
    // a purge) is a different replica, so the handle fences on it (review).
    let ino: number | undefined;
    try {
      ino = (await stat(join(replicaDir, "replica.db"))).ino;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return new SqliteReplicaHandle({
      spec,
      replicaId: replicaHash,
      device,
      store,
      replicaDir,
      replica,
      guard: storeGuard,
      read: (section, withFence) => readGated(spec, partitionId!, store, replicaDir, generation, section, withFence),
      policy: resolvePolicy,
      recordGrantInstall: async (cid, at) =>
        gate.recordGrantInstall(profileDir, await gate.grantInstallHashOf(snapshot.salt, identityKeyHash, cid), at),
      transportFor: options.transportFor,
      dirSync: options.dirSync,
      generation,
      ino,
    });
    });
  }

  async function inspectStatus(spec: KVReplicaSpec, { signal }: { signal: AbortSignal }): Promise<LocalReplicaStatus | undefined> {
    assertLogoutClear(options.logoutPendingFile);
    const checkAbort = () => {
      if (signal.aborted) throw signal.reason ?? Object.assign(new Error("Replica status inspection was aborted"), { code: "ABORTED" });
    };
    checkAbort();
    const idDir = partitionDirOf(root, spec.identity);
    if (!(await pathExists(idDir))) return undefined;
    checkAbort();
    const identityFile = join(idDir, "identity.json");
    const storedIdentity = identityRecordOf(await readJsonFile(identityFile));
    if (storedIdentity === undefined || !sameIdentity(storedIdentity, spec.identity)) {
      throw new ReplicaStorageError("STORAGE_ERROR", `The partition at ${idDir} belongs to a different identity or has no identity record.`);
    }
    checkAbort();
    let device = spec.device;
    if (device === undefined) {
      const deviceFile = join(idDir, "device.jwk");
      const storedDevice = await readJsonFile(deviceFile);
      if (storedDevice === undefined) return undefined;
      device = deviceRecordOf(storedDevice);
      if (device === undefined) throw new ReplicaStorageError("STORAGE_ERROR", `The replica device key at ${deviceFile} is unreadable.`);
    }
    checkAbort();
    const replicaDir = join(idDir, "replicas", replicaHashOf(spec.prefix, device.did));
    if (!(await pathExists(replicaDir))) return undefined;
    checkAbort();
    const [replica, sqlite] = (await Promise.all([
      // @ts-ignore — TS2307 when replica's dist is absent (CI builds node-sdk first).
      import("@tinycloud/replica"),
      // @ts-ignore — same as above.
      import("@tinycloud/replica/sqlite"),
    ])) as [ReplicaRuntime, SqliteRuntime];
    checkAbort();
    const syncedThroughEpoch = await readFence(replicaDir);
    checkAbort();
    const inspected = await sqlite.SqliteReplicaStore.inspect(replicaDir, { signal });
    checkAbort();
    if (inspected === null) return undefined;
    const { state, status } = inspected;
    if (state.config.host !== spec.identity.host || state.config.space !== spec.space || state.config.prefix !== spec.prefix || principalOf(state.config.deviceDid) !== principalOf(device.did)) {
      throw new ReplicaStorageError("STORAGE_ERROR", `The replica at ${replicaDir} does not match the requested identity, space, prefix, or device.`);
    }
    checkAbort();
    assertLogoutClear(options.logoutPendingFile);
    // CONTRACT.md §2: pending while a deferred denial holds the profile or any intent remains.
    const gateState = await (await fileGate()).readGateSnapshot(profileDir);
    const purgePending = gateState !== undefined && (gateState.eraseDeferred || gateState.intents.length > 0);
    return {
      purgePending,
      coverage: status.coverage,
      lastSyncAt: status.lastSyncAt,
      syncedThroughEpoch,
      authority: state.grant !== null && (inspected.activeGrantInstall === null ||
          Date.now() >= inspected.activeGrantInstall.effectiveExpiresAt)
        ? { state: "expired", expiresAt: inspected.activeGrantInstall === null
          ? null : new Date(inspected.activeGrantInstall.effectiveExpiresAt).toISOString() }
        : { state: status.authority.state, expiresAt: status.authority.expiresAt },
      grant: newestGrantInfo(replica, state.pendingGrant ?? state.grant, state.pendingGrant, spec, inspected.grantInstall),
      counts: status.counts,
      bytes: status.bytes,
      lastError: status.lastError,
    };
  }

  async function purgePartition(target: PurgeTarget): Promise<void> {
    // Literal specifiers, as in openHandle, so bundlers follow the dependency.
    const [replica, sqlite] = (await Promise.all([
      // @ts-ignore — TS2307 when replica's dist is absent (CI builds node-sdk first).
      import("@tinycloud/replica"),
      // @ts-ignore — same as above.
      import("@tinycloud/replica/sqlite"),
    ])) as [ReplicaRuntime, SqliteRuntime];
    return profileSection(async () => {
    const idDir = partitionDirOf(root, target.identity);
    if (!(await realDirectoryExists(idDir))) return;
    const hasReplicas = await realDirectoryExists(join(idDir, "replicas"));
    // The deduplicated device union (§10.2): the partition's stored device
    // read ONLY (a missing file never creates one and never skips the
    // session device), plus the delegate-posture session device.
    const deviceDids: string[] = [];
    const deviceFile = join(idDir, "device.jwk");
    const stored = await readJsonFile(deviceFile);
    if (stored !== undefined) {
      const device = deviceRecordOf(stored);
      if (device === undefined) {
        throw new ReplicaStorageError(
          "STORAGE_ERROR",
          `The replica device key at ${deviceFile} is unreadable.`,
        );
      }
      deviceDids.push(device.did);
    }
    if (target.sessionDeviceDid !== undefined) deviceDids.push(target.sessionDeviceDid);
    const devices = [...new Map(deviceDids.map((did) => [principalOf(did), did])).values()];

    const removeLeftover = async (replicaDir: string): Promise<void> => {
      const layout = await sqlite.inspectSqliteReplicaLayout(replicaDir, { allowAdapterFence: true });
      const missingDatabase = !(await pathExists(join(replicaDir, "replica.db")));
      const unexpected = layout.unknownPaths.filter((path) => path !== "replica.db");
      if (unexpected.length !== 0 ||
          layout.unknownPaths.includes("replica.db") !== missingDatabase ||
          layout.unknownEntries.some((item) => item.path === "replica.db")) {
        // Targeted purge has no discard approval: anything but the source layout stays.
        throw new ReplicaStorageError("STORAGE_ERROR",
          `Refusing to remove unexpected replica path ${join(replicaDir, unexpected[0] ?? "replica.db")}.`);
      }
      await sqlite.removeSqliteReplicaLayout(replicaDir, {
        expectedRoot: layout.rootIdentity, expectedKnown: layout.knownEntries,
        allowAdapterFence: true, allowMissingDatabase: missingDatabase,
      });
    };

    let firstError: unknown;
    for (const deviceDid of devices) {
      const replicaDir = join(idDir, "replicas", replicaHashOf(target.prefix, deviceDid));
      if (!hasReplicas || !(await realDirectoryExists(replicaDir))) continue;
      try {
        let store: SqliteReplicaStore;
        try {
          store = await sqlite.SqliteReplicaStore.open(replicaDir, { create: false, guard: profileSection });
        } catch (error) {
          if (replica.isReplicaError(error, replica.ReplicaErrorCode.NOT_FOUND)) {
            await removeLeftover(replicaDir);
            continue;
          }
          throw error;
        }
        try {
          const state = await store.open();
          if (state === null) {
            await store.close().catch(() => undefined);
            await removeLeftover(replicaDir);
            continue;
          }
          const lease = await store.acquireSyncLease(SYNC_LEASE_TTL_MS);
          if (lease === null) {
            throw new replica.ReplicaError(
              replica.ReplicaErrorCode.BUSY,
              "Another process holds this replica's sync lease.",
            );
          }
          try {
            const gate = await fileGate();
            const currentGate = await gate.readGateSnapshot(profileDir);
            if (currentGate !== undefined && currentGate.principalHash !== null &&
                currentGate.principalHash === await gate.principalHashOf(currentGate.salt, target.identity.principal)) {
              const identityKeyHash = await gate.identityHashOf(currentGate.salt, replicationIdentityKey(target.identity));
              await retainGrantInstalls(gate, currentGate, identityKeyHash, store);
            }
            // Generation fencing (review): wipe in place FIRST so the
            // replica row's generation commits past every handle opened
            // before this purge — the same contract the browser purge
            // stamps. Skipped when the replica is already revoked:
            // markRevoked bumped the generation itself, and reset refuses
            // revoked replicas. Only then is the directory removed — an
            // open handle never reads a live replica out of a directory
            // that vanished under it.
            if (state.revoked === null) {
              await store.reset(lease, "purged");
            }
            await store.destroy(lease, { allowAdapterFence: true });
          } finally {
            await store.releaseLease(lease).catch(() => undefined);
          }
        } finally {
          await store.close().catch(() => undefined);
        }
      } catch (error) {
        // Every device is attempted; the first error throws after the rest ran.
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
    });
  }

  return {
    kind: "sqlite",
    lifecycle,
    open: openHandle,
    inspectStatus,
    purge: purgePartition,
    // File-backed pending writes are always bound to a stamped gate.
    pendingWrites(identity: ReplicationIdentity, opts?: { stamp?: ReplicaSessionStamp }): PendingWriteStore {
      return new FilePendingWriteStore(
        identity,
        partitionDirOf(root, identity),
        profileDir,
        guard,
        opts?.stamp,
        options.dirSync,
        options.logoutPendingFile,
      );
    },
  };
}

/**
 * CLI-facing profile lifecycle. `guard` is the same profile lock as CLI
 * session/key writes and MUST be reentrant within one async call chain: the CLI
 * calls this facade while it already holds that lock.
 */
export function createProfileReplicaPurge(options: {
  profileDir: string;
  guard: MutationGuard;
  /** Exact regular diagnostics file names the CLI writes directly under `replication/`. */
  diagnosticFiles?: readonly string[];
  /** Observe directory-fsync ordering in tests; production uses fsyncDir. @internal */
  dirSync?: DirSync;
}): ProfileReplicaPurge {
  return createSqliteReplicaStorage({
    dir: join(options.profileDir, "replication"),
    guard: options.guard,
    dirSync: options.dirSync,
    logoutPendingFile: join(options.profileDir, REPLICA_LOGOUT_PENDING_FILE),
    diagnosticFiles: options.diagnosticFiles,
  }).lifecycle;
}

/**
 * The public Node-entry adapter (§2.5): durable SQLite replicas partitioned
 * by canonical identity, and ALWAYS the durable partitioned pending-write
 * store — never a silent memory fallback (§3.1, review). Node ≥ 22.13 —
 * older runtimes surface `RUNTIME_UNSUPPORTED` from `open`/`purge`, never
 * silently.
 */
export function sqliteReplicaStorage(options: {
  dir: string;
  guard?: MutationGuard;
  gateFile?: string;
  logoutPendingFile?: string;
  /** CLI opt-in; see `SqliteReplicaStorageOptions.diagnosticFiles`. */
  diagnosticFiles?: readonly string[];
}): KVReplicaStorage {
  return createSqliteReplicaStorage(options);
}
