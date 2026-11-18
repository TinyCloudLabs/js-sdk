import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  profilePath,
  refuseWriteToDeletedProfile,
  updateProfileStore,
  withPinnedProfileDirectory,
  withProfileLock,
  writeJsonAtomic,
} from "@tinycloud/operations/state";
import { fileExists } from "../config/storage.js";
import { ProfileManager } from "../config/profiles.js";

/**
 * The revoke-only grant an issuer sent next to a delegation (`holderMayRevoke`), as it travels in a grant file and as the
 * holder stores it. `expiry` is an ISO string in both places.
 */
export interface StoredRevokeControl {
  cid: string;
  targetCid: string;
  delegateDID: string;
  authorization: string;
  expiry: string;
  host?: string;
}

export function revokeControlsPath(profile: string): string {
  return join(profilePath(profile), "revoke-controls.json");
}

/** A value that has the shape of a revoke grant for `targetCid`, or undefined. The node checks the signature. */
export function parseRevokeControl(value: unknown, targetCid: string, expectedDelegate?: string): StoredRevokeControl | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const { cid, delegateDID, authorization } = candidate;
  if (typeof cid !== "string" || cid === "" || typeof delegateDID !== "string" || typeof authorization !== "string" || authorization === "") return undefined;
  if (candidate.targetCid !== targetCid) return undefined;
  if (expectedDelegate !== undefined && delegateDID.split("#", 1)[0] !== expectedDelegate.split("#", 1)[0]) return undefined;
  const expiry = new Date(candidate.expiry as string | number | Date);
  if (Number.isNaN(expiry.getTime())) return undefined;
  return {
    cid, targetCid, delegateDID, authorization, expiry: expiry.toISOString(),
    ...(typeof candidate.host === "string" ? { host: candidate.host } : {}),
  };
}

export async function loadRevokeControls(profile: string): Promise<StoredRevokeControl[]> {
  return withPinnedProfileDirectory(profile, async (directory) => {
    if (!directory) return [];
    const path = revokeControlsPath(profile);
    if (!(await fileExists(path))) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).flatMap((entry) => {
      const targetCid = entry !== null && typeof entry === "object" ? (entry as { targetCid?: unknown }).targetCid : undefined;
      const control = typeof targetCid === "string" ? parseRevokeControl(entry, targetCid) : undefined;
      return control ? [control] : [];
    });
  });
}

/** The stored revoke grant for `targetCid` that has not ended, if any. */
export async function findRevokeControl(profile: string, targetCid: string): Promise<StoredRevokeControl | undefined> {
  const now = Date.now();
  return (await loadRevokeControls(profile)).find((control) => control.targetCid === targetCid && new Date(control.expiry).getTime() > now);
}

export async function appendRevokeControl(profile: string, control: StoredRevokeControl): Promise<void> {
  await withProfileLock(profile, async () => {
    await ProfileManager.ensureProfileDir(profile);
    await refuseWriteToDeletedProfile(profile);
    const records = (await loadRevokeControls(profile)).filter((record) => record.targetCid !== control.targetCid);
    await writeJsonAtomic(revokeControlsPath(profile), [...records, control]);
  });
}

/** Drops the stored revoke grant for `targetCid`; call it only after the node confirmed the revoke. */
export async function removeRevokeControl(profile: string, targetCid: string): Promise<void> {
  await withProfileLock(profile, async () => {
    await refuseWriteToDeletedProfile(profile);
    const records = await loadRevokeControls(profile);
    const remaining = records.filter((record) => record.targetCid !== targetCid);
    if (remaining.length !== records.length) await writeJsonAtomic(revokeControlsPath(profile), remaining);
  });
}

/** Drops the delegation the holder stored for `cid` (a no-op when none is stored); call it only after the node confirmed the revoke. */
export async function removeHeldDelegation(profile: string, cid: string): Promise<void> {
  await updateProfileStore<unknown, void>(profile, "additional-delegations", (records) => ({
    records: records.filter((entry) => {
      if (entry === null || typeof entry !== "object" || !("delegation" in entry)) return true;
      const delegation = entry.delegation;
      return delegation === null || typeof delegation !== "object" || !("cid" in delegation) || delegation.cid !== cid;
    }),
    result: undefined,
  }));
}
