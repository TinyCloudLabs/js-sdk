/**
 * Node/CLI lifecycle gate file (`replica-gate.json`, CONTRACT.md §2). One file per profile holds the
 * account gate (salted principal hash, no plaintext principal), the outstanding purge intents and
 * the device-level first-install anchors.
 *
 * Callers hold the profile lock around every call here. Writes go to a temp file that is fsynced
 * and renamed over the target, so a crash leaves either the old or the new state. Every salted hash
 * is derived before the file is read or written, never inside a held transaction.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ReplicaAccountGate,
  ReplicaDenyInput,
  ReplicaDenyOutcome,
  ReplicaGateAccess,
  ReplicaGateReason,
  ReplicaPurgeIntent,
  ReplicaSessionStamp,
} from "@tinycloud/sdk-services/kv/replication";
import { REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";
import { gatedError } from "../errors";
import { saltedHash } from "./saltedHash";

const GATE_FILE_VERSION = 1;

export interface NodeGateState extends ReplicaAccountGate {
  intents: ReplicaPurgeIntent[];
  /** Identity key hash to first-install time (ms). Cleared by every committed deny. */
  firstInstall: Record<string, number>;
  /** Salted identity+CID hash to immutable first-install time; survives targeted partition purge. */
  grantInstall: Record<string, number>;
  /** Identity key hash to generation; advanced once with a newly queued pending intent. */
  pendingGenerations: Record<string, number>;
  /** Deferred revoke blocks recovery from erasing these already-durable intents. */
  eraseDeferred: boolean;
  /** Salted original principal, retained after resume to recognize idempotent retries. */
  deferredPrincipalHash: string | null;
}

function gateRefusal(gate: ReplicaGateReason, message: string) {
  return gatedError(gate, message);
}

/** Lowercase hex HMAC-SHA-256(salt, lower-cased principal DID). The only principal form stored. */
export function principalHashOf(salt: string, principal: string): Promise<string> {
  return saltedHash(salt, principal.toLowerCase());
}

/** Salted opaque identity id, derived before a guarded data operation. */
export function identityHashOf(salt: string, identityKey: string): Promise<string> {
  return saltedHash(salt, identityKey);
}

