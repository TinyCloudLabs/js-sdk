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
  /** Identity key hash to generation; advanced once with a newly queued pending intent. */
  pendingGenerations: Record<string, number>;
}

function gateRefusal(gate: ReplicaGateReason, message: string) {
  return gatedError(gate, message);
}

/** Lowercase hex HMAC-SHA-256(salt, lower-cased principal DID). The only principal form stored. */
export function principalHashOf(salt: string, principal: string): Promise<string> {
  return saltedHash(salt, principal.toLowerCase());
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
  if (record.principalHash !== null && typeof record.principalHash !== "string") {
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
  const firstInstall = record.firstInstall === undefined ? {} : record.firstInstall;
  if (typeof firstInstall !== "object" || firstInstall === null || Array.isArray(firstInstall)) {
    throw gateRefusal("gate_unavailable", "The replica gate file has an invalid firstInstall map.");
  }
  for (const value of Object.values(firstInstall)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw gateRefusal("gate_unavailable", "The replica gate file has an invalid firstInstall entry.");
    }
  }
  const pendingGenerations = record.pendingGenerations === undefined ? {} : record.pendingGenerations;
  if (typeof pendingGenerations !== "object" || pendingGenerations === null || Array.isArray(pendingGenerations)) {
    throw gateRefusal("gate_unavailable", "The replica gate file has an invalid pending generation map.");
  }
  for (const [hash, generation] of Object.entries(pendingGenerations)) {
    if (!/^[0-9a-f]{64}$/.test(hash) || typeof generation !== "number" ||
        !Number.isSafeInteger(generation) || generation < 0) {
      throw gateRefusal("gate_unavailable", "The replica gate file has an invalid pending generation.");
    }
  }
  // Intent entries are validated where they are consumed (erase), not here.
  return {
    incarnation: record.incarnation,
    salt: record.salt,
    principalHash: record.principalHash,
    lifecycleEpoch: record.lifecycleEpoch,
    deniedAt: record.deniedAt,
    intents: record.intents as ReplicaPurgeIntent[],
    firstInstall: firstInstall as Record<string, number>,
    pendingGenerations: pendingGenerations as Record<string, number>,
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
    pendingGenerations: {},
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
  return state?.firstInstall[identityKeyHash];
}

/** Records the first-install anchor only when absent. Returns the stored value. */
export async function recordFirstInstall(profileDir: string, identityKeyHash: string, atMs: number): Promise<number> {
  const state = await readGateState(profileDir);
  const existing = state.firstInstall[identityKeyHash];
  if (existing !== undefined) return existing;
  await writeState(profileDir, { ...state, firstInstall: { ...state.firstInstall, [identityKeyHash]: atMs } });
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
  if (state.intents.length > 0) throw gateRefusal("purge_pending", "A purge is pending for this profile.");
  if (state.deniedAt !== null && issuedAt <= state.deniedAt) {
    throw gateRefusal("stamp_stale", "The sign-in predates the last sign-out.");
  }
  const hash = await principalHashOf(state.salt, principal);
  if (state.principalHash === null) {
    await writeState(profileDir, { ...state, principalHash: hash });
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
  if (state !== undefined && state.intents.length > 0) throw gateRefusal("purge_pending", "A purge is pending for this profile.");
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
): Promise<ReplicaDenyOutcome> {
  if (input.reason === "account_switch" && input.next === undefined) {
    throw new TypeError("An account switch needs the incoming principal.");
  }
  try {
    const state = await readState(profileDir);
    if (state === undefined || state.principalHash === null) return { status: "stale" };
    if (state.principalHash !== (await principalHashOf(state.salt, input.principal))) return { status: "stale" };
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
      pendingGenerations,
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
