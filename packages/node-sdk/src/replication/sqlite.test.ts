/**
 * Unit tests for `createSqliteReplicaStorage` (TC-858 §6.3, §10.1-10.2,
 * amendment §1): the file pending store and its serialization, the identity
 * partition, grant install and `unconstrained`, the per-replica
 * `syncedThroughEpoch` fence, and purge across the device union. Real
 * `bun:sqlite` stores under a temp dir; transports and device keys are
 * faked through the internal seams — no WASM, no network.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { chmod, mkdir, mkdtemp, open as openFile, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519";
import type { ReplicaTransport } from "@tinycloud/replica";
import { SqliteReplicaStore } from "@tinycloud/replica/sqlite";
import { Database } from "bun:sqlite";
import { device, FakeNode } from "../../../replica/test/fixtures";
import type {
  KVReplicaSpec,
  PendingWriteState,
  ReplicationIdentity,
} from "@tinycloud/sdk-services";
import type { ReplicaSessionStamp } from "@tinycloud/sdk-services/kv/replication";

import {
  createSqliteReplicaStorage,
  createProfileReplicaPurge,
  REPLICA_LOGOUT_PENDING_FILE,
  assertProfileLogoutClear,
  type SqliteReplicaStorageOptions,
} from "./sqlite";
import { denyGate, establishSessionStamp, readGateSnapshot } from "@tinycloud/replica/profile-gate";
import { REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dirs: string[] = [];
const roots: string[] = [];
const stamps = new Map<string, ReplicaSessionStamp>();

async function makeDir(): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), "tc858-replica-"));
  dirs.push(profile);
  const dir = join(profile, "replication");
  await mkdir(dir);
  roots.push(dir);
  stamps.set(profile, await establishSessionStamp(profile, PRINCIPAL, { siweIssuedAt: 1 }));
  return dir;
}

async function makeLegacyMirror(profileDir: string): Promise<string> {
  const dir = join(profileDir, "replicas", "notes");
  await mkdir(dirname(dir), { recursive: true });
  const store = await SqliteReplicaStore.open(dir, { create: true });
  await store.close();
  return dir;
}

async function eraseLegacy(profileDir: string): Promise<void> {
  await rm(join(profileDir, "replicas"), { recursive: true, force: true });
}
/** Test setup: explicit discard approval is bound to the inventory just displayed. */
async function prepareApproved(purge: ReturnType<typeof createProfileReplicaPurge>) {
  const approval = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
  return purge.prepareLogoutPending({ principal: PRINCIPAL, discardLocalChanges: true, approval });
}


afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  roots.length = 0;
  stamps.clear();
});

const HOST_A = "http://127.0.0.1:8000";
const HOST_B = "http://localhost:8000";
const SPACE_A = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const SPACE_B = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:other";
const PRINCIPAL = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const DEVICE_DID = "did:key:zTestReplicaDevice";
const DELEGATE_DID = "did:key:zTestDelegateDevice";

function identity(over: Partial<ReplicationIdentity> = {}): ReplicationIdentity {
  return { host: HOST_A, space: SPACE_A, principal: PRINCIPAL, ...over };
}

/** Serializing test guard — what the CLI's profile lock provides. */
function serialGuard(): <T>(section: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (section) => {
    const run = tail.then(section);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const sharedGuard = serialGuard();

function storageOptions(over: Partial<SqliteReplicaStorageOptions> = {}): SqliteReplicaStorageOptions {
  return {
    dir: roots[roots.length - 1]!,
    guard: sharedGuard,
    createDevice: async () => ({ did: DEVICE_DID, jwk: { kty: "OKP" } }),
    transportFor: () => fakeTransport,
    ...over,
  };
}

function spec(over: Partial<KVReplicaSpec> = {}): KVReplicaSpec {
  return {
    identity: identity(),
    space: SPACE_A,
    prefix: "notes/",
    allowSecrets: false,
    stamp: stamps.get(dirname(roots[roots.length - 1]!)),
    grantPolicy: { grantTtlMs: 86_400_000, consentAnchor: { at: Date.now() - 1000, source: "siwe" } },
    ...over,
  };
}

/** A sync transport that answers one empty page then stops. */
const fakeTransport: ReplicaTransport = {
  async syncPage({ prefix }) {
    return {
      changes: [],
      more: false,
      cursor: "1",
      source: { nodeDid: "did:key:zTestNode", space: SPACE_A, prefix },
      authority: { notBefore: null, expiresAt: null, retainUntil: null },
    };
  },
  async fetchContent() {
    return new Map();
  },
};

// --- Signed test UCANs (EdDSA did:key issuers, like real device grants) ---

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

function didKeyOf(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(2 + publicKey.length);
  prefixed.set([0xed, 0x01]);
  prefixed.set(publicKey, 2);
  return `did:key:z${base58Encode(prefixed)}`;
}

const issuerSecret = ed25519.utils.randomPrivateKey();
const issuerDid = didKeyOf(ed25519.getPublicKey(issuerSecret));

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/**
 * Mint a verifiable compact UCAN: Ed25519 did:key issuer, `aud` the replica
 * device, covering `<space>/kv/notes` (and `<space>/kv/other` when given).
 */
async function mintUcan(input: {
  audience: string;
  space?: string;
  prefixes?: string[];
  exp?: number;
  prf?: string[];
  caveats?: Record<string, unknown>;
}): Promise<string> {
  const space = input.space ?? SPACE_A;
  const prefixes = input.prefixes ?? ["notes", "notes/"];
  const att: Record<string, Record<string, unknown>> = {};
  for (const prefix of prefixes) {
    att[`${space}/kv/${prefix}`] = {
      "tinycloud.kv/get": input.caveats ?? {},
      "tinycloud.kv/sync": {},
    };
  }
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        iss: issuerDid,
        aud: input.audience,
        exp: input.exp ?? Math.floor(Date.now() / 1000) + 86_400,
        att,
        prf: input.prf ?? ["bafyParentCid"],
      }),
    ),
  );
  const signature = await ed25519.sign(
    new TextEncoder().encode(`${header}.${payload}`),
    issuerSecret,
  );
  return `${header}.${payload}.${b64url(signature)}`;
}

async function partitionDirs(root: string): Promise<string[]> {
  return readdir(root);
}

async function filesNamed(root: string, filename: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await filesNamed(path, filename));
    else if (entry.name === filename) found.push(path);
  }
  return found;
}