/** One account identity and signed CID, without persisting a plaintext CID in gate metadata. */
export function grantInstallHashOf(salt: string, identityKeyHash: string, cid: string): Promise<string> {
  return saltedHash(salt, `grantInstall\0${identityKeyHash}\0${cid}`);
}
function parseState(text: string): NodeGateState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw gateRefusal("gate_unavailable", "The replica gate file is not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null) throw gateRefusal("gate_unavailable", "The replica gate file is malformed.");
  const record = raw as Record<string, unknown>;
  if (record.v !== GATE_FILE_VERSION) throw gateRefusal("gate_unavailable", "The replica gate file has an unknown version.");
  if (typeof record.incarnation !== "string" || record.incarnation.length === 0) {
    throw gateRefusal("gate_unavailable", "The replica gate file has no incarnation.");
  }
  // Canonical base64url that decodes to at least 32 bytes.
  if (
    typeof record.salt !== "string" ||
    Buffer.from(record.salt, "base64url").toString("base64url") !== record.salt ||
    Buffer.from(record.salt, "base64url").length < 32
  ) {
    throw gateRefusal("gate_unavailable", "The replica gate file has an invalid salt.");
  }
  if (record.principalHash !== null &&
      (typeof record.principalHash !== "string" || !/^[0-9a-f]{64}$/.test(record.principalHash))) {
    throw gateRefusal("gate_unavailable", "The replica gate file has an invalid principal hash.");
  }
  if (typeof record.lifecycleEpoch !== "number" || !Number.isSafeInteger(record.lifecycleEpoch) || record.lifecycleEpoch < 0) {
    throw gateRefusal("gate_unavailable", "The replica gate file has an invalid lifecycle epoch.");
  }
  if (record.deniedAt !== null && (typeof record.deniedAt !== "number" ||
      !Number.isSafeInteger(record.deniedAt) || record.deniedAt < 0)) {
    throw gateRefusal("gate_unavailable", "The replica gate file has an invalid deniedAt.");
  }
  if (!Array.isArray(record.intents)) throw gateRefusal("gate_unavailable", "The replica gate file has no intents list.");
  for (const intent of record.intents) {
    if (typeof intent !== "object" || intent === null || typeof intent.id !== "string" ||
        !/^[0-9a-f]{64}$/.test(intent.principalHash) || !Number.isSafeInteger(intent.recordedAt) ||
        intent.recordedAt < 0 ||
        (intent.kind === "pending"
          ? !/^[0-9a-f]{64}$/.test(intent.identityKeyHash) || intent.id !== `pending:${intent.identityKeyHash}`
          : intent.kind !== "partition" || typeof intent.partitionId !== "string" ||
            intent.partitionId.length === 0 || intent.id !== intent.partitionId)) {
      throw gateRefusal("gate_unavailable", "The replica gate file has an invalid purge intent.");
    }
  }
  const firstInstall = record.firstInstall;
  if (typeof firstInstall !== "object" || firstInstall === null || Array.isArray(firstInstall)) {
    throw gateRefusal("gate_unavailable", "The replica gate file has no valid firstInstall map.");
  }
  for (const [hash, value] of Object.entries(firstInstall)) {
    if (!/^[0-9a-f]{64}$/.test(hash) || typeof value !== "number" ||
        !Number.isSafeInteger(value) || value < 0) {
      throw gateRefusal("gate_unavailable", "The replica gate file has an invalid firstInstall entry.");
    }
  }
  const grantInstall = Object.prototype.hasOwnProperty.call(record, "grantInstall") ? record.grantInstall : {};
  if (typeof grantInstall !== "object" || grantInstall === null || Array.isArray(grantInstall)) {
    throw gateRefusal("gate_unavailable", "The replica gate has an invalid grantInstall map.");
  }
  for (const [hash, installedAt] of Object.entries(grantInstall)) {
    if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(installedAt) || (installedAt as number) < 0) {
      throw gateRefusal("gate_unavailable", "The replica gate has an invalid grant install time.");
    }
  }
  const pendingGenerations = record.pendingGenerations;
  if (typeof pendingGenerations !== "object" || pendingGenerations === null || Array.isArray(pendingGenerations)) {
    throw gateRefusal("gate_unavailable", "The replica gate file has an invalid pending generation map.");
  }
  for (const [hash, generation] of Object.entries(pendingGenerations)) {
    if (!/^[0-9a-f]{64}$/.test(hash) || typeof generation !== "number" ||
        !Number.isSafeInteger(generation) || generation < 0) {
      throw gateRefusal("gate_unavailable", "The replica gate file has an invalid pending generation.");
    }
  }
  const eraseDeferred = Object.prototype.hasOwnProperty.call(record, "eraseDeferred") ? record.eraseDeferred : false;
  const deferredPrincipalHash = Object.prototype.hasOwnProperty.call(record, "deferredPrincipalHash")
    ? record.deferredPrincipalHash : null;
  if (typeof eraseDeferred !== "boolean" ||
      (deferredPrincipalHash !== null && (typeof deferredPrincipalHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(deferredPrincipalHash))) ||
      (eraseDeferred && (record.principalHash !== null || deferredPrincipalHash === null))) {
    throw gateRefusal("gate_unavailable", "The replica gate has an invalid deferred erase state.");
  }
  return {
    incarnation: record.incarnation,
    salt: record.salt,
    principalHash: record.principalHash,
    lifecycleEpoch: record.lifecycleEpoch,
    deniedAt: record.deniedAt,
    intents: record.intents as ReplicaPurgeIntent[],
    firstInstall: firstInstall as Record<string, number>,
    grantInstall: grantInstall as Record<string, number>,
    pendingGenerations: pendingGenerations as Record<string, number>,
    eraseDeferred,
    deferredPrincipalHash,
  };
}

