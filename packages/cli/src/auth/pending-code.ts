import { createHash } from "node:crypto";
import { chmod, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { profilePath } from "@tinycloud/operations/state";
import { readJson, writeJsonDurable } from "../config/storage.js";
import type { DelegationData } from "./browser-auth.js";
import { sessionExpiresAt } from "./scoped-login.js";

/**
 * OpenKey consumes a short code on the first redeem (a second GET is a 404), so the redeemed delegation is
 * the only copy of the owner's approval. A `--paste` flow saves it here before returning to the caller's
 * verify/activate work, and the caller's commit deletes it (`completeApprovalResult`). The record holds the
 * delegation OpenKey returned, whose key is the public JWK only; the private key stays in key.json.
 */
const FILE = "pending-delegation-code.json";

interface PendingCode {
  /** sha256 of the lower-cased code: a record is never served for another code. */
  codeHash: string;
  /** The delegation's signed expiry; a later record is dead weight and is dropped. */
  expiresAt: string;
  savedAt: string;
  delegation: DelegationData;
}

interface PendingCodes {
  version: 1;
  records: PendingCode[];
}

function hashOf(code: string): string {
  return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}

function fileOf(profile: string): string {
  return join(profilePath(profile), FILE);
}

async function write(profile: string, records: PendingCode[]): Promise<void> {
  if (records.length === 0) await rm(fileOf(profile), { force: true });
  else await writeJsonDurable(fileOf(profile), { version: 1, records } satisfies PendingCodes);
}

/** Live records. An expired record or an unreadable file is removed; a loose mode is repaired; a non-regular path is left alone. */
async function live(profile: string): Promise<PendingCode[]> {
  const file = fileOf(profile);
  let records: PendingCode[];
  try {
    const info = await lstat(file);
    // A symlink, directory or another user's file is not ours to read or delete.
    if (!info.isFile() || info.uid !== process.getuid?.()) return [];
    // The only copy of a consumed code is repaired, not destroyed, over a loose mode.
    if ((info.mode & 0o077) !== 0) await chmod(file, 0o600);
    const stored = await readJson<PendingCodes>(file);
    if (stored?.version !== 1 || !Array.isArray(stored.records)) throw new Error("unknown format");
    records = stored.records.filter((record) => typeof record?.codeHash === "string"
      && Number.isFinite(Date.parse(record.expiresAt)) && typeof record.delegation === "object" && record.delegation !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") await rm(file, { force: true });
    return [];
  }
  const unexpired = records.filter((record) => Date.parse(record.expiresAt) > Date.now());
  if (unexpired.length !== records.length) await write(profile, unexpired);
  return unexpired;
}

/** The unexpired delegation this profile saved when it redeemed `code`. */
export async function pendingDelegationFor(profile: string, code: string): Promise<DelegationData | undefined> {
  const hash = hashOf(code);
  return (await live(profile)).find((record) => record.codeHash === hash)?.delegation;
}

/** Save the redeemed delegation, fsynced with its directory entry, replacing an earlier record for the same code. */
export async function savePendingDelegation(profile: string, code: string, delegation: DelegationData): Promise<void> {
  const expiresAt = sessionExpiresAt(delegation);
  // A delegation with no readable future expiry is refused by every caller anyway; nothing to keep.
  if (expiresAt === null || Date.parse(expiresAt) <= Date.now()) return;
  const hash = hashOf(code);
  const records = (await live(profile)).filter((record) => record.codeHash !== hash);
  records.push({ codeHash: hash, expiresAt, savedAt: new Date().toISOString(), delegation });
  await write(profile, records);
}

/** Delete the record saved for `code` (a refused record must not be served again). */
export async function dropPendingDelegationFor(profile: string, code: string): Promise<void> {
  const hash = hashOf(code);
  const records = await live(profile);
  const kept = records.filter((record) => record.codeHash !== hash);
  if (kept.length !== records.length) await write(profile, kept);
}

/**
 * Delete the record whose delegation a durable commit has just stored. `delegation` is the verified
 * login's `delegationCid` or a stored grant's portable `cid`; other records are untouched.
 */
export async function dropCommittedDelegation(profile: string, delegation: object): Promise<void> {
  const committed = "delegationCid" in delegation ? delegation.delegationCid : "cid" in delegation ? delegation.cid : undefined;
  if (typeof committed !== "string") return;
  try {
    const records = await live(profile);
    const kept = records.filter((record) => record.delegation.delegationCid !== committed);
    if (kept.length !== records.length) await write(profile, kept);
  } catch (error) {
    // The login or grant is already durably committed: a leftover record only expires on its own.
    console.error(`warning: could not remove the saved delegation code record (${(error as Error).message}); it expires on its own.`);
  }
}