describe("mandatory Node lifecycle gate", () => {
  test("missing guard refuses pending access without creating a partition", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage({ dir });
    await expect(storage.pendingWrites!(identity(), { stamp: { incarnation: "x", lifecycleEpoch: 0 } }).read())
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(await readdir(dir)).toEqual([]);
  });

  test("missing lock refuses stamped SQLite open before creating a replica", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage({ dir });
    await expect(storage.open(spec())).rejects.toMatchObject({
      code: "REPLICA_GATED", gate: "gate_unavailable",
    });
    expect(await readdir(dir)).toEqual([]);
  });

  test("pending readExisting checks the gate even with no partition or file", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const stamp = await establishSessionStamp(dirname(dir), PRINCIPAL, { siweIssuedAt: 1 });
    const pending = storage.pendingWrites!(identity(), { stamp });
    expect(await pending.readExisting!()).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    await rm(join(dirname(dir), REPLICA_GATE_FILE));
    await expect(pending.readExisting!()).rejects.toMatchObject({ code: "REPLICA_GATED" });
    expect(await readdir(dir)).toEqual([]);
  });

  test("a second process denying the gate fences synchronous delivery", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const stamp = await storage.lifecycle!.restoreSessionStamp(PRINCIPAL, stamps.get(dirname(dir)));
    expect(storage.lifecycle!.deliverable(stamp)).toBe(true);
    await denyGate(dirname(dir), { reason: "sign_out", principal: PRINCIPAL }, async () => []);
    expect(storage.lifecycle!.deliverable(stamp)).toBe(false);
  });

  test("SQLite grant/status reads do not take the mutation profile lock", async () => {
    const dir = await makeDir();
    let block = false;
    const storage = createSqliteReplicaStorage(storageOptions({
      guard: async (section) => {
        if (block) throw new Error("Profile lock held elsewhere");
        return sharedGuard(section);
      },
    }));
    const handle = await storage.open(spec());
    block = true;
    expect(await handle.grant()).toBeNull();
    expect((await handle.status()).coverage).toBe("empty");
    block = false;
    await handle.close();
  });

  test("denial fences an opened SQLite handle before any replica bytes or keys", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    const denied = await storage.lifecycle!.deny({ reason: "sign_out", principal: PRINCIPAL });
    expect(denied.status).toBe("denied");
    await expect(handle.get("notes/a")).rejects.toMatchObject({ code: "REPLICA_GATED" });
    await expect(handle.list({ prefix: "notes/" })).rejects.toMatchObject({ code: "REPLICA_GATED" });
    await handle.close();
    const devices = await filesNamed(dir, "device.jwk");
    expect(devices).toHaveLength(1);
    const report = await storage.lifecycle!.erasePending({ signal: new AbortController().signal });
    expect(report.failed).toEqual([]);
    expect(await filesNamed(dir, "device.jwk")).toEqual([]);
  });

  test("recover reports a busy profile lock without erasing pending files", async () => {
    const dir = await makeDir();
    const active = createSqliteReplicaStorage(storageOptions());
    await active.pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! })
      .update((state) => { state.seq = 1; });
    expect((await active.lifecycle!.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
    const busy = createSqliteReplicaStorage(storageOptions({
      guard: async () => { throw Object.assign(new Error("Profile lock busy"), { code: "BUSY" }); },
    }));
    const report = await busy.lifecycle!.recover({ signal: new AbortController().signal });
    expect(report).toMatchObject({ erased: [], failed: [{ id: "gate", code: "REPLICA_GATED" }], remaining: 1 });
    expect(await filesNamed(dir, "pending.json")).toHaveLength(1);
  });

  test("deferred revoke survives restart without erasing files, then resumes the exact denial", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    const pending = storage.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! });
    await pending.update((state) => { state.seq = 1; });
    const before = await filesNamed(dir, "pending.json");
    const devices = await filesNamed(dir, "device.jwk");
    const databases = await filesNamed(dir, "replica.db");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });

    const denied = await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true });
    expect(denied).toMatchObject({ status: "denied" });
    if (denied.status !== "denied" || denied.resumeToken === undefined) throw new Error("Missing durable resume token");
    const token = denied.resumeToken;
    expect(await filesNamed(dir, "pending.json")).toEqual(before);
    expect(await filesNamed(dir, "device.jwk")).toEqual(devices);
    expect(await filesNamed(dir, "replica.db")).toEqual(databases);
    await expect(handle.get("notes/a")).rejects.toMatchObject({ code: "REPLICA_GATED" });
    await expect(pending.read()).rejects.toMatchObject({ code: "REPLICA_GATED" });
    await handle.close();

    const restarted = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    expect(await restarted.deferredErase()).toEqual(token);
    expect((await restarted.recover({ signal: new AbortController().signal })).remaining).toBeGreaterThan(0);
    expect((await restarted.erasePending({ signal: new AbortController().signal })).remaining).toBeGreaterThan(0);
    expect(await filesNamed(dir, "pending.json")).toEqual(before);
    expect(await filesNamed(dir, "device.jwk")).toEqual(devices);
    expect(await filesNamed(dir, "replica.db")).toEqual(databases);
    await expect(restarted.resumeDeferredErase({ ...token, principalHash: "0".repeat(64) }, {
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    expect(await restarted.deferredErase()).toEqual(token);

    const report = await restarted.resumeDeferredErase(token, { signal: new AbortController().signal });
    expect(report.failed).toEqual([]);
    expect(report.remaining).toBe(0);
    expect(await filesNamed(dir, "pending.json")).toEqual([]);
    expect(await filesNamed(dir, "device.jwk")).toEqual([]);
    expect(await filesNamed(dir, "replica.db")).toEqual([]);
    expect(await restarted.deferredErase()).toBeNull();
    expect(await restarted.resumeDeferredErase(token, { signal: new AbortController().signal }))
      .toEqual({ erased: [], failed: [], remaining: 0 });
  });

  test("interruption after clearing deferred marker leaves intents for restart recovery", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const storage = createSqliteReplicaStorage(storageOptions());
    await storage.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! })
      .update((state) => { state.seq = 1; });
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const denied = await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true });
    if (denied.status !== "denied" || denied.resumeToken === undefined) throw new Error("Missing durable resume token");
    const controller = new AbortController();
    let lockTurns = 0;
    const interrupted = createProfileReplicaPurge({ profileDir, guard: async (section) => {
      const result = await sharedGuard(section);
      if (++lockTurns === 1) controller.abort();
      return result;
    } });

    await expect(interrupted.resumeDeferredErase(denied.resumeToken, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(await purge.deferredErase()).toBeNull();
    expect(await filesNamed(dir, "pending.json")).toHaveLength(1);
    const restarted = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    expect(await restarted.recover({ signal: new AbortController().signal }))
      .toMatchObject({ failed: [], remaining: 0 });
    expect(await filesNamed(dir, "pending.json")).toEqual([]);
  });

  test("deferred denial blocks account switch until purge and rejects old token after successor", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await createSqliteReplicaStorage(storageOptions()).pendingWrites!(identity(), {
      stamp: stamps.get(profileDir)!,
    }).update((state) => { state.seq = 1; });
    expect(() => purge.deny({ reason: "account_switch", principal: PRINCIPAL, next: "did:key:Bob" }, {
      deferErase: true,
    })).toThrow(TypeError);
    expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
    const denied = await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true });
    if (denied.status !== "denied" || denied.resumeToken === undefined) throw new Error("Missing durable resume token");
    const token = denied.resumeToken;
    expect(await purge.deny({ reason: "account_switch", principal: PRINCIPAL, next: "did:key:Bob" }))
      .toMatchObject({ status: "stale" });
    expect(await purge.deferredErase()).toEqual(token);
    expect(await createSqliteReplicaStorage(storageOptions()).lifecycle!.activationAllowed("did:key:Bob")).toBe(false);
    await purge.resumeDeferredErase(token, { signal: new AbortController().signal });
    expect(await createSqliteReplicaStorage(storageOptions()).lifecycle!.activationAllowed("did:key:Bob")).toBe(false);
    const deniedAt = (await readGateSnapshot(profileDir))!.deniedAt!;
    const originalNow = Date.now();
    try {
      setSystemTime(new Date(deniedAt + 2));
      await createSqliteReplicaStorage(storageOptions()).lifecycle!.establishSessionStamp("did:key:Bob", {
        consentAnchor: { at: deniedAt + 1, source: "siwe" },
      });
    } finally {
      setSystemTime(originalNow);
    }
    expect(await createSqliteReplicaStorage(storageOptions()).lifecycle!.activationAllowed("did:key:Bob")).toBe(true);
    await expect(purge.resumeDeferredErase(token, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
  });

  test("no-marker recovery reports durable intents without deleting credentials or replaying", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const storage = createSqliteReplicaStorage(storageOptions());
    await storage.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! })
      .update((state) => { state.seq = 1; });
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
    const report = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { throw new Error("no marker must not shred credentials"); },
      eraseLegacyReplicas: async () => { throw new Error("no marker must not erase legacy files"); },
    });
    expect(report).toMatchObject({ erased: [], failed: [], remaining: 1 });
    expect(await filesNamed(dir, "pending.json")).toHaveLength(1);
  });

  test("no-marker recovery refuses corrupt gate without touching credentials", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "session");
    await writeFile(key, "key");
    await writeFile(join(profileDir, REPLICA_GATE_FILE), "{corrupt");
    let cleanupCalls = 0;
    const report = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { cleanupCalls++; },
      eraseLegacyReplicas: async () => { cleanupCalls++; },
    });
    expect(report.erased).toEqual([]);
    expect(report.failed).toEqual([{ id: "logout", code: "gate_unavailable" }]);
    expect(report.remaining).toBeGreaterThan(0);
    expect(cleanupCalls).toBe(0);
    expect(existsSync(session)).toBe(true);
    expect(existsSync(key)).toBe(true);
  });

  test("no-marker recovery reports a gate inspection I/O failure, not an empty queue", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const gatePath = join(profileDir, REPLICA_GATE_FILE);
    await rm(gatePath);
    await mkdir(gatePath);
    const report = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { throw new Error("no marker must not touch credentials"); },
      eraseLegacyReplicas: async () => { throw new Error("no marker must not touch replicas"); },
    });
    expect(report.erased).toEqual([]);
    expect(report.failed).toEqual([{ id: "logout", code: "gate_unavailable" }]);
    expect(report.remaining).toBeGreaterThan(0);
    expect(existsSync(gatePath)).toBe(true);
  });

  test("a durable CLI logout marker fences a second opened handle before credentials are removed", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const marker = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
    const first = createSqliteReplicaStorage(storageOptions({ logoutPendingFile: marker }));
    const second = createSqliteReplicaStorage(storageOptions({ logoutPendingFile: marker }));
    const handle = await second.open(spec());
    const pending = second.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! });
    await pending.update((state) => { state.seq = 1; });
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    expect(existsSync(marker)).toBe(true);
    await expect(handle.get("notes/a")).rejects.toMatchObject({ code: "REPLICA_GATED" });
    await expect(handle.list({ prefix: "notes/" })).rejects.toMatchObject({ code: "REPLICA_GATED" });
    await expect(handle.status()).rejects.toMatchObject({ code: "REPLICA_GATED" });
    await expect(second.inspectStatus!(spec(), { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "REPLICA_GATED" });
    await expect(pending.read()).rejects.toMatchObject({ code: "REPLICA_GATED" });
    expect(second.lifecycle!.checkDelivery(stamps.get(profileDir)!)).toMatchObject({ status: "gated" });
    await expect(first.lifecycle!.restoreSessionStamp(PRINCIPAL, stamps.get(profileDir)!))
      .rejects.toMatchObject({ code: "REPLICA_GATED" });
    await handle.close();
  });

  test("crash after marker fsync but before either unlink clears both credentials and the full inventory on restart", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, JSON.stringify({ jwk: { d: "private" } }));
    await writeFile(key, JSON.stringify({ d: "private" }));
    const storage = createSqliteReplicaStorage(storageOptions());
    await storage.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! })
      .update((state) => { state.seq = 1; });
    const before = await filesNamed(dir, "pending.json");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    expect(existsSync(session)).toBe(true);
    expect(existsSync(key)).toBe(true);
    expect(await filesNamed(dir, "pending.json")).toEqual(before);
    const restarted = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    let cleanupCalls = 0;
    const report = await restarted.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {
        cleanupCalls++;
        await rm(session, { force: true });
        await rm(key, { force: true });
      },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(report.failed).toEqual([]);
    expect(report.remaining).toBe(0);
    expect(cleanupCalls).toBe(1);
    expect(existsSync(session)).toBe(false);
    expect(existsSync(key)).toBe(false);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect(await filesNamed(dir, "pending.json")).toEqual([]);
    expect((await readGateSnapshot(profileDir))?.principalHash).toBeNull();
  });

  test("crash after durable gate denial but before unlink retains marker until credential cleanup", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "{}");
    await writeFile(key, "{}");
    const storage = createSqliteReplicaStorage(storageOptions());
    await storage.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! })
      .update((state) => { state.seq = 1; });
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
    expect((await purge.recover({ signal: new AbortController().signal })).failed)
      .toEqual([{ id: "logout", code: "REPLICA_GATED" }]);
    expect(await filesNamed(dir, "pending.json")).toHaveLength(1);
    const report = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { await rm(session); await rm(key); },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(report.failed).toEqual([]);
    expect(await filesNamed(dir, "pending.json")).toEqual([]);
    expect(existsSync(session)).toBe(false);
    expect(existsSync(key)).toBe(false);
  });

  test("v1 preflight accepts a source-created legacy mirror before any denial", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    expect(await purge.preflightLogout({ principal: PRINCIPAL }))
      .toMatchObject({ knownLegacyReplicas: 1, unknownLegacyPaths: [] });
    await writeFile(join(legacy, "fence.json"), "only the flag-owned adapter creates this");
    await expect(purge.preflightLogout({ principal: PRINCIPAL }))
      .rejects.toThrow(/fence.json/);
    await rm(join(legacy, "fence.json"));
    expect(await purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .toMatchObject({ v: 1 });
    expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
    expect(existsSync(join(legacy, "replica.db"))).toBe(true);
  });

  test.each(["absent", "inactive"] as const)(
    "%s gate accepts only a proven source-schema legacy mirror without discard",
    async (gateState) => {
      const dir = await makeDir();
      const profileDir = dirname(dir);
      const legacy = await makeLegacyMirror(profileDir);
      const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
      if (gateState === "absent") await rm(join(profileDir, REPLICA_GATE_FILE));
      else expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
      const approval = await purge.preflightLogout({ principal: PRINCIPAL });
      expect(approval).toMatchObject({ knownLegacyReplicas: 1, unknownPaths: [] });
      expect(await purge.prepareLogoutPending({ principal: PRINCIPAL, approval }))
        .toMatchObject({ v: gateState === "absent" ? 2 : 3 });
      expect(existsSync(join(legacy, "replica.db"))).toBe(true);
    },
  );

  test("original version-one mirror schema is source-known but a changed table is unknown", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    const db = new Database(join(legacy, "replica.db"));
    db.exec("DROP TABLE grant_install; PRAGMA user_version = 1");
    db.close();
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    expect(await purge.preflightLogout({ principal: PRINCIPAL }))
      .toMatchObject({ knownLegacyReplicas: 1, unknownLegacyPaths: [] });
    const altered = new Database(join(legacy, "replica.db"));
    altered.exec("ALTER TABLE entry ADD COLUMN local_write BLOB");
    altered.close();
    await expect(purge.preflightLogout({ principal: PRINCIPAL }))
      .rejects.toThrow(/replicas\/notes\/replica.db/);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
  });

  test.each(["active", "absent", "inactive"] as const)(
    "%s gate rejects an extra SQLite outbox table before a logout marker or remote revoke",
    async (gateState) => {
      const dir = await makeDir();
      const profileDir = dirname(dir);
      const legacy = await makeLegacyMirror(profileDir);
      const db = new Database(join(legacy, "replica.db"));
      db.exec("CREATE TABLE pending_outbox (id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
      db.run("INSERT INTO pending_outbox (id, body) VALUES (1, ?)", Buffer.from("unsynced"));
      db.close();
      const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
      if (gateState === "absent") await rm(join(profileDir, REPLICA_GATE_FILE));
      if (gateState === "inactive") {
        expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
      }
      const session = join(profileDir, "session.json");
      const key = join(profileDir, "key.json");
      await writeFile(session, "retained");
      await writeFile(key, "retained");
      await expect(purge.preflightLogout({ principal: PRINCIPAL }))
        .rejects.toThrow(/replicas\/notes\/replica.db/);
      await expect(purge.prepareLogoutPending({ principal: PRINCIPAL, remotePending: true }))
        .rejects.toThrow(/replicas\/notes\/replica.db/);
      expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
      expect(existsSync(session)).toBe(true);
      expect(existsSync(key)).toBe(true);
      expect(existsSync(join(legacy, "replica.db"))).toBe(true);
      const explicit = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
      expect(explicit.unknownEntries).toContainEqual(expect.objectContaining({
        path: "replicas/notes/replica.db", kind: "file",
      }));
    },
  );

  test("readonly preflight sees an uncheckpointed WAL outbox without approving its database", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    const db = new Database(join(legacy, "replica.db"));
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("CREATE TABLE pending_outbox (id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
      db.run("INSERT INTO pending_outbox (id, body) VALUES (1, ?)", Buffer.from("unsynced"));
      const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
      await expect(purge.preflightLogout({ principal: PRINCIPAL }))
        .rejects.toThrow(/replicas\/notes\/replica.db/);
      expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
      expect(db.query("SELECT COUNT(*) AS n FROM pending_outbox").get()).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });

  test.each(["before marker", "after marker"] as const)(
    "SQLite outbox added %s is refused before durable denial or remote revoke",
    async (phase) => {
      const dir = await makeDir();
      const profileDir = dirname(dir);
      const legacy = await makeLegacyMirror(profileDir);
      const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
      const approval = await purge.preflightLogout({ principal: PRINCIPAL });
      if (phase === "after marker") {
        await purge.prepareLogoutPending({ principal: PRINCIPAL, approval, remotePending: true });
      }
      const db = new Database(join(legacy, "replica.db"));
      db.exec("CREATE TABLE pending_outbox (id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
      db.close();
      if (phase === "before marker") {
        await expect(purge.prepareLogoutPending({
          principal: PRINCIPAL, approval, remotePending: true,
        })).rejects.toThrow(/replicas\/notes\/replica.db/);
        expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
      } else {
        expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true })).status)
          .toBe("unguarded");
        expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(true);
      }
      expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
      expect(existsSync(join(legacy, "replica.db"))).toBe(true);
    },
  );

  test("v1 preflight refuses unknown legacy state before marker, credentials, or remote revoke", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    await writeFile(join(legacy, "pending-v2.json"), "unsynced");
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "private");
    await writeFile(key, "private");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await expect(purge.preflightLogout({ principal: PRINCIPAL }))
      .rejects.toThrow(/sync first.*--discard-local-changes.*pending-v2.json/i);
    await expect(purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toThrow(/sync first.*--discard-local-changes.*pending-v2.json/i);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect(existsSync(session)).toBe(true);
    expect(existsSync(key)).toBe(true);
    expect(existsSync(join(legacy, "pending-v2.json"))).toBe(true);
    expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
  });

  test("v1 preflight reports unknown flag-owned children before marker or remote work", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const unknown = join(dir, "unknown-child", "private.bin");
    await mkdir(dirname(unknown));
    await writeFile(unknown, "unsynced");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await expect(purge.preflightLogout({ principal: PRINCIPAL }))
      .rejects.toThrow(/replication\/unknown-child\/private.bin/);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
    const report = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
    expect(report.unknownLegacyPaths).toContain("replication/unknown-child/private.bin");
  });

  test("v1 explicit discard reports unknown state and persists consent across crash recovery", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    await writeFile(join(legacy, "pending-v2.json"), "unsynced");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
    expect(approval).toMatchObject({
      knownLegacyReplicas: 0, unknownLegacyPaths: ["replicas/notes/pending-v2.json"],
    });
    const marker = await purge.prepareLogoutPending({
      principal: PRINCIPAL, discardLocalChanges: true, approval,
    });
    expect(marker).toMatchObject({ v: 1, discardLocalChanges: true });
    let callbackDiscard: boolean | undefined;
    const report = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: async ({ discardLocalChanges }) => {
        callbackDiscard = discardLocalChanges;
        await eraseLegacy(profileDir);
      },
    });
    expect(callbackDiscard).toBe(true);
    expect(report).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
  });

  test("exact discard approval refuses a new child before durable marker or remote action", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    const first = join(legacy, "pending-v2.json");
    await writeFile(first, "unsynced");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
    expect(approval.unknownEntries).toContainEqual(expect.objectContaining({
      path: "replicas/notes/pending-v2.json", kind: "file",
      dev: expect.any(String), ino: expect.any(String),
    }));
    await writeFile(join(legacy, "pending-v3.json"), "new changes");
    await expect(purge.prepareLogoutPending({
      principal: PRINCIPAL, discardLocalChanges: true, approval,
    })).rejects.toThrow(/pending-v3.json|inventory changed/i);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect(existsSync(first)).toBe(true);
    expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
  });

  test("remote-pending approval retains credentials, then changed inventory retains the cleanup marker", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    await writeFile(join(legacy, "pending-v2.json"), "first");
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "private");
    await writeFile(key, "private");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
    expect(await purge.prepareLogoutPending({
      principal: PRINCIPAL, discardLocalChanges: true, approval, remotePending: true,
    })).toMatchObject({ v: 1, remotePending: true });
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true })).status).toBe("denied");
    let cleanupCalls = 0;
    const recover = () => createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { cleanupCalls++; await rm(session, { force: true }); await rm(key, { force: true }); },
      eraseLegacyReplicas: async () => { cleanupCalls++; await eraseLegacy(profileDir); },
    });
    expect((await recover()).failed.length).toBeGreaterThan(0);
    expect(cleanupCalls).toBe(0);
    expect(existsSync(session)).toBe(true);
    expect(existsSync(key)).toBe(true);
    await purge.completeRemoteLogout({ principal: PRINCIPAL });
    await writeFile(join(legacy, "pending-v3.json"), "after approval");
    expect((await recover()).failed.length).toBeGreaterThan(0);
    expect(cleanupCalls).toBe(1); // credentials are shredded after verified remote success
    expect(existsSync(session)).toBe(false);
    expect(existsSync(key)).toBe(false);
    expect(existsSync(join(legacy, "pending-v2.json"))).toBe(true);
    expect(existsSync(join(legacy, "pending-v3.json"))).toBe(true);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(true);
    const fresh = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
    await purge.reapproveLogoutPending({ principal: PRINCIPAL, approval: fresh });
    expect((await recover()).failed).toEqual([]);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
  });

  test("remote-pending logout cannot reapprove a changed inventory before remote completion", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    await writeFile(join(legacy, "first"), "listed before any action");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
    await purge.prepareLogoutPending({
      principal: PRINCIPAL, discardLocalChanges: true, approval, remotePending: true,
    });
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true })).status)
      .toBe("denied");
    const markerPath = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
    const before = await readFile(markerPath, "utf8");
    await writeFile(join(legacy, "second"), "not approved for remote-pending cleanup");
    const changed = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
    await expect(purge.reapproveLogoutPending({ principal: PRINCIPAL, approval: changed }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(await readFile(markerPath, "utf8")).toBe(before);
    expect((await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { throw new Error("remote incomplete"); },
      eraseLegacyReplicas: async () => { throw new Error("remote incomplete"); },
    })).remaining).toBeGreaterThan(0);
    expect(existsSync(join(legacy, "second"))).toBe(true);
  });

  test("a plain marker cannot silently become a remote-pending marker", async () => {
    const dir = await makeDir();
    const purge = createProfileReplicaPurge({ profileDir: dirname(dir), guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL });
    await purge.prepareLogoutPending({ principal: PRINCIPAL, approval });
    await expect(purge.prepareLogoutPending({ principal: PRINCIPAL, approval, remotePending: true }))
      .rejects.toMatchObject({ code: "REPLICA_GATED" });
    expect(await purge.remotePendingLogout({ principal: PRINCIPAL })).toBe(false);
  });

  test("remote completion and abandon fail closed when the gate cannot be read", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-remote-gate-"));
    dirs.push(profileDir);
    await mkdir(join(profileDir, "replication"));
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL });
    await purge.prepareLogoutPending({ principal: PRINCIPAL, remotePending: true });
    await writeFile(join(profileDir, REPLICA_GATE_FILE), "{broken");
    await expect(purge.remotePendingLogout({ principal: PRINCIPAL }))
      .rejects.toMatchObject({ code: "REPLICA_GATED" });
    await expect(purge.completeRemoteLogout({ principal: PRINCIPAL }))
      .rejects.toMatchObject({ code: "REPLICA_GATED" });
    await expect(purge.abandonRemoteLogout({ principal: PRINCIPAL, approval }))
      .rejects.toMatchObject({ code: "REPLICA_GATED" });
    expect(JSON.parse(await readFile(join(profileDir, REPLICA_LOGOUT_PENDING_FILE), "utf8")))
      .toMatchObject({ remotePending: true });
  });

  test("plain abandon after a denied remote failure keeps its distinct state through interrupted recovery", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "session private");
    await writeFile(key, "owner private");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL });
    await purge.prepareLogoutPending({ principal: PRINCIPAL, approval, remotePending: true });
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true })).status)
      .toBe("denied");
    await expect(purge.abandonRemoteLogout({ principal: "did:key:Successor", approval }))
      .rejects.toMatchObject({ gate: "principal_mismatch" });
    const fresh = await purge.preflightLogout({ principal: PRINCIPAL });
    const abandoned = await purge.abandonRemoteLogout({ principal: PRINCIPAL, approval: fresh });
    expect(abandoned.remoteAbandoned).toBe(true);
    expect(abandoned.remotePending).toBeUndefined();
    const markerPath = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
    const first = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { await rm(session); throw new Error("interrupted"); },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(first.failed).toHaveLength(1);
    expect(existsSync(key)).toBe(true);
    expect(existsSync(legacy)).toBe(true);
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toMatchObject({ remoteAbandoned: true });
    expect(await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { await rm(session, { force: true }); await rm(key, { force: true }); },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    })).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(key)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
  });

  test("plain override after failed remote revoke refuses changed inventory before marker or credential mutation", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "session private");
    await writeFile(key, "owner private");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL });
    await purge.prepareLogoutPending({ principal: PRINCIPAL, approval, remotePending: true });
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true })).status)
      .toBe("denied");
    const markerFile = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
    const before = await readFile(markerFile, "utf8");
    const unknown = join(legacy, "new-unsynced");
    await writeFile(unknown, "local change after remote failure");
    await expect(purge.abandonRemoteLogout({ principal: PRINCIPAL, approval }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(await readFile(markerFile, "utf8")).toBe(before);
    expect(await readFile(session, "utf8")).toBe("session private");
    expect(await readFile(key, "utf8")).toBe("owner private");
    expect(await readFile(unknown, "utf8")).toBe("local change after remote failure");
    const fresh = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
    expect(fresh.unknownEntries).toContainEqual(expect.objectContaining({
      path: "replicas/notes/new-unsynced", kind: "file",
    }));
    const abandoned = await purge.abandonRemoteLogout({
      principal: PRINCIPAL, approval: fresh, discardLocalChanges: true,
    });
    expect(abandoned).toMatchObject({ remoteAbandoned: true, discardLocalChanges: true });
    expect(abandoned.approvedUnknown).toContainEqual(expect.objectContaining({
      path: "replicas/notes/new-unsynced", kind: "file",
    }));
    expect(await readFile(session, "utf8")).toBe("session private");
    expect(await readFile(key, "utf8")).toBe("owner private");
  });

  test("consumed deferred denial still accepts remote completion or explicit abandon at its original epoch", async () => {
    for (const transition of ["completeRemoteLogout", "abandonRemoteLogout"] as const) {
      const dir = await makeDir();
      const profileDir = dirname(dir);
      const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
      const approval = await purge.preflightLogout({ principal: PRINCIPAL });
      await purge.prepareLogoutPending({ principal: PRINCIPAL, approval, remotePending: true });
      const denied = await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true });
      expect(denied.status).toBe("denied");
      await purge.resumeDeferredErase(denied.resumeToken!, { signal: new AbortController().signal });
      expect(await purge.remotePendingLogout({ principal: PRINCIPAL })).toBe(true);
      const converted = transition === "completeRemoteLogout"
        ? await purge.completeRemoteLogout({ principal: PRINCIPAL })
        : await purge.abandonRemoteLogout({
          principal: PRINCIPAL, approval: await purge.preflightLogout({ principal: PRINCIPAL }),
        });
      expect(converted.remotePending).toBeUndefined();
      expect(converted.remoteAbandoned).toBe(transition === "abandonRemoteLogout" ? true : undefined);
    }
  });

  test("successor epoch fences completion and abandonment of the old remote marker", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL });
    await purge.prepareLogoutPending({ principal: PRINCIPAL, remotePending: true });
    const denied = await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true });
    expect(denied.status).toBe("denied");
    await purge.resumeDeferredErase(denied.resumeToken!, { signal: new AbortController().signal });
    const deniedAt = (await readGateSnapshot(profileDir))!.deniedAt!;
    const originalNow = Date.now();
    try {
      setSystemTime(new Date(deniedAt + 2));
      await establishSessionStamp(profileDir, "did:key:Successor", { siweIssuedAt: deniedAt + 1 });
    } finally { setSystemTime(originalNow); }
    await expect(purge.completeRemoteLogout({ principal: PRINCIPAL }))
      .rejects.toMatchObject({ code: "REPLICA_GATED" });
    await expect(purge.abandonRemoteLogout({ principal: PRINCIPAL, approval }))
      .rejects.toMatchObject({ code: "REPLICA_GATED" });
    expect(JSON.parse(await readFile(join(profileDir, REPLICA_LOGOUT_PENDING_FILE), "utf8")))
      .toMatchObject({ remotePending: true });
  });

  test("an approved unknown base32 identity directory is inventoried, not collected as an intent", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const unknown = join(dir, "a".repeat(26));
    await mkdir(unknown);
    await writeFile(join(unknown, "private.bin"), "unrecognized");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
    expect(approval.unknownPaths).toContain(`replication/${"a".repeat(26)}`);
    await purge.prepareLogoutPending({ principal: PRINCIPAL, discardLocalChanges: true, approval });
    const denied = await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true });
    expect(denied).toMatchObject({ status: "denied", intents: 0 });
    expect(await purge.pendingPurge()).toEqual([]);
    const result = await purge.recoverLogoutPending({
      signal: new AbortController().signal, clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    });
    expect(result).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(unknown)).toBe(false);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
  });

  test("only a denied remote-pending profile permits a network-only retry, then plain logout abandons remote revocation", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "private");
    await writeFile(key, "private");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL });
    await purge.prepareLogoutPending({ principal: PRINCIPAL, approval, remotePending: true });
    await expect(purge.remotePendingLogout({ principal: PRINCIPAL }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true })).status)
      .toBe("denied");
    expect(await purge.remotePendingLogout({ principal: PRINCIPAL })).toBe(true);
    await expect(purge.remotePendingLogout({ principal: `${PRINCIPAL}:other` }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "principal_mismatch" });
    expect((await purge.abandonRemoteLogout({
      principal: PRINCIPAL, approval: await purge.preflightLogout({ principal: PRINCIPAL }),
    })))
      .toMatchObject({ v: 1, remoteAbandoned: true });
    expect(await purge.remotePendingLogout({ principal: PRINCIPAL })).toBe(false);
    const report = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { await rm(session); await rm(key); },
      eraseLegacyReplicas: async () => { await eraseLegacy(profileDir); },
    });
    expect(report).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(session)).toBe(false);
    expect(existsSync(key)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
  });

  test.each(["orphan", "inactive"] as const)(
    "%s remote-pending retry is bound to the selected original principal",
    async (gateState) => {
      const dir = await makeDir();
      const profileDir = dirname(dir);
      const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
      if (gateState === "orphan") await rm(join(profileDir, REPLICA_GATE_FILE));
      else expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
      const approval = await purge.preflightLogout({ principal: PRINCIPAL });
      expect(await purge.prepareLogoutPending({
        principal: PRINCIPAL, approval, remotePending: true,
      })).toMatchObject({ v: gateState === "orphan" ? 2 : 3, remotePending: true });
      await expect(purge.remotePendingLogout({ principal: `${PRINCIPAL}:other` }))
        .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "principal_mismatch" });
      expect(await purge.remotePendingLogout({ principal: PRINCIPAL })).toBe(true);
      expect((await purge.abandonRemoteLogout({
        principal: PRINCIPAL, approval: await purge.preflightLogout({ principal: PRINCIPAL }),
      })).remoteAbandoned).toBe(true);
    },
  );

  test("plain logout can abandon a remote-pending marker even when defer-deny failed", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "private");
    await writeFile(key, "private");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL });
    await purge.prepareLogoutPending({ principal: PRINCIPAL, approval, remotePending: true });
    expect((await purge.abandonRemoteLogout({
      principal: PRINCIPAL, approval: await purge.preflightLogout({ principal: PRINCIPAL }),
    })))
      .toMatchObject({ v: 1, remoteAbandoned: true });
    const report = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { await rm(session); await rm(key); },
      eraseLegacyReplicas: async () => {},
    });
    expect(report).toMatchObject({ failed: [], remaining: 0 });
    expect((await readGateSnapshot(profileDir))?.principalHash).toBeNull();
    expect(existsSync(session)).toBe(false);
    expect(existsSync(key)).toBe(false);
  });

  test("new flag data after approval blocks deferred denial until it is listed again", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const unknownDir = join(dir, "unknown-child");
    await mkdir(unknownDir);
    await writeFile(join(unknownDir, "first"), "first");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
    expect(await purge.prepareLogoutPending({
      principal: PRINCIPAL, discardLocalChanges: true, approval, remotePending: true,
    })).toMatchObject({ v: 1, remotePending: true });
    await writeFile(join(unknownDir, "second"), "new unsynced data");
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true })).status)
      .toBe("unguarded");
    expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
    expect(existsSync(join(unknownDir, "first"))).toBe(true);
    expect(existsSync(join(unknownDir, "second"))).toBe(true);
    const fresh = await purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true });
    expect(fresh.unknownPaths).toContain("replication/unknown-child/second");
    await expect(purge.reapproveLogoutPending({ principal: PRINCIPAL, approval: fresh }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    await rm(join(unknownDir, "second"));
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true })).status)
      .toBe("denied");
    expect((await readGateSnapshot(profileDir))?.principalHash).toBeNull();
  });

  test("verified scoped logout removes flag-owned roots before clearing its crash marker", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    await handle.close();
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const approval = await purge.preflightLogout({ principal: PRINCIPAL });
    expect(approval.unknownPaths).toEqual([]);
    await purge.prepareLogoutPending({ principal: PRINCIPAL, approval });
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
    const report = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    });
    expect(report).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
  });

  test("v1 preflight and final marker stay on the pinned profile after a named-path replacement", async () => {
    if (process.platform !== "linux") return;
    const dir = await makeDir();
    const named = dirname(dir);
    const moved = `${named}-moved`;
    const outside = await mkdtemp(join(tmpdir(), "tc858-v1-outside-"));
    dirs.push(moved, outside);
    await makeLegacyMirror(named);
    await mkdir(join(outside, "replicas"));
    await writeFile(join(outside, "replicas", "keep"), "outside");
    const handle = await openFile(named, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const pinned = `/proc/self/fd/${handle.fd}`;
    try {
      const purge = createProfileReplicaPurge({ profileDir: pinned, guard: sharedGuard });
      const approval = await purge.preflightLogout({ principal: PRINCIPAL });
      expect(approval).toMatchObject({ knownLegacyReplicas: 1, unknownLegacyPaths: [] });
      await rename(named, moved);
      await symlink(outside, named, "dir");
      expect(await purge.prepareLogoutPending({ principal: PRINCIPAL, approval })).toMatchObject({ v: 1 });
      expect(existsSync(join(moved, REPLICA_LOGOUT_PENDING_FILE))).toBe(true);
      expect(existsSync(join(outside, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
      expect(existsSync(join(outside, "replicas", "keep"))).toBe(true);
    } finally {
      await handle.close();
    }
  });

  test("already-denied gate still persists a marker for legacy cleanup across credential-unlink crash", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    await writeFile(join(legacy, "pending-v2.json"), "unsynced");
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "private session");
    await writeFile(key, "private key");
    const storage = createSqliteReplicaStorage(storageOptions());
    await storage.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! })
      .update((state) => { state.seq = 1; });
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
    await expect(purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toThrow(/sync first.*--discard-local-changes/i);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    const marker = await prepareApproved(purge);
    expect(marker).toMatchObject({ v: 3, scope: "inactive_gate" });
    await rm(session);
    await rm(key);
    const restarted = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const report = await restarted.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(report).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(join(profileDir, "replicas"))).toBe(false);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect(await filesNamed(dir, "pending.json")).toEqual([]);
  });

  test("inactive gate with only pending intents still requires a crash-replay marker", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const storage = createSqliteReplicaStorage(storageOptions());
    await storage.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! })
      .update((state) => { state.seq = 1; });
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
    expect(await purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .toMatchObject({ v: 3, scope: "inactive_gate" });
    const report = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    });
    expect(report).toMatchObject({ failed: [], remaining: 0 });
    expect(await filesNamed(dir, "pending.json")).toEqual([]);
  });

  test("inactive gate marker cannot erase a successor account's legacy files", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = join(profileDir, "replicas", "notes");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "replica.db"), "keep");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
    await prepareApproved(purge);
    const deniedAt = (await readGateSnapshot(profileDir))!.deniedAt!;
    const originalNow = Date.now();
    try {
      setSystemTime(new Date(deniedAt + 2));
      await establishSessionStamp(profileDir, "did:key:Successor", { siweIssuedAt: deniedAt + 1 });
    } finally {
      setSystemTime(originalNow);
    }
    const report = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(report.failed).toEqual([{ id: "logout", code: "stamp_stale" }]);
    expect(existsSync(join(legacy, "replica.db"))).toBe(true);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(true);
  });

  test("missing gate with profile replica files writes an orphan marker and recovers after a crash", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-replica-"));
    dirs.push(profileDir);
    const replicaRoot = join(profileDir, "replication");
    const legacyRoot = join(profileDir, "replicas");
    const partition = join(replicaRoot, "a".repeat(26));
    const replicaDir = join(partition, "replicas", "b".repeat(26));
    await mkdir(replicaDir, { recursive: true });
    await mkdir(join(legacyRoot, "notes"), { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify(identity()));
    await writeFile(join(replicaDir, "replica.db"), "ciphertext");
    await writeFile(join(legacyRoot, "notes", "replica.db"), "legacy");
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "session private key");
    await writeFile(key, "owner private key");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const marker = await prepareApproved(purge);
    expect(marker).toMatchObject({ v: 2, scope: "orphan_profile" });
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(true);
    expect(existsSync(session)).toBe(true);
    expect(() => assertProfileLogoutClear(profileDir)).toThrow();
    const restarted = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { await rm(session); await rm(key); },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(restarted).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(session)).toBe(false);
    expect(existsSync(key)).toBe(false);
    expect(existsSync(replicaRoot)).toBe(false);
    expect(existsSync(legacyRoot)).toBe(false);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect(await readGateSnapshot(profileDir)).toBeUndefined();
  });

  test("pinned proc-fd profile refuses unknown writes and wipes only its original directory after replacement", async () => {
    if (process.platform !== "linux") return;
    const named = await mkdtemp(join(tmpdir(), "tc858-pinned-profile-"));
    const moved = `${named}-moved`;
    const outside = await mkdtemp(join(tmpdir(), "tc858-pinned-outside-"));
    dirs.push(named, moved, outside);
    await mkdir(join(named, "replication", "unknown-child"), { recursive: true });
    await writeFile(join(named, "replication", "unknown-child", "pending.json"), "unsynced");
    await writeFile(join(named, "session.json"), "private session");
    await writeFile(join(named, "key.json"), "private key");
    await mkdir(join(outside, "replication"));
    await writeFile(join(outside, "replication", "keep.db"), "outside");
    const handle = await openFile(named, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const pinned = `/proc/self/fd/${handle.fd}`;
    try {
      const purge = createProfileReplicaPurge({ profileDir: pinned, guard: sharedGuard });
      await expect(purge.prepareLogoutPending({ principal: PRINCIPAL }))
        .rejects.toThrow(/sync first.*--discard-local-changes/i);
      expect(existsSync(join(named, "session.json"))).toBe(true);
      expect(existsSync(join(named, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
      expect(await prepareApproved(purge))
        .toMatchObject({ v: 2, scope: "orphan_profile" });
      await rename(named, moved);
      await symlink(outside, named, "dir");
      const report = await purge.recoverLogoutPending({
        signal: new AbortController().signal,
        clearCredentials: async () => {
          await rm(join(pinned, "session.json"));
          await rm(join(pinned, "key.json"));
        },
        eraseLegacyReplicas: async () => {},
      });
      expect(report).toMatchObject({ failed: [], remaining: 0 });
      expect(existsSync(join(moved, "replication"))).toBe(false);
      expect(existsSync(join(moved, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
      expect(existsSync(join(outside, "replication", "keep.db"))).toBe(true);
      expect(existsSync(join(outside, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    } finally {
      await handle.close();
    }
  });

  test("arbitrary profile aliases and closed descriptor pins fail closed even without replica roots", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-profile-alias-"));
    const alias = `${profileDir}-alias`;
    dirs.push(profileDir, alias);
    await symlink(profileDir, alias, "dir");
    await expect(createProfileReplicaPurge({ profileDir: alias, guard: sharedGuard })
      .prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    await rm(alias);
    const handle = await openFile(profileDir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const pinned = `/proc/self/fd/${handle.fd}`;
    await handle.close();
    await expect(createProfileReplicaPurge({ profileDir: pinned, guard: sharedGuard })
      .prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
  });

  test("orphan wipe refuses unsynced pending records until explicit discard consent", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-pending-"));
    dirs.push(profileDir);
    const replicaRoot = join(profileDir, "replication");
    const partition = join(replicaRoot, "a".repeat(26));
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify(identity()));
    await writeFile(join(partition, "pending.json"), JSON.stringify({
      v: 2, identity: identity(), committedEpoch: 1, seq: 1,
      records: [{ opId: "pending", seq: 1, key: "notes/a", op: "put", state: "committed", epoch: 1 }],
    }));
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await expect(purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toThrow(/sync first.*--discard-local-changes/i);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect(await prepareApproved(purge))
      .toMatchObject({ v: 2, scope: "orphan_profile" });
    const recovered = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    });
    expect(recovered).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(replicaRoot)).toBe(false);
  });

  test("nested legacy state and symlinks are indeterminate without explicit discard", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-legacy-"));
    const outside = await mkdtemp(join(tmpdir(), "tc858-legacy-outside-"));
    dirs.push(profileDir, outside);
    const root = join(profileDir, "replicas");
    const legacy = join(root, "notes");
    await mkdir(join(legacy, "nested"), { recursive: true });
    await writeFile(join(legacy, "nested", "pending.json"), "unsynced state");
    await writeFile(join(outside, "keep.db"), "outside");
    await symlink(outside, join(legacy, "linked"), "dir");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await expect(purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toThrow(/sync first.*--discard-local-changes/i);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect(await prepareApproved(purge))
      .toMatchObject({ v: 2, scope: "orphan_profile" });
    const report = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(report).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(outside, "keep.db"))).toBe(true);
  });

  test("named-path preflight refuses a symlink before approving or unlinking credentials", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacy = await makeLegacyMirror(profileDir);
    const outside = await mkdtemp(join(tmpdir(), "tc858-named-outside-"));
    dirs.push(outside);
    const link = join(legacy, "linked");
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(join(outside, "keep"), "outside");
    await symlink(outside, link, "dir");
    await writeFile(session, "private");
    await writeFile(key, "private");
    const platform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "darwin" });
      const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
      await expect(purge.preflightLogout({ principal: PRINCIPAL, discardLocalChanges: true }))
        .rejects.toThrow(/symlink.*cannot be removed safely/);
      await expect(purge.prepareLogoutPending({ principal: PRINCIPAL, discardLocalChanges: true }))
        .rejects.toThrow(/symlink.*cannot be removed safely/);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect(existsSync(session)).toBe(true);
    expect(existsSync(key)).toBe(true);
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("outside");
  });

  test("missing flag pending index refuses even a known identity without discard", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-no-index-"));
    dirs.push(profileDir);
    const partition = join(profileDir, "replication", "a".repeat(26));
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify(identity()));
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await expect(purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toThrow(/sync first.*--discard-local-changes/i);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
  });

  test("unrecognized flag child refuses beside a missing or empty pending index", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-v2-pending-"));
    dirs.push(profileDir);
    const partition = join(profileDir, "replication", "a".repeat(26));
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify(identity()));
    await writeFile(join(partition, "pending-v2.json"), "unsynced state");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await expect(purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toThrow(/sync first.*--discard-local-changes/i);
    await writeFile(join(partition, "pending.json"), JSON.stringify({
      v: 2, identity: identity(), committedEpoch: 1, seq: 1, records: [],
    }));
    await expect(purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toThrow(/sync first.*--discard-local-changes/i);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect(await prepareApproved(purge))
      .toMatchObject({ v: 2, scope: "orphan_profile" });
  });

  test("an inspected empty pending file does not require discard consent", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-synced-"));
    dirs.push(profileDir);
    const partition = join(profileDir, "replication", "a".repeat(26));
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify(identity()));
    await writeFile(join(partition, "pending.json"), JSON.stringify({
      v: 2, identity: identity(), committedEpoch: 1, seq: 1, records: [],
    }));
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    expect(await purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .toMatchObject({ v: 2, scope: "orphan_profile" });
  });

  test("partition replay removes an approved leftover after its database disappears", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    await handle.close();
    const [id] = await readdir(dir);
    const [partitionName] = await readdir(join(dir, id!, "replicas"));
    const partition = join(dir, id!, "replicas", partitionName!);
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    const denied = await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true });
    expect(denied).toMatchObject({ status: "denied", intents: 2 });
    await rm(join(partition, "replica.db"));
    const result = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal, clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    });
    expect(result).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(partition)).toBe(false);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
  });


  test("orphan v2 removes a verified empty pending index and its identity on recovery", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-clean-"));
    dirs.push(profileDir);
    const partition = join(profileDir, "replication", "a".repeat(26));
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify(identity()));
    await writeFile(join(partition, "pending.json"), JSON.stringify({
      v: 2, identity: identity(), committedEpoch: 1, seq: 1, records: [],
    }));
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    expect(await purge.prepareLogoutPending({ principal: PRINCIPAL })).toMatchObject({ v: 2 });
    const result = await purge.recoverLogoutPending({
      signal: new AbortController().signal, clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    });
    expect(result).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(partition)).toBe(false);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
  });

  test.each([{ removed: ["pending.json"] }, { removed: ["pending.json", "identity.json"] }])(
    "orphan v2 replays after approved control files were unlinked: %j",
    async ({ removed }) => {
      const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-replay-"));
      dirs.push(profileDir);
      const partition = join(profileDir, "replication", "a".repeat(26));
      await mkdir(partition, { recursive: true });
      await writeFile(join(partition, "identity.json"), JSON.stringify(identity()));
      await writeFile(join(partition, "pending.json"), JSON.stringify({
        v: 2, identity: identity(), committedEpoch: 1, seq: 1, records: [],
      }));
      const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
      await purge.prepareLogoutPending({ principal: PRINCIPAL });
      for (const name of removed) await rm(join(partition, name));
      expect(await purge.recoverLogoutPending({
        signal: new AbortController().signal, clearCredentials: async () => {},
        eraseLegacyReplicas: async () => {},
      })).toMatchObject({ failed: [], remaining: 0 });
      expect(existsSync(partition)).toBe(false);
      expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    },
  );

  test("orphan replay removes an approved empty replicas root after identity cleanup was interrupted", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-root-replay-"));
    dirs.push(profileDir);
    const partition = join(profileDir, "replication", "a".repeat(26));
    await mkdir(join(partition, "replicas"), { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify(identity()));
    await writeFile(join(partition, "pending.json"), JSON.stringify({
      v: 2, identity: identity(), committedEpoch: 1, seq: 1, records: [],
    }));
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await prepareApproved(purge);
    await rm(join(partition, "pending.json"));
    await rm(join(partition, "identity.json"));
    expect(await purge.recoverLogoutPending({
      signal: new AbortController().signal, clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    })).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(partition)).toBe(false);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
  });

  test("orphan v2 requires discard for device.jwk then removes only its approved inode", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-device-"));
    dirs.push(profileDir);
    const partition = join(profileDir, "replication", "a".repeat(26));
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify(identity()));
    await writeFile(join(partition, "pending.json"), JSON.stringify({
      v: 2, identity: identity(), committedEpoch: 1, seq: 1, records: [],
    }));
    await writeFile(join(partition, "device.jwk"), "private");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await expect(purge.prepareLogoutPending({ principal: PRINCIPAL })).rejects.toThrow(/discard-local-changes/);
    expect(await prepareApproved(purge)).toMatchObject({ v: 2, discardLocalChanges: true });
    const result = await purge.recoverLogoutPending({
      signal: new AbortController().signal, clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    });
    expect(result).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(partition)).toBe(false);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
  });

  test("orphan v2 refuses a replaced known device inode and retains its marker", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-device-swap-"));
    dirs.push(profileDir);
    const partition = join(profileDir, "replication", "a".repeat(26));
    await mkdir(partition, { recursive: true });
    await writeFile(join(partition, "identity.json"), JSON.stringify(identity()));
    await writeFile(join(partition, "pending.json"), JSON.stringify({
      v: 2, identity: identity(), committedEpoch: 1, seq: 1, records: [],
    }));
    const devicePath = join(partition, "device.jwk");
    await writeFile(devicePath, "original key");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await prepareApproved(purge);
    await rename(devicePath, join(profileDir, "saved-key"));
    await writeFile(devicePath, "replacement key");
    const result = await purge.recoverLogoutPending({
      signal: new AbortController().signal, clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    });
    expect(result.failed).toHaveLength(1);
    expect(existsSync(devicePath)).toBe(true);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(true);
  });

  test("unrecognized orphan-root files require explicit discard before any marker write", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-unknown-"));
    dirs.push(profileDir);
    const root = join(profileDir, "replication");
    await mkdir(root);
    await writeFile(join(root, "pending.json"), "unknown layout");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await expect(purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toThrow(/sync first.*--discard-local-changes/i);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect(await prepareApproved(purge))
      .toMatchObject({ v: 2, scope: "orphan_profile" });
  });

  test("corrupt gate requires explicit discard even when pending writes cannot be inspected", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-corrupt-gate-"));
    dirs.push(profileDir);
    await mkdir(join(profileDir, "replication"));
    await writeFile(join(profileDir, REPLICA_GATE_FILE), "{invalid");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await expect(purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toThrow(/sync first.*--discard-local-changes/i);
    expect(await prepareApproved(purge))
      .toMatchObject({ v: 2, scope: "orphan_profile" });
    const result = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    });
    expect(result).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(join(profileDir, "replication"))).toBe(false);
    await expect(readGateSnapshot(profileDir)).rejects.toMatchObject({ code: "REPLICA_GATED" });
  });

  test("orphan cleanup refuses a symlink root and retains its marker after a root swap", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "tc858-outside-"));
    dirs.push(profileDir, outside);
    await writeFile(join(outside, "keep.db"), "outside");
    const root = join(profileDir, "replication");
    await symlink(outside, root, "dir");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await expect(prepareApproved(purge))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    await rm(root);
    await mkdir(root);
    await writeFile(join(root, "ciphertext.db"), "replica");
    await prepareApproved(purge);
    await rm(root, { recursive: true });
    await symlink(outside, root, "dir");
    const failed = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    });
    expect(failed).toMatchObject({ failed: [{ id: "logout", code: "gate_unavailable" }], remaining: 1 });
    expect(existsSync(join(outside, "keep.db"))).toBe(true);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(true);
    await rm(root);
    const resumed = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    });
    expect(resumed).toMatchObject({ failed: [], remaining: 0 });
  });

  test("orphan marker fsync failure leaves credentials and replica files intact", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-fsync-"));
    dirs.push(profileDir);
    const root = join(profileDir, "replication");
    await mkdir(root);
    await writeFile(join(root, "replica.db"), "ciphertext");
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "session");
    await writeFile(key, "key");
    const broken = createProfileReplicaPurge({
      profileDir, guard: sharedGuard,
      dirSync: async () => { throw Object.assign(new Error("marker fsync failed"), { code: "EIO" }); },
    });
    await expect(prepareApproved(broken))
      .rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(existsSync(session)).toBe(true);
    expect(existsSync(key)).toBe(true);
    expect(existsSync(join(root, "replica.db"))).toBe(true);
    // Rename may have reached disk, but without the directory fsync the caller must not
    // claim a durable logout. A surviving marker remains independently resumable.
    const marker = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
    expect(existsSync(marker)).toBe(true);
    const recovered = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { await rm(session); await rm(key); },
      eraseLegacyReplicas: async () => {},
    });
    expect(recovered).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(root)).toBe(false);
  });

  test("orphan recovery keeps the marker when credential cleanup is interrupted", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-credentials-"));
    dirs.push(profileDir);
    const root = join(profileDir, "replication");
    await mkdir(root);
    await writeFile(join(root, "replica.db"), "ciphertext");
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "session");
    await writeFile(key, "key");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await prepareApproved(purge);
    const marker = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
    const interrupted = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {
        expect(existsSync(marker)).toBe(true);
        await rm(key);
        throw Object.assign(new Error("credential cleanup interrupted"), { code: "EIO" });
      },
      eraseLegacyReplicas: async () => {},
    });
    expect(interrupted).toMatchObject({ failed: [{ id: "logout", code: "EIO" }] });
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(session)).toBe(true);
    expect(existsSync(root)).toBe(true);
    const recovered = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { await rm(session, { force: true }); await rm(key, { force: true }); },
      eraseLegacyReplicas: async () => {},
    });
    expect(recovered).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  test("orphan marker blocks a fresh replica establish until the crash recovery finishes", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-orphan-signin-"));
    dirs.push(profileDir);
    await mkdir(join(profileDir, "replication"));
    await writeFile(join(profileDir, "replication", "ciphertext.db"), "replica");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await prepareApproved(purge);
    const storage = createSqliteReplicaStorage({
      ...storageOptions(), dir: join(profileDir, "replication"),
      logoutPendingFile: join(profileDir, REPLICA_LOGOUT_PENDING_FILE),
    });
    await expect(storage.lifecycle!.establishSessionStamp(PRINCIPAL, {
      consentAnchor: { at: Date.now(), source: "siwe" },
    })).rejects.toMatchObject({ code: "REPLICA_GATED" });
    expect(await readGateSnapshot(profileDir)).toBeUndefined();
  });

  test("active gate without a marker is a legitimate uncommitted sign-in, not an abandoned logout", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    let cleanupCalls = 0;
    const result = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { cleanupCalls++; },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(result).toEqual({ erased: [], failed: [], remaining: 0 });
    expect(cleanupCalls).toBe(0);
    expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
  });

  test("no-marker recovery reports ordinary intents without mistaking them for a logout marker", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const storage = createSqliteReplicaStorage(storageOptions());
    await storage.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! })
      .update((state) => { state.seq = 1; });
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    expect((await purge.deny({ reason: "sign_out", principal: PRINCIPAL })).status).toBe("denied");
    let cleanupCalls = 0;
    const report = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { cleanupCalls++; },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(report).toEqual({ erased: [], failed: [], remaining: 1 });
    expect(cleanupCalls).toBe(0);
    expect(await filesNamed(dir, "pending.json")).toHaveLength(1);
  });

  test("zero-intent deferred logout still needs its durable marker to clear credentials", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    const denied = await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true });
    expect(denied).toMatchObject({ status: "denied", intents: 0 });
    expect(await purge.pendingPurge()).toEqual([]);
    expect(await purge.deferredErase()).not.toBeNull();
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    let cleanupCalls = 0;
    const report = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { cleanupCalls++; },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(report).toEqual({ erased: [], failed: [], remaining: 0 });
    expect(cleanupCalls).toBe(1);
    expect(await purge.deferredErase()).toBeNull();
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
  });

  test("successful remote revoke converts deferred denial only after shredding both credentials", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, JSON.stringify({ jwk: { d: "private" } }));
    await writeFile(key, JSON.stringify({ d: "private" }));
    const storage = createSqliteReplicaStorage(storageOptions());
    await storage.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! })
      .update((state) => { state.seq = 1; });
    const pendingFiles = await filesNamed(dir, "pending.json");
    const durableBoundaries: Array<{ session: boolean; key: boolean; marker: boolean }> = [];
    const purge = createProfileReplicaPurge({
      profileDir,
      guard: sharedGuard,
      dirSync: async (path) => {
        const handle = await openFile(path, "r");
        try { await handle.sync(); } finally { await handle.close(); }
        durableBoundaries.push({
          session: existsSync(session),
          key: existsSync(key),
          marker: existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE)),
        });
      },
    });
    const denied = await purge.deny({ reason: "sign_out", principal: PRINCIPAL }, { deferErase: true });
    expect(denied.status).toBe("denied");
    expect((await purge.recover({ signal: new AbortController().signal })).remaining).toBeGreaterThan(0);
    expect(await filesNamed(dir, "pending.json")).toEqual(pendingFiles);
    expect(existsSync(session)).toBe(true);
    expect(existsSync(key)).toBe(true);
    // The caller invokes this seam only after verified remote revoke success.
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    const result = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { await rm(session, { force: true }); await rm(key, { force: true }); },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(result.failed).toEqual([]);
    expect(result.remaining).toBe(0);
    expect(existsSync(session)).toBe(false);
    expect(existsSync(key)).toBe(false);
    expect(await filesNamed(dir, "pending.json")).toEqual([]);
    expect(durableBoundaries).toEqual([
      { session: true, key: true, marker: true },
      { session: false, key: false, marker: true },
      { session: false, key: false, marker: true },
      { session: false, key: false, marker: false },
    ]);
    expect(await purge.deferredErase()).toBeNull();
  });

  test("legacy root is removed only after full gate intent commit and before marker clear", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacyRoot = join(profileDir, "replicas");
    const marker = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
    await makeLegacyMirror(profileDir);
    await writeFile(join(profileDir, "session.json"), "{}");
    await writeFile(join(profileDir, "key.json"), "{}");
    const storage = createSqliteReplicaStorage(storageOptions());
    await storage.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! })
      .update((state) => { state.seq = 1; });
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    const report = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {
        await rm(join(profileDir, "session.json"));
        await rm(join(profileDir, "key.json"));
      },
      eraseLegacyReplicas: async () => {
        const gate = await readGateSnapshot(profileDir);
        expect(gate?.principalHash).toBeNull();
        expect(gate?.intents).toHaveLength(1);
        expect(existsSync(marker)).toBe(true);
        expect(await filesNamed(dir, "pending.json")).toHaveLength(1);
        expect(existsSync(join(profileDir, "session.json"))).toBe(false);
        expect(existsSync(join(profileDir, "key.json"))).toBe(false);
        await rm(legacyRoot, { recursive: true });
      },
    });
    expect(report).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(legacyRoot)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(await filesNamed(dir, "pending.json")).toEqual([]);
  });

  test("partial legacy cleanup failure keeps the marker and committed S3 intents for restart", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacyRoot = join(profileDir, "replicas");
    const marker = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
    await makeLegacyMirror(profileDir);
    const storage = createSqliteReplicaStorage(storageOptions());
    await storage.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! })
      .update((state) => { state.seq = 1; });
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    const failed = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: async () => { throw Object.assign(new Error("legacy erase failed"), { code: "EIO" }); },
    });
    expect(failed).toMatchObject({ failed: [{ id: "logout", code: "EIO" }], remaining: 1 });
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(legacyRoot)).toBe(true);
    expect((await readGateSnapshot(profileDir))?.principalHash).toBeNull();
    expect(await filesNamed(dir, "pending.json")).toHaveLength(1);
    const recovered = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: async () => { await rm(legacyRoot, { recursive: true }); },
    });
    expect(recovered).toMatchObject({ failed: [], remaining: 0 });
    expect(existsSync(marker)).toBe(false);
    expect(await filesNamed(dir, "pending.json")).toEqual([]);
  });

  test("interruption after legacy unlink but before marker clear retries idempotently", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacyRoot = join(profileDir, "replicas");
    const marker = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
    await makeLegacyMirror(profileDir);
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    const failed = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {
        await rm(legacyRoot, { recursive: true });
        throw Object.assign(new Error("crash after legacy unlink"), { code: "EIO" });
      },
    });
    expect(failed).toMatchObject({ failed: [{ id: "logout", code: "EIO" }], remaining: 1 });
    expect(existsSync(legacyRoot)).toBe(false);
    expect(existsSync(marker)).toBe(true);
    const restarted = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(restarted).toEqual({ erased: [], failed: [], remaining: 0 });
    expect(existsSync(marker)).toBe(false);
  });

  test("legacy cleanup callback cannot clear the marker while the physical legacy root survives", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const legacyRoot = join(profileDir, "replicas");
    const marker = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
    await makeLegacyMirror(profileDir);
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    const failed = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: async () => {},
    });
    expect(failed).toMatchObject({ failed: [{ id: "logout", code: "gate_unavailable" }], remaining: 1 });
    expect(existsSync(legacyRoot)).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  test("a failed credential unlink retains the marker and refuses every second-process read", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    await writeFile(session, "{}");
    await writeFile(key, "{}");
    const storage = createSqliteReplicaStorage(storageOptions({
      logoutPendingFile: join(profileDir, REPLICA_LOGOUT_PENDING_FILE),
    }));
    const handle = await storage.open(spec());
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    const failed = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { await rm(key); throw Object.assign(new Error("session unlink failed"), { code: "EIO" }); },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(failed).toMatchObject({ failed: [{ id: "logout", code: "EIO" }], remaining: 1 });
    expect(existsSync(session)).toBe(true);
    expect(existsSync(key)).toBe(false);
    await expect(handle.get("notes/a")).rejects.toMatchObject({ code: "REPLICA_GATED" });
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(true);
    const resumed = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { await rm(session, { force: true }); await rm(key, { force: true }); },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(resumed.failed).toEqual([]);
    expect(existsSync(session)).toBe(false);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    await handle.close();
  });

  test("a callback claiming success without deleting both credentials cannot clear the logout marker", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    await writeFile(join(profileDir, "session.json"), "{}");
    await writeFile(join(profileDir, "key.json"), "{}");
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    const result = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { await rm(join(profileDir, "key.json")); },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(result).toMatchObject({ failed: [{ id: "logout", code: "gate_unavailable" }], remaining: 1 });
    expect(existsSync(join(profileDir, "session.json"))).toBe(true);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(true);
    expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
  });

  test("busy profile lock cannot report a durable logout marker or erase credentials", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const busy = createProfileReplicaPurge({
      profileDir,
      guard: async () => { throw Object.assign(new Error("profile lock busy"), { code: "BUSY" }); },
    });
    await expect(busy.prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toMatchObject({ code: "REPLICA_GATED" });
    let cleanupCalls = 0;
    const report = await busy.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { cleanupCalls++; },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(report).toMatchObject({ failed: [{ id: "logout", code: "gate_unavailable" }], remaining: 1 });
    expect(cleanupCalls).toBe(0);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
  });

  test("marker write failure cannot be reported as a durable logout", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const marker = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
    await mkdir(marker);
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await expect(purge.prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
    expect(await readdir(marker)).toEqual([]);
  });

  const gateWriteTest = process.platform === "win32" || process.getuid?.() === 0 ? test.skip : test;
  gateWriteTest("gate-file write failure after credential unlink retains the marker and retries on recovery", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const session = join(profileDir, "session.json");
    const key = join(profileDir, "key.json");
    const marker = join(profileDir, REPLICA_LOGOUT_PENDING_FILE);
    await writeFile(session, "{}");
    await writeFile(key, "{}");
    const storage = createSqliteReplicaStorage(storageOptions({ logoutPendingFile: marker }));
    const handle = await storage.open(spec());
    await storage.pendingWrites!(identity(), { stamp: stamps.get(profileDir)! })
      .update((state) => { state.seq = 1; });
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    try {
      const failed = await purge.recoverLogoutPending({
        signal: new AbortController().signal,
        clearCredentials: async () => {
          await rm(session);
          await rm(key);
          await chmod(profileDir, 0o500);
        },
        eraseLegacyReplicas: () => eraseLegacy(profileDir),
      });
      expect(failed).toMatchObject({ failed: [{ id: "logout", code: "gate_unavailable" }], remaining: 1 });
      expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
      expect(existsSync(marker)).toBe(true);
      expect(await filesNamed(dir, "pending.json")).toHaveLength(1);
      await expect(handle.get("notes/a")).rejects.toMatchObject({ code: "REPLICA_GATED" });
    } finally {
      await chmod(profileDir, 0o700);
      await handle.close();
    }
    const recovered = await createProfileReplicaPurge({ profileDir, guard: sharedGuard }).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => {},
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(recovered).toMatchObject({ failed: [], remaining: 0 });
    expect(await filesNamed(dir, "pending.json")).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    expect((await readGateSnapshot(profileDir))?.principalHash).toBeNull();
  });

  test("when both marker and deny cannot take the lock, no durable denial is claimed", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const busy = createProfileReplicaPurge({
      profileDir,
      guard: async () => { throw Object.assign(new Error("profile lock busy"), { code: "BUSY" }); },
    });
    await expect(busy.prepareLogoutPending({ principal: PRINCIPAL }))
      .rejects.toMatchObject({ code: "REPLICA_GATED" });
    expect(await busy.deny({ reason: "sign_out", principal: PRINCIPAL }))
      .toMatchObject({ status: "unguarded" });
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(false);
    expect((await readGateSnapshot(profileDir))?.principalHash).not.toBeNull();
  });

  test("stale logout marker never deletes a successor account's credentials", async () => {
    const dir = await makeDir();
    const profileDir = dirname(dir);
    const purge = createProfileReplicaPurge({ profileDir, guard: sharedGuard });
    await purge.prepareLogoutPending({ principal: PRINCIPAL });
    expect((await denyGate(profileDir, { reason: "sign_out", principal: PRINCIPAL }, async () => []))
      .status).toBe("denied");
    const deniedAt = (await readGateSnapshot(profileDir))!.deniedAt!;
    const now = Date.now();
    try {
      setSystemTime(new Date(deniedAt + 2));
      await establishSessionStamp(profileDir, "did:key:successor", { siweIssuedAt: deniedAt + 1 });
    } finally {
      setSystemTime(now);
    }
    let cleanupCalls = 0;
    const failed = await purge.recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: async () => { cleanupCalls++; },
      eraseLegacyReplicas: () => eraseLegacy(profileDir),
    });
    expect(failed.failed).toEqual([{ id: "logout", code: "stamp_stale" }]);
    expect(cleanupCalls).toBe(0);
    expect(existsSync(join(profileDir, REPLICA_LOGOUT_PENDING_FILE))).toBe(true);
  });

  test("deny advances a pending generation once and fences a queued update", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const stamp = await storage.lifecycle!.establishSessionStamp(PRINCIPAL, {
      consentAnchor: { at: 1, source: "siwe" },
    });
    const pending = storage.pendingWrites!(identity(), { stamp });
    await pending.update((state) => { state.seq = 1; });
    const denied = await storage.lifecycle!.deny({ reason: "sign_out", principal: PRINCIPAL });
    expect(denied.status).toBe("denied");
    await expect(pending.read()).rejects.toMatchObject({ code: "REPLICA_GATED" });
    await expect(pending.update((state) => { state.seq = 2; }))
      .rejects.toMatchObject({ code: "REPLICA_GATED" });
    const state = await readGateSnapshot(dirname(dir));
    expect(Object.values(state!.pendingGenerations)).toEqual([1]);
    await storage.lifecycle!.erasePending({ signal: new AbortController().signal });
    expect(Object.values((await readGateSnapshot(dirname(dir)))!.pendingGenerations)).toEqual([1]);
  });
  test("a queued pending update cannot refill pending.json after denial", async () => {
    const dir = await makeDir();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const denyWaiting = Promise.withResolvers<void>();
    const lock = serialGuard();
    let calls = 0;
    const storage = createSqliteReplicaStorage(storageOptions({
      guard: (section) => {
        if (++calls === 2) denyWaiting.resolve();
        return lock(section);
      },
    }));
    const pending = storage.pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    const first = pending.update(async (state) => {
      state.seq = 1;
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const denied = storage.lifecycle!.deny({ reason: "sign_out", principal: PRINCIPAL });
    await denyWaiting.promise;
    const queued = pending.update((state) => { state.seq = 2; });
    release.resolve();
    await first;
    expect((await denied).status).toBe("denied");
    await expect(queued).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    expect(await filesNamed(dir, "pending.json")).toHaveLength(1);
    await storage.lifecycle!.erasePending({ signal: new AbortController().signal });
    expect(await filesNamed(dir, "pending.json")).toEqual([]);
    expect(Object.values((await readGateSnapshot(dirname(dir)))!.pendingGenerations)).toEqual([1]);
  });

});
// ---------------------------------------------------------------------------
// FilePendingWriteStore (§6.3)
// ---------------------------------------------------------------------------