/** The stored state, or `undefined` when no gate file exists. Never creates the file. */
async function readState(profileDir: string): Promise<NodeGateState | undefined> {
  let text: string;
  try {
    text = await readFile(join(profileDir, REPLICA_GATE_FILE), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw gateRefusal("gate_unavailable", "The replica gate file cannot be read.");
  }
  return parseState(text);
}

/** Control-only snapshot. In particular, a missing gate is never minted by a pending read. */
export function readGateSnapshot(profileDir: string): Promise<NodeGateState | undefined> {
  return readState(profileDir);
}

/** Call under the profile lock; caller derives both hashes before entering its data section. */
export async function assertGateAccess(
  profileDir: string,
  access: ReplicaGateAccess,
  salt: string,
): Promise<NodeGateState> {
  if (access.stamp === undefined) {
    throw gateRefusal("not_established", "The replica session has no stamp.");
  }
  const state = await readState(profileDir);
  if (state === undefined || state.salt !== salt) {
    throw gateRefusal("gate_unavailable", "The replica gate is unavailable or was replaced.");
  }
  if (state.incarnation !== access.incarnation) {
    throw gateRefusal("stamp_stale", "The replica gate was replaced.");
  }
  if (state.lifecycleEpoch !== access.stamp.lifecycleEpoch || state.incarnation !== access.stamp.incarnation) {
    throw gateRefusal("stamp_stale", "The replica session stamp has changed.");
  }
  if (state.principalHash === null || state.principalHash !== access.principalHash) {
    throw gateRefusal("principal_mismatch", "The replica belongs to a different account.");
  }
  if (state.intents.some((intent) =>
    (intent.kind === "partition" && intent.partitionId === access.partitionId) ||
    (intent.kind === "pending" && intent.identityKeyHash === access.identityKeyHash)
  )) {
    throw gateRefusal("purge_pending", "This replica has a pending erase.");
  }
  return state;
}

/** Erase precedes this operation. Keeping generations makes replay and stale-store fencing durable. */
export async function clearGateIntent(profileDir: string, id: string): Promise<void> {
  const state = await readState(profileDir);
  if (state === undefined || !state.intents.some((intent) => intent.id === id)) return;
  if (state.eraseDeferred) throw gateRefusal("purge_pending", "Deferred replica erase has not been resumed.");
  await writeState(profileDir, { ...state, intents: state.intents.filter((intent) => intent.id !== id) });
}

async function writeState(profileDir: string, state: NodeGateState): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  const target = join(profileDir, REPLICA_GATE_FILE);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ v: GATE_FILE_VERSION, ...state }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    const directory = await open(profileDir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function freshState(): NodeGateState {
  return {
    incarnation: randomUUID(),
    salt: randomBytes(32).toString("base64url"),
    principalHash: null,
    lifecycleEpoch: 0,
    deniedAt: null,
    intents: [],
    firstInstall: {},
    grantInstall: {},
    pendingGenerations: {},
    eraseDeferred: false,
    deferredPrincipalHash: null,
  };
}

/** Reads the gate, creating it (fresh incarnation and salt) when absent. Fails closed on a corrupt file. */
export async function readGateState(profileDir: string): Promise<NodeGateState> {
  const existing = await readState(profileDir);
  if (existing !== undefined) return existing;
  const created = freshState();
  await writeState(profileDir, created);
  return created;
}

/** The device-level first-install anchor for one identity, or `undefined` when none is recorded. */
export async function readFirstInstall(profileDir: string, identityKeyHash: string): Promise<number | undefined> {
  const state = await readState(profileDir);
  if (state?.eraseDeferred) throw gateRefusal("purge_pending", "Deferred replica erase has not been resumed.");
  return state?.firstInstall[identityKeyHash];
}

/** Records the first-install anchor only when absent. Returns the stored value. */
export async function recordFirstInstall(profileDir: string, identityKeyHash: string, atMs: number): Promise<number> {
  if (!/^[0-9a-f]{64}$/.test(identityKeyHash) || !Number.isSafeInteger(atMs) || atMs < 0) {
    throw gateRefusal("gate_unavailable", "A salted identity hash and finite first-install time are required.");
  }
  const state = await readGateState(profileDir);
  if (state.eraseDeferred) throw gateRefusal("purge_pending", "Deferred replica erase has not been resumed.");
  const existing = state.firstInstall[identityKeyHash];
  if (existing !== undefined) return existing;
  await writeState(profileDir, { ...state, firstInstall: { ...state.firstInstall, [identityKeyHash]: atMs } });
  return atMs;
}

/** A per-CID install floor, persisted before committing a SQLite grant install. Call under the profile lock. */
export async function recordGrantInstall(profileDir: string, hash: string, atMs: number): Promise<number> {
  if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(atMs) || atMs < 0) {
    throw gateRefusal("gate_unavailable", "A salted grant hash and finite install time are required.");
  }
  const state = await readState(profileDir);
  if (state === undefined || state.principalHash === null) {
    throw gateRefusal("gate_unavailable", "The replica account gate is not established.");
  }
  if (state.eraseDeferred || state.intents.length > 0) {
    throw gateRefusal("purge_pending", "A purge is pending for this profile.");
  }
  const previous = state.grantInstall[hash];
  if (previous !== undefined && previous <= atMs) return previous;
  await writeState(profileDir, { ...state, grantInstall: { ...state.grantInstall, [hash]: atMs } });
  return atMs;
}

/**
 * `establishSessionStamp` (fresh sign-in only). Rejects `purge_pending` while any intent is
 * outstanding, then `stamp_stale` when `siweIssuedAt` (ms) is not after `deniedAt`. A null gate
 * principal is set to the caller's (no epoch bump); the same principal returns the current stamp;
 * another principal is `principal_mismatch`. Writes only when the principal is first set.
 */
export async function establishSessionStamp(
  profileDir: string,
  principal: string,
  o: { siweIssuedAt: number },
): Promise<ReplicaSessionStamp> {
  if (!Number.isSafeInteger(o?.siweIssuedAt) || o.siweIssuedAt < 0) {
    throw gateRefusal("not_established", "A finite signed SIWE issued-at time is required.");
  }
  const issuedAt = Math.min(o.siweIssuedAt, Date.now());
  const state = await readGateState(profileDir);
  if (state.eraseDeferred || state.intents.length > 0) throw gateRefusal("purge_pending", "A purge is pending for this profile.");
  if (state.deniedAt !== null && issuedAt <= state.deniedAt) {
    throw gateRefusal("stamp_stale", "The sign-in predates the last sign-out.");
  }
  const hash = await principalHashOf(state.salt, principal);
  if (state.principalHash === null) {
    await writeState(profileDir, { ...state, principalHash: hash, deferredPrincipalHash: null });
  } else if (state.principalHash !== hash) {
    throw gateRefusal("principal_mismatch", "The profile belongs to another account.");
  }
  return { incarnation: state.incarnation, lifecycleEpoch: state.lifecycleEpoch };
}

/**
 * `restoreSessionStamp`: validates the persisted stamp and never writes. An absent gate file never
 * gets created here; with no gate, a persisted stamp is stale and no stamp is not established.
 */
export async function restoreSessionStamp(
  profileDir: string,
  principal: string,
  persisted: ReplicaSessionStamp | undefined,
): Promise<ReplicaSessionStamp> {
  const state = await readState(profileDir);
  if (state !== undefined && (state.eraseDeferred || state.intents.length > 0)) {
    throw gateRefusal("purge_pending", "A purge is pending for this profile.");
  }
  if (persisted === undefined) throw gateRefusal("not_established", "The session has no replica stamp.");
  if (
    typeof persisted !== "object" || persisted === null || Array.isArray(persisted) ||
    Object.keys(persisted).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(persisted, "incarnation") ||
    !Object.prototype.hasOwnProperty.call(persisted, "lifecycleEpoch") ||
    typeof persisted.incarnation !== "string" || persisted.incarnation.length === 0 ||
    !Number.isSafeInteger(persisted.lifecycleEpoch) || persisted.lifecycleEpoch < 0
  ) {
    throw gateRefusal("stamp_stale", "The persisted replica stamp is malformed.");
  }
  if (state === undefined) throw gateRefusal("stamp_stale", "The replica gate no longer exists.");
  if (persisted.incarnation !== state.incarnation || persisted.lifecycleEpoch !== state.lifecycleEpoch) {
    throw gateRefusal("stamp_stale", "The session stamp is from an earlier sign-in.");
  }
  if (state.principalHash !== (await principalHashOf(state.salt, principal))) {
    throw gateRefusal("principal_mismatch", "The profile belongs to another account.");
  }
  return { incarnation: persisted.incarnation, lifecycleEpoch: persisted.lifecycleEpoch };
}

/**
 * `deny` step 1. If `input.principal` does not match the gate, returns `stale` and writes nothing.
 * Otherwise one atomic rewrite clears the principal, increments epoch and pending generations
 * for new pending intents, records the deduplicated intents and clears first-install anchors.
 * A failed write returns `unguarded`. The caller holds the nonreentrant profile lock throughout.
 */