describe("FilePendingWriteStore (§6.3)", () => {
  test("durable: records written by update are visible to a fresh store instance", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const store = storage.pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    expect(store.durable).toBe(true);
    const opId = await store.update((state) => {
      state.records.push({
        opId: "op1",
        seq: ++state.seq,
        key: "notes/a",
        op: "put",
        state: "in_flight",
        epoch: null,
        at: new Date().toISOString(),
        settledAt: null,
      });
      state.committedEpoch += 1;
      return "op1";
    });
    expect(opId).toBe("op1");

    const reopened = createSqliteReplicaStorage(storageOptions()).pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    const state = await reopened.read();
    expect(state.v).toBe(2);
    expect(state.committedEpoch).toBe(1);
    expect(state.seq).toBe(1);
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({ opId: "op1", key: "notes/a", state: "in_flight" });
  });

  test("two contending updates serialize: the second observes the first", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const store = storage.pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    // The first update blocks on the gate mid-mutate; the second is issued
    // while it waits. A real guard queues the second's read-modify-write
    // behind the first — an unguarded store would let it read the empty
    // state and both would write seq=1.
    const first = store.update((state) => {
      state.seq += 1;
      started.resolve();
      return gate.promise.then(() => state.seq);
    });
    await started.promise;
    const second = store.update((state) => {
      state.seq += 1;
      return state.seq;
    });
    gate.resolve();
    const results = await Promise.all([first, second]);
    expect(results).toEqual([1, 2]);
    expect((await store.read()).seq).toBe(2);
  });

  test("a mutate that throws leaves the file untouched", async () => {
    const dir = await makeDir();
    const store = createSqliteReplicaStorage(storageOptions()).pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    await store.update((state) => {
      state.seq += 1;
    });
    await expect(
      store.update((state) => {
        state.seq += 100;
        throw new Error("mutate failed");
      }),
    ).rejects.toThrow("mutate failed");
    expect((await store.read()).seq).toBe(1);
  });

  test("a pending.json naming another identity is STORAGE_ERROR, never silently shared", async () => {
    const dir = await makeDir();
    const store = createSqliteReplicaStorage(storageOptions()).pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    await store.update(() => undefined); // creates the partition
    const [idDir] = await partitionDirs(dir);
    const other: PendingWriteState = {
      v: 2,
      identity: identity({ host: HOST_B }),
      committedEpoch: 3,
      seq: 4,
      records: [],
    };
    await writeFile(join(dir, idDir!, "pending.json"), JSON.stringify(other));
    await expect(store.read()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  test("corrupt pending.json is STORAGE_ERROR", async () => {
    const dir = await makeDir();
    const store = createSqliteReplicaStorage(storageOptions()).pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    await store.update(() => undefined);
    const [idDir] = await partitionDirs(dir);
    await writeFile(join(dir, idDir!, "pending.json"), "{not json");
    await expect(store.read()).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  test("pending updates fail closed when an open identity partition is swapped for a symlink", async () => {
    const dir = await makeDir();
    const alternateRoot = await makeDir();
    const store = createSqliteReplicaStorage(storageOptions({ dir })).pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    const alternate = createSqliteReplicaStorage(storageOptions({ dir: alternateRoot }))
      .pendingWrites!(identity(), { stamp: stamps.get(dirname(alternateRoot))! });
    await store.update(() => undefined);
    await alternate.update(() => undefined);
    const [partition] = await partitionDirs(dir);
    const [alternatePartition] = await partitionDirs(alternateRoot);
    await rename(join(dir, partition!), join(dir, `${partition!}-moved`));
    await symlink(join(alternateRoot, alternatePartition!), join(dir, partition!), "dir");

    await expect(store.update((state) => { state.seq += 1; }))
      .rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect((await alternate.read()).seq).toBe(0);
  });

  test("no guard never creates pending state, even with a valid stamp", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage({ dir });
    const store = storage.pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    expect(store.durable).toBe(true);
    await expect(store.readExisting!()).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    await expect(store.update((state) => { state.committedEpoch = 3; }))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(await readdir(dir)).toEqual([]);
  });

  test("concurrent update() calls on one store all survive — in-process serialization", async () => {
    const dir = await makeDir();
    // Both the in-process queue and the mandatory profile lock serialize updates.
    const store = createSqliteReplicaStorage(storageOptions({ dir })).pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.update((state) => {
          state.records.push({
            opId: `op-${i}`,
            seq: ++state.seq,
            key: `notes/${i}`,
            op: "put",
            state: "in_flight",
            epoch: null,
            at: new Date().toISOString(),
            settledAt: null,
          });
        }),
      ),
    );
    const state = await createSqliteReplicaStorage(storageOptions({ dir })).pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! })
      .read();
    expect(state.seq).toBe(N);
    expect(state.records).toHaveLength(N);
    expect(state.records.map((record) => record.seq)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
  });

  test("concurrent update() calls across store instances on the same path all survive", async () => {
    const dir = await makeDir();
    const first = createSqliteReplicaStorage(storageOptions({ dir })).pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    const second = createSqliteReplicaStorage(storageOptions({ dir })).pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    const N = 50;
    // Interleave the two instances: both must share the file's in-process
    // chain, not race independent read-modify-writes.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        (i % 2 === 0 ? first : second).update((state) => {
          state.records.push({
            opId: `op-${i}`,
            seq: ++state.seq,
            key: `notes/${i}`,
            op: "put",
            state: "in_flight",
            epoch: null,
            at: new Date().toISOString(),
            settledAt: null,
          });
        }),
      ),
    );
    const state = await first.read();
    expect(state.seq).toBe(N);
    expect(state.records).toHaveLength(N);
    expect(state.records.map((record) => record.seq)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
  });

  test("concurrent updates across a symlinked root and its real path all survive — canonical lock key", async () => {
    const dir = await makeDir();
    const alias = join(await makeDir(), "alias");
    await symlink(dir, alias, "dir");
    // The regression (Sol P2): lock keyed by resolve() is lexical — a store
    // through the symlink and one through the real path ran independent
    // read-modify-write chains on one file and lost records (80 → 60).
    const real = createSqliteReplicaStorage(storageOptions({ dir })).pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    const linked = createSqliteReplicaStorage(storageOptions({ dir: alias, gateFile: join(dirname(dir), REPLICA_GATE_FILE) }))
      .pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    const N = 80;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        (i % 2 === 0 ? real : linked).update((state) => {
          state.records.push({
            opId: `op-${i}`,
            seq: ++state.seq,
            key: `notes/${i}`,
            op: "put",
            state: "in_flight",
            epoch: null,
            at: new Date().toISOString(),
            settledAt: null,
          });
        }),
      ),
    );
    const state = await real.read();
    expect(state.seq).toBe(N);
    expect(state.records).toHaveLength(N);
    expect(state.records.map((record) => record.seq)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
  });
});

// ---------------------------------------------------------------------------
// Identity partition isolation (§6.3 regressions)
// ---------------------------------------------------------------------------

describe("identity partition isolation (§6.3)", () => {
  test("same principal+key, different host or space: independent pending state", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const hostA = storage.pendingWrites!(identity({ host: HOST_A }), { stamp: stamps.get(dirname(dir))! });
    const hostB = storage.pendingWrites!(identity({ host: HOST_B }), { stamp: stamps.get(dirname(dir))! });
    const spaceB = storage.pendingWrites!(identity({ space: SPACE_B }), { stamp: stamps.get(dirname(dir))! });

    await hostA.update((state) => {
      state.committedEpoch = 9;
      state.records.push({
        opId: "a1",
        seq: ++state.seq,
        key: "notes/a",
        op: "put",
        state: "committed",
        epoch: 1,
        at: new Date().toISOString(),
        settledAt: null,
      });
    });
    await hostB.update((state) => {
      state.committedEpoch = 2;
    });
    // B's sync clearing B's committed records never touches A's (amendment §1).
    await hostB.update((state) => {
      state.records.length = 0;
    });

    expect((await hostA.read()).committedEpoch).toBe(9);
    expect((await hostA.read()).records).toHaveLength(1);
    expect((await hostB.read()).committedEpoch).toBe(2);
    expect((await hostB.read()).records).toHaveLength(0);
    expect((await spaceB.read()).committedEpoch).toBe(0);
    expect((await spaceB.read()).records).toHaveLength(0);
  });

  test("two hosts on one storage root create separate identity partitions", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const first = await storage.open(spec({ identity: identity({ host: HOST_A }) }));
    const second = await storage.open(spec({ identity: identity({ host: HOST_B }) }));
    expect(first.spec.identity.host).toBe(HOST_A);
    expect(second.spec.identity.host).toBe(HOST_B);
    expect(await partitionDirs(dir)).toHaveLength(2);
    await first.close();
    await second.close();
  });
  test("canonicalization: HTTPS://host:443 and https://host share one partition", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const loud = storage.pendingWrites!(identity({ host: "HTTPS://NODE.EXAMPLE:443/" }), { stamp: stamps.get(dirname(dir))! });
    const quiet = storage.pendingWrites!(identity({ host: "https://node.example" }), { stamp: stamps.get(dirname(dir))! });
    await loud.update((state) => {
      state.committedEpoch = 5;
    });
    expect((await quiet.read()).committedEpoch).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Replica handles: open, grants, fence, purge
// ---------------------------------------------------------------------------

describe("read-only replica status inspection", () => {
  test("a never-opened prefix is absent without creating profile files", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions({ dir }));

    expect(await storage.inspectStatus!(spec(), { signal: new AbortController().signal })).toBeUndefined();
    const pending = storage.pendingWrites(identity(), { stamp: stamps.get(dirname(dir))! });
    expect(await pending.readExisting?.()).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    await pending.update((state) => { state.seq = 1; });
    expect(await pending.readExisting?.()).toMatchObject({ seq: 1, identity: identity() });
  });

  test("inspection bypasses a held mutation guard and missing replicas stay missing after purge", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions({ dir }));
    const handle = await storage.open(spec());
    await handle.close();

    const hold = Promise.withResolvers<void>();
    const heldGuard = async <T>(section: () => Promise<T>): Promise<T> => {
      await hold.promise;
      return section();
    };
    const reader = createSqliteReplicaStorage(storageOptions({ dir, guard: heldGuard }));
    const inspection = reader.inspectStatus!(spec(), { signal: new AbortController().signal });
    const { promise: deadline, resolve: expire } = Promise.withResolvers<{ timedOut: true }>();
    // A real deadline ensures this fails promptly if inspection ever queues on the held guard.
    const timer = setTimeout(() => expire({ timedOut: true }), 3_500);
    const result = await Promise.race([
      inspection.then((value) => ({ timedOut: false as const, value })),
      deadline,
    ]);
    clearTimeout(timer);
    expect(result.timedOut).toBe(false);
    if (result.timedOut) throw new Error("Read-only status inspection waited on the mutation guard.");
    expect(result.value).toMatchObject({ coverage: "empty", authority: { state: "valid" } });

    await storage.purge({ identity: identity(), space: SPACE_A, prefix: "notes/" });
    expect(await storage.inspectStatus!(spec(), { signal: new AbortController().signal })).toBeUndefined();
    expect(await filesNamed(dir, "replica.db")).toEqual([]);
  });
});