export async function denyGate(
  profileDir: string,
  input: ReplicaDenyInput,
  collectIntents: (principalHash: string) => Promise<readonly ReplicaPurgeIntent[]>,
  precomputed?: { salt: string; principalHash: string },
  options?: { deferErase?: boolean },
): Promise<ReplicaDenyOutcome> {
  if (input.reason === "account_switch" && input.next === undefined) {
    throw new TypeError("An account switch needs the incoming principal.");
  }
  if (options?.deferErase === true && input.reason !== "sign_out") {
    throw new TypeError("Deferred erase is only available for sign-out.");
  }
  try {
    const state = await readState(profileDir);
    if (state === undefined || state.principalHash === null) return { status: "stale" };
    if (precomputed !== undefined && state.salt !== precomputed.salt) {
      throw gateRefusal("gate_unavailable", "The replica gate salt changed before denial.");
    }
    if (state.principalHash !== (precomputed?.principalHash ?? await principalHashOf(state.salt, input.principal))) {
      return { status: "stale" };
    }
    const intents = await collectIntents(state.principalHash);
    const known = new Set(state.intents.map((intent) => intent.id));
    const added: ReplicaPurgeIntent[] = [];
    for (const intent of intents) {
      if (known.has(intent.id)) continue;
      known.add(intent.id);
      added.push(intent);
    }
    const pendingGenerations = { ...state.pendingGenerations };
    for (const intent of added) {
      if (intent.kind !== "pending") continue;
      const hash = intent.identityKeyHash;
      if (!/^[0-9a-f]{64}$/.test(hash) || intent.id !== `pending:${hash}` ||
          !Number.isSafeInteger((pendingGenerations[hash] ?? 0) + 1)) {
        throw gateRefusal("gate_unavailable", "A pending purge intent has an invalid identity generation.");
      }
      pendingGenerations[hash] = (pendingGenerations[hash] ?? 0) + 1;
    }
    const merged = [...state.intents, ...added];
    const lifecycleEpoch = state.lifecycleEpoch + 1;
    const deniedAt = Math.max(Date.now(), (state.deniedAt ?? -1) + 1);
    if (!Number.isSafeInteger(lifecycleEpoch) || !Number.isSafeInteger(deniedAt)) {
      throw gateRefusal("gate_unavailable", "The replica deny floor cannot advance.");
    }
    const next: NodeGateState = {
      ...state,
      principalHash: null,
      lifecycleEpoch,
      deniedAt,
      intents: merged,
      firstInstall: {},
      grantInstall: {},
      pendingGenerations,
      eraseDeferred: options?.deferErase === true,
      deferredPrincipalHash: options?.deferErase === true ? state.principalHash : null,
    };
    await writeState(profileDir, next);
    return { status: "denied", lifecycleEpoch: next.lifecycleEpoch, intents: merged.length };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "STORAGE_ERROR";
    return { status: "unguarded", code };
  }
}

/** Local fencing token; not a bearer capability. Caller holds the profile lock. */
export interface DeferredEraseToken {
  deniedEpoch: number;
  principalHash: string;
}

/** Read-only inspection of a deferred denial. A missing gate never creates one. */
export async function deferredGateToken(profileDir: string): Promise<DeferredEraseToken | null> {
  const state = await readState(profileDir);
  return state?.eraseDeferred
    ? { deniedEpoch: state.lifecycleEpoch, principalHash: state.deferredPrincipalHash! }
    : null;
}

/** Resume only the denial identified by the same durable epoch and original principal. */
export async function resumeDeferredGate(profileDir: string, token: DeferredEraseToken): Promise<boolean> {
  const state = await readState(profileDir);
  if (state === undefined) throw gateRefusal("gate_unavailable", "The replica gate no longer exists.");
  if (!Number.isSafeInteger(token?.deniedEpoch) || token.deniedEpoch < 0 ||
      typeof token.principalHash !== "string" || !/^[0-9a-f]{64}$/.test(token.principalHash) ||
      state.lifecycleEpoch !== token.deniedEpoch || state.deferredPrincipalHash !== token.principalHash ||
      state.principalHash !== null) {
    throw gateRefusal("stamp_stale", "The deferred erase token is stale or belongs to another account.");
  }
  if (!state.eraseDeferred) return false;
  await writeState(profileDir, { ...state, eraseDeferred: false });
  return true;
}