describe("sqlite replica handle", () => {
  test("open creates the §6.3 partition layout; delegate posture never writes device.jwk", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    expect(handle.deviceDid).toBe(DEVICE_DID);
    const [idDir] = await partitionDirs(dir);
    expect(existsSync(join(dir, idDir!, "identity.json"))).toBe(true);
    expect(existsSync(join(dir, idDir!, "device.jwk"))).toBe(true);
    expect(existsSync(join(dir, idDir!, "replicas"))).toBe(true);
    await handle.close();

    // Delegate posture: spec.device is used verbatim, device.jwk untouched.
    const dir2 = await makeDir();
    const delegate = await createSqliteReplicaStorage({
      ...storageOptions(),
      dir: dir2,
    }).open(spec({ device: { did: DELEGATE_DID, jwk: {} } }));
    expect(delegate.deviceDid).toBe(DELEGATE_DID);
    const [idDir2] = await partitionDirs(dir2);
    expect(existsSync(join(dir2, idDir2!, "device.jwk"))).toBe(false);
    await delegate.close();
  });

  test("per-CID install time survives reinstall and effective expiry blocks guarded reads", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const now = Date.now();
    const handle = await storage.open(spec({
      grantPolicy: { grantTtlMs: 60_000, consentAnchor: { source: "siwe", at: now - 1000 } },
    }));
    try {
      const ucan = await mintUcan({ audience: DEVICE_DID, exp: Math.floor(now / 1000) + 3600 });
      const first = await handle.installGrant(ucan);
      expect(first.installedAt).toBeGreaterThan(0);
      expect(first.effectiveExpiresAt).toBe(first.installedAt! + 60_000);
      setSystemTime(new Date(now + 10_000));
      const again = await handle.installGrant(ucan);
      expect(again.installedAt).toBe(first.installedAt);
      expect(again.effectiveExpiresAt).toBe(first.effectiveExpiresAt);
      await handle.sync({ signal: new AbortController().signal, syncStartEpoch: 1 });
      setSystemTime(new Date(now + 120_000));
      await expect(handle.get("notes/a")).rejects.toMatchObject({ code: "GRANT_EXPIRED" });
      await expect(handle.list({ prefix: "notes/" })).rejects.toMatchObject({ code: "GRANT_EXPIRED" });
    } finally {
      setSystemTime();
      await handle.close();
    }
  });

  test("targeted purge cannot refresh a CID's original TTL or sync an expired grant", async () => {
    await makeDir();
    const now = Date.now();
    const feed = new FakeNode();
    feed.put("notes/a", "first");
    const storage = createSqliteReplicaStorage(storageOptions({
      createDevice: async () => ({ did: device.did, jwk: {} }),
      transportFor: () => feed,
    }));
    const signedGrant = await mintUcan({ audience: device.did, exp: Math.floor(now / 1000) + 3_600 });
    const boundedSpec = spec({
      grantPolicy: { grantTtlMs: 1_000, consentAnchor: { source: "siwe", at: now } },
    });
    const first = await storage.open(boundedSpec);
    try {
      const installed = await first.installGrant(signedGrant);
      await first.sync({ signal: new AbortController().signal, syncStartEpoch: 1 });
      await first.close();
      await storage.purge({ identity: identity(), space: SPACE_A, prefix: "notes/" });

      setSystemTime(new Date(now + 500));
      const next = await storage.open(boundedSpec);
      try {
        const reused = await next.installGrant(signedGrant);
        expect(reused.installedAt).toBe(installed.installedAt);
        expect(reused.effectiveExpiresAt).toBe(installed.effectiveExpiresAt);
        await next.sync({ signal: new AbortController().signal, syncStartEpoch: 2 });
        setSystemTime(new Date(now + 2_000));
        const before = feed.syncCalls;
        await expect(next.sync({ signal: new AbortController().signal, syncStartEpoch: 7 }))
          .rejects.toMatchObject({ code: "GRANT_EXPIRED" });
        expect(feed.syncCalls).toBe(before);
        expect((await next.status()).syncedThroughEpoch).toBe(2);
      } finally {
        await next.close();
      }
      await storage.purge({ identity: identity(), space: SPACE_A, prefix: "notes/" });
      const after = await storage.open(boundedSpec);
      try {
        await expect(after.installGrant(signedGrant)).rejects.toMatchObject({ code: "GRANT_EXPIRED" });
      } finally {
        await after.close();
      }
    } finally {
      setSystemTime();
      await first.close();
    }
  });

  test("a grant expiring during a sync page commits no rows or success fence", async () => {
    await makeDir();
    const now = Date.now();
    const feed = new FakeNode();
    feed.put("notes/a", "never committed");
    const storage = createSqliteReplicaStorage(storageOptions({
      createDevice: async () => ({ did: device.did, jwk: {} }),
      transportFor: () => feed,
    }));
    const handle = await storage.open(spec({
      grantPolicy: { grantTtlMs: 1_000, consentAnchor: { source: "siwe", at: now } },
    }));
    try {
      await handle.installGrant(await mintUcan({ audience: device.did, exp: Math.floor(now / 1000) + 3_600 }));
      feed.onSyncPage = () => { setSystemTime(new Date(now + 2_000)); };
      await expect(handle.sync({ signal: new AbortController().signal, syncStartEpoch: 7 }))
        .rejects.toMatchObject({ code: "GRANT_EXPIRED" });
      expect(feed.syncCalls).toBe(1);
      setSystemTime();
      expect((await handle.status()).syncedThroughEpoch).toBe(0);
      expect((await handle.list({ prefix: "notes/" })).keys).toEqual([]);
    } finally {
      setSystemTime();
      await handle.close();
    }
  });

  test("reopening recomputes expiry from the same persisted CID install time", async () => {
    await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const now = Date.now();
    const anchor = { source: "siwe" as const, at: now - 1000 };
    const initial = await storage.open(spec({ grantPolicy: { grantTtlMs: 60_000, consentAnchor: anchor } }));
    const ucan = await mintUcan({ audience: DEVICE_DID, exp: Math.floor(now / 1000) + 3600 });
    const first = await initial.installGrant(ucan);
    await initial.close();

    const restored = await storage.open(spec({ grantPolicy: { grantTtlMs: 30_000, consentAnchor: anchor } }));
    try {
      const info = await restored.grant();
      expect(info?.installedAt).toBe(first.installedAt);
      expect(info?.effectiveExpiresAt).toBe(first.installedAt! + 30_000);
      expect(info?.consentAnchor).toEqual(anchor);
      expect(info?.consentDeadline).toBe(anchor.at + 7 * 24 * 60 * 60 * 1000);
    } finally {
      await restored.close();
    }
  });

  test("installGrant → pending info with parentCid and unconstrained; caveated grants reject", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    expect(await handle.grant()).toBeNull();

    const exp = Math.floor(Date.now() / 1000) + 3_600;
    const ucan = await mintUcan({ audience: DEVICE_DID, exp, prf: ["bafyParentCid"] });
    const info = await handle.installGrant(ucan);
    expect(info.parentCid).toBe("bafyParentCid");
    expect(info.expiresAt).toBe(exp * 1000);
    expect(info.unconstrained).toBe(true);
    expect(info.state).toBe("pending");
    expect((await handle.grant())!.state).toBe("pending");

    const caveated = await mintUcan({
      audience: DEVICE_DID,
      caveats: { maxValueSize: [1000] },
    });
    await expect(handle.installGrant(caveated)).rejects.toMatchObject({
      code: "GRANT_NOT_COVERING",
    });
    await handle.close();
  });

  test("a grant for a different device audience rejects", async () => {
    const dir = await makeDir();
    const handle = await createSqliteReplicaStorage(storageOptions()).open(spec());
    const foreign = await mintUcan({ audience: "did:key:zSomeoneElse" });
    await expect(handle.installGrant(foreign)).rejects.toMatchObject({
      code: "GRANT_AUDIENCE_MISMATCH",
    });
    await handle.close();
  });

  test("sync persists syncedThroughEpoch on success only; status and reads report it", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    await handle.installGrant(await mintUcan({ audience: DEVICE_DID }));

    const result = await handle.sync({ signal: new AbortController().signal, syncStartEpoch: 7 });
    expect(result).toMatchObject({ status: "synced", syncedThroughEpoch: 7 });
    const status = await handle.status();
    expect(status.syncedThroughEpoch).toBe(7);
    expect(status.grant).toMatchObject({ state: "active", unconstrained: true });
    const read = await handle.get("notes/a");
    expect(read.status).toBe("absent");
    expect(read.meta.syncedThroughEpoch).toBe(7);
    await handle.close();

    // The fence survives reopening the handle (amendment §1: durable).
    const reopened = await storage.open(spec());
    expect((await reopened.status()).syncedThroughEpoch).toBe(7);
    await reopened.close();
  });

  test("a paused SQLite list never labels its older rows with a later sync epoch", async () => {
    await makeDir();
    const feed = new FakeNode();
    feed.put("notes/a", "old");
    const storage = createSqliteReplicaStorage(storageOptions({
      createDevice: async () => ({ did: device.did, jwk: {} }),
      transportFor: () => feed,
    }));
    const handle = await storage.open(spec());
    const originalList = SqliteReplicaStore.prototype.list;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let pause = true;
    try {
      await handle.installGrant(await mintUcan({ audience: device.did }));
      await handle.sync({ signal: new AbortController().signal, syncStartEpoch: 1 });
      SqliteReplicaStore.prototype.list = async function (options) {
        if (pause) {
          pause = false;
          entered.resolve();
          await release.promise;
        }
        return originalList.call(this, options);
      };
      const reading = handle.list({ prefix: "notes/" });
      await entered.promise;
      feed.put("notes/b", "new");
      await handle.sync({ signal: new AbortController().signal, syncStartEpoch: 7 });
      release.resolve();
      const result = await reading;
      expect(result.keys).toEqual(["notes/a"]);
      expect(result.meta.syncedThroughEpoch).toBe(1);
      expect((await handle.list({ prefix: "notes/" })).keys).toEqual(["notes/a", "notes/b"]);
    } finally {
      release.resolve();
      SqliteReplicaStore.prototype.list = originalList;
      await handle.close();
    }
  });

  test("a failed sync leaves the prior fence unchanged", async () => {
    const dir = await makeDir();
    let fail = false;
    const transport: ReplicaTransport = {
      async syncPage({ prefix }) {
        if (fail) throw new Error("node unreachable");
        return fakeTransport.syncPage({ prefix, limit: 100 });
      },
      fetchContent: fakeTransport.fetchContent,
    };
    const storage = createSqliteReplicaStorage(storageOptions({ transportFor: () => transport }));
    const handle = await storage.open(spec());
    await handle.installGrant(await mintUcan({ audience: DEVICE_DID }));
    await handle.sync({ signal: new AbortController().signal, syncStartEpoch: 3 });

    fail = true;
    await expect(
      handle.sync({ signal: new AbortController().signal, syncStartEpoch: 99 }),
    ).rejects.toThrow("node unreachable");
    expect((await handle.status()).syncedThroughEpoch).toBe(3);
    await handle.close();
  });

  test("two replicas of one identity fence independently (amendment §1 regression)", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const ucan = await mintUcan({
      audience: DEVICE_DID,
      prefixes: ["notes/", "other/"],
    });
    const notes = await storage.open(spec({ prefix: "notes/" }));
    const other = await storage.open(spec({ prefix: "other/" }));
    await notes.installGrant(ucan);
    await other.installGrant(ucan);

    // Replica "notes" syncs at identity epoch 7; "other" stays fenced at 0 —
    // a shared fence would wrongly prove "other" caught up.
    await notes.sync({ signal: new AbortController().signal, syncStartEpoch: 7 });
    expect((await notes.status()).syncedThroughEpoch).toBe(7);
    expect((await other.status()).syncedThroughEpoch).toBe(0);

    // After "other" syncs later at epoch 9, each reports its own fence.
    await other.sync({ signal: new AbortController().signal, syncStartEpoch: 9 });
    expect((await notes.status()).syncedThroughEpoch).toBe(7);
    expect((await other.status()).syncedThroughEpoch).toBe(9);
    await notes.close();
    await other.close();
  });

  test("verbatim space case: EIP-55 then lowercase is CONFIG_MISMATCH (§6.3 row 17)", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const mixed = "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000A1:default";
    const handle = await storage.open(
      spec({ identity: identity({ space: mixed }), space: mixed }),
    );
    await handle.close();
    const lower = mixed.toLowerCase();
    await expect(
      storage.open(spec({ identity: identity({ space: lower }), space: lower })),
    ).rejects.toMatchObject({ code: "REPLICA_CONFIG_MISMATCH" });
  });

  test("secrets space refuses without allowSecrets (§10.1)", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const secretsSpace = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets";
    await expect(
      storage.open(spec({ space: secretsSpace, identity: identity({ space: secretsSpace }) })),
    ).rejects.toMatchObject({ code: "SECRETS_OPT_IN_REQUIRED" });
    const vault = await storage.open(spec({ prefix: "vault/keys", allowSecrets: false })).catch((e) => e);
    expect(vault).toMatchObject({ code: "SECRETS_OPT_IN_REQUIRED" });
  });

  test("closed handle rejects reads", async () => {
    const dir = await makeDir();
    const handle = await createSqliteReplicaStorage(storageOptions()).open(spec());
    await handle.close();
    await expect(handle.get("notes/a")).rejects.toMatchObject({ code: "REPLICA_CLOSED" });
    await expect(handle.status()).rejects.toMatchObject({ code: "REPLICA_CLOSED" });
  });
});

describe("purge across the device union (§10.2)", () => {
  test("erases the stored device and the session-device replica, keeps the partition", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const own = await storage.open(spec());
    const delegated = await storage.open(spec({ device: { did: DELEGATE_DID, jwk: {} } }));
    await own.close();
    await delegated.close();

    const [idDir] = await partitionDirs(dir);
    const replicasBefore = await readdir(join(dir, idDir!, "replicas"));
    expect(replicasBefore.length).toBe(2);

    await storage.purge({
      identity: identity(),
      space: SPACE_A,
      prefix: "notes/",
      sessionDeviceDid: DELEGATE_DID,
    });
    const replicasAfter = await readdir(join(dir, idDir!, "replicas"));
    expect(replicasAfter.length).toBe(0);
    expect(existsSync(join(dir, idDir!, "identity.json"))).toBe(true);
  });

  test("purge of a missing partition resolves; a session device alone is still purged", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    await expect(
      storage.purge({ identity: identity({ host: HOST_B }), space: SPACE_A, prefix: "notes/" }),
    ).resolves.toBeUndefined();

    // A partition that never had device.jwk (pure delegate posture) still
    // gets its session-device replica erased.
    const delegated = await storage.open(spec({ device: { did: DELEGATE_DID, jwk: {} } }));
    await delegated.close();
    const [idDir] = await partitionDirs(dir);
    expect(existsSync(join(dir, idDir!, "device.jwk"))).toBe(false);
    await storage.purge({
      identity: identity(),
      space: SPACE_A,
      prefix: "notes/",
      sessionDeviceDid: DELEGATE_DID,
    });
    expect((await readdir(join(dir, idDir!, "replicas"))).length).toBe(0);
  });

  test("purge of a leftover missing-database layout removes only listed source files", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    await handle.close();
    const [id] = await readdir(dir);
    const partition = join(dir, id!, "replicas", (await readdir(join(dir, id!, "replicas")))[0]!);
    await rm(join(partition, "replica.db"));
    await writeFile(join(partition, "private.bin"), "do not erase");
    await expect(storage.purge({ identity: identity(), space: SPACE_A, prefix: "notes/" }))
      .rejects.toThrow();
    expect(existsSync(join(partition, "private.bin"))).toBe(true);
    await rm(join(partition, "private.bin"));
    await storage.purge({ identity: identity(), space: SPACE_A, prefix: "notes/" });
    expect(existsSync(partition)).toBe(false);
  });

  test("purge while another process holds the sync lease rejects BUSY", async () => {
    const { SqliteReplicaStore } = await import("@tinycloud/replica/sqlite");
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    await handle.close();
    const [idDir] = await partitionDirs(dir);
    const [replicaDir] = await readdir(join(dir, idDir!, "replicas"));

    // A foreign store handle holds the lease: purge must not remove the dir.
    const foreign = await SqliteReplicaStore.open(join(dir, idDir!, "replicas", replicaDir!), {
      create: false,
    });
    const lease = await foreign.acquireSyncLease(120_000);
    expect(lease).not.toBeNull();
    await expect(
      storage.purge({ identity: identity(), space: SPACE_A, prefix: "notes/" }),
    ).rejects.toMatchObject({ code: "REPLICA_BUSY" });
    expect(existsSync(join(dir, idDir!, "replicas", replicaDir!))).toBe(true);
    await foreign.releaseLease(lease!);
    await foreign.close();
  });

  test("a handle opened before purge is fenced: status, get and list reject RESET_REQUIRED", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    await handle.installGrant(await mintUcan({ audience: DEVICE_DID }));
    // The handle stays OPEN across the purge: generation fencing (the
    // browser wipe contract) must invalidate it — never unlink under it.
    await storage.purge({ identity: identity(), space: SPACE_A, prefix: "notes/" });
    await expect(handle.status()).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    await expect(handle.get("notes/a")).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    await expect(handle.list({ prefix: "notes/" })).rejects.toMatchObject({
      code: "RESET_REQUIRED",
    });
    await handle.close();
    // A fresh handle on the same dir re-initializes cleanly.
    const reopened = await storage.open(spec());
    expect(await reopened.grant()).toBeNull();
    await reopened.close();
  });

  test("a filesystem error that isn't ENOENT fails purge — pending protection stays", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const handle = await storage.open(spec());
    await handle.close();
    const [idDir] = await partitionDirs(dir);
    const replicasDir = join(dir, idDir!, "replicas");
    // EACCES on stat is not "absent": purge must fail, not remove.
    await chmod(replicasDir, 0o000);
    try {
      await expect(
        storage.purge({ identity: identity(), space: SPACE_A, prefix: "notes/" }),
      ).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    } finally {
      await chmod(replicasDir, 0o700);
    }
    expect((await readdir(replicasDir)).length).toBe(1);
  });

  test("concurrent first opens of an identical spec both succeed", async () => {
    const dir = await makeDir();
    // Both processes use the same required profile lock, including the first init.
    const a = createSqliteReplicaStorage(storageOptions());
    const b = createSqliteReplicaStorage(storageOptions());
    const [ha, hb] = await Promise.all([a.open(spec()), b.open(spec())]);
    expect(ha.deviceDid).toBe(DEVICE_DID);
    expect(hb.deviceDid).toBe(DEVICE_DID);
    await ha.close();
    await hb.close();
  });
});

describe("atomic-write durability", () => {
  test("every pending-state write fsyncs the parent directory after the rename", async () => {
    const dir = await makeDir();
    const synced: string[] = [];
    const dirSync = async (d: string): Promise<void> => {
      synced.push(d);
    };
    const storage = createSqliteReplicaStorage(storageOptions({ dirSync }));
    const store = storage.pendingWrites!(identity(), { stamp: stamps.get(dirname(dir))! });
    await store.update((state) => {
      state.seq += 1;
    });
    // identity.json (partition) + pending.json each fsynced their parent.
    expect(synced.length).toBeGreaterThanOrEqual(2);
    expect(synced.some((d) => d.endsWith("pending.json") === false)).toBe(true);
    expect((await store.read()).seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §4.4 reuse rule inputs: a restored invocation sees the installed grant's
// parent and expiry without any mint (the controller's decision inputs).
// ---------------------------------------------------------------------------

describe("grant reuse across restored invocations (§4.4 inputs)", () => {
  test("ten reopens report the same installed parentCid/expiresAt after one sync", async () => {
    const dir = await makeDir();
    const storage = createSqliteReplicaStorage(storageOptions());
    const exp = Math.floor(Date.now() / 1000) + 240; // final 5 minutes of the parent
    const ucan = await mintUcan({ audience: DEVICE_DID, exp, prf: ["bafyParentX"] });

    const first = await storage.open(spec());
    await first.installGrant(ucan);
    await first.sync({ signal: new AbortController().signal, syncStartEpoch: 1 });
    await first.close();

    for (let invocation = 0; invocation < 10; invocation++) {
      const restored = await storage.open(spec());
      const grant = await restored.grant();
      // After promotion the grant is active; parent and expiry are stable —
      // §4.4's rule would mint zero times across these invocations.
      expect(grant).toMatchObject({
        state: "active",
        parentCid: "bafyParentX",
        expiresAt: exp * 1000,
        unconstrained: true,
      });
      await restored.close();
    }
  });
});
